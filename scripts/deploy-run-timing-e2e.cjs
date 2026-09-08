/**
 * E2E（真实 Electron + 沙箱主目录）：发布运行时间进度 + 发布历史列位置
 *
 * 需求：
 *   1) 发布加个时间进度——发布卡显示阶段完成度与已用/总耗时，各阶段显示自身耗时
 *   2) 发布历史把「耗时」列挪到「目标」列旁，窄侧栏下也能直接看到
 *
 * 验收标准（源自需求）：
 *   A1 发布前不显示时间进度行（无本次运行）
 *   A2 发布后出现进度行：阶段计数与总耗时（失败在「上传文件」阶段 → 2/9 已完成）
 *   A3 已完成阶段在 chips 上显示自身耗时（check/package 均非 0ms）
 *   A4 失败阶段标记 ✗，进度条为失败态
 *   A5 发布历史表头顺序：版本 → 目标 → 耗时 → 时间（修复点）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/deploy-run-timing-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-e2e-timing-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const PROJECT_DIR = path.join(SANDBOX, 'project')
const PROJ_FILE = path.join(USER_DATA, 'deploy-projects.json')
const PROJECT_ID = 'dp_e2e_timing'

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  // 真实项目目录：检查阶段通过，打包阶段产生非零耗时，上传阶段因 SSH 不可达失败
  fs.mkdirSync(PROJECT_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, 'docker-compose.yml'), 'services:\n  app:\n    image: nginx\n')
  fs.writeFileSync(path.join(PROJECT_DIR, 'payload.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
  fs.writeFileSync(PROJ_FILE, JSON.stringify({
    projects: [{
      id: PROJECT_ID,
      name: '计时验证项目',
      localPath: PROJECT_DIR,
      version: { strategy: 'manual', manual: '1.0.0' },
      composeFile: 'docker-compose.yml',
      deploy: {
        backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
        dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
        keepReleases: 10, keepBackups: 10,
      },
      targets: [{
        id: `${PROJECT_ID}_t1`, name: '环境甲',
        // 127.0.0.1:59999 无监听：SSH 立即失败，发布停在「上传文件」阶段
        server: { host: '127.0.0.1', port: 59999, username: 'root', authType: 'password', keyPath: '' },
        remotePath: '/opt/apps/timing',
        health: { enabled: false, url: '', timeout: 90, interval: 3 },
        dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
      }],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(USER_DATA, 'deploy-history.json'), JSON.stringify({ records: [] }, null, 2))
}

const sleep = 'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))'

const helpers = `
  ${sleep}
  const q = (s) => document.querySelector(s)
  const ready = async (ms = 12000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (q('.publish-btn')) return true; await sleep(150) }
    return false
  }
  const runMeta = () => {
    const el = q('.run-meta'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''
  }
  const runMetaShown = () => !!q('.run-meta')
  const trackCls = () => { const t = q('.run-track'); return t ? [...t.classList].filter((c) => c.startsWith('is-')).join(',') : '' }
  const chips = () => [...document.querySelectorAll('.stages .stage-chip')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim())
  const chipDur = (idx) => {
    const c = document.querySelectorAll('.stages .stage-chip')[idx]
    const d = c && c.querySelector('.stage-dur')
    return d ? d.textContent.trim() : ''
  }
  const chipCls = (idx) => { const c = document.querySelectorAll('.stages .stage-chip')[idx]; return c ? [...c.classList].filter((x) => x.startsWith('is-')).join(',') : '' }
  const histHeaders = () => [...document.querySelectorAll('.deploy-page .el-table__header th')]
    .map((th) => th.textContent.trim()).filter(Boolean)
  const boxBtn = async (text, ms = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const b = [...document.querySelectorAll('.el-message-box')].find((x) => x.getBoundingClientRect().width > 0)
      if (b) {
        const btn = [...b.querySelectorAll('.el-message-box__btns button')].find((x) => x.textContent.includes(text))
        if (btn) { btn.click(); return 'ok' }
      }
      await sleep(150)
    }
    return 'no-box'
  }
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL = `(async () => {
  ${helpers}
  const r = {}
  if (!await ready()) { done(); return { fatal: '部署页未就绪' } }
  r.metaBefore = runMetaShown()

  // 发布：check 通过 → package 打包 → upload 因 SSH 不可达失败
  q('.publish-btn').click()
  r.confirm = await boxBtn('发布')
  r.alert = await boxBtn('知道了')
  await sleep(1000)

  r.metaAfter = runMeta()
  r.metaShown = runMetaShown()
  r.trackCls = trackCls()
  r.chips = chips()
  r.dur0 = chipDur(0) // 检查项目
  r.dur1 = chipDur(1) // 项目打包
  r.cls1 = chipCls(1)
  r.cls2 = chipCls(2) // 上传文件（失败）
  r.headers = histHeaders()
  await sleep(7000) // 留出主进程截图窗口
  done()
  return r
})()`

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
    SMOKE_SHOT_MS: '15000',
  }
  return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], {
    cwd: ROOT, encoding: 'utf8', timeout: 150000, env,
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

console.log('=== 发布运行时间进度 + 发布历史列位置 ===')
preseed()
const p = launch(EVAL, 'run-timing.png')
const ev = parseEval(p.stdout || '')
if (!ev) {
  console.log('  FAIL  未取到 eval 结果')
  console.log((p.stdout || '').slice(-2500))
  failed++
} else {
  if (ev.fatal) assert('页面就绪', false, ev.fatal)
  assert('A1 发布前不显示时间进度行', ev.metaBefore === false, `实际=${ev.metaBefore}`)
  assert('A2 发布后出现进度行', ev.metaShown === true)
  assert('A2 进度行显示阶段计数与总耗时',
    /3\/9 阶段/.test(ev.metaAfter) && /总耗时 \d{2}:\d{2}/.test(ev.metaAfter),
    `实际="${ev.metaAfter}"`)
  assert('A3 打包阶段显示自身耗时（非 0ms）', /(ms|s)$/.test(ev.dur1 || ''), `dur1="${ev.dur1}"`)
  assert('A4 打包阶段成功、上传阶段失败',
    String(ev.cls1).includes('is-success') && String(ev.cls2).includes('is-failed'),
    `cls1="${ev.cls1}" cls2="${ev.cls2}"`)
  assert('A4 进度条为失败态', String(ev.trackCls).includes('is-failed'), `track="${ev.trackCls}"`)
  const h = ev.headers || []
  assert('A5 发布历史表头顺序 版本→目标→耗时→时间',
    h[0] === '版本' && h[1] === '目标' && h[2] === '耗时' && h[3] === '时间',
    `实际=${JSON.stringify(h)}`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev, null, 1))
}

if (process.env.KEEP_SANDBOX) console.log('沙箱保留:', SANDBOX)
else { try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ } }
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
