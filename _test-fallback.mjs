/**
 * 兜底生成自检：模型没调用时，宿主用这一轮的正文生成建议。
 * 不依赖真实模型：llm.stream 是假的，session 是假的。
 */
import assert from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 测试写日志要隔离，别污染真实的 turn.log
process.env.DSH_HOME = join(here, '_test-home')
const mod = await import('file://' + join(here, 'index.js').replace(/\\/g, '/'))

function makeSession(events) {
  return {
    id: 's-fallback',
    snapshotEvents: () => events,
    requestContext: () => ({ provider: 'deepseek', model: 'deepseek-flash' }),
  }
}
function makeChunks(text) {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}
const ctxWith = (llm) => ({ get: (key) => (key === 'llm' ? llm : undefined) })
const tick = () => new Promise((r) => setTimeout(r, 30))

{
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, data: { turn: 1, name: 'next_steps', arguments: '{}' } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'hi' }] } } },
  ]
  mod.maybeGenerate(ctxWith({ stream: () => { throw new Error('不该调用模型') } }), {}, { agent: { session: makeSession(events) }, turn: 1 })
  await tick()
  assert.equal(mod.fallbackActionsFor('s-fallback', 1), null, '调用过就不该生成')
  console.log('OK  本轮调用过：跳过生成')
}

{
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 2 } },
    { type: 'assistant/message', seq: 2, data: { turn: 2, message: { content: [{ type: 'text', text: '我修好了 X 文件的问题。' }] } } },
  ]
  let seen = null
  const llm = { stream: (options) => { seen = options; return makeChunks('[{"angle":"standard","label":"跑测试","prompt":"跑测试"}]') } }
  mod.maybeGenerate(ctxWith(llm), {}, { agent: { session: makeSession(events) }, turn: 2 })
  await tick()
  const actions = mod.fallbackActionsFor('s-fallback', 2)
  assert.ok(actions !== null && actions.length === 1, '必须生成一条')
  assert.equal(actions[0].label, '跑测试')
  assert.equal(seen.provider, 'deepseek', '用会话自己的 provider')
  assert.equal(seen.model, 'deepseek-flash', '用会话自己的 model')
  console.log('OK  没调用 + 有正文：生成成功，且用会话自己的 provider/model')
}

{
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 3 } },
    { type: 'assistant/message', seq: 2, data: { turn: 3, message: { content: [{ type: 'text', text: '正文' }] } } },
  ]
  mod.maybeGenerate(ctxWith({ stream: () => makeChunks('这不是 JSON') }), {}, { agent: { session: makeSession(events) }, turn: 3 })
  await tick()
  assert.equal(mod.fallbackActionsFor('s-fallback', 3), null, '非 JSON 不能存')
  console.log('OK  非 JSON：不写入')
}

{
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 4 } },
    { type: 'assistant/message', seq: 2, data: { turn: 4, message: { content: [] } } },
  ]
  mod.maybeGenerate({ get: () => undefined }, {}, { agent: { session: makeSession(events) }, turn: 4 })
  await tick()
  assert.equal(mod.fallbackActionsFor('s-fallback', 4), null)
  console.log('OK  没有 llm 服务：安静跳过')
}

assert.doesNotThrow(() => mod.maybeGenerate(null, null, null))
assert.doesNotThrow(() => mod.maybeGenerate({ get: () => undefined }, null, { agent: null }))
assert.doesNotThrow(() => mod.maybeGenerate({ get: () => undefined }, null, {}))
console.log('OK  参数异常：不抛错')

console.log('\nfallback checks passed')
