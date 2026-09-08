/* copyConfig 动态验证 harness：
 * stub electron(app.getPath) 与 store(加解密改为可识别的伪加密)，
 * 业务模块 deploy-projects.js 原样加载，真实执行 copyConfig 并断言结果。 */
const Module = require('module')
const fs = require('fs')
const path = require('path')
const assert = require('assert')

const tmp = 'D:\\AiProject\\project-tool\\.sdd\\specs\\deploy_copy\\_harness'
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const dataFile = path.join(tmp, 'deploy-projects.json')

const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...args) {
  if (request === 'electron') return path.join(tmp, 'electron-stub.js')
  if (request === '../store') return path.join(tmp, 'store-stub.js')
  return origResolve.call(this, request, ...args)
}
fs.writeFileSync(path.join(tmp, 'electron-stub.js'),
  "module.exports = { app: { getPath: () => " + JSON.stringify(tmp) + " } }")
// 伪加密：enc(x) => 'enc:' + x；dec 只解 enc: 前缀
fs.writeFileSync(path.join(tmp, 'store-stub.js'), `
module.exports = {
  encryptText: (t) => 'enc:' + t,
  decryptText: (s) => (typeof s === 'string' && s.startsWith('enc:')) ? s.slice(4) : '',
}`)

const dp = require('D:\\AiProject\\project-tool\\electron\\deploy\\deploy-projects.js')

// ── 准备源项目 A（2 个环境，含凭据）与目标项目 B（1 个环境）──
const a = dp.defaultProject()
a.name = 'ProjectA'
a.deployMode = 'script'
a.version = { strategy: 'manual', manual: '0.1.2' }
a.deploy.backupDatabase = true
a.targets[0].name = '生产'
a.targets[0].server.host = '10.0.0.8'
a.targets[0].remotePath = '/opt/apps/a'
a.targets[0].server.secret = 'pass-A1' // save() 按明文加密落盘（真实渲染层流程）
a.targets[0].dataSync.importSecret = 'import-A1'
const t2 = dp.defaultTarget()
t2.name = '测试'
t2.server.host = '10.0.0.9'
t2.server.passphrase = 'phrase-A2'
a.targets.push(t2)

const b = dp.defaultProject()
b.name = 'ProjectB'
b.targets[0].server.host = '192.168.1.5'
b.targets[0].server.secret = 'pass-B1'
dp.save(a); dp.save(b)

// ── 断言 1：正常复制 ──
const r = dp.copyConfig({ fromProjectId: a.id, toProjectId: b.id })
assert.deepStrictEqual({ ok: r.ok, copiedTargets: r.copiedTargets, id: r.id }, { ok: true, copiedTargets: 2, id: b.id })

const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8')).projects
const B = raw.find((p) => p.id === b.id)
const A = raw.find((p) => p.id === a.id)
assert.strictEqual(B.targets.length, 3, 'B 应有 1+2 个环境')
assert.strictEqual(B.targets[0].server.secret, 'enc:pass-B1', 'B 原环境保留')
assert.strictEqual(B.targets[0].id !== A.targets[0].id, true, '复制目标 id 必须重新生成')
assert.strictEqual(B.targets[1].server.secret, 'enc:pass-A1', 'SSH 密码凭据字节原样复制')
assert.strictEqual(B.targets[1].dataSync.importSecret, 'enc:import-A1', '数据同步凭据原样复制')
assert.strictEqual(B.targets[2].server.passphrase, 'enc:phrase-A2', '私钥口令原样复制')
assert.strictEqual(B.deployMode, 'script', '部署形态复制')
assert.strictEqual(B.version.manual, '0.1.2', '版本策略复制')
assert.strictEqual(B.deploy.backupDatabase, true, '部署选项复制')
assert.strictEqual(B.name, 'ProjectB', '项目自身属性不被覆盖')
assert.notStrictEqual(B.targets[1].id, A.targets[0].id, '新 id 与源 id 不同')

// 复制后的 B 经 save() 回写（模拟用户随后保存）不应破坏复制来的凭据
B.targets[1].server.secret = '' // 渲染层留空=保持
B.targets[1].server.clearSecret = false
dp.save(B)
const B2 = JSON.parse(fs.readFileSync(dataFile, 'utf8')).projects.find((p) => p.id === b.id)
assert.strictEqual(B2.targets[1].server.secret, 'enc:pass-A1', '后续 save 不丢复制来的凭据')

// ── 断言 2：异常路径 ──
assert.strictEqual(dp.copyConfig({ fromProjectId: 'nope', toProjectId: b.id }).ok, false, '源不存在失败')
assert.strictEqual(dp.copyConfig({ fromProjectId: a.id, toProjectId: 'nope' }).ok, false, '目标不存在失败')
assert.strictEqual(dp.copyConfig({ fromProjectId: b.id, toProjectId: b.id }).ok, false, '自身复制被拒')

// ── 断言 3：脱敏 list() 上复制来的凭据状态 ──
const listed = dp.list().find((p) => p.id === b.id)
assert.strictEqual(listed.targets[1].server.secretConfigured, true, 'list 显示凭据已配置')
assert.strictEqual(listed.targets[1].server.secret, undefined, '明文/密文不出主进程')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('copyConfig harness: 全部断言通过 ✓ (3 环境/凭据原样/新 id/save 回写不丢/异常路径/脱敏)')
