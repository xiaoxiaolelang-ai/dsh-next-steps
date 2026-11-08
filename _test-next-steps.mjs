import fs from 'node:fs'
import assert from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(join(here, 'client.js'), 'utf8')
const MARKER = 'dsh-next-steps/v1'

// --- 极简 hook shim：同步渲染一次 ---
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
  useMemo: (fn) => fn(),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { fn() },
  useSyncExternalStore: (_sub, get) => get(),
  useCallback: (fn) => fn,
}

let captured = null
const memory = new Map()
const memoryWrites = { count: 0 }
globalThis.window = {
  __ModuleLoader__: { load: (entry) => { captured = entry } },
  setTimeout: () => 0,
  localStorage: {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => { memory.set(key, String(value)); memoryWrites.count += 1 },
    removeItem: (key) => { memory.delete(key) },
  },
}
// 在第一次渲染之前就塞好，插件的内存镜像只会读一次
memory.set('dsh-next-steps:tails:v1', JSON.stringify({
  're|40': { mode: 'latest', actions: [{ angle: 'standard', label: 'R1' }] },
}))
globalThis.document = { head: { appendChild() {} }, createElement: () => ({ dataset: {}, textContent: '' }) }
new Function('window', 'document', source)(globalThis.window, globalThis.document)

const components = {}
const fakeCtx = {
  get: () => undefined,
  effect: (fn) => (typeof fn === 'function' ? fn() : undefined),
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: {
    inject: (_key, cb) => { cb() },
    register: (options, component) => { components[options.name ?? options.key] = component; return () => {} },
  },
}
const mod = captured.factory((id) => { if (id === 'react') return React; throw new Error('unexpected require ' + id) })
mod.apply(fakeCtx)
const Tail = components['conversation.chat.turnTail']
assert.ok(typeof Tail === 'function', 'tail registered')

function payload(seq, actions, mode = 'latest') {
  return { anchorSeq: seq, data: { content: [{ type: 'text', text: MARKER + '\n' + JSON.stringify({ rev: 't', mode, actions }) }] } }
}
const mk = (entries) => {
  const map = new Map()
  for (const [seq, actions, mode] of entries) map.set('n' + seq, payload(seq, actions, mode))
  return { order: [...map.keys()], nodes: map }
}
/** React 会在 effect 登记“最新收尾号”后重渲一次；shim 不会,所以手动渲染两遍。 */
function settled(props) { Tail(props); return Tail(props) }
function labelsOf(tree) {
  if (!tree) return null
  const grid = tree.children.find((c) => c && c.props && c.props.className === 'dns-grid')
  if (!grid) return null
  return grid.children.filter((c) => c && c.type === 'button')
    .map((c) => ({ label: c.children[0].children[0], tier: c.props['data-tier'], span: c.props.style?.gridColumn ?? null }))
}
const turnA = { start: { seq: 10 }, end: { seq: 20 } }
const turnB = { start: { seq: 20 }, end: { seq: 40 } }
const turnC = { start: { seq: 40 }, end: { seq: 60 } }

// 1) A 轮：只看到自己的两条；顺序与强调由 host 决定（这里原样透传）
const snapA = mk([[15, [{ angle: 'standard', label: 'A1' }, { angle: 'recommended-ish', label: 'A2', recommended: true }]]])
const labelsA = labelsOf(settled({ sessionId: 's', seq: 20, turn: turnA, useChat: (sel) => sel(snapA) }))
assert.deepEqual(labelsA, [
  { label: 'A1', tier: 'normal', span: null },
  { label: 'A2', tier: 'rec', span: null },
], 'A 轮只显示自己的两条，recommended 用强调档')
console.log('OK  A 轮:', JSON.stringify(labelsA))

// 2) 同一会话的 B 轮：只看到自己那三条，stop 走弱档并独占末行
const snapB = mk([
  [15, [{ angle: 'standard', label: 'A1' }]],
  [35, [{ angle: 'standard', label: 'B1' }, { angle: 'cautious', label: 'B2' }, { angle: 'stop', label: 'B3' }]],
])
const labelsB = labelsOf(settled({ sessionId: 's', seq: 40, turn: turnB, useChat: (sel) => sel(snapB) }))
assert.deepEqual(labelsB, [
  { label: 'B1', tier: 'normal', span: null },
  { label: 'B2', tier: 'normal', span: null },
  { label: 'B3', tier: 'weak', span: '1 / -1' },
], 'B 轮只显示自己的三条，stop 弱档独占末行')
console.log('OK  B 轮:', JSON.stringify(labelsB))

// 3) C 轮没调用工具 → 无按钮，不回显上一轮
assert.equal(settled({ sessionId: 's', seq: 60, turn: turnC, useChat: (sel) => sel(snapB) }), null, 'C 轮无建议')
console.log('OK  C 轮（没调用工具）：null')

// 4) latest 模式：历史轮次不渲染
assert.equal(settled({ sessionId: 's', seq: 20, turn: turnA, useChat: (sel) => sel(snapB) }), null, 'latest 模式隐藏历史轮')
console.log('OK  latest 模式隐藏历史轮')

// 5) all 模式：各轮各自保留
const snapAll = mk([
  [15, [{ angle: 'standard', label: 'A1', recommended: true }], 'all'],
  [35, [{ angle: 'standard', label: 'B1' }], 'all'],
])
assert.deepEqual(labelsOf(settled({ sessionId: 's', seq: 20, turn: turnA, useChat: (sel) => sel(snapAll) })),
  [{ label: 'A1', tier: 'rec', span: '1 / -1' }], 'all 模式 A 轮保留自己的')
assert.deepEqual(labelsOf(settled({ sessionId: 's', seq: 40, turn: turnB, useChat: (sel) => sel(snapAll) })),
  [{ label: 'B1', tier: 'normal', span: '1 / -1' }], 'all 模式 B 轮保留自己的')
console.log('OK  all 模式：各轮互不串台')

// 6) 单条 → 整宽
const snapOne = mk([[15, [{ angle: 'standard', label: 'only', recommended: true }], 'all']])
assert.deepEqual(labelsOf(settled({ sessionId: 's', seq: 20, turn: turnA, useChat: (sel) => sel(snapOne) })),
  [{ label: 'only', tier: 'rec', span: '1 / -1' }], '单条独占整行')
console.log('OK  单条独占整行')

// 7) 兜底通道：节点形状认不出来时，采集器只喂最新一轮
const Capture = components['tool.call.toolview']
Capture({ sessionId: 's', callId: 'c1', block: { content: [{ type: 'text', text: MARKER + '\n' + JSON.stringify({ mode: 'latest', actions: [{ angle: 'standard', label: 'FB' }] }) }] } })
const empty = { order: [], nodes: new Map() }
const fbLatest = labelsOf(settled({ sessionId: 's', seq: 60, turn: turnC, useChat: (sel) => sel(empty) }))
assert.deepEqual(fbLatest, [{ label: 'FB', tier: 'normal', span: '1 / -1' }], '兜底：最新一轮拿到采集值')
const fbHistoric = settled({ sessionId: 'fb', seq: 20, turn: turnA, useChat: (sel) => sel(empty) })
assert.equal(fbHistoric, null, '兜底：历史轮次不渲染')
// 8) 会话隔离：另一个会话更大的 seq 不能把本会话的「最新一轮」判定带偏
const snapS2 = mk([[15, [{ angle: 'standard', label: 'S2' }]]])
const s2 = labelsOf(settled({ sessionId: 's2', seq: 20, turn: turnA, useChat: (sel) => sel(snapS2) }))
assert.deepEqual(s2, [{ label: 'S2', tier: 'normal', span: '1 / -1' }], '另一个会话不受本会话最大 seq 影响')
// 9) 缓存回归：节点店是同一个对象、只有 order 换了新数组时，必须重新索引
const liveStore = new Map([['n15', payload(15, [{ angle: 'standard', label: 'L1' }])]])
const order1 = ['n15']
const firstPass = labelsOf(settled({ sessionId: 'live', seq: 20, turn: turnA, useChat: (sel) => sel({ order: order1, nodes: liveStore }) }))
assert.deepEqual(firstPass, [{ label: 'L1', tier: 'normal', span: '1 / -1' }], 'live store: 第一轮读到 L1')
liveStore.set('n25', payload(25, [{ angle: 'standard', label: 'L2', recommended: true }]))
const order2 = ['n15', 'n25']
const secondPass = labelsOf(settled({ sessionId: 'live', seq: 30, turn: { start: { seq: 20 }, end: { seq: 30 } }, useChat: (sel) => sel({ order: order2, nodes: liveStore }) }))
assert.deepEqual(secondPass, [{ label: 'L2', tier: 'rec', span: '1 / -1' }], 'live store: 第二轮必须看到新条目 L2，而不是复用缓存')
console.log('OK  缓存不能只看 store（order 变了要重算）')

console.log('OK  会话隔离：s2 独立判定最新一轮')

console.log('OK  兜底通道：只有最新一轮')

// 10) 重启还原：节点重放认不出数据段时，用按轮次记下的那一份
const noNodes = { order: [], nodes: new Map() }
assert.deepEqual(
  labelsOf(settled({ sessionId: 're', seq: 40, turn: turnB, useChat: (sel) => sel(noNodes) })),
  [{ label: 'R1', tier: 'normal', span: '1 / -1' }],
  '重启后节点认不出数据段：按轮次还原出 R1',
)
console.log('OK  重启还原：按轮次记忆恢复 R1')

// 11) 还原不能串会话：别的会话同一 seq 的那份不能用
assert.equal(
  settled({ sessionId: 'other', seq: 40, turn: turnB, useChat: (sel) => sel(noNodes) }),
  null,
  '另一个会话不得复用 re 会话的建议',
)
console.log('OK  重启还原：不串会话')

// 12) 实时渲染时要顺手写进记忆，供下次重启用
const liveWrite = mk([[35, [{ angle: 'standard', label: 'W1' }]]])
settled({ sessionId: 'wr', seq: 40, turn: turnB, useChat: (sel) => sel(liveWrite) })
const savedAll = JSON.parse(memory.get('dsh-next-steps:tails:v1') ?? '{}')
assert.deepEqual(savedAll['wr|40']?.actions?.map((a) => a.label), ['W1'], '实时渲染后必须把本轮建议写进记忆')
console.log('OK  实时渲染写入轮次记忆')

// 13) 写入去重：同一轮内容没变时不能反复写盘（流式期间 tail 会反复重渲）
const snapDup = mk([[35, [{ angle: 'standard', label: 'D1' }]]])
const renderDup = () => settled({ sessionId: 'dup', seq: 40, turn: turnB, useChat: (sel) => sel(snapDup) })
renderDup()
const afterFirst = memoryWrites.count
renderDup()
renderDup()
assert.equal(memoryWrites.count, afterFirst, '同一轮重复渲染不得重复写 localStorage')
console.log('OK  写入去重：内容没变就不写盘')

console.log('\nall checks passed')
