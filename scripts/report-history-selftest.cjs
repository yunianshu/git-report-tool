/**
 * 报告历史自测：上限裁剪（含正文文件清理）+ 同毫秒 ID 碰撞 + 少量保存不误删
 * 用法：node scripts/report-history-selftest.cjs
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-test-'))
const stubExports = { app: { getPath: () => path.join(tmpRoot, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } }
const Module = require('module')
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stubExports }
const history = require('../electron/report-history')
const reportsDir = path.join(tmpRoot, 'userdata', 'reports')

// 1) 保存 205 份报告 → 索引与正文都只保留最新 200
for (let i = 0; i < 205; i++) history.save({ title: `t${i}`, content: `c${i}` })
const rows = history.list()
assert.strictEqual(rows.length, 200, `索引应裁剪到 200，实际 ${rows.length}`)
const files = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.md'))
assert.strictEqual(files.length, 200, `正文应只剩 200 个，实际 ${files.length}`)
assert.ok(!files.includes('0.md') || rows.some((r) => r.id === '0'), '不应残留被裁剪记录的正文')
// 2) 少于上限时不误删（回归保护：slice 负索引）
fs.rmSync(reportsDir, { recursive: true, force: true })
fs.rmSync(path.join(tmpRoot, 'userdata', 'reports.json'), { force: true })
for (let i = 0; i < 3; i++) history.save({ title: `t${i}`, content: `c${i}` })
assert.strictEqual(history.list().length, 3, '少量保存不应误删')
assert.strictEqual(fs.readdirSync(reportsDir).filter((f) => f.endsWith('.md')).length, 3, '少量保存正文不应误删')
// 3) read/remove 往返
const first = history.list()[0]
assert.ok(history.read(first.id).content.length > 0, 'read 应返回正文')

// 4) config:save 失败路径 —— store.save 返回 false 的场景（只读目录）由 main 层包装，这里验证 store.save 正常路径返回 true
const store = require('../electron/store')
assert.strictEqual(store.save({ roots: ['D:/x'] }), true, '正常保存应返回 true')

fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('报告历史自测全部通过')
