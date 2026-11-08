/**
 * 按 Agent 的作用域注册：全局层只有我们一个工具（实测 defs=1），而 Agent 能看到的
 * 工具全部来自各自作用域，所以必须再往每个 Agent 的作用域里注册一份。
 */
import assert from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import('file://' + join(here, 'index.js').replace(/\\/g, '/'))

let handler = null
let globalRegisters = 0
let scopedRegisters = 0
const ctx = {
  get: () => undefined,
  effect: (fn) => fn(),
  on: (name, fn) => { if (name === 'agent/created') handler = fn; return () => {} },
  tools: { register: () => { globalRegisters += 1; return () => {} } },
  systemPrompt: { section: () => () => {} },
}

mod.apply(ctx)
assert.ok(handler !== null, '必须监听 agent/created')
assert.equal(globalRegisters, 1, '全局注册一次')
console.log('OK  监听 agent/created，全局注册 1 次')

const scopedTools = { register: () => { scopedRegisters += 1; return () => {} } }
const agent = { id: 'a1', ctx: { tools: scopedTools } }
handler({ agent })
assert.equal(scopedRegisters, 1, '每个 Agent 注册一次')
console.log('OK  新 Agent 到来时，往它的作用域里注册一份')

handler({ agent })
assert.equal(scopedRegisters, 1, '同一个 Agent 重复触发不能再注册')
console.log('OK  幂等：同一个 Agent 只注册一次')

handler({})
handler({ agent: { id: 'a2' } })
handler(undefined)
assert.equal(scopedRegisters, 1, '没有 agent/ctx 时安静跳过')
console.log('OK  缺字段时安静跳过，不抛错')

const broken = { register: () => { throw new Error('boom') } }
assert.doesNotThrow(() => handler({ agent: { id: 'a3', ctx: { tools: broken } } }))
console.log('OK  作用域注册抛错被吞掉，不影响 Agent 创建')

console.log('\nscoped checks passed')
