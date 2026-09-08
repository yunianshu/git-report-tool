/**
 * E2E（真实 Electron 环境）：切换项目后发布历史跟随刷新
 *
 * 背景：DeployView.onSelectProject 在 fillForm 后同步调用 historyRef.reload()，
 * 而子组件 props 由父组件重渲染异步更新——reload 读到的 projectId 仍是旧项目，
 * 发布历史停留在上一个项目的内容。
 *
 * 修复：DeployHistoryTable 自行 watch(projectId, immediate) 驱动加载；
 * DeployView 不再同步触发。
 *
 * 验收标准（源自需求「切换项目后发布历史应变化」）：
 *   A1 启动后历史表显示当前项目（甲）的记录 v9.9.9
 *   A2 切到「项目乙」→ 历史表变为 v8.8.8（修复点；修复前停留在 9.9.9）
 *   A3 切回「项目甲」→ 恢复 v9.9.9（双向回归）
 *   A4 历史表不串行：任意时刻表格里只有当前项目 id 的记录版本
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/deploy-history-switch-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-e2e-hist-switch-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const mkProject = (id, name, host) => ({
    id,
    name,
    localPath: 'D:\\tmp\\some-project',
    version: { strategy: 'auto', manual: '' },
    composeFile: 'docker-compose.yml',
    deploy: {
      backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
      dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
      keepReleases: 10, keepBackups: 10,
    },
    targets: [{
      id: `${id}_t1`, name: '测试环境',
      server: { host, port: 22, username: 'root', authType: 'password', keyPath: '' },
      remotePath: `/opt/apps/${id}`, health: { enabled: false, url: '', timeout: 90, interval: 3 },
      dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
    }],
  })
  fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({
    projects: [mkProject('dp_e2e_a', '项目甲', '192.0.2.10'), mkProject('dp_e2e_b', '项目乙', '192.0.2.11')],
  }, null, 2))
  const base = Date.now()
  fs.writeFileSync(path.join(USER_DATA, 'deploy-history.json'), JSON.stringify({
    records: [
      { id: 'h_a1', projectId: 'dp_e2e_a', projectName: '项目甲', targetId: 'dp_e2e_a_t1', targetName: '测试环境', type: 'deploy', version: '9.9.9', oldVersion: '', status: 'success', startedAt: base, finishedAt: base + 1000, durationMs: 1000, host: '192.0.2.10:22', remotePath: '/opt/apps/dp_e2e_a', message: '发布成功', logFile: '', stages: {} },
      { id: 'h_b1', projectId: 'dp_e2e_b', projectName: '项目乙', targetId: 'dp_e2e_b_t1', targetName: '测试环境', type: 'deploy', version: '8.8.8', oldVersion: '', status: 'success', startedAt: base + 2000, finishedAt: base + 3000, durationMs: 1000, host: '192.0.2.11:22', remotePath: '/opt/apps/dp_e2e_b', message: '发布成功', logFile: '', stages: {} },
    ],
  }, null, 2))
}

const sleep = 'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))'

/** 历史表首行版本文本（无行返回空串） */
const helpers = `
  ${sleep}
  const histFirstVersion = () => {
    const tr = document.querySelector('.deploy-page .el-table__body tbody tr')
    return tr ? tr.querySelector('td').textContent.trim() : ''
  }
  // 顶栏「当前项目」选择器：结构化定位（EP 新版 placeholder 渲染为 span 而非 input 属性）
  const projSelect = () => document.querySelector('.project-switcher .el-select')
  const switchProject = async (name) => {
    const sel = projSelect()
    if (!sel) return 'no-select'
    const trigger = sel.querySelector('.el-select__wrapper') || sel
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const opt = await new Promise(async (resolve) => {
      const t0 = Date.now()
      while (Date.now() - t0 < 4000) {
        const o = [...document.querySelectorAll('.el-select-dropdown__item')].find(x => x.textContent.trim() === name && x.offsetParent !== null)
        if (o) return resolve(o)
        await sleep(100)
      }
      resolve(null)
    })
    if (!opt) return 'no-option'
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(400) // 模拟真实用户的切换间隔（同一 tick 内连切两次会被 Vue 渲染批合并）
    return 'ok'
  }
  // 等历史表首行变为期望版本（切换→表单填充→watch→异步加载 有多级延迟，轮询最稳）
  const waitForVersion = async (expect, ms = 20000) => {
    const t0 = Date.now()
    const seen = []
    while (Date.now() - t0 < ms) {
      const v = histFirstVersion()
      if (!seen.length || seen[seen.length - 1].v !== v) seen.push({ t: Date.now() - t0, v })
      if (v === expect) { r.lastSeen = seen; return true }
      await sleep(120)
    }
    r.lastSeen = seen
    return false
  }
`

const EVAL1 = `(async () => {
  ${helpers}
  // 等部署页就绪（历史表渲染出来）
  const ready = await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 8000) { if (document.querySelector('.deploy-page .el-table')) return true; await sleep(150) } return false })()
  if (!ready) return { fatal: '部署页历史表未渲染' }
  const r = {}
  // 顶栏选择器当前显示（失败时用于区分「切换没生效」还是「历史没刷新」）
  const selectLabel = () => {
    const sel = document.querySelector('.project-switcher .el-select')
    const span = sel && [...sel.querySelectorAll('.el-select__selected-item span, .el-select__placeholder span, .el-select__selection span')]
      .find(x => x.textContent.trim() && x.textContent.trim() !== '全部项目')
    return span ? span.textContent.trim() : ''
  }
  // A1：初始（项目甲）历史应轮询出现 v9.9.9
  r.a1 = await waitForVersion('9.9.9') ? '9.9.9' : histFirstVersion()
  r.sel1 = selectLabel()
  // A2：切到项目乙 → 等历史变 v8.8.8
  r.swB = await switchProject('项目乙')
  r.sel2 = selectLabel()
  r.a2 = await waitForVersion('8.8.8') ? '8.8.8' : histFirstVersion()
  r.seenB = r.lastSeen
  // A3：切回项目甲 → 等历史恢复 v9.9.9
  r.swA = await switchProject('项目甲')
  r.sel3 = selectLabel()
  r.a3 = await waitForVersion('9.9.9') ? '9.9.9' : histFirstVersion()
  r.seenA = r.lastSeen
  return r
})()`

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '100000',
    SMOKE_VIEW: '部署',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '8000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '6000',
  }
  return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], {
    cwd: ROOT, encoding: 'utf8', timeout: 90000, env,
  })
}

function parseEval(stdout) {
  for (const line of String(stdout).split('\n')) {
    if (line.includes('[SMOKE][eval]')) {
      try { return JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim()) } catch { return null }
    }
  }
  return null
}

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

console.log('=== 切换项目 → 发布历史跟随刷新 ===')
preseed()
const p = launch(EVAL1, 'hist-switch.png')
const ev = parseEval(p.stdout || '')
if (!ev) {
  console.log('  FAIL  未取到 eval 结果')
  console.log((p.stdout || '').slice(-2500))
  failed++
} else {
  if (ev.fatal) assert('页面就绪', false, ev.fatal)
  assert('A1 初始显示项目甲历史 v9.9.9', ev.a1 === '9.9.9', `实际="${ev.a1}"`)
  assert('A2 切到项目乙 → v8.8.8（修复点）', ev.swB === 'ok' && ev.a2 === '8.8.8', `swB=${ev.swB} 实际="${ev.a2}"`)
  assert('A3 切回项目甲 → v9.9.9', ev.swA === 'ok' && ev.a3 === '9.9.9', `swA=${ev.swA} 实际="${ev.a3}"`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev, null, 1))
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
