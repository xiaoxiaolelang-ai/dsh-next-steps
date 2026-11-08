import fs from 'node:fs'
const p = 'index.js'
let s = fs.readFileSync(p, 'utf8')
const done = []
const rep = (from, to, label) => {
  if (!s.includes(from)) throw new Error('anchor missing: ' + label)
  s = s.replace(from, to)
  done.push(label)
}

// 1) 定义抽成常量，全局与作用域两种注册共用
rep(`  const definition = {
    name: 'next_steps',`, `  const definition = {
    name: 'next_steps',`, 'noop')

rep(`    async execute(args, exec) {
      const actions = normalizeActions(args?.actions, maxActions)
      recordActions(sessionIdOf(exec), actions, history)
      return { shown: actions.length > 0 }
    },
  })
  let visible = 'n/a'`, `    async execute(args, exec) {
      const actions = normalizeActions(args?.actions, maxActions)
      recordActions(sessionIdOf(exec), actions, history)
      return { shown: actions.length > 0 }
    },
  }

  try {
    ctx.tools.register(definition)
    let visible = 'n/a'`, '全局注册用常量')

// 2) 每个 Agent 的作用域里再注册一份（作用域注册不受全局限制影响）
rep(`  // 放在工具注册之后：注册顺序是这次二分实验里唯一的变量。
  if (typeof installRoute === 'function') installRoute(ctx)
}`,
`  /* 关键：全局层只有我们这一个工具（探针 defs=1），而 Agent 能看到的 153 个工具
     全部来自各自的作用域。所以只注册全局是不够的——同时注册进每个 Agent 的
     作用域，作用域注册不受全局限制影响，也一定出现在该 Agent 的工具集里。 */
  const registeredAgents = new WeakSet()
  try {
    ctx.on('agent/created', function onAgentCreated(payload) {
      try {
        const agent = payload === undefined || payload === null ? undefined : payload.agent
        if (agent === undefined || agent === null) return
        if (registeredAgents.has(agent)) return
        const scopedTools = agent.ctx === undefined || agent.ctx === null ? undefined : agent.ctx.tools
        if (scopedTools === undefined || scopedTools === null || typeof scopedTools.register !== 'function') return
        registeredAgents.add(agent)
        scopedTools.register(definition)
        reportLoad('scoped', 'registered')
      } catch (error) {
        reportLoad('scoped', 'failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    })
  } catch (error) {
    reportLoad('scoped', 'listen-failed: ' + (error instanceof Error ? error.message : String(error)))
  }

  // 放在工具注册之后：注册顺序是这次二分实验里唯一的变量。
  if (typeof installRoute === 'function') installRoute(ctx)
}`, '按 Agent 注册')

fs.writeFileSync(p, s)
console.log('applied:', done.join(' | '))
