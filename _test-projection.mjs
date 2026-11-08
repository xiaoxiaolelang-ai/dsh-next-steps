/**
 * 会话投影自检：把 actions 从事件参数写进投影，两种调用形态都要覆盖。
 *
 * 这里同时钉住两条性能契约：
 *   1. 不相关的事件必须返回**同一个 state 引用**（宿主据此跳过重算）；
 *   2. 坏参数不能抛错、也不能改状态。
 */
import assert from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import('file://' + join(here, 'index.js').replace(/\\/g, '/'))

let captured = null
let disposed = false
const ctx = {
  get: (key) => {
    if (key === 'sessionProjections') return { register: (unit) => { captured = unit; return () => { disposed = true } } }
    return undefined
  },
  effect: (fn) => { const cleanup = fn(); return cleanup },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  locale: { register: () => () => {}, bind: () => (k) => k },
}

mod.apply(ctx)
assert.ok(captured !== null, 'projection unit must be registered')
assert.equal(captured.key, 'next-steps')
assert.equal(captured.stateVersion, 1)
console.log('OK  投影单元已注册：key=next-steps, stateVersion=1')

const actions = [
  { angle: 'standard', label: '跑一遍自检', prompt: '跑一遍自检', recommended: true },
  { angle: 'cautious', label: '只跑投影那块', prompt: '只跑投影那块的用例' },
]

// 1) native：tool/call，arguments 是字符串
let state = captured.init({ id: 's1' }, 0)
const afterNative = captured.apply(state, { type: 'tool/call', seq: 10, time: 1, data: { name: 'suggest_actions', arguments: JSON.stringify({ actions }) } })
assert.notEqual(afterNative, state, 'native 调用必须改变状态')
const view1 = captured.wire.view(afterNative)
assert.equal(view1.items.length, 1)
assert.equal(view1.items[0].seq, 10)
assert.equal(view1.items[0].actions.length, 2)
assert.equal(view1.items[0].actions.filter((a) => a.recommended === true).length, 1, '推荐项必须唯一')
console.log('OK  native tool/call：写入 1 条（2 个动作，推荐唯一）')

// 2) PTC：tool/ptc-dispatch，arguments 是对象
const afterPtc = captured.apply(afterNative, { type: 'tool/ptc-dispatch', seq: 20, time: 2, data: { name: 'suggest_actions', arguments: { actions } } })
const view2 = captured.wire.view(afterPtc)
assert.equal(view2.items.length, 2, 'PTC 调度也必须写入')
assert.equal(view2.items[1].seq, 20)
console.log('OK  PTC tool/ptc-dispatch：也写入 1 条')

// 3) 不相关事件：同一个 state 引用（性能契约）
for (const event of [
  { type: 'assistant/message', seq: 21, data: {} },
  { type: 'tool/call', seq: 22, data: { name: 'run_code', arguments: '{}' } },
  { type: 'user/message', seq: 23, data: {} },
]) {
  const next = captured.apply(afterPtc, event)
  assert.equal(next, afterPtc, '不相关事件必须原样返回 state：' + event.type)
}
console.log('OK  不相关事件：返回同一引用，不触发重算')

// 4) 坏参数：不抛、不改状态
for (const bad of [
  { type: 'tool/call', seq: 24, data: { name: 'suggest_actions', arguments: '{not json' } },
  { type: 'tool/call', seq: 25, data: { name: 'suggest_actions', arguments: '{}' } },
  { type: 'tool/ptc-dispatch', seq: 26, data: { name: 'suggest_actions', arguments: { actions: [] } } },
  { type: 'tool/call', seq: 27, data: {} },
]) {
  const next = captured.apply(afterPtc, bad)
  assert.equal(next, afterPtc, '坏参数必须原样返回：' + JSON.stringify(bad.data))
}
console.log('OK  坏参数 / 空 actions：不抛错、不改状态')

// 5) 上限：超过 200 条只保留最近 200 条
let bounded = afterPtc
for (let i = 0; i < 250; i += 1) {
  bounded = captured.apply(bounded, { type: 'tool/call', seq: 1000 + i, data: { name: 'suggest_actions', arguments: JSON.stringify({ actions }) } })
}
const view3 = captured.wire.view(bounded)
assert.equal(view3.items.length, 200, '投影必须封顶 200 条')
assert.equal(view3.items[199].seq, 1249, '保留的是最近的')
console.log('OK  上限：250 次写入后只保留最近 200 条')

// 6) 宿主没有这个服务时：降级为 false，不抛
const legacy = { get: () => undefined, effect: (fn) => { fn() }, tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} } }
assert.doesNotThrow(() => mod.apply(legacy), '缺少 sessionProjections 时必须安稳降级')
assert.equal(typeof mod.installProjection, 'function')
assert.equal(mod.installProjection(legacy, 4), false, '没有服务时 installProjection 返回 false')
console.log('OK  旧宿主降级：无 sessionProjections 时不注册也不抛')

// 7) 回归：宿主会直接调 stateSchema.parse / viewSchema.parse —— 缺了就是整段会话加载失败
assert.ok(captured.stateSchema !== undefined && typeof captured.stateSchema.parse === 'function', 'unit 必须带 stateSchema.parse')
assert.ok(captured.wire.viewSchema !== undefined && typeof captured.wire.viewSchema.parse === 'function', 'wire 必须带 viewSchema.parse')
assert.doesNotThrow(() => captured.stateSchema.parse({ items: [], mode: 'latest' }))
assert.doesNotThrow(() => captured.wire.viewSchema.parse(captured.wire.view(afterPtc)))
const repaired = captured.stateSchema.parse({ garbage: true })
assert.deepEqual(repaired.items, [], '坏状态必须被修成合法空状态')
assert.ok(repaired.mode === 'latest' || repaired.mode === 'all', '修出来的状态必须带合法 mode')
console.log('OK  schema：宿主需要的 parse 都在，坏状态被修成合法空状态')

// 8) 开关：projection: off 时完全不注册
assert.equal(mod.installProjection(ctx, 4, 'latest', false), false, 'projection: off 必须跳过注册')
assert.equal(mod.installProjection(ctx, 4, 'latest', true), true, 'projection 开启时注册')
console.log('OK  开关：projection=off 时不注册（不必禁用整个插件）')

console.log('\nprojection checks passed')
