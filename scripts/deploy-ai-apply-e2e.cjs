/**
 * E2E（真实 Electron）：AI 部署助手「套用到部署配置」点确定后必须真的写进配置
 *
 * 背景（本用例要防的回归）：apply() 把 result.plan 原样传给 IPC，而 result 是 Vue 的 ref，
 * result.plan 是响应式代理对象。代理无法跨 contextBridge 传递，ipcRenderer.invoke 直接抛
 * 「An object could not be cloned.」；该异常被 Vue 的事件处理器捕获后只进了 console，
 * 界面既不提示也不写配置——用户看到的就是「点确定毫无反应」。
 *
 * 验收标准（源自「点了确定要有反应」）：
 *   A1 点确定后出现成功提示
 *   A2 磁盘上的部署配置真的被改写（部署形态 / 健康检查 / 数据库备份）
 *   A3 过程中没有出现 "could not be cloned" 渲染层错误
 *   A4 确认框能正常关闭，应用不崩
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/deploy-ai-apply-e2e.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-e2e-ai-apply-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const PROJ = path.join(SANDBOX, 'proj')

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

/** 项目：带 Compose（命名卷 + postgres），体检结论会是 docker + 健康检查 + 数据库备份；种子配置故意全是相反值 */
function seed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(PROJ, { recursive: true })
  fs.writeFileSync(path.join(PROJ, 'docker-compose.yml'), [
    'services:',
    '  app:',
    '    image: demo/app:latest',
    '    ports:',
    '      - "18080:8080"',
    '    volumes:',
    '      - appdata:/app/data',
    '    environment:',
    '      DB_HOST: db',
    '  db:',
    '    image: postgres:16',
    '    volumes:',
    '      - pgdata:/var/lib/postgresql/data',
    'volumes:',
    '  appdata:',
    '  pgdata:',
    '',
  ].join('\n'), 'utf8')
  fs.writeFileSync(path.join(PROJ, '.env.example'), 'POSTGRES_DB=demo\nPOSTGRES_USER=demo\n', 'utf8')
  fs.writeFileSync(path.join(PROJ, 'package.json'), JSON.stringify({ name: 'demo', version: '2.3.4' }), 'utf8')
  fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({
    projects: [{
      id: 'dp_apply', name: '套用用例项目', localPath: PROJ,
      deployMode: 'script',
      version: { strategy: 'auto', manual: '' },
      composeFile: 'docker-compose.yml',
      scriptMode: { artifactDir: 'release', upgradeScript: 'upgrade.sh', packageCommand: '', packageTimeoutSec: 900, autoBumpVersion: true, bootstrapJava: false, bootstrapPgdump: false },
      deploy: { backupCode: true, autoRollback: true, deleteUploadAfterSuccess: true, keepReleases: 10, keepBackups: 10 },
      targets: [{
        id: 'dp_apply_t1', name: '测试环境',
        server: { host: '127.0.0.1', port: 1, username: 'root', authType: 'password', keyPath: '' },
        remotePath: '/opt/apps/apply',
        health: { enabled: false, url: '', timeout: 90, interval: 3 },
        db: { enabled: false, type: 'postgres', container: '', name: '', user: '' },
        dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
      }],
    }],
  }, null, 2))
}

const EVAL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, ms = 60000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step) } return null }
  const vis = (el) => !!(el && el.offsetParent !== null)
  const btn = (t) => [...document.querySelectorAll('button')].find((b) => vis(b) && b.textContent.replace(/\\s+/g, '').includes(t.replace(/\\s+/g, '')))
  const r = {}
  if (!await until(() => document.querySelector('.deploy-page'), 15000)) return { fatal: '部署页未渲染' }
  // 跑一段时间内出现过的所有成功/错误提示，避免抢在提示消失前漏读
  const seen = []
  const timer = setInterval(() => {
    const m = document.querySelector('.el-message')
    if (m) { const t = m.textContent.trim(); if (t && seen[seen.length - 1] !== t) seen.push(t) }
  }, 100)
  r.seenBefore = seen.slice()

  const openBtn = btn('AI部署助手')
  if (!openBtn) return { ...r, fatal: '找不到「AI 部署助手」按钮' }
  openBtn.click()
  const scanBtn = await until(() => btn('开始体检') || btn('重新体检'), 10000)
  if (!scanBtn) return { ...r, fatal: '找不到「开始体检」按钮' }
  scanBtn.click()
  const applyBtn = await until(() => { const b = btn('套用到部署配置'); return b && !b.disabled ? b : null }, 120000)
  if (!applyBtn) return { ...r, fatal: '「套用到部署配置」按钮一直不可用（体检未出结论）' }
  r.planMode = (document.querySelector('.ops .el-tag') || {}).textContent || ''
  applyBtn.click()
  const box = await until(() => document.querySelector('.el-message-box'), 8000)
  if (!box) return { ...r, fatal: '点套用后没有弹出确认框' }
  r.boxTitle = (box.querySelector('.el-message-box__title') || {}).textContent || ''
  const okBtn = [...box.querySelectorAll('button')].find((b) => b.textContent.replace(/\\s+/g, '') === '确定')
  if (!okBtn) return { ...r, fatal: '确认框里没有「确定」按钮' }
  okBtn.click()
  await until(() => seen.some((t) => t.includes('已写入配置') || t.includes('失败')), 15000)
  await sleep(500)
  clearInterval(timer)
  r.messages = seen
  r.boxClosed = !document.querySelector('.el-message-box')
  r.aiDialogOpen = !!document.querySelector('.ai-deploy')
  return r
})()`

console.log('=== AI 部署助手：套用到部署配置 → 确定 ===')
seed()
const before = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'deploy-projects.json'), 'utf8')).projects[0]
const p = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], {
  cwd: ROOT, encoding: 'utf8', timeout: 180000,
  env: {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '150000',
    SMOKE_VIEW: '部署',
    SMOKE_EVAL: EVAL,
    SMOKE_EVAL_MS: '6000',
  },
})
const out = String(p.stdout || '')
let ev = null
for (const line of out.split('\n')) {
  if (line.includes('[SMOKE][eval]')) {
    try { ev = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim()) } catch { /* 取最后一条 */ }
  }
}
const cloneErr = out.split('\n').filter((l) => l.includes('renderer:error') && /could not be cloned/i.test(l))

if (!ev) {
  assert('取到界面结果', false, '未取到 [SMOKE][eval] 输出')
} else if (ev.fatal) {
  assert('界面就绪', false, ev.fatal)
} else {
  const after = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'deploy-projects.json'), 'utf8')).projects[0]
  const msgs = (ev.messages || []).join(' | ')
  assert('A1 点确定后出现成功提示', /已写入配置/.test(msgs), `提示="${msgs}"`)
  assert('A2 部署形态被改写（script → docker）', before.deployMode === 'script' && after.deployMode === 'docker', `${before.deployMode} → ${after.deployMode}`)
  assert('A2 健康检查被写入', after.targets[0].health.enabled === true && /18080/.test(after.targets[0].health.url),
    JSON.stringify(after.targets[0].health))
  assert('A2 数据库备份被写入', after.targets[0].db.enabled === true && after.targets[0].db.type === 'postgres',
    JSON.stringify(after.targets[0].db))
  assert('A2 服务器地址与凭据未被改动', after.targets[0].server.host === '127.0.0.1' && after.targets[0].remotePath === '/opt/apps/apply')
  assert('A3 没有 could not be cloned 渲染层错误', cloneErr.length === 0, cloneErr.join(' / ').slice(0, 200))
  assert('A4 确认框已关闭且应用未崩', ev.boxClosed === true && ev.aiDialogOpen === true, `boxClosed=${ev.boxClosed} aiDialog=${ev.aiDialogOpen}`)
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
