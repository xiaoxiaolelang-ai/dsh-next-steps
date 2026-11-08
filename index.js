/**
 * 下一步建议（dsh-next-steps）—— Host 半边。
 *
 * 只做一件事：注册 `suggest_next_steps` 工具。模型调它，参数里带 2-4 条建议，
 * 工具立刻返回，这一轮正常结束——不等人、不打断。
 *
 * 为什么不 import 宿主的包：本插件以**本地目录**安装，模块解析从插件目录
 * 往上走，拿不到 dsh 安装目录里的 @deepseek-ai/*。所以这里只用明文 JSON
 * Schema 直接注册，零依赖；排序/去重/截断也在这里算一次，客户端照抄。
 */

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
  "End the reply with the `suggest_next_steps` tool. Every reply gets a call, except a bare acknowledgement.",
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

  ctx.tools.register({
    name: 'suggest_next_steps',
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
            text: MARKER + '\n' + JSON.stringify({ rev: '0.1.19', mode: history, actions }),
          },
        ]
      },
    },
    async execute(args) {
      return { shown: normalizeActions(args?.actions, maxActions).length > 0 }
    },
  })
}

export { apply, inject, name, normalizeActions }
