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
  'Two to four is the usual number; never pad. Omit `prompt` when the button text is already a sentence the user could send.',
  'This never waits for an answer: it returns immediately and your turn ends normally.',
].join(' ')

/** 常驻提示：让模型每轮都调用一次工具，而不是靠它自己记得。 */
const PROMPT_TEXT = [
  "End the reply with the `suggest_actions` tool. Every reply gets a call, except a bare acknowledgement with nothing left to do.",
  "Quality bar: each step must follow from the work of this turn — name the file, command, error or value you just touched, so it can be acted on without re-reading the conversation.",
  "Size: two to four steps is normal; if only one step is genuinely worth taking, return one. Never pad.",
  "Stances: at most one entry per stance, exactly one marked `recommended`.",
  "Fields: `label` is the action written in the conversation language as a complete instruction; `prompt` is the exact message the user would send, self-contained with paths and the detail a fresh turn needs; omit `prompt` only when `label` is already that message.",
  "Never: generic filler (continue, optimize further, check the docs), repeating work you just finished, or hedging (if you want, you could).",
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
      // 9899：几乎排到系统提示的最后——这条要求越靠近末尾，模型越不容易在中途"忘了收尾"。
      // 包一层：万一别的插件占了同名 section 或宿主 API 变了，也不能连累工具注册。
      try {
        ctx.effect(
          () => systemPrompt.section({ name: "next-steps", order: 9899, text: PROMPT_TEXT }),
          "dsh-next-steps: prompt section",
        )
      } catch {}

    }
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
            text: MARKER + '\n' + JSON.stringify({ rev: '0.1.3', mode: history, actions }),
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
