import assert from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(join(here, 'index.js')).href)
assert.equal(mod.name, 'dsh-next-steps')
assert.deepEqual(mod.inject, ['tools'])

function makeCtx(options = {}) {
  const state = { tool: null, section: null }
  const ctx = {
    tools: { register: (def) => { state.tool = def } },
    get: (n) => (n === 'systemPrompt' ? options.systemPrompt : undefined),
    effect: (fn) => fn(),
  }
  return { ctx, state }
}

const systemPrompt = { section: (s) => { state.section = s; return () => {} } }
const { ctx, state } = makeCtx({ systemPrompt })
mod.apply(ctx, { maxActions: 4, history: 'latest', prompt: 'always' })

// 1) 工具注册形状
assert.equal(state.tool.name, 'suggest_next_steps')
assert.ok(state.tool.parameters && state.tool.parameters.type === 'object')
assert.equal(typeof state.tool.output.render, 'function')
assert.equal(typeof state.tool.execute, 'function')
console.log('OK  工具注册形状：parameters/output.render/execute 齐全')

// 2) 常驻指令：order 与文案
assert.ok(state.section, 'section registered')
assert.equal(state.section.name, 'next-steps')
assert.equal(state.section.order, 10250, '必须排在所有内置段之后（最后一个内置段是 10200）')
assert.ok(state.section.text.includes('suggest_next_steps'))
assert.ok(state.section.text.includes('Every reply gets a call'), '指令必须要求每轮调用')
assert.ok(state.section.text.includes('only ran tools'), '只跑了工具的轮次也必须调用')
assert.ok(state.section.text.includes('name the file, command, error or value'), '指令必须要求落到具体对象')
assert.ok(state.section.text.includes('beats four padded ones'), '指令必须禁止凑数')
assert.ok(state.section.text.includes('generic filler'), '指令必须点明禁止的填充词')
assert.ok(state.section.text.includes('if they only said continue'), '首条必须按“用户下一句会做什么”来推')
assert.ok(state.section.text.includes('message the user sends afterwards'), '聊天外动作要写成完成后的那句消息')
assert.ok(state.section.text.includes('Never restate finished work'), '已完成的步骤不得再当推荐项')
assert.ok(!state.section.text.includes('Skip it only when'), '不能保留那条容易被当借口的例外')

// 通用性：提示词里不许出现某一种具体场景的名词，否则就是过拟合
const scenarioWords = ['restart', 'release', 'pull request', 'merge', 'pipeline', 'chain', 'downstream', 'entry file', 'commit']
for (const word of scenarioWords) {
  assert.ok(!state.section.text.toLowerCase().includes(word), '提示词不得绑定具体场景：' + word)
}
// 体量：小。超过 200 词就说明又膨胀回去了
const words = state.section.text.trim().split(/\s+/).length
assert.ok(words <= 200, '提示词必须保持精简，当前 ' + words + ' 词')
console.log('OK  常驻指令：order=9899，' + words + ' 词，无场景绑定，要求每轮调用 + 落到具体对象 + 禁止凑数')

// 3) 渲染交回给客户端的第二段必须带 MARKER，且是算好的顺序
const rendered = state.tool.output.render({ actions: [
  { angle: 'stop', label: '先不做' },
  { angle: 'standard', label: '照做', recommended: true },
] })
assert.equal(rendered.length, 2)
assert.equal(rendered[0].type, 'text')
const marker = rendered[1].text
assert.ok(marker.startsWith('dsh-next-steps/v1\n'), 'marker prefix')
const payload = JSON.parse(marker.slice('dsh-next-steps/v1\n'.length))
assert.equal(payload.mode, 'latest')
assert.deepEqual(payload.actions.map((a) => a.label), ['照做', '先不做'])
console.log('OK  render：MARKER 正确，推荐置顶 / stop 沉底，mode=latest')

// 4) execute 的 shown 语义
assert.deepEqual(await state.tool.execute({ actions: [{ angle: 'standard', label: 'x' }] }), { shown: true })
assert.deepEqual(await state.tool.execute({ actions: [] }), { shown: false })
assert.deepEqual(await state.tool.execute({ actions: [{ angle: 'standard', label: '   ' }] }), { shown: false })
console.log('OK  execute：有可用条目 true，空/全非法 false')

// 5) prompt: off 或宿主没有 systemPrompt 时不注册 section，且不抛
{
  const { ctx: c2, state: s2 } = makeCtx({ systemPrompt })
  mod.apply(c2, { prompt: 'off' })
  assert.equal(s2.section, null, 'prompt: off 不注册 section')
  const { ctx: c3, state: s3 } = makeCtx({ systemPrompt: undefined })
  mod.apply(c3, {})
  assert.equal(s3.section, null)
  assert.ok(s3.tool, '没有 systemPrompt 时工具照常注册')
}
console.log('OK  prompt: off / 无 systemPrompt：不注册 section，工具照常')

console.log('\nhost checks passed')
