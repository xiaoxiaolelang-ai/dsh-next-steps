/**
 * 路由自检：PTC 会话拿不到顶层工具结果，只能通过这条 GET 路由把 actions 带到客户端。
 * 不碰会话投影、不碰会话事件——坏了最多是"没有按钮"。
 */
import assert from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import('file://' + join(here, 'index.js').replace(/\\/g, '/'))

let route = null
let tool = null
const ctx = {
  connection: { fetch: { register: (definition) => { route = definition; return () => { route = null } } } },
  get: () => undefined,
  effect: (fn) => fn(),
  tools: { register: (definition) => { tool = definition; return () => {} } },
  systemPrompt: { section: () => () => {} },
  locale: { register: () => () => {}, bind: () => (k) => k },
}

mod.apply(ctx)
assert.ok(route !== null, 'route must be registered')
assert.equal(route.path, '/api/dsh-next-steps/actions')
assert.deepEqual(route.methods, ['GET'])
console.log('OK  路由已注册：GET /api/dsh-next-steps/actions')

const actions = [{ angle: 'standard', label: '跑测试', prompt: '跑测试', recommended: true }]
const exec = { agent: { session: { id: 'sess-1' } } }
await tool.execute({ actions }, exec)

const answer = await route.fetch({ url: '/api/dsh-next-steps/actions?session=sess-1' })
assert.equal(answer.status, 200)
const body = await answer.json()
assert.equal(body.entries.length, 1, '记录必须按会话隔离')
assert.equal(body.entries[0].actions[0].label, '跑测试')
assert.equal(body.entries[0].mode, 'latest')
console.log('OK  execute 记录 → 路由按会话返回')

const other = await (await route.fetch({ url: '/api/dsh-next-steps/actions?session=sess-2' })).json()
assert.deepEqual(other.entries, [], '别的会话不能看到')
console.log('OK  会话隔离：其他会话拿到空数组')

const noQuery = await (await route.fetch({ url: '/api/dsh-next-steps/actions' })).json()
assert.deepEqual(noQuery.entries, [], '没有 session 参数时返回空，不抛错')
console.log('OK  缺参数：返回空数组，不抛错')

for (let i = 0; i < 25; i += 1) {
  await tool.execute({ actions: [{ angle: 'standard', label: '第' + i + '条', prompt: 'p' }] }, exec)
}
const bounded = await (await route.fetch({ url: '/api/dsh-next-steps/actions?session=sess-1' })).json()
assert.equal(bounded.entries.length, 20, '每个会话最多保留 20 条')
assert.equal(bounded.entries[19].actions[0].label, '第24条', '保留的是最近的')
console.log('OK  上限：每个会话最多 20 条，保留最近的')

// 没有 agent（独立服务调用）时不能抛
await assert.doesNotReject(() => tool.execute({ actions }, {}))
assert.equal((await (await route.fetch({ url: '/api/dsh-next-steps/actions?session=' })).json()).entries.length, 0)
console.log('OK  没有 agent 时：安静跳过，不抛错')

const legacy = { get: () => undefined, effect: (fn) => fn(), tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} } }
assert.equal(mod.installRoute(legacy), false, '没有 connection 服务时返回 false')
console.log('OK  没有 connection 服务：降级为 false')

console.log('\nroute checks passed')
