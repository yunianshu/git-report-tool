/**
 * E2E（真实 Electron + 沙箱主目录 + 真实 Git 仓库）：一键填报「加班跨夜工时」
 *
 * 需求（用户反馈）：昨天 08:30 上班、加班到次日 00:30，选昨天填报时工时只有 8h——
 *   因为补填历史日期时终点被固定为设置页的下班时间（17:30），页面没有任何入口
 *   表达「次日凌晨收工」。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   B1 工具条出现「下班时间」选择器，可留空（placeholder 提示自动取值）
 *   B2 历史日期 + 留空 → 预览为 上班时间–下班时间（17:30），不是跨夜
 *   B3 历史日期 + 选 00:30（早于上班时间）→ 预览显示「次日 00:30」且预计工时 15.0h
 *   B4 点「生成报告」后，明细标题含「次日 00:30」，合计 15.00h，项目行 15h
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/fill-overnight-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-fill-overnight-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const REPO_ALPHA = path.join(SANDBOX, 'repo-alpha')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')

const P_ALPHA = 'fo_e2e_alpha'
const IDENTITY = { name: 'E2E加班用户', email: 'fill-overnight@example.com' }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
  return r.stdout
}

const pad = (n) => String(n).padStart(2, '0')
const yesterday = new Date(Date.now() - 86400000)
const YESTERDAY = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`

/** 用 author/committer 日期把提交固定到「昨天」，让历史日期填报有提交可收集 */
function realCommit(time, msg) {
  const r = spawnSync('git', ['commit', '-q', '--allow-empty', '-m', msg], {
    cwd: REPO_ALPHA,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: IDENTITY.name,
      GIT_AUTHOR_EMAIL: IDENTITY.email,
      GIT_COMMITTER_NAME: IDENTITY.name,
      GIT_COMMITTER_EMAIL: IDENTITY.email,
      GIT_AUTHOR_DATE: `${YESTERDAY} ${time}:00 +0800`,
      GIT_COMMITTER_DATE: `${YESTERDAY} ${time}:00 +0800`,
    },
  })
  if (r.status !== 0) throw new Error(`git commit 失败：${r.stderr || r.stdout}`)
}

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(REPO_ALPHA, { recursive: true })
  git(REPO_ALPHA, ['init', '-q'])
  realCommit('09:12', 'feat: 完成跨夜需求')
  realCommit('22:40', 'fix: 修复凌晨崩溃')
  // 禅道不配置：只验证计划生成与工时计算，不触网
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ roots: [SANDBOX], identities: [IDENTITY] }, null, 2))
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    projects: [{ id: P_ALPHA, name: 'Alpha项目', localPath: REPO_ALPHA }],
  }, null, 2))
}

const helpers = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const q = (s) => document.querySelector(s)
  const waitFor = async (fn, ms = 8000, step = 120) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
    return false
  }
  const viewReady = (ms = 20000) => waitFor(() => q('.fill-page') && q('.fill-page .project-select'), ms, 150)
  const rangeTip = () => norm(q('.fill-range-tip')?.textContent)
  const endSelect = () => q('.fill-toolbar .end-time-select')
  const timeOptionEls = () => [...document.querySelectorAll('.el-select-dropdown__item')]
    .filter((x) => /^\\d{2}:\\d{2}$/.test(norm(x.textContent)))
  const openEndSelect = async () => {
    const sel = endSelect(); if (!sel) return false
    const trigger = sel.querySelector('.el-select__wrapper') || sel
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return waitFor(() => timeOptionEls().some((x) => x.offsetParent !== null), 6000)
  }
  const pickTime = (t) => {
    const el = timeOptionEls().find((x) => norm(x.textContent) === t && x.offsetParent !== null)
    if (!el) return false
    el.click(); return true
  }
  const openDatePanel = async () => {
    const editor = q('.fill-toolbar .el-date-editor')
    if (!editor) return 'no-editor'
    const input = editor.querySelector('input')
    if (!input) return 'no-input'
    input.focus()
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const ok = await waitFor(() => [...document.querySelectorAll('.el-picker-panel__shortcut')].some((x) => x.offsetParent !== null), 6000)
    return ok ? 'ok' : 'no-panel'
  }
  const pickDateShortcut = (text) => {
    const el = [...document.querySelectorAll('.el-picker-panel__shortcut')]
      .find((x) => norm(x.textContent) === text && x.offsetParent !== null)
    if (!el) return false
    el.click(); return true
  }
  const fillSelect = () => q('.fill-page .project-select')
  const fillOptionEls = () => [...document.querySelectorAll('.el-select-dropdown__item')].filter((x) => x.querySelector('.project-option'))
  const dropdownOpen = () => fillOptionEls().some((x) => x.offsetParent !== null)
  const openDropdown = async () => {
    if (dropdownOpen()) return 'ok'
    const sel = fillSelect(); if (!sel) return 'no-select'
    const trigger = sel.querySelector('.el-select__wrapper') || sel
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return (await waitFor(dropdownOpen, 5000)) ? 'ok' : 'no-dropdown'
  }
  const optionByName = (name) => fillOptionEls().find((x) => norm(x.textContent).includes(name))
  const optionEnabled = (name) => { const o = optionByName(name); return !!(o && !o.classList.contains('is-disabled')) }
  const pickOption = (name) => { const o = optionByName(name); if (!o) return false; o.click(); return true }
  const generateBtn = () => [...document.querySelectorAll('.fill-toolbar button')].find((b) => norm(b.textContent).includes('生成报告'))
  const generateEnabled = () => { const b = generateBtn(); return !!(b && !b.disabled) }
  const rowOf = (name) => [...document.querySelectorAll('.prow')].find((r) => norm(r.textContent).includes(name))
  const cardHeaders = () => [...document.querySelectorAll('.fill-page .card-header')].map((x) => norm(x.textContent)).join(' | ')
  const dateInputValue = () => (q('.fill-toolbar .el-date-editor input') || {}).value || ''
  const nowHM = () => { const d = new Date(); return \`\${String(d.getHours()).padStart(2, '0')}:\${String(d.getMinutes()).padStart(2, '0')}\` }
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) { done(); return { fatal: '一键填报页未就绪' } }

  // B1：下班时间选择器存在（可留空 → placeholder 提示取点击时刻）
  const sel = endSelect()
  r.endSelectExists = !!sel
  r.endPlaceholder = sel ? norm(sel.textContent) : ''
  r.rangeTipDefault = rangeTip()

  // B2：切到昨天，未填下班时间 → 终点为点击时刻（与填报日期无关，不再是 17:30）
  const nowBefore = nowHM()
  r.datePanelOpened = await openDatePanel()
  r.pickedYesterday = pickDateShortcut('昨天')
  r.dateApplied = await waitFor(() => dateInputValue() === '${YESTERDAY}', 8000)
  r.dateAfterPick = dateInputValue()
  r.rangeTipYesterday = rangeTip()
  r.expectedEnds = [nowBefore, nowHM()]

  // B3：下班时间选 00:30（早于上班时间）→ 次日跨夜 + 15h
  r.endOpened = await openEndSelect()
  r.pickedEnd = pickTime('00:30')
  r.overnightApplied = await waitFor(() => rangeTip().includes('次日 00:30'), 8000)
  r.rangeTipOvernight = rangeTip()

  // B4：生成报告 → 明细标题 / 合计 / 行工时
  if (await openDropdown() !== 'ok') { done(); return { ...r, fatal: '项目下拉未打开' } }
  await waitFor(() => optionEnabled('Alpha项目'), 25000)
  r.picked = pickOption('Alpha项目')
  r.generateReady = await waitFor(generateEnabled, 6000)
  const gen = generateBtn()
  r.generated = !!gen
  if (gen) gen.click()
  r.rowAppeared = await waitFor(() => !!rowOf('Alpha项目'), 30000, 200)
  r.headers = cardHeaders()
  r.rowHours = rowOf('Alpha项目') ? norm(rowOf('Alpha项目').querySelector('.phours')?.textContent) : ''
  done()
  return r
})()`

/** 设置 E2E_EXE 时驱动打包产物（win-unpacked 可执行文件），否则用开发版 Electron。
 *  必须转绝对路径：spawnSync 的 cwd 会改变相对路径的解析基准。 */
const EXE = process.env.E2E_EXE ? path.resolve(process.env.E2E_EXE) : ''

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '150000',
    SMOKE_VIEW: '一键填报',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '5000',
  }
  const bin = EXE || process.execPath
  const args = EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.']
  return spawnSync(bin, args, { cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: 180000, env })
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

console.log(`=== 一键填报：加班跨夜工时（B1–B4，昨天=${YESTERDAY}）===`)
preseed()

const p = launch(EVAL, 'fill-overnight.png')
const ev = parseEval(p.stdout || '')
if (!ev) {
  console.log('  FAIL  未取到 eval 结果')
  console.log(`  status=${p.status} signal=${p.signal} error=${p.error && p.error.message}`)
  console.log(`  stdout=${JSON.stringify((p.stdout || '').slice(-3000))}`)
  console.log(`  stderr=${JSON.stringify((p.stderr || '').slice(-1500))}`)
  failed++
} else {
  if (ev.fatal) assert('页面就绪', false, ev.fatal)
  assert('B1 工具条出现下班时间选择器', ev.endSelectExists === true)
  assert('B1 placeholder 提示自动取值', /下班（.+）/.test(String(ev.endPlaceholder)), `实际="${ev.endPlaceholder}"`)
  assert('B1 默认预览显示区间与预计工时', /预计/.test(String(ev.rangeTipDefault)), `实际="${ev.rangeTipDefault}"`)
  assert('B2 切到昨天成功', ev.datePanelOpened === 'ok' && ev.pickedYesterday === true && ev.dateApplied === true, `panel=${ev.datePanelOpened} pick=${ev.pickedYesterday} date=${ev.dateAfterPick}`)
  // 终点=点击时刻；当前时刻早于上班时间时预览合法地显示「次日」前缀（规格行为），断言须兼容
  const endIsNow = (ev.expectedEnds || []).some((e) => new RegExp(`–(次日 )?${e} ·`).test(String(ev.rangeTipYesterday)))
  assert('B2 未填下班时间 → 终点为点击时刻（与日期无关，不再是 17:30）',
    endIsNow && /^08:30–(次日 )?\d{2}:\d{2} · 预计 \d+\.\d\s*h$/.test(String(ev.rangeTipYesterday)),
    `实际="${ev.rangeTipYesterday}" 期望终点∈${JSON.stringify(ev.expectedEnds)}`)
  assert('B3 选 00:30 成功', ev.endOpened === true && ev.pickedEnd === true, `open=${ev.endOpened} pick=${ev.pickedEnd}`)
  assert('B3 预览显示次日跨夜且 15.0h', ev.rangeTipOvernight === '08:30–次日 00:30 · 预计 15.0h', `实际="${ev.rangeTipOvernight}"`)
  assert('B4 生成报告后出现明细行', ev.picked === true && ev.generated === true && ev.rowAppeared === true, `picked=${ev.picked} gen=${ev.generated} row=${ev.rowAppeared}`)
  assert('B4 明细标题含「次日 00:30」', String(ev.headers).includes('次日 00:30'), `实际="${ev.headers}"`)
  assert('B4 合计 15.00h', String(ev.headers).includes('15.00h'), `实际="${ev.headers}"`)
  assert('B4 项目行工时 15h', ev.rowHours === '15h', `实际="${ev.rowHours}"`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev, null, 1))
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
