import fs from 'node:fs'
import assert from 'node:assert'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = fs.readFileSync(join(here, 'index.js'), 'utf8')
const start = src.indexOf('function normalizeActions')
assert.ok(start > 0, 'normalizeActions found')
const end = src.indexOf('\n}\n', start)
assert.ok(end > start, 'function body closed')
const body = src.slice(start, end + 3)
const ANGLES = ['cautious', 'standard', 'bold', 'alternative', 'stop']
const normalizeActions = new Function('ANGLES', 'MAX_ACTIONS', body + '\nreturn normalizeActions')(ANGLES, 4)

// 推荐置顶、stop 沉底
const out = normalizeActions([
  { angle: 'stop', label: '先不做' },
  { angle: 'bold', label: '硬上' },
  { angle: 'standard', label: '照方案做', recommended: true, prompt: '就按这个做' },
  { angle: 'cautious', label: '先验证' },
], 4)
assert.deepEqual(out.map((i) => i.label), ['照方案做', '硬上', '先验证', '先不做'])
assert.equal(out[0].recommended, true)
assert.equal(out[0].prompt, '就按这个做')
console.log('OK  推荐置顶 + stop 沉底:', out.map((i) => i.label).join(' / '))

// 同一立场只留第一条
const dedup = normalizeActions([
  { angle: 'standard', label: '一' },
  { angle: 'standard', label: '二' },
], 4)
assert.deepEqual(dedup.map((i) => i.label), ['一'])
console.log('OK  重复立场被丢弃')

// 非法立场 / 空标签 / 非对象 全部过滤
const filtered = normalizeActions([
  null, 'x', { angle: 'nope', label: '不行' }, { angle: 'bold', label: '   ' }, { angle: 'bold', label: '行' },
], 4)
assert.deepEqual(filtered.map((i) => i.label), ['行'])
console.log('OK  非法/空条目被过滤')

// 截断到 4，且上限最多 4
const many = normalizeActions([
  { angle: 'standard', label: '1' }, { angle: 'bold', label: '2' },
  { angle: 'cautious', label: '3' }, { angle: 'alternative', label: '4' },
  { angle: 'stop', label: '5' },
], 9)
assert.equal(many.length, 4, 'maxActions 夹到 4')
assert.ok(!many.some((i) => i.label === '5'), 'stop 被截断')
console.log('OK  上限夹到 4 条:', many.map((i) => i.label).join(','))

// 只保留一个推荐
const one = normalizeActions([
  { angle: 'standard', label: 'a', recommended: true },
  { angle: 'bold', label: 'b', recommended: true },
], 4)
assert.equal(one.filter((i) => i.recommended).length, 1)
console.log('OK  只保留一个推荐')

console.log('\nnormalize checks passed')
