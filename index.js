/**
 * 下一步建议（dsh-next-steps）—— Host 半边。
 *
 * 只做一件事：注册 `suggest_actions` 工具。模型调它，参数里带 2-4 条建议，
 * 工具立刻返回，这一轮正常结束——不等人、不打断。
 *
 * 为什么不 import 宿主的包：本插件以**本地目录**安装，模块解析从插件目录
 * 往上走，拿不到 dsh 安装目录里的 @deepseek-ai/*。所以这里只用明文 JSON
 * Schema 直接注册，零依赖；排序/去重/截断也在这里算一次，客户端照抄。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 探针日志：只写 DSH_HOME/dsh-next-steps/turn.log。
 * 目的是确认 agent/turn-stopping 真的会在轮次关闭前触发、能拿到 agent 与 turn，
 * 以及本轮有没有调用过 next_steps。
 */
function reportTurn(stage, detail) {
  try {
    const home = process.env.DSH_HOME === undefined || process.env.DSH_HOME === '' ? join(homedir(), '.dsh') : process.env.DSH_HOME
    const file = join(home, 'dsh-next-steps', 'turn.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), stage, detail }) + '\n')
  } catch {
    // 探针不能影响插件
  }
}

/** 宿主侧兜底：模型没调用时，用它自己这一轮的正文生成建议。 */
const FALLBACK_SYSTEM = [
  'You generate the "next steps" buttons shown under an assistant reply.',
  'Return ONLY a JSON array, no prose, no code fence. Each item: {"angle","label","prompt","recommended"}.',
  'angle is one of: cautious, standard, bold, alternative, stop. At most one item has "recommended": true.',
  'The first item is the next action of the current work. If that action happens outside the chat, phrase the item as the message the user sends afterwards.',
  'Ground each item in the turn you are given: name the file, command, error or value involved.',
  'One real item beats four padded ones. Never repeat finished work, never ask the user to confirm something already confirmed.',
].join(' ')

const generatedByTurn = new Map()

const name = 'dsh-next-steps'
const inject = ['tools']

/** 客户端按这个前缀认领数据段；换版本就换前缀，旧客户端会自然忽略。 */
const MARKER = 'dsh-next-steps/v1'
const ANGLES = ['cautious', 'standard', 'bold', 'alternative', 'stop']
const MAX_ACTIONS = 4

const description = [
  'Show the user up to four clickable next-step suggestions under your reply.',
  'Clicking one sends its text as the user\'s next message, so phrase each as the action it performs.',
  'Give them in the order you want them read: the single `recommended` entry is moved to the first cell of a 2x2 grid.',
  'Use at most one entry per stance, chosen from: cautious (smaller step, verify first), standard (the sensible move),',
  'bold (push the same route harder), alternative (a different route — the current approach is given up), stop (this need not be done at all).',
  'Call it at the end of every reply, after the prose.',
  'Two to four is the usual number; never pad. Omit `prompt` when the button text is already a sentence the user could send.',
  'This never waits for an answer: it returns immediately and your turn ends normally.',
].join(' ')

/** 常驻提示：让模型每轮都调用一次工具，而不是靠它自己记得。 */
const PROMPT_TEXT = [
  "End the reply with the `suggest_actions` tool. Every reply gets a call, except a bare acknowledgement.",
  "A turn that only ran tools still counts: the reply is what you write after them, so it ends with a call too.",
  "The first item is the next action and carries `recommended`: what the user would do next if they only said continue. Never restate finished work.",
  "If that action happens outside the chat, write the item as the message the user sends afterwards, not as an instruction.",
  "Ground each item in this turn: name the file, command, error or value involved. One real item beats four padded ones.",
  "`label` is the action in the conversation language; `prompt` is the exact message to send, with the detail a fresh turn needs.",
  "No generic filler; never ask to confirm what is already confirmed.",
].join(" ")

const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['actions'],
  properties: {
    actions: {
      type: 'array',
      description: 'Suggestions rendered as a 2x2 grid under the reply. The recommended entry is moved to the first cell.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['angle', 'label'],
        properties: {
          angle: {
            type: 'string',
            enum: ANGLES,
            description: 'cautious | standard | bold | alternative | stop. Never repeat a stance.',
          },
          label: { type: 'string', description: 'Button text the user reads. Short and concrete.' },
          prompt: { type: 'string', description: 'Text sent when clicked. Defaults to the label.' },
          recommended: { type: 'boolean', description: 'Set true on the single suggestion you recommend most.' },
        },
      },
    },
  },
}

/**
 * 清洗：过滤非法/空标签、按立场去重、只保留一个推荐、推荐置顶、stop 沉底、
 * 截断到上限。纯函数，顺序完全确定，客户端不需要再算一次。
 */
function normalizeActions(raw, max) {
  const limit = Number.isInteger(max) && max > 0 ? Math.min(max, MAX_ACTIONS) : MAX_ACTIONS
  const seen = new Set()
  const items = []
  let recommended = false

  for (const candidate of Array.isArray(raw) ? raw : []) {
    if (candidate === null || typeof candidate !== 'object') continue
    const angle = String(candidate.angle ?? '')
    if (!ANGLES.includes(angle) || seen.has(angle)) continue
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : ''
    if (label === '') continue
    seen.add(angle)
    const item = { angle, label }
    const prompt = typeof candidate.prompt === 'string' ? candidate.prompt.trim() : ''
    if (prompt !== '') item.prompt = prompt
    if (candidate.recommended === true && !recommended) {
      item.recommended = true
      recommended = true
    }
    items.push(item)
  }

  const head = items.filter((item) => item.recommended === true)
  const tail = items.filter((item) => item.recommended !== true && item.angle === 'stop')
  const middle = items.filter((item) => item.recommended !== true && item.angle !== 'stop')
  return [...head, ...middle, ...tail].slice(0, limit)
}

function apply(ctx, config) {
  const rawMax = Number(config?.maxActions)
  const maxActions = Number.isInteger(rawMax) && rawMax > 0 ? rawMax : MAX_ACTIONS
  const history = config?.history === 'all' ? 'all' : 'latest'

  if (typeof installRoute === 'function') installRoute(ctx)

  const promptMode = config?.prompt === "off" ? "off" : "always"
  if (promptMode === "always") {
    const systemPrompt = ctx.get("systemPrompt")
    if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.section === "function") {
      // 10250：宿主内置段的最大顺序是 10200（DEPLOYMENT_PERSONA_SUFFIX），
      // 所以用 10250 能排到整段系统提示的**最后**。原来的 9899 后面还跟着
      // STRUCTURED_OUTPUT / HARNESS_SOURCE / WEB_SURFACE 等段（实测只占 73% 位置），
      // 收尾要求被埋在中段，是漏调用的直接原因。
      // 包一层：万一别的插件占了同名 section 或宿主 API 变了，也不能连累工具注册。
      try {
        ctx.effect(
          () => systemPrompt.section({ name: "next-steps", order: 10250, text: PROMPT_TEXT }),
          "dsh-next-steps: prompt section",
        )
      } catch {}

    }
  }

  function pickEmitter(candidate) {
    if (candidate === undefined || candidate === null) return null
    if (typeof candidate.on === 'function') return candidate
    if (candidate.root !== undefined && candidate.root !== null && typeof candidate.root.on === 'function') return candidate.root
    if (candidate.scope !== undefined && candidate.scope !== null && typeof candidate.scope.on === 'function') return candidate.scope
    return null
  }

  reportTurn('ctx-shape', JSON.stringify({
    on: typeof ctx.on,
    effect: typeof ctx.effect,
    tools: typeof (ctx.tools ?? null),
    get: typeof ctx.get,
    hasRoot: ctx.root !== undefined && ctx.root !== null,
    rootOn: ctx.root === undefined || ctx.root === null ? 'n/a' : typeof ctx.root.on,
  }))

  const emitter = pickEmitter(ctx)
  try {
    if (emitter === null) throw new Error('no emitter on ctx/root/scope')
    emitter.on('agent/turn-stopping', function onTurnStopping(payload) {
      try {
        const agent = payload === undefined || payload === null ? undefined : payload.agent
        if (config?.fallback !== 'off') maybeGenerate(ctx, config, payload)
        reportTurn('turn-stopping', JSON.stringify({
          keys: payload === undefined || payload === null ? [] : Object.keys(payload),
          turn: payload === undefined || payload === null ? null : payload.turn,
          sessionId: agent === undefined || agent === null ? null : agent.id ?? agent.session?.id ?? null,
          scopedThis: this !== undefined && this !== null,
        }))
      } catch (error) {
        reportTurn('turn-stopping-error', error instanceof Error ? error.message : String(error))
      }
    })
    reportTurn('listener', 'registered')
  } catch (error) {
    reportTurn('listener', 'failed: ' + (error instanceof Error ? error.message : String(error)))
    // 再试几次：有些上下文要晚一点才具备事件能力
    let tries = 0
    const timer = setInterval(() => {
      tries += 1
      const late = pickEmitter(ctx)
      if (late !== null) {
        clearInterval(timer)
        try {
          late.on('agent/turn-stopping', function onTurnStopping(payload) {
            try {
              if (config?.fallback !== 'off') maybeGenerate(ctx, config, payload)
              reportTurn('turn-stopping-late', 'ok')
            } catch {}
          })
          reportTurn('listener', 'registered-late attempt=' + tries)
        } catch (error2) {
          reportTurn('listener', 'late-failed: ' + (error2 instanceof Error ? error2.message : String(error2)))
        }
        return
      }
      if (tries >= 20) clearInterval(timer)
    }, 1500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  ctx.tools.register({
    name: 'suggest_actions',
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['shown'],
        properties: { shown: { type: 'boolean' } },
      },
      render: (args) => {
        const actions = normalizeActions(args?.actions, maxActions)
        return [
          {
            type: 'text',
            text: actions.length > 0
              ? 'Suggestions are visible to the user under your reply.'
              : 'No suggestions were shown: every entry was missing a usable label.',
          },
          {
            // 这一段只给客户端读：插件配置在客户端拿不到，上限与模式跟着这份算好的
            // 结果一起送达，规则因此只有一份。用户看不见——工具卡片被客户端接管。
            type: 'text',
            text: MARKER + '\n' + JSON.stringify({ rev: '0.1.18', mode: history, actions }),
          },
        ]
      },
    },
    async execute(args) {
      return { shown: normalizeActions(args?.actions, maxActions).length > 0 }
    },
  })
}

/**
 * 宿主侧兜底：模型这一轮没调用 next_steps 时，用这一轮的正文生成。
 * 不阻塞轮次关闭（不 await），失败只记日志。
 */
function maybeGenerate(ctxRef, configRef, payload) {
  try {
    const agent = payload === undefined || payload === null ? undefined : payload.agent
    const session = agent === undefined || agent === null ? undefined : agent.session
    if (session === undefined || session === null) return
    const turn = payload.turn
    if (!Number.isInteger(turn)) return
    const llm = typeof ctxRef.get === 'function' ? ctxRef.get('llm') : undefined
    if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
      reportTurn('fallback', 'no-llm')
      return
    }
    // 这一轮有没有调用过工具？
    let called = false
    try {
      for (const event of session.snapshotEvents()) {
        if (event.type === 'turn/start') called = false
        if (event.type === 'turn/end' && event.data?.turn === turn) break
        if (event.type === 'tool/call' && event.data?.name === 'next_steps') called = true
      }
    } catch {}
    if (called) {
      reportTurn('fallback', 'skip-called ' + turn)
      return
    }
    // 这一轮的正文
    let text = ''
    try {
      for (const event of session.snapshotEvents()) {
        if (event.type !== 'assistant/message') continue
        if (event.data?.turn !== turn) continue
        for (const block of event.data?.message?.content ?? []) {
          if (block !== null && block !== undefined && block.type === 'text') text += String(block.text ?? '')
        }
      }
    } catch {}
    if (text.trim() === '') {
      reportTurn('fallback', 'skip-empty ' + turn)
      return
    }
    let route = null
    try { route = session.requestContext() } catch {}
    const provider = route?.provider ?? configRef?.provider
    const model = route?.model ?? configRef?.model
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      reportTurn('fallback', 'no-route ' + turn)
      return
    }
    const started = Date.now()
    void (async () => {
      try {
        let raw = ''
        const stream = llm.stream({
          provider,
          model,
          maxTokens: 600,
          temperature: 0.3,
          system: FALLBACK_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: text.slice(-6000) }] }],
          sessionId: session.id,
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') raw += chunk.text
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
            reportTurn('fallback', 'stream-error ' + turn + ' ' + chunk.reason.failure.message)
            return
          }
        }
        const start = raw.indexOf('[')
        const end = raw.lastIndexOf(']')
        if (start < 0 || end <= start) {
          reportTurn('fallback', 'no-json ' + turn)
          return
        }
        let parsed = null
        try { parsed = JSON.parse(raw.slice(start, end + 1)) } catch { parsed = null }
        const actions = normalizeActions(parsed, 4)
        if (actions.length === 0) {
          reportTurn('fallback', 'no-actions ' + turn)
          return
        }
        const perSession = generatedByTurn.get(session.id) ?? new Map()
        perSession.set(turn, actions)
        if (perSession.size > 40) {
          const oldest = perSession.keys().next()
          if (oldest.done !== true) perSession.delete(oldest.value)
        }
        generatedByTurn.set(session.id, perSession)
        reportTurn('fallback', 'generated turn=' + turn + ' n=' + actions.length + ' ms=' + (Date.now() - started))
      } catch (error) {
        reportTurn('fallback', 'failed ' + turn + ' ' + (error instanceof Error ? error.message : String(error)))
      }
    })()
  } catch (error) {
    reportTurn('fallback', 'outer-failed ' + (error instanceof Error ? error.message : String(error)))
  }
}

const ACTIONS_PATH = '/api/dsh-next-steps/actions'

/** 某个会话最近一轮的兜底结果（客户端只知道“最后一轮”，不知道轮次号）。 */
function latestFallback(sessionId) {
  const perSession = generatedByTurn.get(sessionId)
  if (perSession === undefined || perSession.size === 0) return null
  let bestTurn = -1
  let best = null
  for (const [turn, actions] of perSession) {
    if (turn > bestTurn && Array.isArray(actions) && actions.length > 0) {
      bestTurn = turn
      best = actions
    }
  }
  return best
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

let routeInstalled = false

/** 注册 GET 路由；宿主没有 connection 服务就返回 false。失败不影响工具。 */
function installRoute(ctx) {
  if (routeInstalled) return false
  const connection = ctx.connection ?? (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
  const fetchService = connection === undefined || connection === null ? undefined : connection.fetch
  if (fetchService === undefined || fetchService === null || typeof fetchService.register !== 'function') return false
  routeInstalled = true
  try {
    ctx.effect(() => fetchService.register({
      path: ACTIONS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const url = new URL(String(request?.url ?? ACTIONS_PATH), 'http://dsh.local')
          const sessionId = url.searchParams.get('session') ?? ''
          const actions = latestFallback(sessionId)
          reportTurn('route-hit', 'session=' + sessionId.slice(0, 24) + ' n=' + (actions === null ? 0 : actions.length))
          return jsonResponse({ actions: actions === null ? [] : actions })
        } catch {
          return jsonResponse({ actions: [] })
        }
      },
    }), 'dsh-next-steps: actions route')
    reportTurn('route', 'registered')
    return true
  } catch (error) {
    reportTurn('route', 'failed: ' + (error instanceof Error ? error.message : String(error)))
    return false
  }
}

/** 供路由与测试读取：某个会话某一轮的兜底结果。 */
function fallbackActionsFor(sessionId, turn) {
  const perSession = generatedByTurn.get(sessionId)
  if (perSession === undefined) return null
  const actions = perSession.get(turn)
  return Array.isArray(actions) && actions.length > 0 ? actions : null
}

export { apply, fallbackActionsFor, inject, installRoute, latestFallback, maybeGenerate, name, normalizeActions }
