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
assert.equal(state.tool.name, 'suggest_actions')
assert.ok(state.tool.parameters && state.tool.parameters.type === 'object')
assert.equal(typeof state.tool.output.render, 'function')
assert.equal(typeof state.tool.execute, 'function')
console.log('OK  工具注册形状：parameters/output.render/execute 齐全')

// 2) 常驻指令：order 与文案
assert.ok(state.section, 'section registered')
assert.equal(state.section.name, 'next-steps')
assert.equal(state.section.order, 9500)
assert.ok(state.section.text.includes('suggest_actions'))
console.log('OK  常驻指令：order=9500，文案点名 suggest_actions')

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
