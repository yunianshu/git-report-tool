/**
 * E2E（真实 Electron + 沙箱主目录）：发布卡「新版本」选择后，发布进程状态跟随复位
 *
 * 背景：阶段 chips / 发布日志 / 进度计数同属「一次发布运行」的展示状态，
 *       原先只在点「发布」或「回滚」时清空。用户改版本后（onNewVersion 保存成功），
 *       下方仍显示上一次发布的 ✓/✗，与「即将发布新版本」的预期不符。
 *
 * 验收标准（源自需求「选择新版本后应更新下方发布进程状态」）：
 *   A1 上一次发布失败后，阶段 1 显示 ✗（前置：确有上一轮残留状态）
 *   A2 打开「新版本」对话框后取消 → 阶段状态不变（复位只发生在版本真正切换时）
 *   A3 选中候选并保存 → 发布按钮显示新版本，阶段 chips 全部回到等待（·）
 *   A4 保存后发布日志区回到空态（上一轮日志不再残留）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/deploy-version-runstate-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-e2e-verstate-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const PROJ_FILE = path.join(USER_DATA, 'deploy-projects.json')
const PROJECT_ID = 'dp_e2e_verstate'

function mkTarget(id, name) {
  return {
    id,
    name,
    // 127.0.0.1:59999 无监听：SSH 立即失败
    server: { host: '127.0.0.1', port: 59999, username: 'root', authType: 'password', keyPath: '' },
    remotePath: `/opt/apps/${id}`,
    health: { enabled: false, url: '', timeout: 90, interval: 3 },
    dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
  }
}

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.writeFileSync(PROJ_FILE, JSON.stringify({
    projects: [{
      id: PROJECT_ID,
      name: '版本状态项目',
      localPath: path.join(SANDBOX, 'no-such-project'), // 不存在 → 检查阶段失败，快速产生阶段状态
      version: { strategy: 'manual', manual: '0.0.1' },
      composeFile: 'docker-compose.yml',
      deploy: {
        backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
        dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
        keepReleases: 10, keepBackups: 10,
      },
      targets: [mkTarget(`${PROJECT_ID}_t1`, '环境甲')],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(USER_DATA, 'deploy-history.json'), JSON.stringify({ records: [] }, null, 2))
}

const sleep = 'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))'

const helpers = `
  ${sleep}
  const q = (s) => document.querySelector(s)
  const publishBtnText = () => { const b = q('.publish-btn'); return b ? b.textContent.trim() : '' }
  const chips = () => [...document.querySelectorAll('.stages .stage-chip')].map((c) => ({
    label: c.textContent.replace(/\\s+/g, ' ').trim(),
    cls: [...c.classList].filter((x) => x.startsWith('is-')).join(','),
  }))
  const chipCls = (idx) => { const c = chips()[idx]; return c ? c.cls : '' }
  const allWaiting = () => chips().length > 0 && chips().every((c) => c.cls === 'is-waiting')
  const logLineCount = () => document.querySelectorAll('.log-box .log-line').length
  const logEmptyShown = () => !!q('.log-box .log-empty')
  const ready = async (ms = 10000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (q('.publish-btn')) return true; await sleep(150) }
    return false
  }
  const msgBox = () => [...document.querySelectorAll('.el-message-box')]
    .find((x) => x.getBoundingClientRect().width > 0)
  const clickBoxBtn = async (text, ms = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const b = msgBox()
      if (b) {
        const btn = [...b.querySelectorAll('.el-message-box__btns button')].find((x) => x.textContent.includes(text))
        if (btn) { btn.click(); return 'ok' }
      }
      await sleep(150)
    }
    return 'no-box'
  }
  const verDialog = () => [...document.querySelectorAll('.el-dialog')].find((d) => {
    const t = d.querySelector('.el-dialog__title')
    return t && t.textContent.includes('添加新版本')
  })
  const dialogShown = () => {
    const d = verDialog()
    if (!d) return false
    const rect = d.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const openVerDialog = async () => {
    const btn = [...document.querySelectorAll('.publish-row button')].find((b) => b.textContent.includes('新版本'))
    if (!btn) return 'no-btn'
    btn.click()
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) { if (dialogShown()) return 'ok'; await sleep(100) }
    return 'not-shown'
  }
  const closeVerDialog = async () => {
    const d = verDialog(); if (!d) return 'no-dialog'
    const btn = [...d.querySelectorAll('.el-dialog__footer button')].find((b) => b.textContent.includes('取消'))
    if (btn) btn.click()
    const t0 = Date.now()
    while (Date.now() - t0 < 3000) { if (!dialogShown()) return 'ok'; await sleep(100) }
    return 'still-shown'
  }
  const verOptions = () => {
    const d = verDialog()
    return d ? [...d.querySelectorAll('.el-radio')].map((x) => x.textContent.trim()) : []
  }
  const pickOption = (text) => {
    const d = verDialog(); if (!d) return false
    const el = [...d.querySelectorAll('.el-radio')].find((x) => x.textContent.trim().includes(text))
    if (!el) return false
    el.click(); return true
  }
  const clickSave = () => {
    const d = verDialog(); if (!d) return false
    const btn = [...d.querySelectorAll('.el-dialog__footer button')].find((b) => b.textContent.includes('保存并使用'))
    if (!btn) return false
    btn.click(); return true
  }
  const waitPublishBtn = async (expect, ms = 12000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (publishBtnText().includes(expect)) return true; await sleep(150) }
    return false
  }
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL = `(async () => {
  ${helpers}
  const r = {}
  if (!await ready()) { done(); return { fatal: '部署页未就绪' } }
  r.btn0 = publishBtnText()
  r.chipsBeforeRun = chips()

  // 前置：点发布（本地目录不存在 → 检查阶段失败）→ 产生上一轮残留状态
  q('.publish-btn').click()
  r.confirm = await clickBoxBtn('发布')
  r.alert = await clickBoxBtn('知道了')
  await sleep(800)
  r.chipsAfterFail = chips()
  r.failChipCls = chipCls(0)
  r.logAfterFail = { lines: logLineCount(), empty: logEmptyShown() }

  // A2：打开「新版本」后取消 → 阶段状态不得变化
  r.open1 = await openVerDialog()
  r.close1 = await closeVerDialog()
  await sleep(400)
  r.chipsAfterCancel = chips()

  // A3/A4：重新打开 → 选候选保存 → 阶段复位 + 日志清空
  r.open2 = await openVerDialog()
  r.opts = verOptions()
  r.pick = pickOption('0.1.0')
  r.save = clickSave()
  r.btnSaved = await waitPublishBtn('0.1.0')
  await sleep(600)
  r.btn2 = publishBtnText()
  r.chipsAfterSave = chips()
  r.allWaitingAfterSave = allWaiting()
  r.logAfterSave = { lines: logLineCount(), empty: logEmptyShown() }
  done()
  return r
})()`

/** 设置 E2E_EXE 时驱动打包产物（win-unpacked 可执行文件），否则用开发版 Electron */
const EXE = process.env.E2E_EXE || ''

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '120000',
    SMOKE_VIEW: '部署',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '5000',
  }
  const bin = EXE || process.execPath
  const args = EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.']
  return spawnSync(bin, args, {
    cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: 150000, env,
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

/** 磁盘终态：项目已保存的手动版本 */
function savedManual() {
  const p = JSON.parse(fs.readFileSync(PROJ_FILE, 'utf8')).projects.find((x) => x.id === PROJECT_ID)
  return p && p.version ? p.version.manual : null
}

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

console.log('=== 新版本选择后发布进程状态复位 ===')
preseed()
const p = launch(EVAL, 'ver-runstate.png')
const ev = parseEval(p.stdout || '')
if (!ev) {
  console.log('  FAIL  未取到 eval 结果')
  console.log((p.stdout || '').slice(-2500))
  failed++
} else {
  if (ev.fatal) assert('页面就绪', false, ev.fatal)
  assert('初始发布按钮显示本地版本 0.0.1', String(ev.btn0).includes('0.0.1'), `实际="${ev.btn0}"`)
  assert('A1 发布失败后阶段 1 显示 ✗（存在上一轮残留）',
    ev.confirm === 'ok' && String(ev.failChipCls).includes('is-failed'),
    `confirm=${ev.confirm} cls="${ev.failChipCls}"`)
  assert('A1 发布失败后日志区有上一轮日志',
    ev.logAfterFail && ev.logAfterFail.lines > 0 && ev.logAfterFail.empty === false,
    `log=${JSON.stringify(ev.logAfterFail)}`)
  assert('A2 打开后取消：阶段状态不变（仍为失败）',
    ev.open1 === 'ok' && ev.close1 === 'ok' && ev.chipsAfterCancel && ev.chipsAfterCancel[0]
      && String(ev.chipsAfterCancel[0].cls).includes('is-failed'),
    `open=${ev.open1} close=${ev.close1} cls="${ev.chipsAfterCancel && ev.chipsAfterCancel[0] && ev.chipsAfterCancel[0].cls}"`)
  assert('A3 候选含 0.1.0（新功能）',
    Array.isArray(ev.opts) && ev.opts.some((o) => o.includes('0.1.0')),
    `实际=${JSON.stringify(ev.opts)}`)
  assert('A3 选中候选保存后发布按钮显示 0.1.0',
    ev.pick === true && ev.save === true && ev.btnSaved === true && String(ev.btn2).includes('0.1.0'),
    `pick=${ev.pick} save=${ev.save} btn="${ev.btn2}"`)
  assert('A3 保存后阶段 chips 全部回到等待（修复点）',
    ev.allWaitingAfterSave === true,
    `实际=${JSON.stringify(ev.chipsAfterSave)}`)
  assert('A4 保存后发布日志区回到空态',
    ev.logAfterSave && ev.logAfterSave.lines === 0 && ev.logAfterSave.empty === true,
    `log=${JSON.stringify(ev.logAfterSave)}`)
  const sv = savedManual()
  assert('A3 配置持久化（manual=0.1.0）', sv === '0.1.0', `磁盘=${sv}`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev, null, 1))
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
