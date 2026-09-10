/**
 * E2E（真实 Electron + 沙箱主目录 + 真实 Git 仓库 + 本地 fake 汉印网关）：
 * 一键填报「占比 0% 的汉印条目不要记录」
 *
 * 需求（用户反馈）：汉印工时填报中，如果有 0% 的数据，就不要记录。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   Z1 计划的汉印条目里不含占比 0% 的条目，剩余条目占比合计仍为 100%（汉印硬约束）
 *   Z2 界面明确提示「有 N 个任务工时不足（占比 0%），不写入汉印」
 *   Z3 走真实 HTTP 链路：/login/getToken → GetDict → GetProjectList → GetProjectTaskList
 *      → GetByDate 均由真实 hanprint-service 客户端发起（fake 网关记录到这些请求，
 *      条目由真实客户端构造，不是打桩结果）
 *   Z4 工时为 0 的项目在禅道侧汇总里照常出现（本次只改汉印记录口径）
 *   Z5 先生成再勾选：生成前不预选项目；取消勾选一个项目后，工时与占比按剩余子集重算
 *      （Beta 从 0% 变 100%，Alpha 显示未选）
 *
 * 场景构造：Alpha 3 条提交 / Beta 1 条提交，下班时间 09:30（默认上班 08:30）→ 总工时 1h
 *   → Beta 份额 0.25h 被 0.5h 向下取整抹成 0h → 占比 0% → 不应写入汉印。
 *
 * 边界：汉印平台无可用账号（见项目记忆），故用本地网关替代真实服务器；禅道不配置，
 *       本次改动不涉及禅道写入口径，因此不验证禅道真实写入。
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/fill-zero-percent-e2e.cjs
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-fill-zero-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const REPO_ALPHA = path.join(SANDBOX, 'repo-alpha')
const REPO_BETA = path.join(SANDBOX, 'repo-beta')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')
const PROJECTS_FILE = path.join(USER_DATA, 'deploy-projects.json')
const BINDINGS_FILE = path.join(USER_DATA, 'fill-bindings.json')

const P_ALPHA = 'fz_e2e_alpha'
const P_BETA = 'fz_e2e_beta'
const TASK_ALPHA = 123
const TASK_BETA = 456
const IDENTITY = { name: 'E2E占比用户', email: 'fill-zero@example.com' }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
  return r.stdout
}

/** 真实 Git 仓库 + 当日（默认提交时间）本人提交若干条 */
function createRepo(dir, subjects) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  for (const s of subjects) {
    git(dir, ['-c', `user.name=${IDENTITY.name}`, '-c', `user.email=${IDENTITY.email}`, 'commit', '-q', '--allow-empty', '-m', s])
  }
}

/** 本地 fake 汉印网关：协议按 hanprint-service 的调用顺序实现 */
function startFakeHanprint() {
  const state = { paths: [], addBodies: [] }
  const taskMap = {
    799: [{ Key: String(TASK_ALPHA), Name: 'Alpha开发任务' }, { Key: String(TASK_BETA), Name: 'Beta开发任务' }],
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    state.paths.push(url.pathname)
    const json = (obj) => {
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf8' })
      res.end(JSON.stringify(obj))
    }
    if (url.pathname === '/login/getToken') return json({ code: 0, data: 'e2e-token' })
    if (url.pathname === '/com/workhour/GetDict') return json({ code: 0, data: [{ Key: 3, Name: '软件项目' }] })
    if (url.pathname === '/com/workhour/GetProjectList') return json({ code: 0, data: [{ Key: 799, Name: 'E2E汉印项目' }] })
    if (url.pathname === '/com/workhour/GetProjectTaskList') return json({ code: 0, data: taskMap[url.searchParams.get('projectid')] || [] })
    if (url.pathname === '/com/workhour/GetByDate') return json({ code: 0, data: [] })
    if (url.pathname === '/com/workhour/add') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { state.addBodies.push(body); json({ code: 0, msg: 'ok' }) })
      return undefined
    }
    return json({ code: 0, data: null })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }))
  })
}

function preseed(hanyiPort) {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  createRepo(REPO_ALPHA, ['feat: Alpha 提交一', 'fix: Alpha 提交二', 'refactor: Alpha 提交三'])
  createRepo(REPO_BETA, ['feat: Beta 提交四'])
  // 汉印指向本地 fake 网关（真实账号不可得）；密码走明文兜底字段，主进程解密后即为凭证
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    roots: [SANDBOX],
    identities: [IDENTITY],
    hanprint: {
      baseUrl: `http://127.0.0.1:${hanyiPort}`,
      clientId: '1',
      account: 'E2E工号',
      pwdEnc: { plain: 'e2e-pwd' },
    },
  }, null, 2))
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify({
    projects: [
      { id: P_ALPHA, name: 'Alpha项目', localPath: REPO_ALPHA },
      { id: P_BETA, name: 'Beta项目', localPath: REPO_BETA },
    ],
  }, null, 2))
  fs.writeFileSync(BINDINGS_FILE, JSON.stringify({
    [P_ALPHA]: { taskId: TASK_ALPHA, taskName: 'Alpha开发任务', boundAt: new Date().toISOString() },
    [P_BETA]: { taskId: TASK_BETA, taskName: 'Beta开发任务', boundAt: new Date().toISOString() },
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
  const viewReady = (ms = 25000) => waitFor(() => q('.fill-page') && q('.fill-page .project-select'), ms, 150)
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
  const selectedTagCount = () => document.querySelectorAll('.fill-page .project-select .el-tag').length
  const closeDropdown = () => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }
  const rowOf = (name) => [...document.querySelectorAll('.prow')].find((r) => norm(r.textContent).includes(name))
  const rowOff = (name) => { const r = rowOf(name); return !!(r && r.classList.contains('prow-off')) }
  const rowHours = (name) => { const r = rowOf(name); return r ? norm(r.querySelector('.phours')?.textContent) : '(no-row)' }
  const hpLines = () => [...document.querySelectorAll('.hpline')].map((x) => norm(x.textContent))
  const generateBtn = () => [...document.querySelectorAll('.fill-toolbar button')].find((b) => norm(b.textContent).includes('生成报告'))
  const generateEnabled = () => { const b = generateBtn(); return !!(b && !b.disabled) }
  const done = () => setTimeout(() => window.close(), 400)
`

/** 先生成（不预选项目）→ 默认勾选 → 取消勾选一个项目触发子集重算 */
const EVAL = `(async () => {
  ${helpers}
  const r = {}
  if (!await viewReady()) { done(); return { fatal: '一键填报页未就绪' } }
  if (!await openEndSelect()) { done(); return { fatal: '下班时间选择器未打开' } }
  r.pickedEnd = pickTime('09:30')
  r.rangeTip = await waitFor(() => rangeTip().includes('1.0h'), 8000) ? rangeTip() : rangeTip()
  // 仓库扫描就绪（两个项目都要有仓库，否则计划里少一个项目）
  if (await openDropdown() !== 'ok') { done(); return { fatal: '项目下拉未打开' } }
  r.projectsReady = await waitFor(() => optionEnabled('Alpha项目') && optionEnabled('Beta项目'), 30000)
  r.selectedBefore = selectedTagCount() // 生成前不预选项目
  closeDropdown()
  r.generateReady = await waitFor(generateEnabled, 8000)
  const gen = generateBtn()
  r.generated = !!gen
  if (gen) gen.click()
  r.hpBlock = await waitFor(() => !!q('.hp-block'), 40000, 200)
  r.selectedAfter = await waitFor(() => selectedTagCount() >= 2, 15000) // 生成后默认勾选当天有提交的项目
  r.hpTitle = norm(q('.hp-title')?.textContent)
  r.hpLines = hpLines()
  r.hints = [...document.querySelectorAll('.submit-hint')].map((x) => norm(x.textContent))
  r.sumLines = [...document.querySelectorAll('.sumline')].map((x) => norm(x.textContent))

  // 取消勾选 Alpha → 子集重算：工时与占比归到 Beta（0% → 100%）
  const alphaRow = rowOf('Alpha项目')
  const cb = alphaRow && alphaRow.querySelector('.pcheck')
  r.alphaUnchecked = false
  if (cb) {
    cb.click()
    r.alphaUnchecked = await waitFor(
      () => rowOff('Alpha项目') && norm(q('.hp-block')?.textContent).includes('Beta开发任务'),
      20000,
      200,
    )
  }
  r.hpLinesAfter = hpLines()
  r.rowHoursAfter = { alpha: rowHours('Alpha项目'), beta: rowHours('Beta项目') }
  r.hintsAfter = [...document.querySelectorAll('.submit-hint')].map((x) => norm(x.textContent))
  done()
  return r
})()`

const EXE = process.env.E2E_EXE ? path.resolve(process.env.E2E_EXE) : ''

/**
 * 异步启动（不能用 spawnSync）：fake 网关跑在本进程里，同步等待会阻塞事件循环，
 * 网关无法响应 → 主进程请求全部超时。
 */
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
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: EXE ? path.dirname(EXE) : ROOT, env })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    const guard = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, 180000)
    child.on('close', () => { clearTimeout(guard); resolve(out) })
  })
}

function parseEval(stdout) {
  const line = String(stdout || '').split('\n').find((l) => l.includes('[SMOKE][eval]'))
  if (!line) return null
  try {
    return JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
  } catch {
    return null
  }
}

async function main() {
  const { server, state, port } = await startFakeHanprint()
  preseed(port)
  let result = null
  try {
    const proc = await launch(EVAL, 'zero-percent.png')
    result = parseEval(proc)
    if (!result) {
      console.error('未取到渲染层结果，stdout 片段：')
      console.error(String(proc || '').split('\n').slice(-15).join('\n'))
      process.exitCode = 1
      return
    }
  } finally {
    server.close()
  }

  console.log('=== 一键填报：汉印 0% 条目不写入 ===')
  let failed = 0
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` → ${detail}`}`)
    if (!ok) failed += 1
  }

  if (result.fatal) {
    check(`渲染层前置步骤（${result.fatal}）`, false)
    process.exitCode = 1
    return
  }

  check('Z0 下班时间 09:30 → 预览 1.0h（构造 0 小时项目的前提）', result.pickedEnd && result.rangeTip.includes('1.0h'), result.rangeTip)
  check('Z0 生成报告不再要求先选项目（生成前未预选）', result.selectedBefore === 0, `selectedBefore=${result.selectedBefore}`)
  check('Z0 生成后默认勾选当天有提交的两个项目', result.selectedAfter === true)
  check('Z1 汉印条目只有 1 条（0% 的 Beta 不写入）', result.hpLines.length === 1, JSON.stringify(result.hpLines))
  check('Z1 该条目为 Alpha 任务且占比 100%', (result.hpLines[0] || '').includes('Alpha开发任务') && (result.hpLines[0] || '').includes('100%'), result.hpLines[0])
  check('Z1 占比合计仍为 100%（汉印硬约束）', /1 条 · 占比合计 100%/.test(result.hpTitle || ''), result.hpTitle)
  check('Z2 提示「有 1 个任务工时不足（占比 0%），不写入汉印」',
    (result.hints || []).some((h) => h.includes('占比 0%') && h.includes('1 个')), JSON.stringify(result.hints))
  check('Z4 0 小时的 Beta 仍出现在禅道任务汇总里',
    (result.sumLines || []).some((s) => s.includes(`#${TASK_BETA}`)), JSON.stringify(result.sumLines))
  check('Z5 取消勾选 Alpha 后按剩余子集重算：Beta 变 100%、Alpha 显示未选',
    result.alphaUnchecked === true
      && result.hpLinesAfter.length === 1
      && result.hpLinesAfter[0].includes('Beta开发任务')
      && result.hpLinesAfter[0].includes('100%')
      && result.rowHoursAfter.alpha === '未选'
      && result.rowHoursAfter.beta === '1h',
    JSON.stringify({ after: result.hpLinesAfter, hours: result.rowHoursAfter }))
  const seen = new Set(state.paths)
  const expectPaths = ['/login/getToken', '/com/workhour/GetDict', '/com/workhour/GetProjectList', '/com/workhour/GetProjectTaskList', '/com/workhour/GetByDate']
  const missing = expectPaths.filter((p) => !seen.has(p))
  check('Z3 真实客户端完成汉印 HTTP 链路（登录 → 字典 → 项目 → 任务 → 当日记录）', missing.length === 0, `缺少 ${missing.join(', ')}`)
  check('Z3 本次没有发生任何汉印写入请求', state.addBodies.length === 0, JSON.stringify(state.addBodies))

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
  if (failed) process.exitCode = 1
}

main().catch((e) => {
  console.error('E2E 异常:', e)
  process.exitCode = 1
})
