/**
 * 交互自检：点击发送、失败可重试、Shift+点击追加、无障碍标记。
 *
 * 与 _test-next-steps.mjs 的区别：那边用无状态的 hook shim 只验渲染结果，
 * 这里需要"点击 → 状态变化 → 再渲染"，所以用一个最小的有状态 useState。
 */
import fs from 'node:fs'
import assert from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(join(here, 'client.js'), 'utf8')
const MARKER = 'dsh-next-steps/v1'

// --- 有状态的最小 hook shim ---
let states = []
let cursor = 0
let dirty = false
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value ?? null }),
  // 同步执行 effect：tail 要靠它在 effect 里登记自己的收尾序号，
  // 否则 latestEnd 永远是 undefined，兜底通道不会启用。返回的清理函数在测试里忽略。
  useEffect: (fn) => { fn() },
  useSyncExternalStore: (_sub, get) => get(),
  useState: (init) => {
    const index = cursor
    cursor += 1
    if (!(index in states)) states[index] = typeof init === 'function' ? init() : init
    const set = (next) => {
      const value = typeof next === 'function' ? next(states[index]) : next
      if (value !== states[index]) {
        states[index] = value
        dirty = true
      }
    }
    return [states[index], set]
  },
}

let captured = null
const timers = []
globalThis.window = {
  __ModuleLoader__: { load: (entry) => { captured = entry } },
  setTimeout: (fn) => { timers.push(fn); return timers.length },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}
/** 让 Promise 回调（.then）先跑完：我们的 setTimeout 是假的，微任务队列得手动放行。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function flushTimers() {
  let guard = 0
  while (timers.length > 0 && guard < 200) {
    const fn = timers.shift()
    guard += 1
    fn()
  }
}
globalThis.document = { head: { appendChild() {} }, createElement: () => ({ dataset: {}, textContent: '' }) }

// --- 假 ctx：带 conversation 服务，可控制提交成功/失败 ---
const drafts = { value: '' }
const submits = []
let submitThrows = false
let submitAsyncReject = false
const shell = {
  state: { getSnapshot: () => ({ draft: drafts.value }) },
  actions: {
    setDraft: (text) => { drafts.value = text },
    submit: () => {
      if (submitThrows) throw new Error('composer rejected the submit')
      if (submitAsyncReject) return Promise.reject(new Error('async composer rejected'))
      submits.push(drafts.value)
      return undefined
    },
  },
  focus: () => {},
}
const ctx = {
  get: (key) => (key === 'conversation' ? { input: { shell: () => shell } } : undefined),
  effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: { inject: (_k, cb) => { cb() }, register: (o, c) => { ctx.__components[o.name ?? o.key] = c; return () => {} } },
  __components: {},
}

new Function('window', 'document', source)(globalThis.window, globalThis.document)
captured.factory((id) => { if (id === 'react') return React; throw new Error('unexpected require ' + id) }).apply(ctx)

const Tail = ctx.__components['conversation.chat.turnTail']
const Capture = ctx.__components['tool.call.toolview']
assert.equal(typeof Tail, 'function', 'tail registered')

function reset() {
  states = []
  cursor = 0
  dirty = false
}

/**
 * 渲染直到稳定。至少要跑两遍：tail 在 effect 里登记自己的收尾序号，
 * 第一遍渲染时 latestEnd 还是 undefined，第二遍才拿得到。
 */
function render(props) {
  let tree = null
  for (let pass = 0; pass < 2; pass += 1) {
    cursor = 0
    dirty = false
    tree = Tail(props)
  }
  let guard = 0
  while (dirty && guard < 20) {
    guard += 1
    cursor = 0
    dirty = false
    tree = Tail(props)
  }
  return tree
}

function buttonsOf(tree) {
  if (!tree) return []
  const grid = tree.children.find((c) => c && c.props && c.props.className === 'dns-grid')
  if (!grid) return []
  return grid.children.filter((c) => c && c.type === 'button')
}

function prepare(sessionId, label) {
  Capture({
    sessionId,
    callId: 'call-' + sessionId,
    block: { content: [{ type: 'text', text: MARKER + '\n' + JSON.stringify({ mode: 'all', actions: [{ angle: 'standard', label }] }) }] },
  })
  return { sessionId, seq: 60, turn: { start: { seq: 40 }, end: { seq: 60 } }, useChat: (sel) => sel({ order: [], nodes: new Map() }) }
}

// 1) 无障碍：根节点是一组建议，带本地化标题
reset()
const props1 = prepare('a11y', '跑一遍自检')
const tree1 = render(props1)
assert.equal(tree1.props.role, 'group', 'container must expose a group role')
assert.equal(tree1.props['aria-label'], '下一步建议', 'container must have a localized label')
console.log('OK  无障碍：role=group + aria-label')

// 2) Shift + 点击：追加到已有草稿，不覆盖、不发送
drafts.value = '我已经写了半句话'
submits.length = 0
const tree2 = render(props1)
buttonsOf(tree2)[0].props.onClick({ shiftKey: true })
flushTimers()
assert.equal(drafts.value, '我已经写了半句话\n跑一遍自检', 'shift+click must append, not overwrite')
assert.equal(submits.length, 0, 'shift+click must not send')
console.log('OK  Shift+点击：追加到已有草稿且不发送')

// 3) Shift + 点击（草稿为空）：直接填入
drafts.value = ''
const tree3 = render(props1)
buttonsOf(tree3)[0].props.onClick({ shiftKey: true })
flushTimers()
assert.equal(drafts.value, '跑一遍自检', 'empty draft must be filled directly')
console.log('OK  Shift+点击：空草稿直接填入')

// 4) 点击发送成功：提交一次、按钮锁定
drafts.value = ''
submits.length = 0
submitThrows = false
const tree4 = render(props1)
buttonsOf(tree4)[0].props.onClick({ shiftKey: false })
flushTimers()
await tick()
assert.equal(submits.length, 1, 'click must submit once')
assert.equal(submits[0], '跑一遍自检', 'submitted text must be the action prompt')
const afterSuccess = render(props1)
assert.equal(buttonsOf(afterSuccess)[0].props.disabled, true, 'after a successful send the buttons must lock')
console.log('OK  点击发送：提交一次并锁定按钮')

// 5) 提交失败：不锁按钮，并且显示失败原因（可重试）
reset()
const props5 = prepare('retry', '再试一次')
drafts.value = ''
submits.length = 0
submitThrows = true
const tree5 = render(props5)
buttonsOf(tree5)[0].props.onClick({ shiftKey: false })
flushTimers()
await tick()
const afterFailure = render(props5)
const buttonAfter = buttonsOf(afterFailure)[0]
assert.equal(buttonAfter.props.disabled, false, 'a failed send must leave the buttons usable')
// 失败提示和按钮在同一个 grid 里，不是 root 的直接子节点
const gridAfter = afterFailure.children.find((c) => c && c.props && c.props.className === 'dns-grid')
const errorNode = (gridAfter?.children ?? []).find((c) => c && c.props && c.props.className === 'dns-error')
assert.ok(errorNode, 'a failed send must surface the reason')
assert.ok(String(errorNode.children?.[0] ?? '').includes('composer rejected'), 'the failure text must carry the cause')
console.log('OK  提交失败：按钮可用且显示原因（可重试）')

// 6) 失败后重试成功：可以再点一次并提交
submitThrows = false
submits.length = 0
const tree6 = render(props5)
buttonsOf(tree6)[0].props.onClick({ shiftKey: false })
flushTimers()
await tick()
assert.equal(submits.length, 1, 'retry after failure must submit')
const afterRetry = render(props5)
assert.equal(buttonsOf(afterRetry)[0].props.disabled, true, 'retry success must lock the buttons')
console.log('OK  失败后重试：可再次点击并成功提交')

// 7) submit 返回被拒绝的 Promise：同样算失败，不能当成已发送
const props7 = prepare('async-reject', '异步提交会失败')
reset()
drafts.value = ''
submits.length = 0
submitAsyncReject = true
submitThrows = false
const tree7 = render(props7)
buttonsOf(tree7)[0].props.onClick({ shiftKey: false })
flushTimers()
await tick()
const afterAsync = render(props7)
assert.equal(buttonsOf(afterAsync)[0].props.disabled, false, 'an async submit rejection must not lock the buttons')
console.log('OK  异步 submit 被拒绝：也算失败，按钮可用')
submitAsyncReject = false


// 12) 宿主兜底通路：节点里没有 payload，GET 路由给了建议
let fbCalls = 0
globalThis.fetch = async (url) => {
  fbCalls += 1
  assert.ok(String(url).includes('/api/dsh-next-steps/actions?session='), '必须带上 session')
  return { ok: true, json: async () => ({ actions: [{ angle: 'standard', label: '来自兜底', prompt: '来自兜底' }] }) }
}
reset()
const propsFb = { sessionId: 'fb-1', seq: 200, turn: { start: { seq: 190 }, end: { seq: 200 } }, useChat: (sel) => sel({ order: [], nodes: new Map() }) }
render(propsFb)
await tick()
const treeFb = render(propsFb)
const buttonsFb = buttonsOf(treeFb)
assert.equal(fbCalls, 1, '只应拉一次')
assert.equal(buttonsFb.length, 1, '兜底有数据就要显示')
assert.equal(buttonsFb[0].children[0].children[0], '来自兜底')
console.log('OK  宿主兜底：最后一轮没有 payload 时也能显示')

delete globalThis.fetch

// 13) 兜底重试：前两次是空的（宿主还没生成完），第三次才有，最终必须显示
globalThis.__dnsRetryMs = 5
let tries = 0
globalThis.fetch = async () => {
  tries += 1
  const ready = tries >= 3
  return { ok: true, json: async () => ({ actions: ready ? [{ angle: 'standard', label: '重试后拿到', prompt: '重试后拿到' }] : [] }) }
}
reset()
const propsRetry = { sessionId: 'retry-1', seq: 300, turn: { start: { seq: 290 }, end: { seq: 300 } }, useChat: (sel) => sel({ order: [], nodes: new Map() }) }
render(propsRetry)
await new Promise((r) => setTimeout(r, 60))
const treeRetry = render(propsRetry)
const buttonsRetry = buttonsOf(treeRetry)
assert.equal(tries, 3, '前两次空 → 第三次拿到就停（实际调用 ' + tries + ' 次）')
assert.equal(buttonsRetry.length, 1, '重试成功必须显示')
assert.equal(buttonsRetry[0].children[0].children[0], '重试后拿到')
console.log('OK  兜底重试：空的会重试，拿到就停')

delete globalThis.fetch
delete globalThis.__dnsRetryMs

console.log('\naction checks passed')
