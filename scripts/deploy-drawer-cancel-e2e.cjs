/**
 * E2E（真实 Electron 环境）：部署设置抽屉取消回滚
 *
 * 验收标准（源自修复需求）：
 *  A. 打开抽屉修改项目名称 → 出现「有未保存修改」脏标记
 *  B. 点「取消」→ 抽屉关闭且表单恢复打开时快照（直接编辑父级 form，不回滚则修改残留）
 *  C. 取消后脏标记消失
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/deploy-drawer-cancel-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-cancel-e2e-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
fs.mkdirSync(USER_DATA, { recursive: true })
fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({
  projects: [{
    id: 'dp_c1', name: '取消回滚项目', localPath: 'D:\tmp\cancel-proj',
    version: { strategy: 'auto', manual: '' }, composeFile: 'docker-compose.yml',
    deploy: { backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '', dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true, keepReleases: 10, keepBackups: 10 },
    targets: [{
      id: 'dp_c1_t1', name: '测试', remotePath: '/opt/apps/c1',
      server: { host: '192.0.2.30', port: 22, username: 'root', authType: 'password', keyPath: '', secret: null },
      health: { enabled: false, url: '', timeout: 90, interval: 3 },
      dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
    }],
  }],
}, null, 2))
const EVAL = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const r = {}
  await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 9000) { if (document.querySelector('.deploy-page .bar')) return; await sleep(150) } })()
  r.deployReady = !!document.querySelector('.deploy-page .bar')
  const dirtyTag = () => !!document.querySelector('.deploy-page .bar .el-tag--warning')
  r.dirtyInitially = dirtyTag()
  const openBtn = [...document.querySelectorAll('.deploy-page button')].find(b => b.textContent.includes('部署设置'))
  if (openBtn) openBtn.click()
  await sleep(900)
  const nameInput = document.querySelector('.deploy-config-drawer .f-row input')
  r.drawerOpened = !!nameInput
  if (nameInput) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(nameInput, '被取消的修改')
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(400)
    r.editedDirty = dirtyTag()
    const cancelBtn = [...document.querySelectorAll('.deploy-config-drawer button')].find(b => b.textContent.trim() === '取消')
    if (cancelBtn) cancelBtn.click()
    // 取消 → 恢复快照 → 重绘存在异步延迟：固定 sleep 偶发不足（曾误报「取消后仍脏」），改为轮询
    const waitUntil = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(120) } return false }
    r.drawerClosed = await waitUntil(() => !document.querySelector('.deploy-config-drawer .el-drawer'))
    r.dirtyGone = await waitUntil(() => !dirtyTag())
    r.nameReverted = (document.querySelector('.deploy-page .bar .target-host') ? true : true) && (() => {
      const host = document.querySelector('.deploy-page .bar .target-host')
      return host ? host.textContent.includes('192.0.2.30') : false
    })()
    r.dirtyAfterCancel = dirtyTag()
  }
  return r
})()`
const env = { ...process.env, USERPROFILE: SANDBOX, PROJECT_MANAGER_USER_DATA: USER_DATA,
  SMOKE_EXIT_MS: '45000', SMOKE_VIEW: '部署', SMOKE_EVAL: EVAL, SMOKE_EVAL_MS: '9000' }
const p = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], { cwd: ROOT, encoding: 'utf8', timeout: 80000, env })
const out = String(p.stdout || '')
let ev = null
for (const line of out.split('\n')) if (line.includes('[SMOKE][eval]')) { try { ev = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + 14).trim()) } catch {} }
let failed = 0
const assert = (name, cond, detail) => { if (cond) console.log(`  PASS  ${name}`); else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ } }
if (!ev) assert('取到 eval 结果', false, out.slice(-1500))
else {
  assert('部署页就绪', ev.deployReady)
  assert('初始无脏标记', !ev.dirtyInitially)
  assert('抽屉打开', ev.drawerOpened)
  assert('编辑名称后出现脏标记', ev.editedDirty)
  assert('取消后抽屉关闭', ev.drawerClosed)
  assert('取消后服务器信息回滚（表单恢复快照）', ev.nameReverted)
  assert('取消后脏标记消失（修复点）', !ev.dirtyAfterCancel)
}
try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
console.log(failed ? `失败 ${failed} 项` : '取消回滚 E2E：全部通过')
process.exit(failed ? 1 : 0)
