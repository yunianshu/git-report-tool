/* copyConfig / 新建默认带入 动态验证 harness：
 * stub electron(app.getPath) 与 store(加解密改为可识别的伪加密)，
 * 业务模块 deploy-projects.js 原样加载；种子项目直接写原始数据文件（等价真实已配置状态）。 */
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

// ── 种子：源项目 A（2 个环境，含凭据）与目标项目 B（1 个环境，已配置）直接写原始数据 ──
const a = dp.defaultProject()
a.id = 'dp_a'
a.name = 'ProjectA'
a.deployMode = 'script'
a.version = { strategy: 'manual', manual: '0.1.2' }
a.targets[0].name = '生产'
a.targets[0].server.host = '10.0.0.8'
a.targets[0].remotePath = '/opt/apps/a'
a.targets[0].server.secret = 'enc:pass-A1' // 原始数据里即加密形态
a.targets[0].dataSync.importSecret = 'enc:import-A1'
// 数据库备份配置按环境独立：两个环境连的是不同的库
a.targets[0].db = { enabled: true, type: 'postgres', container: 'pg-prod', name: 'db_prod', user: 'uprod' }
const t2 = dp.defaultTarget()
t2.name = '测试'
t2.server.host = '10.0.0.9'
t2.server.passphrase = 'enc:phrase-A2'
t2.db = { enabled: true, type: 'mysql', container: 'pg-test', name: 'db_test', user: 'utest' }
a.targets.push(t2)
a.updatedAt = 1000

const b = dp.defaultProject()
b.id = 'dp_b'
b.name = 'ProjectB'
b.targets[0].server.host = '192.168.1.5'
b.targets[0].server.secret = 'enc:pass-B1'
b.updatedAt = 2000

fs.writeFileSync(dataFile, JSON.stringify({ projects: [a, b] }))

// ── 断言 1：显式 copyConfig 正常复制 ──
const r = dp.copyConfig({ fromProjectId: a.id, toProjectId: b.id })
assert.deepStrictEqual({ ok: r.ok, copiedTargets: r.copiedTargets, id: r.id }, { ok: true, copiedTargets: 2, id: b.id })

const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8')).projects
const B = raw.find((p) => p.id === b.id)
const A = raw.find((p) => p.id === a.id)
assert.strictEqual(B.targets.length, 3, 'B 应有 1+2 个环境')
assert.strictEqual(B.targets[0].server.secret, 'enc:pass-B1', 'B 原环境保留')
assert.strictEqual(B.targets[1].server.secret, 'enc:pass-A1', 'SSH 密码凭据字节原样复制')
assert.strictEqual(B.targets[1].dataSync.importSecret, 'enc:import-A1', '数据同步凭据原样复制')
assert.strictEqual(B.targets[2].server.passphrase, 'enc:phrase-A2', '私钥口令原样复制')
assert.strictEqual(B.deployMode, 'script', '部署形态复制')
assert.strictEqual(B.version.manual, '0.1.2', '版本策略复制')
// 数据库备份配置随环境复制：每个目标带各自的库配置（不是项目级一份）
assert.deepStrictEqual(B.targets[1].db,
  { enabled: true, type: 'postgres', container: 'pg-prod', name: 'db_prod', user: 'uprod' },
  '生产环境的数据库备份配置随环境复制')
assert.deepStrictEqual(B.targets[2].db,
  { enabled: true, type: 'mysql', container: 'pg-test', name: 'db_test', user: 'utest' },
  '测试环境的数据库备份配置独立复制（不被前一个环境覆盖）')
assert.ok(!('backupDatabase' in B.deploy) && !('dbContainer' in B.deploy),
  '数据库备份配置已下沉到环境，项目级不得残留')
assert.strictEqual(B.name, 'ProjectB', '项目自身属性不被覆盖')
assert.notStrictEqual(B.targets[1].id, A.targets[0].id, '新 id 与源 id 不同')

// 复制后的 B 经 save() 回写（模拟渲染层提交：凭据字段一律空串，明文不出主进程）不应破坏凭据
for (const t of B.targets) {
  t.server.secret = ''
  t.server.passphrase = ''
  delete t.server.clearSecret
  delete t.server.clearPassphrase
}
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

// ── 断言 4：新建项目默认带入（spec R6）──
// B 是最近保存且配置过主机的项目 → 新项目 C 首次保存应带入 B 的配置
const c = dp.defaultProject()
c.name = 'ProjectC'
const rc = dp.save(c)
assert.strictEqual(rc.ok, true, 'C 保存成功')
assert.strictEqual(rc.copiedFrom, 'ProjectB', '默认带入来源=最近配置过的项目')
assert.strictEqual(rc.copiedTargets, 3, '带入 B 的全部 3 个环境')
const C1 = JSON.parse(fs.readFileSync(dataFile, 'utf8')).projects.find((p) => p.id === rc.id)
assert.strictEqual(C1.targets.length, 4, 'C = 默认环境 + 带入的 3 个环境')
assert.strictEqual(C1.targets[1].server.secret, 'enc:pass-B1', '带入凭据原样保留')
assert.strictEqual(C1.version.manual, '0.1.2', '版本策略随带入')
// 再次保存 C（已有部署配置）不重复带入
const rc2 = dp.save(C1)
assert.strictEqual(rc2.copiedTargets, undefined, '再次保存不重复带入')
const C2 = JSON.parse(fs.readFileSync(dataFile, 'utf8')).projects.find((p) => p.id === rc2.id)
assert.strictEqual(C2.targets.length, 4, '环境数量不变')

// 无已配置主机的源项目 → 新项目静默跳过（spec R6）
dp.remove(a.id); dp.remove(b.id); dp.remove(rc.id)
const d = dp.defaultProject(); d.name = 'ProjectD' // 无 host 配置
dp.save(d)
const e = dp.defaultProject(); e.name = 'ProjectE'
const re = dp.save(e)
assert.strictEqual(re.copiedTargets, undefined, '无可用源时静默跳过')
const E = JSON.parse(fs.readFileSync(dataFile, 'utf8')).projects.find((p) => p.id === re.id)
assert.strictEqual(E.targets.length, 1, 'E 仅保留默认环境')

// ── 断言 5：旧格式迁移——数据库备份原为项目级(deploy.backupDatabase/dbContainer/...) ──
// 多环境下测试库与生产库不同，现按环境存放；旧项目只有项目级配置，读取时必须迁移到环境
const old = dp.defaultProject()
old.id = 'dp_old'
old.name = 'LegacyProject'
delete old.targets[0].db // 旧版本落盘的目标没有 db 字段
old.targets[0].server.host = '10.1.1.1'
old.targets[0].remotePath = '/opt/apps/legacy'
old.deploy.backupDatabase = true // 旧的项目级数据库备份配置
old.deploy.dbType = 'postgres'
old.deploy.dbContainer = 'pg-legacy'
old.deploy.dbName = 'legacy_db'
old.deploy.dbUser = 'ulegacy'
const rawOld = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
rawOld.projects.push(old)
fs.writeFileSync(dataFile, JSON.stringify(rawOld))

const listedOld = dp.list().find((p) => p.id === 'dp_old')
assert.deepStrictEqual(listedOld.targets[0].db,
  { enabled: true, type: 'postgres', container: 'pg-legacy', name: 'legacy_db', user: 'ulegacy' },
  '项目级数据库备份配置迁移到环境')
assert.ok(!('backupDatabase' in listedOld.deploy) && !('dbContainer' in listedOld.deploy) && !('dbType' in listedOld.deploy),
  '迁移后项目级不再保留数据库配置（避免两份真源）')
// 回写后仍在环境上、项目级不残留（迁移幂等：保存一次不会把配置弄丢）
dp.save(listedOld)
const savedOld = JSON.parse(fs.readFileSync(dataFile, 'utf8')).projects.find((p) => p.id === 'dp_old')
assert.strictEqual(savedOld.targets[0].db.container, 'pg-legacy', '回写后数据库配置仍在环境上')
assert.strictEqual(savedOld.targets[0].db.enabled, true, '回写后备份开关保持')
assert.ok(!('backupDatabase' in savedOld.deploy), '回写后项目级不残留数据库配置')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('copyConfig harness: 全部断言通过 ✓ (复制凭据原样/新 id/save 回写不丢/异常路径/脱敏/新建默认带入/重复保存不带入/无源跳过/环境级数据库配置复制/旧格式迁移)')
