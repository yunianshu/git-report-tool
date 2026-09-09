/**
 * 版本号安全防护自测：手动版本非法字符（路径注入）在 normalizeProject 与 resolveVersion 双层拦截
 * 用法：node scripts/deploy-version-guard-selftest.cjs
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-test-'))
const stubExports = { app: { getPath: () => path.join(tmpRoot, 'userdata') }, safeStorage: { isEncryptionAvailable: () => false } }
const Module = require('module')
const electronPath = require.resolve('electron')
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: stubExports }
const projects = require('../electron/deploy/deploy-projects')
const { resolveVersion } = require('../electron/deploy/deploy-service')

// normalizeProject：非法 manual 清空
for (const bad of ['1.2.3/../../x', 'a b', '1;rm -rf /', '../etc']) {
  const p = projects.normalizeProject({ name: 'x', version: { strategy: 'manual', manual: bad } })
  assert.strictEqual(p.version.manual, '', `应清空非法版本号: ${bad}`)
}
// 合法值保留（含语义化后缀）
for (const ok of ['1.2.3', 'v1.4.35', '1.2.3-beta+1', '2026.09.10~rc2']) {
  const p = projects.normalizeProject({ name: 'x', version: { strategy: 'manual', manual: ok } })
  assert.strictEqual(p.version.manual, ok, `应保留合法版本号: ${ok}`)
}
// resolveVersion：绕过 normalize 的直接调用同样拦截
assert.deepStrictEqual(resolveVersion({ version: { strategy: 'manual', manual: '../../evil' } }), { version: '', source: '' })
assert.strictEqual(resolveVersion({ version: { strategy: 'manual', manual: '1.2.3' } }).version, '1.2.3')
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('第 3 轮版本注入拦截验证：全部通过')
