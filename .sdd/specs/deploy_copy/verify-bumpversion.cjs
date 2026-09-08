/* 版本预测工具（src/utils/version.js）单元验证：
 * 用 esbuild 把 ESM 源码转 CJS 后加载，断言的是真实源文件逻辑（非复制函数体）。
 * 覆盖 spec R7：0.0.1 → 0.0.2 / 0.1.0 / 1.0.0；无法解析不给候选；基准取历史最高版本。 */
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const esbuild = require('esbuild')

const SRC = path.resolve(__dirname, '../../../src/utils/version.js')
const out = esbuild.transformSync(fs.readFileSync(SRC, 'utf8'), { format: 'cjs', loader: 'js', target: 'node18' })
const mod = { exports: {} }
new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require)
const { parseVersion, bumpVersion, compareVersion, highestVersion } = mod.exports

// —— 递增（spec R7 验收：0.0.1 → 0.0.2 / 0.1.0 / 1.0.0）——
assert.deepStrictEqual(
  [bumpVersion('0.0.1', 'patch'), bumpVersion('0.0.1', 'minor'), bumpVersion('0.0.1', 'major')],
  ['0.0.2', '0.1.0', '1.0.0'],
)
assert.strictEqual(bumpVersion('v2.3.4', 'minor'), '2.4.0')
assert.strictEqual(bumpVersion('10.0.9', 'patch'), '10.0.10')
assert.strictEqual(bumpVersion('1.9.9', 'minor'), '1.10.0')
assert.strictEqual(bumpVersion('1.2.3', 'major'), '2.0.0')
assert.strictEqual(bumpVersion('1.2.3-beta.1', 'patch'), '1.2.4') // 预发布后缀按前三段递增
// 无法解析 → 不给候选（仅自定义）
assert.strictEqual(bumpVersion('20260908', 'patch'), '')
assert.strictEqual(bumpVersion('', 'patch'), '')
assert.strictEqual(bumpVersion(null, 'patch'), '')
assert.strictEqual(bumpVersion('abc', 'minor'), '')

// —— 解析 ——
assert.deepStrictEqual(parseVersion('1.2.3'), [1, 2, 3])
assert.deepStrictEqual(parseVersion(' v10.0.9 '), [10, 0, 9])
assert.strictEqual(parseVersion('20260908'), null)
assert.strictEqual(parseVersion(undefined), null)

// —— 比较（数字序，非字典序）——
assert.strictEqual(compareVersion('1.2.3', '1.2.3'), 0)
assert.strictEqual(compareVersion('1.10.0', '1.9.0'), 1)
assert.strictEqual(compareVersion('0.1.0', '0.0.2'), 1)
assert.strictEqual(compareVersion('2.0.0', '10.0.0'), -1)
assert.strictEqual(compareVersion('abc', '1.0.0'), -1) // 无法解析视为最小
assert.strictEqual(compareVersion('1.0.0', 'abc'), 1)

// —— 基准取最高（spec R7：本地 0.0.1 + 线上/历史 0.1.3 → 基准 0.1.3）——
assert.strictEqual(highestVersion(['0.0.1', '0.1.3']), '0.1.3')
assert.strictEqual(highestVersion(['0.1.3', '0.0.1']), '0.1.3')
assert.strictEqual(highestVersion(['0.0.1', '', '未知', null, '1.0.0', '0.9.9']), '1.0.0')
assert.strictEqual(highestVersion([]), '')
assert.strictEqual(highestVersion(null), '')
assert.strictEqual(highestVersion(['abc', '20260908']), '')
// 组合：基准 0.1.3 → 候选 0.1.4 / 0.2.0 / 1.0.0
const base = highestVersion(['0.0.1', '0.1.3'])
assert.deepStrictEqual(
  [bumpVersion(base, 'patch'), bumpVersion(base, 'minor'), bumpVersion(base, 'major')],
  ['0.1.4', '0.2.0', '1.0.0'],
)

console.log('version.js 单元验证：全部通过 ✓')
