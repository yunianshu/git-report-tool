/**
 * E2E（真实 Electron + 沙箱主目录 + 真实 Git 仓库）：一键填报「绑定项目后也能解绑」
 *
 * 需求：项目绑定禅道任务后必须还能解除绑定。原实现里「绑定禅道任务」按钮只出现在未绑定的
 *       明细行上，绑定后弹窗不可再打开 → 解绑入口不可达（后端 fill:unbind 有实现但用不上）。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   A0 已绑定且有仓库的项目在进入页面时默认选中（减少手动勾选）；未绑定或无仓库的项目不自动选中，
 *      且用户手动改选/清空后该选择跨视图保留（不被默认值覆盖）
 *   A1 项目下拉中已绑定项目可直接解绑：点「解绑」后该选项标签由「已绑定 #123」变「未绑定」，
 *      且该次点击不会顺带把项目选中（下拉内操作与选择互不干扰）
 *   A2 解绑落盘：userData/fill-bindings.json 中该项目条目被删除，同文件其他项目的绑定保留
 *   A3 生成报告后，已绑定项目的明细行同时提供「更换」与「解绑」入口
 *   A4 明细行「更换」仍能打开绑定弹窗：标题为「管理绑定」且提供「解除绑定」（已绑定项目弹窗可达）
 *   A5 明细行点「解绑」：该行变「未绑定」并出现「绑定禅道任务」；按任务汇总不再含该任务、
 *      出现未绑定提示；磁盘上仅该项目的绑定被删除
 *   A6 重启后仍为未绑定（持久化生效，不复活），其他项目的绑定不受影响
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/fill-unbind-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-fill-unbind-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const REPO_ALPHA = path.join(SANDBOX, 'repo-alpha')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')
const BINDINGS_FILE = path.join(USER_DATA, 'fill-bindings.json')

const P_ALPHA = 'fp_e2e_alpha'
const P_BETA = 'fp_e2e_beta'
const IDENTITY = { name: 'E2E填报用户', email: 'fill-e2e@example.com' }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
  return r.stdout
}

/** 真实 Git 仓库 + 一条本人今天的提交（plan 的提交来源） */
function createRepo() {
  fs.mkdirSync(REPO_ALPHA, { recursive: true })
  git(REPO_ALPHA, ['init', '-q'])
  fs.writeFileSync(path.join(REPO_ALPHA, 'README.md'), '# alpha\n')
  fs.writeFileSync(path.join(REPO_ALPHA, 'app.js'), 'console.log(1)\n')
  git(REPO_ALPHA, ['add', '.'])
  git(REPO_ALPHA, [
    '-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`,
    'commit', '-q', '-m', 'feat: 初始化 alpha 项目',
  ])
}

/** 两个项目都预置绑定：解绑 Alpha 后 Beta 必须仍在（验证只删目标条目） */
function seedBindings() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.writeFileSync(BINDINGS_FILE, JSON.stringify({
    [P_ALPHA]: { taskId: 123, taskName: 'Alpha开发任务', boundAt: new Date().toISOString() },
    [P_BETA]: { taskId: 456, taskName: 'Beta开发任务', boundAt: new Date().toISOString() },
  }, null, 2))
}

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  createRepo()
  // 禅道刻意不配置：绑定/解绑的持久化不依赖禅道连通性（也避免 E2E 触网）
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    roots: [SANDBOX],
    identities: [IDENTITY],
  }, null, 2))
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    projects: [
      { id: P_ALPHA, name: 'Alpha项目', localPath: REPO_ALPHA },
      { id: P_BETA, name: 'Beta项目', localPath: path.join(SANDBOX, 'beta-no-repo') },
    ],
  }, null, 2))
  seedBindings()
}

function readBindings() {
  try { return JSON.parse(fs.readFileSync(BINDINGS_FILE, 'utf8')) } catch { return null }
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
  // 顶栏「当前项目」选择器与填报页项目选择器同名 class（.project-select），必须限定 .fill-page 内，
  // 否则会点到顶栏那个、断言到它的下拉选项。
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
  const optionTag = (name) => { const o = optionByName(name); return o ? norm(o.querySelector('.el-tag')?.textContent) : '(no-option)' }
  const optionUnbindBtn = (name) => { const o = optionByName(name); return o ? o.querySelector('.project-option-unbind') : null }
  const optionEnabled = (name) => { const o = optionByName(name); return !!(o && !o.classList.contains('is-disabled')) }
  const selectedTagCount = () => document.querySelectorAll('.fill-page .project-select .el-tag').length
  const pickOption = (name) => { const o = optionByName(name); if (!o) return false; o.click(); return true }
  const generateBtn = () => [...document.querySelectorAll('.fill-toolbar button')].find((b) => norm(b.textContent).includes('生成报告'))
  const generateEnabled = () => { const b = generateBtn(); return !!(b && !b.disabled) }
  const rows = () => [...document.querySelectorAll('.prow')]
  const rowOf = (name) => rows().find((r) => norm(r.textContent).includes(name))
  const rowTag = (name) => { const r = rowOf(name); return r ? norm(r.querySelector('.pmatch .el-tag')?.textContent) : '(no-row)' }
  const rowBtns = (name) => { const r = rowOf(name); return r ? [...r.querySelectorAll('.pmatch button')].map((b) => norm(b.textContent)) : [] }
  const clickRowBtn = (name, text) => {
    const r = rowOf(name); if (!r) return false
    const b = [...r.querySelectorAll('.pmatch button')].find((x) => norm(x.textContent) === text)
    if (!b) return false
    b.click(); return true
  }
  const dialog = () => [...document.querySelectorAll('.el-dialog')].find((d) => {
    const ov = d.closest('.el-overlay'); if (!ov || ov.style.display === 'none') return false
    const rect = d.getBoundingClientRect(); return rect.width > 0 && rect.height > 0
  })
  const dialogTitle = () => { const d = dialog(); return d ? norm(d.querySelector('.el-dialog__title')?.textContent) : '(no-dialog)' }
  const dialogBtn = (text) => { const d = dialog(); if (!d) return null; return [...d.querySelectorAll('.el-dialog__footer button')].find((b) => norm(b.textContent).includes(text)) }
  const done = () => setTimeout(() => window.close(), 400)
`

const EVAL1 = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) { done(); return { fatal: '一键填报页未就绪' } }
  if (await openDropdown() !== 'ok') { done(); return { fatal: '项目下拉未打开' } }
  // 仓库扫描是启动预热的异步结果：选项被禁用表示项目还没匹配到仓库
  r.alphaReady = await waitFor(() => optionEnabled('Alpha项目'), 25000)
  // A0：已绑定且有仓库的 Alpha 默认选中（默认值由 bindings/项目列表/仓库扫描三个异步源就绪后写入，等它稳定）
  r.defaultPicked = await waitFor(() => selectedTagCount() > 0, 8000)
  r.defaultPickedTags = [...document.querySelectorAll('.fill-page .project-select .el-tag')].map((t) => norm(t.textContent))
  r.tagBefore = optionTag('Alpha项目')
  r.betaBefore = optionTag('Beta项目')
  r.selBefore = selectedTagCount()
  r.unbindBtnShown = !!optionUnbindBtn('Alpha项目')

  // A1：下拉内直接解绑
  const btn = optionUnbindBtn('Alpha项目')
  if (btn) btn.click()
  r.tagChanged = await waitFor(() => optionTag('Alpha项目').includes('未绑定'), 8000)
  r.tagAfter = optionTag('Alpha项目')
  r.selAfter = selectedTagCount()
  r.betaAfter = optionTag('Beta项目')
  r.dropdownStillOpen = dropdownOpen()
  done()
  return r
})()`

const EVAL2 = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) { done(); return { fatal: '一键填报页未就绪' } }
  if (await openDropdown() !== 'ok') { done(); return { fatal: '项目下拉未打开' } }
  r.alphaReady = await waitFor(() => optionEnabled('Alpha项目'), 25000)
  // A0/新需求：已绑定项目默认选中，无需手动勾选即可生成报告（这里等待默认选中生效，不再 pickOption——
  // 对已选中选项再点击会变成取消选择）
  r.picked = await waitFor(() => selectedTagCount() > 0, 8000)
  r.pickedTag = r.picked ? [...document.querySelectorAll('.fill-page .project-select .el-tag')].map((t) => norm(t.textContent)) : []
  r.generateReady = await waitFor(generateEnabled, 5000)
  const gen = generateBtn()
  r.generated = !!gen
  if (gen) gen.click()
  r.rowAppeared = await waitFor(() => !!rowOf('Alpha项目'), 25000, 200)
  r.rowTag = rowTag('Alpha项目')
  r.rowBtns = rowBtns('Alpha项目')

  // A4：「更换」仍可打开绑定弹窗（已绑定项目）
  r.openManage = clickRowBtn('Alpha项目', '更换')
  r.manageTitle = await waitFor(() => dialogTitle().includes('管理绑定'), 6000) ? dialogTitle() : dialogTitle()
  r.unbindBtnInDialog = !!dialogBtn('解除绑定')
  const cancel = dialogBtn('取消')
  if (cancel) cancel.click()
  await waitFor(() => !dialog(), 4000)

  // A5：明细行解绑
  r.rowUnbindClicked = clickRowBtn('Alpha项目', '解绑')
  r.rowUnbound = await waitFor(() => rowTag('Alpha项目').includes('未绑定'), 15000, 200)
  r.rowTagAfter = rowTag('Alpha项目')
  r.rowBtnsAfter = rowBtns('Alpha项目')
  r.summaryHasTask123 = norm(q('.sum-list')?.textContent || '').includes('#123')
  r.unboundHint = norm([...document.querySelectorAll('.submit-hint, .collect-hint')].map((x) => x.textContent).join(' '))
  done()
  return r
})()`

const EVAL3 = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) { done(); return { fatal: '一键填报页未就绪' } }
  if (await openDropdown() !== 'ok') { done(); return { fatal: '项目下拉未打开' } }
  await waitFor(() => optionTag('Beta项目').includes('已绑定'), 25000)
  r.alphaTag = optionTag('Alpha项目')
  r.betaTag = optionTag('Beta项目')
  done()
  return r
})()`

/** 设置 E2E_EXE 时驱动打包产物，否则用开发版 Electron */
const EXE = process.env.E2E_EXE || ''

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '120000',
    SMOKE_VIEW: '一键填报',
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

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

console.log('=== 一键填报：已绑定项目解绑（A1–A6）===')
preseed()

// —— 第一次启动：下拉内解绑 ——
const p1 = launch(EVAL1, 'fill-unbind-1.png')
const ev1 = parseEval(p1.stdout || '')
if (!ev1) {
  console.log('  FAIL  第一次启动未取到 eval 结果')
  console.log((p1.stdout || '').slice(-2500))
  failed++
} else {
  if (ev1.fatal) assert('第一次启动页面就绪', false, ev1.fatal)
  assert('A0 已绑定且有仓库的项目默认选中（仅 Alpha，无仓库的 Beta 不选）',
    ev1.defaultPicked === true && JSON.stringify(ev1.defaultPickedTags) === JSON.stringify(['Alpha项目']),
    `tags=${JSON.stringify(ev1.defaultPickedTags)}`)
  assert('A1 解绑前下拉显示「已绑定 #123」', ev1.tagBefore.includes('已绑定 #123'), `实际="${ev1.tagBefore}"`)
  assert('A1 下拉提供解绑入口', ev1.unbindBtnShown === true)
  assert('A1 点解绑后标签变「未绑定」', String(ev1.tagAfter).includes('未绑定'), `实际="${ev1.tagAfter}"`)
  assert('A1 解绑点击未顺带选中项目', ev1.selAfter === ev1.selBefore, `before=${ev1.selBefore} after=${ev1.selAfter}`)
  assert('A1 其他项目绑定不受影响（Beta 仍已绑定 #456）', ev1.betaAfter.includes('已绑定 #456'), `实际="${ev1.betaAfter}"`)
  const b1 = readBindings() || {}
  assert('A2 磁盘删除 Alpha 绑定', !b1[P_ALPHA], `磁盘=${JSON.stringify(b1)}`)
  assert('A2 磁盘保留 Beta 绑定', !!b1[P_BETA] && b1[P_BETA].taskId === 456, `磁盘=${JSON.stringify(b1)}`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev1, null, 1))
}

// —— 第二次启动：生成报告 → 明细行更换/解绑 ——
seedBindings()
const p2 = launch(EVAL2, 'fill-unbind-2.png')
const ev2 = parseEval(p2.stdout || '')
if (!ev2) {
  console.log('  FAIL  第二次启动未取到 eval 结果')
  console.log((p2.stdout || '').slice(-2500))
  failed++
} else {
  if (ev2.fatal) assert('第二次启动页面就绪', false, ev2.fatal)
  assert('A0 重启后默认选中仍生效（标签为已绑定的 Alpha项目）',
    ev2.picked === true && JSON.stringify(ev2.pickedTag) === JSON.stringify(['Alpha项目']),
    `tags=${JSON.stringify(ev2.pickedTag)}`)
  assert('A3 默认选中项目并生成报告后出现明细行',
    ev2.picked === true && ev2.generated === true && ev2.rowAppeared === true,
    `picked=${ev2.picked} generated=${ev2.generated} row=${ev2.rowAppeared}`)
  assert('A3 已绑定行显示绑定任务', String(ev2.rowTag).includes('禅道 #123') && String(ev2.rowTag).includes('Alpha开发任务'), `实际="${ev2.rowTag}"`)
  assert('A3 已绑定行提供「更换」「解绑」',
    Array.isArray(ev2.rowBtns) && ev2.rowBtns.includes('更换') && ev2.rowBtns.includes('解绑'),
    `实际=${JSON.stringify(ev2.rowBtns)}`)
  assert('A4 「更换」打开弹窗且标题为「管理绑定」', ev2.openManage === true && String(ev2.manageTitle).includes('管理绑定'), `title="${ev2.manageTitle}"`)
  assert('A4 弹窗提供「解除绑定」', ev2.unbindBtnInDialog === true)
  assert('A5 明细行点解绑后该行变「未绑定」', ev2.rowUnbindClicked === true && String(ev2.rowTagAfter).includes('未绑定'), `clicked=${ev2.rowUnbindClicked} tag="${ev2.rowTagAfter}"`)
  assert('A5 解绑后行上出现「绑定禅道任务」', Array.isArray(ev2.rowBtnsAfter) && ev2.rowBtnsAfter.includes('绑定禅道任务'), `实际=${JSON.stringify(ev2.rowBtnsAfter)}`)
  assert('A5 汇总不再包含 #123', ev2.summaryHasTask123 === false)
  assert('A5 出现未绑定提示', String(ev2.unboundHint).includes('绑定'), `实际="${ev2.unboundHint}"`)
  const b2 = readBindings() || {}
  assert('A5 磁盘删除 Alpha 绑定', !b2[P_ALPHA], `磁盘=${JSON.stringify(b2)}`)
  assert('A5 磁盘保留 Beta 绑定', !!b2[P_BETA] && b2[P_BETA].taskId === 456, `磁盘=${JSON.stringify(b2)}`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev2, null, 1))
}

// —— 第三次启动：重启后不复活 + 其他项目绑定仍在 ——
const p3 = launch(EVAL3, 'fill-unbind-3.png')
const ev3 = parseEval(p3.stdout || '')
if (!ev3) {
  console.log('  FAIL  第三次启动未取到 eval 结果')
  console.log((p3.stdout || '').slice(-2500))
  failed++
} else {
  if (ev3.fatal) assert('第三次启动页面就绪', false, ev3.fatal)
  assert('A6 重启后 Alpha 仍为「未绑定」', String(ev3.alphaTag).includes('未绑定'), `实际="${ev3.alphaTag}"`)
  assert('A6 重启后 Beta 仍为「已绑定 #456」', String(ev3.betaTag).includes('已绑定 #456'), `实际="${ev3.betaTag}"`)
  const b3 = readBindings() || {}
  assert('A6 磁盘状态稳定（仅 Beta）', !b3[P_ALPHA] && !!b3[P_BETA], `磁盘=${JSON.stringify(b3)}`)
  if (failed) console.log('诊断数据:', JSON.stringify(ev3, null, 1))
}

try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
