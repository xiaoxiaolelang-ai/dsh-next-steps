/**
 * 下一步建议（dsh-next-steps）—— Client 半边。
 *
 * 数据只走一条路：这一轮自己的工具结果。**没有共享 Map、没有 render 副作用、
 * 没有跨组件传递**——每个轮次尾部只回答一个纯问题：
 *   「在 (本轮起点, 本轮收尾] 之间，有没有一条 suggest_actions 结果？」
 * 因此历史轮次各自定格在自己的建议上，晚到的结果也会触发重渲染。
 *
 * 轮次边界来自宿主的 TurnTailOwnerProps：`turn.start.seq` / `turn.end.seq`，
 * 收尾序号另有 `seq` 参数可兜底。
 */
window.__ModuleLoader__.load({
  id: 'dsh-next-steps',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-next-steps'
    const MARKER = 'dsh-next-steps/v1'
    /** 只显示最新一轮时，历史轮次整段不渲染。 */
    const VISIBLE_TIERS = { rec: 'rec', normal: 'normal', weak: 'weak' }

    /* ------------------------------------------------------------------ *
     * 数据：从工具结果里取出算好的 actions
     * ------------------------------------------------------------------ */

    /** 命中 MARKER 的那段文本 → actions；不是我们的段落返回 null。 */
    function parseMarkerText(text) {
      if (typeof text !== 'string' || !text.startsWith(MARKER)) return null
      try {
        const parsed = JSON.parse(text.slice(MARKER.length).trim())
        return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.actions)
          ? { actions: parsed.actions, mode: parsed.mode === 'all' ? 'all' : 'latest' }
          : null
      } catch {
        return null
      }
    }

    /**
     * 在一个 chat 节点里找我们的数据段。
     *
     * 节点内部形状不是公开契约，所以这里不按固定路径取值，而是有界地深搜
     * 字符串——命中 MARKER 就算找到。宁可多走几步，也不依赖某个字段名。
     */
    function findPayload(value, budget) {
      const seen = new Set()
      const stack = [value]
      let steps = 0
      while (stack.length > 0 && steps < budget.steps) {
        steps += 1
        const current = stack.pop()
        if (typeof current === 'string') {
          const hit = parseMarkerText(current)
          if (hit !== null) return hit
          continue
        }
        if (current === null || typeof current !== 'object') continue
        if (seen.has(current)) continue
        seen.add(current)
        if (Array.isArray(current)) {
          for (let i = current.length - 1; i >= 0; i -= 1) stack.push(current[i])
          continue
        }
        for (const key of Object.keys(current)) stack.push(current[key])
      }
      return null
    }

    /** 节点的收尾序号：公开字段先后试一遍，取不到就算了。 */
    function nodeSeq(node) {
      if (node === null || typeof node !== 'object') return undefined
      const candidates = [node.anchorSeq, node.seq, node.data?.seq, node.data?.anchorSeq, node.data?.closing?.finalNode?.seq]
      for (const candidate of candidates) if (typeof candidate === 'number') return candidate
      return undefined
    }

    /** 命中过的节点对象记下来，同一个节点只深搜一次（节点快照是不可变的）。 */
    const payloadByNode = new WeakMap()

    /** 会话节点快照 → 有序的 [{ seq, payload }]；同一个快照只算一次。 */
    let indexCache = { store: null, order: null, list: [] }
    function buildIndex(store, order) {
      // 缓存键必须同时带上 order：节点店可能是同一个对象而顺序数组换了新的，
      // 只看 store 会把上一轮的结果一直复用下去——正是这次要防的那类 bug。
      if (indexCache.store === store && indexCache.order === order && store !== null) return indexCache.list
      const list = []
      if (store !== null && store !== undefined && Array.isArray(order)) {
        const read = typeof store.get === 'function' ? (key) => store.get(key) : (key) => store[key]
        for (const key of order) {
          let node
          try {
            node = read(key)
          } catch {
            continue
          }
          if (node === null || node === undefined) continue
          // 只有工具调用节点可能带着我们的数据段；其余节点直接跳过，长会话才不卡。
          const kind = typeof node.kind === "string" ? node.kind : ""
          if (kind !== "" && kind !== "tool-call") continue
          let payload = payloadByNode.get(node)
          if (payload === undefined) {
            payload = findPayload(node, { steps: 1500 })
            if (payload !== null) payloadByNode.set(node, payload)
          }
          if (payload === null) continue
          list.push({ seq: nodeSeq(node), payload })
        }
      }
      list.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1))
      indexCache = { store: store ?? null, order: order ?? null, list }
      return list
    }

    /* ------------------------------------------------------------------ *
     * 兜底通道：万一节点形状对不上，用采集器保底（仍然只显示最新一轮）
     * ------------------------------------------------------------------ */

    const seenCalls = new Set()
    const EMPTY_FALLBACK = { payload: null }
    /** 兜底值按会话分开：切会话时不能把上一个会话的最后一条喂过来。 */
    const fallbackBySession = new Map()
    const fallbackListeners = new Set()
    function publishFallback(sessionId, callId, payload) {
      if (payload === null || seenCalls.has(callId)) return
      seenCalls.add(callId)
      fallbackBySession.set(sessionId, { payload })
      for (const listener of fallbackListeners) listener()
    }
    function subscribeFallback(listener) {
      fallbackListeners.add(listener)
      return () => fallbackListeners.delete(listener)
    }
    function fallbackOf(sessionId) {
      return fallbackBySession.get(sessionId) ?? EMPTY_FALLBACK
    }

    /* ------------------------------------------------------------------ *
     * 轮次级持久化：重启后历史轮次还原不出建议时，用自己记下的那份
     *
     * 为什么需要：工具结果在会话日志里是全的，但重启后宿主重建出来的节点
     * 形状不一定还能被 findPayload 认出来（实时流和重放是两条路径）。
     * 这里按「会话 + 该轮收尾 seq」存一份，键就是轮次的持久序号，
     * 所以不会跨轮串味；取不到也只是没有，绝不回显上一轮。
     * ------------------------------------------------------------------ */

    const TAIL_STORE = 'dsh-next-steps:tails:v1'
    const TAIL_STORE_MAX = 400

    // 内存镜像：localStorage 只有本插件在写，读一次就够。
    // 没有它的话，每个 tail 每次重渲都要 JSON.parse 整份存储——
    // 流式生成期间 tail 会反复重渲，那是实打实的卡顿来源。
    let tailStoreMirror = null
    // 已经写过的键 → 序列化后的内容；内容没变就不再写盘。
    const tailStoreWritten = new Map()

    function readTailStore() {
      if (tailStoreMirror !== null) return tailStoreMirror
      try {
        const raw = window.localStorage.getItem(TAIL_STORE)
        const parsed = raw === null ? null : JSON.parse(raw)
        tailStoreMirror = parsed !== null && typeof parsed === 'object' ? parsed : {}
      } catch {
        tailStoreMirror = {}
      }
      return tailStoreMirror
    }

    function tailKey(sessionId, endSeq) {
      return sessionId + '|' + String(endSeq)
    }

    function recallTail(sessionId, endSeq) {
      if (sessionId === '' || typeof endSeq !== 'number') return null
      const saved = readTailStore()[tailKey(sessionId, endSeq)]
      if (saved === null || typeof saved !== 'object') return null
      const actions = Array.isArray(saved.actions) ? saved.actions : null
      if (actions === null || actions.length === 0) return null
      return { mode: saved.mode === 'all' ? 'all' : 'latest', actions }
    }

    function rememberTail(sessionId, endSeq, payload) {
      if (sessionId === '' || typeof endSeq !== 'number' || payload === null) return
      if (!Array.isArray(payload.actions) || payload.actions.length === 0) return
      const key = tailKey(sessionId, endSeq)
      const record = {
        mode: payload.mode === 'all' ? 'all' : 'latest',
        actions: payload.actions,
      }
      const stamp = JSON.stringify(record)
      // 内容没变就什么都不做：流式期间 tail 会反复重渲，不能每次都写盘。
      if (tailStoreWritten.get(key) === stamp) return
      tailStoreWritten.set(key, stamp)
      try {
        const all = readTailStore()
        all[key] = record
        const keys = Object.keys(all)
        if (keys.length > TAIL_STORE_MAX) {
          for (const stale of keys.slice(0, keys.length - TAIL_STORE_MAX)) {
            delete all[stale]
            tailStoreWritten.delete(stale)
          }
        }
        window.localStorage.setItem(TAIL_STORE, JSON.stringify(all))
      } catch {
        // 存不下就只靠当次会话内的通道；镜像里留着，本次会话仍可还原
      }
    }

    function Capture(props) {
      const payload = React.useMemo(() => {
        try {
          return findPayload(props.block, { steps: 600 })
        } catch {
          return null
        }
      }, [props.block])
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      React.useEffect(() => {
        if (payload !== null && sessionId !== '') publishFallback(sessionId, String(props.callId ?? ''), payload)
      }, [payload, props.callId, sessionId])
      return null
    }

    /* ------------------------------------------------------------------ *
     * 「哪一轮是最新」：轮次尾部各自登记收尾序号，取最大值
     * ------------------------------------------------------------------ */

    /** sessionId → 已挂载的轮次收尾号；跨会话比大小没有意义，必须分开。 */
    const tailSeqs = new Map()
    const tailListeners = new Set()
    function subscribeTails(listener) {
      tailListeners.add(listener)
      return () => tailListeners.delete(listener)
    }
    function maxTailSeqOf(sessionId) {
      const set = tailSeqs.get(sessionId)
      if (set === undefined || set.size === 0) return undefined
      let max
      for (const seq of set) if (max === undefined || seq > max) max = seq
      return max
    }
    function notifyTails() {
      for (const listener of tailListeners) listener()
    }

    /* ------------------------------------------------------------------ *
     * 提交与填入
     * ------------------------------------------------------------------ */

    function composerShell(ctx, sessionId) {
      try {
        const conversation = ctx.get('conversation')
        const input = conversation?.input
        return typeof input?.shell === 'function' ? input.shell(sessionId) : undefined
      } catch {
        return undefined
      }
    }

    function draftWriter(ctx, sessionId) {
      const shell = composerShell(ctx, sessionId)
      if (shell === undefined) return undefined
      const actions = shell.actions
      if (actions !== undefined && actions !== null && typeof actions.setDraft === 'function') {
        return (text) => actions.setDraft(text)
      }
      return typeof shell.setDraft === 'function' ? (text) => shell.setDraft(text) : undefined
    }

    /** 写草稿 → 等草稿真的落定 → 提交（setDraft 走异步编辑器，同 tick 提交会是空的）。 */
    function sendAsUser(ctx, sessionId, text) {
      const shell = composerShell(ctx, sessionId)
      if (shell === undefined) throw new Error('no composer shell')
      const write = draftWriter(ctx, sessionId)
      if (write === undefined) throw new Error('composer exposes no setDraft')
      const submit = shell.actions !== undefined && typeof shell.actions.submit === 'function'
        ? () => shell.actions.submit()
        : typeof shell.submit === 'function' ? () => shell.submit() : undefined
      if (submit === undefined) throw new Error('composer exposes no submit')
      write(text)
      // 返回 Promise：submit 在定时器里抛错也要能被上层看到，否则 UI 会显示"已发送"
      // 而实际什么都没发生，而且按钮再也点不了。
      return new Promise((resolve) => {
        let tries = 0
        const settle = () => {
          let draft
          try {
            draft = shell.state.getSnapshot().draft
          } catch {
            draft = undefined
          }
          if (draft === text || tries >= 12) {
            const fail = (error) => resolve({ ok: false, error: error instanceof Error ? error.message : String(error) })
            try {
              const pending = submit()
              // submit 也可能返回 Promise：它的拒绝同样不能被当成"发送成功"。
              if (pending !== undefined && pending !== null && typeof pending.then === 'function') {
                pending.then(() => resolve({ ok: true }), fail)
                return
              }
              resolve({ ok: true })
            } catch (error) {
              fail(error)
            }
            return
          }
          tries += 1
          window.setTimeout(settle, 25)
        }
        window.setTimeout(settle, 0)
      })
    }

    /** 读输入框里现有的草稿；读不到就当作空。 */
    function currentDraft(ctx, sessionId) {
      const shell = composerShell(ctx, sessionId)
      if (shell === undefined || shell.state === undefined || typeof shell.state.getSnapshot !== 'function') return ''
      try {
        const draft = shell.state.getSnapshot().draft
        return typeof draft === 'string' ? draft : ''
      } catch {
        return ''
      }
    }

    /**
     * Shift + 点击：把建议塞进输入框但不发送。
     * 已有草稿时**追加**而不是覆盖——用户可能已经打了半句话，
     * 直接替换会把他的内容弄丢。
     */
    function fillComposer(ctx, sessionId, text) {
      const write = draftWriter(ctx, sessionId)
      if (write === undefined) throw new Error('composer exposes no setDraft')
      const existing = currentDraft(ctx, sessionId)
      const trimmed = existing.replace(/[\s\u3000]+$/, '')
      write(trimmed === '' ? text : trimmed + '\n' + text)
      const shell = composerShell(ctx, sessionId)
      if (shell !== undefined && typeof shell.focus === 'function') shell.focus()
    }

    /* ------------------------------------------------------------------ *
     * 样式：三档视觉，全部走主题令牌
     * ------------------------------------------------------------------ */

    const CSS = [
      '.dns-root{margin:0;padding:2px 0 0;max-width:100%;container-type:inline-size}',
      '.dns-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:0}',
      /* 窄容器（右侧栏打开、窄窗口）自动降成一列，2×2 不硬撑。 */
      '@container (max-width:420px){.dns-grid{grid-template-columns:minmax(0,1fr)}}',
      /* 普通档：用「主文字色 7% 叠在透明上」做底，浅色下是浅灰、深色下是微亮，两侧都看得见。
         先给一条 layer-2 兜底，再给 color-mix 覆盖（老内核忽略后者也不至于没底）。 */
      '.dns-btn{position:relative;display:flex;align-items:center;gap:8px;box-sizing:border-box;min-width:0;width:100%;margin:0;padding:10px 12px;border:0;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-2,#f2f3f5);background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 8%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 10%,transparent);color:var(--dsw-alias-label-primary,#1a1a1a);font:inherit;font-size:13px;line-height:1.55;text-align:left;cursor:pointer;transition:background-color .12s ease}',
      '@media (hover:hover){.dns-btn:hover{background:var(--dsw-alias-interactive-bg-active,#e6e8ec);background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 12%,transparent)}}',
      '.dns-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:2px}',
      '.dns-btn:disabled{opacity:.55;cursor:default}',
      /* 主推：品牌色 16% 底 + 55% 描边 + 3px 左座条。 */
      '.dns-btn[data-tier="rec"]{padding-left:15px;background:var(--dsw-alias-bg-layer-2,#f2f3f5);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 16%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 55%,transparent)}',
      '@media (hover:hover){.dns-btn[data-tier="rec"]:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe)) 22%,transparent)}}',
      '.dns-btn[data-tier="rec"]:before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 2px 2px 0;background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe))}',
      /* 弱档（stop）：4% 底 + 次级文字；不再完全透明，能看出是一张可点的卡。 */
      '.dns-btn[data-tier="weak"]{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 5%,transparent);color:var(--dsw-alias-label-secondary,#6b6f76)}',
      '@media (hover:hover){.dns-btn[data-tier="weak"]:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 9%,transparent);color:var(--dsw-alias-label-primary,#1a1a1a)}}',
      '.dns-label{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.dns-error{grid-column:1/-1;margin:0;color:var(--dsw-alias-state-error-primary,#c0392b);font-size:12px;line-height:1.6;word-break:break-word}',
      '@media (prefers-reduced-motion:reduce){.dns-btn{transition:none}}',
    ].join('')

    /** 官方的 styles 服务优先；取不到才自己插一个 <style>，并把移除交给卸载。 */
    function installStyles(ctx) {
      try {
        const styles = ctx.get('styles')
        if (styles !== undefined && styles !== null && typeof styles.insert === 'function') {
          styles.insert(CSS)
          return undefined
        }
      } catch {}
      const tag = document.createElement('style')
      tag.dataset.dshNextSteps = 'styles'
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ------------------------------------------------------------------ *
     * 渲染
     * ------------------------------------------------------------------ */

    function createTail(ctx, t) {
      return function NextStepsTail(props) {
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
        const endSeq = typeof props.seq === 'number'
          ? props.seq
          : typeof props.turn?.end?.seq === 'number' ? props.turn.end.seq : undefined
        const startSeq = typeof props.turn?.start?.seq === 'number' ? props.turn.start.seq : undefined

        const useChat = typeof props.useChat === 'function' ? props.useChat : undefined
        const order = useChat === undefined ? undefined : useChat((snapshot) => snapshot.order)
        const store = useChat === undefined ? undefined : useChat((snapshot) => snapshot.nodes)
        const index = React.useMemo(
          () => (useChat === undefined ? [] : buildIndex(store, order)),
          [useChat, store, order],
        )
        const readFallback = () => fallbackOf(sessionId)
        const readLatest = () => maxTailSeqOf(sessionId)
        const fallback = React.useSyncExternalStore(subscribeFallback, readFallback, readFallback)
        const latestEnd = React.useSyncExternalStore(subscribeTails, readLatest, readLatest)

        React.useEffect(() => {
          if (typeof endSeq !== 'number' || sessionId === '') return undefined
          let set = tailSeqs.get(sessionId)
          if (set === undefined) {
            set = new Set()
            tailSeqs.set(sessionId, set)
          }
          set.add(endSeq)
          notifyTails()
          return () => {
            set.delete(endSeq)
            if (set.size === 0) tailSeqs.delete(sessionId)
            notifyTails()
          }
        }, [endSeq, sessionId])

        const [pending, setPending] = React.useState('')
        const [sent, setSent] = React.useState('')
        const [failure, setFailure] = React.useState('')

        // 这一轮自己的建议：起点 < seq <= 收尾。取不到就是没有，绝不回显上一轮。
        const payload = React.useMemo(() => {
          if (typeof endSeq !== 'number') return null
          for (let i = index.length - 1; i >= 0; i -= 1) {
            const entry = index[i]
            if (typeof entry.seq !== 'number' || entry.seq > endSeq) continue
            if (startSeq !== undefined && entry.seq <= startSeq) return null
            return entry.payload
          }
          return null
        }, [index, endSeq, startSeq])

        // 节点形状对不上时的兜底：只在「这一轮没有任何可用序号」时启用，
        // 且仍然只挂最新一轮——绝不因为兜底把上一轮的建议顶上来。
        const unattributable = index.every((entry) => typeof entry.seq !== 'number')
        // 重启后节点重放认不出数据段时，用记下的那一份；键是轮次收尾 seq，
        // 所以只可能是"这一轮自己的建议"，不会把上一轮的顶上来。
        const stored = React.useMemo(
          () => (payload === null ? recallTail(sessionId, endSeq) : null),
          [payload, sessionId, endSeq],
        )
        const resolved = payload ?? stored ?? ((index.length === 0 || unattributable) && endSeq !== undefined && endSeq === latestEnd
          ? fallback.payload
          : null)

        React.useEffect(() => {
          if (payload !== null) rememberTail(sessionId, endSeq, payload)
        }, [payload, sessionId, endSeq])

        if (resolved === null || resolved.actions.length === 0) return null
        if (resolved.mode === 'latest' && latestEnd !== undefined && endSeq !== latestEnd) return null

        const items = resolved.actions
        const children = items.map((item, position) => {
          const tier = item.recommended === true ? VISIBLE_TIERS.rec : item.angle === 'stop' ? VISIBLE_TIERS.weak : VISIBLE_TIERS.normal
          const span = items.length === 1 || (items.length === 3 && position === 2)
          return h('button', {
            key: `${item.angle}:${position}`,
            type: 'button',
            className: 'dns-btn',
            'data-tier': tier,
            'data-state': sent === item.label ? 'sent' : undefined,
            style: span ? { gridColumn: '1 / -1' } : undefined,
            disabled: pending !== '' || sent !== '',
            /* 悬停提示：有更长的 prompt 就展示它，并总是补一句可操作说明（Shift+点击）。 */
            title: item.prompt !== undefined && item.prompt !== item.label
              ? item.prompt + String.fromCharCode(10) + t('hint')
              : t('hint'),
            onClick: (event) => {
              if (pending !== '' || sent !== '') return
              const text = item.prompt !== undefined ? item.prompt : item.label
              try {
                if (event.shiftKey) {
                  fillComposer(ctx, sessionId, text)
                  return
                }
                setFailure('')
                setPending(item.label)
                let attempt
                try {
                  attempt = sendAsUser(ctx, sessionId, text)
                } catch (error) {
                  setPending('')
                  setFailure(error instanceof Error ? error.message : String(error))
                  return
                }
                // 只有真的提交成功才锁按钮；失败就把按钮释放，让用户能重试。
                attempt.then((result) => {
                  setPending('')
                  if (result !== undefined && result !== null && result.ok === true) {
                    setSent(item.label)
                    return
                  }
                  setFailure(String(result === undefined || result === null ? 'submit failed' : result.error ?? 'submit failed'))
                }).catch((error) => {
                  setPending('')
                  setFailure(error instanceof Error ? error.message : String(error))
                })
              } catch (error) {
                setPending('')
                setFailure(error instanceof Error ? error.message : String(error))
              }
            },
          }, h('span', { className: 'dns-label' }, item.label))
        })

        if (failure !== '') {
          children.push(h('p', { key: 'failure', className: 'dns-error' }, `${t('sendFailed')}${failure}`))
        }

        return h('div', {
          className: 'dns-root',
          'data-tool': 'suggest_actions',
          role: 'group',
          'aria-label': t('group.label'),
        },
          h('div', { className: 'dns-grid' }, children))
      }
    }

    const zh = {
      sendFailed: '没发出去：',
      hint: '点击发送，Shift+点击只填入输入框',
      'group.label': '下一步建议',
    }
    const en = {
      sendFailed: 'Could not send: ',
      hint: 'Click to send, Shift+click to fill the composer',
      'group.label': 'Next steps',
    }

    return {
      name: 'dsh-next-steps',
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => installStyles(ctx) ?? undefined, 'dsh-next-steps: styles')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-next-steps: dictionaries')
        const bound = ctx.locale.bind(NS)
        const t = (key) => {
          const value = bound(key)
          return value === key ? zh[key] ?? key : value
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'suggest_actions',
        }, Capture))
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'next-steps',
          inject: (sessionId) => ({ sessionId }),
        }, createTail(ctx, t)))
      },
    }
  },
})
