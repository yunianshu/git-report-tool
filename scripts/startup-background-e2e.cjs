/**
 * E2E：打开应用时的后台任务时机与主进程流畅度
 *
 * 需求：打开应用时主进程不应被仓库预热（扫描 + 每仓库一个 git 子进程）占用，
 *       预热要等「进入主页（首帧已绘制）」之后再在后台跑，且功能不退化。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   C1 首帧在合理时间内出现（打开不被预热拖慢）
 *   C2 预热由「渲染层首帧」驱动启动，而不是 app ready 就启动（也不是兜底计时）
 *   C3 预热在独立进程里执行：预热进行中首页 IPC 往返时延保持流畅（最大值受限）
 *   C4 功能不退化：主页 Git 活动源数量、报告页收集、设置页强制扫描、仓库信息均正确
 *   C5 渲染层未上报首帧时（页面异常场景）仍有兜底启动，预热不会缺席
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/startup-background-e2e.cjs
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')
/** 指定打包产物可执行文件时，用分发形态验证（asar 内 utilityProcess 是否可用） */
const EXE = process.env.E2E_EXE || ''

/** 临时仓库数量：需让预热持续到 IPC 探针窗口内（真实机器为 77 个仓库，量级相当） */
const REPO_COUNT = 60
/** 首帧上限：改造前实测 2616ms（主进程被预热占用、窗口绘制被挤后），改造后 456ms */
const FCP_MAX_MS = 1500
/** 预热期间首页 IPC 往返时延上限：改造前实测最大 452ms；需求是「打开后不卡」 */
const IPC_MAX_MS = 300

const SANDBOX = path.join(os.tmpdir(), `pm-startup-bg-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const REPOS_ROOT = path.join(SANDBOX, 'repos')

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr || r.stdout}`)
}

/** 造 N 个真实 git 仓库（各含一条今天的提交），保证扫描与收集都真的执行 */
function seedRepos() {
  fs.mkdirSync(REPOS_ROOT, { recursive: true })
  for (let i = 0; i < REPO_COUNT; i++) {
    const dir = path.join(REPOS_ROOT, `repo-${String(i).padStart(2, '0')}`)
    fs.mkdirSync(dir, { recursive: true })
    git(['init', '-q'], dir)
    fs.writeFileSync(path.join(dir, 'README.md'), `repo ${i}\n`)
    git(['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', 'add', '-A'], dir)
    git(['-c', 'user.name=e2e', '-c', 'user.email=e2e@test', 'commit', '-q', '-m', `init repo ${i}`], dir)
  }
  console.log(`已创建 ${REPO_COUNT} 个临时仓库：${REPOS_ROOT}`)
}

function seedUserData() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.writeFileSync(path.join(USER_DATA, 'config.json'), JSON.stringify({
    roots: [REPOS_ROOT],
    excludes: [],
    identities: [{ name: 'e2e', email: 'e2e@test' }],
    harness: { autoStart: false },
    closeAction: 'quit',
  }, null, 2))
}

function startInstance(env) {
  // E2E_EXE 指向打包产物可执行文件时验证分发形态（asar 内工作进程能否加载）
  const child = spawn(EXE || process.execPath, EXE ? [] : [ELECTRON, '.'], {
    cwd: ROOT,
    env: { ...process.env, PROJECT_MANAGER_USER_DATA: USER_DATA, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stdout += d })
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout })))
  return { child, done, stdout: () => stdout }
}

function runSync(env, timeoutMs) {
  const inst = startInstance(env)
  const timer = setTimeout(() => { try { inst.child.kill() } catch { /* noop */ } }, timeoutMs)
  return inst.done.then((r) => { clearTimeout(timer); return r })
}

function parseEval(stdout) {
  for (const line of String(stdout).split('\n')) {
    if (line.includes('[SMOKE][eval]')) {
      try { return JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim()) } catch { return null }
    }
  }
  return null
}

/**
 * 主场景 eval：先记录首帧，再在预热进行中连续打点 IPC 往返时延，
 * 最后轮询等待主页指标与各功能路径的结果。
 */
const EVAL_MAIN = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const r = { repoCount: ${REPO_COUNT} }
  // 首帧：主进程被预热占用时，窗口绘制会被挤后，FCP 迟迟不出现——这里等它出现并记录时刻
  const fcpAt = () => {
    const e = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint')
    return e ? Math.round(e.startTime) : null
  }
  const tWait = performance.now()
  r.fcp = fcpAt()
  while (r.fcp === null && performance.now() - tWait < 8000) { await sleep(50); r.fcp = fcpAt() }
  r.fcpWaitMs = Math.round(performance.now() - tWait)
  r.dashboardPresent = !!document.querySelector('.dashboard-page')
  // 预热进行中的 IPC 往返时延（改造前预热在主进程内跑，这里会被拖到数百毫秒）。
  // 同时记录工作台指标文案：必须真的处在「正在扫描/正在加载」状态，探针窗口才算覆盖预热，
  // 否则（探针被推迟到预热结束之后）这条断言会变成假通过。
  const progressText = () => {
    const el = document.querySelector('.metric-item-action small')
    return el ? el.textContent.trim() : ''
  }
  const lat = []
  const progressSamples = []
  for (let i = 0; i < 40; i++) {
    progressSamples.push(progressText())
    const t = performance.now()
    try { await window.gitReport.configLoad() } catch (e) { /* noop */ }
    lat.push(Math.round(performance.now() - t))
    await sleep(150)
  }
  r.warmupDuringProbe = progressSamples.some((text) => text.includes('正在'))
  r.progressSamples = progressSamples.filter(Boolean).slice(0, 4)
  r.ipcMax = Math.max.apply(null, lat)
  r.ipcAvg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)
  r.ipcSamples = lat
  // 主页「Git 活动源」数量最终应等于仓库数（预热完成）
  const metric = () => document.querySelector('.metric-item-action strong')
  const t0 = performance.now()
  while (performance.now() - t0 < 90000) {
    if (metric() && Number(metric().textContent.trim()) === ${REPO_COUNT}) break
    await sleep(300)
  }
  r.metricCount = metric() ? Number(metric().textContent.trim()) : null
  r.metricWaitMs = Math.round(performance.now() - t0)
  // 报告页路径：collectCommits 走工作进程，结果应与预热一致
  try {
    const repos = await window.gitReport.warmup()
    r.warmupRepos = Array.isArray(repos) ? repos.length : -1
    const today = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const since = today.getFullYear() + '-' + pad(today.getMonth() + 1) + '-' + pad(today.getDate())
    const until = new Date(today.getTime() + 86400000)
    const untilStr = until.getFullYear() + '-' + pad(until.getMonth() + 1) + '-' + pad(until.getDate())
    const commits = await window.gitReport.collectCommits(repos, { since, until: untilStr, authors: [], includeMerges: false })
    r.commitCount = Array.isArray(commits) ? commits.length : -1
    // 设置页路径：强制重新扫描（force=true，绕过缓存）
    const rescanned = await window.gitReport.scanRepos([${JSON.stringify(REPOS_ROOT)}], [], true)
    r.rescanCount = Array.isArray(rescanned) ? rescanned.length : -1
    // 仓库信息（repoInfo 也走工作进程）
    const info = await window.gitReport.repoInfo(repos[0])
    r.repoInfo = { branch: info && info.branch, hasLastCommit: !!(info && info.lastCommit) }
  } catch (e) {
    r.featureError = String((e && e.message) || e)
  }
  return r
})()`

async function main() {
  console.log(`=== 后台任务时机 E2E（C1–C5）${EXE ? ' [打包产物]' : ' [开发版]'} ===`)
  seedRepos()
  seedUserData()

  // ---------- 场景 A：正常打开，预热应由首帧驱动、在独立进程后台执行（C1–C4）----------
  console.log('\n— 场景 A：打开应用，首帧后才启动预热，预热期间首页保持流畅 —')
  const a = await runSync({
    SMOKE_EXIT_MS: '150000',
    SMOKE_EVAL: EVAL_MAIN,
    SMOKE_EVAL_MS: '800',
    SMOKE_CLICK_MS: '600000', // 禁用冒烟默认的 3 秒切页（会把工作台切走，观测不到指标）
  }, 170000)
  const ev = parseEval(a.stdout)
  const out = a.stdout || ''
  if (!ev) {
    console.log('  渲染层 eval 未返回，stdout 尾部：')
    console.log(out.slice(-1500))
    failed++
  } else {
    console.log(`  首帧 FCP=${ev.fcp}ms（等待 ${ev.fcpWaitMs}ms 才出现）  首页已挂载=${ev.dashboardPresent}  预热期间 IPC 平均=${ev.ipcAvg}ms 最大=${ev.ipcMax}ms`)
    console.log(`  探针窗口内指标文案样本=${JSON.stringify(ev.progressSamples)}  覆盖预热进行中=${ev.warmupDuringProbe}`)
    console.log(`  主页 Git 活动源=${ev.metricCount}（等待 ${ev.metricWaitMs}ms）  预热仓库=${ev.warmupRepos}  今日提交=${ev.commitCount}  强制重扫=${ev.rescanCount}`)
    if (ev.featureError) console.log(`  功能路径异常：${ev.featureError}`)
    assert(`C1 首帧在 ${FCP_MAX_MS}ms 内出现（打开阶段未被预热拖慢）`, typeof ev.fcp === 'number' && ev.fcp < FCP_MAX_MS, `fcp=${ev.fcp}`)
    assert('C2 预热由渲染层首帧驱动启动', out.includes('后台任务启动（渲染层首帧）'), '未出现「（渲染层首帧）」日志')
    assert('C2 未走兜底计时（首帧上报有效）', !out.includes('后台任务启动（兜底计时）'), '出现了兜底启动')
    assert('C3 探针窗口确实覆盖预热进行中（避免假通过）', ev.warmupDuringProbe === true, `progressSamples=${JSON.stringify(ev.progressSamples)}`)
    assert(`C3 预热期间首页 IPC 最大往返 < ${IPC_MAX_MS}ms（后台执行不阻塞主进程）`, ev.ipcMax < IPC_MAX_MS, `max=${ev.ipcMax} samples=${JSON.stringify(ev.ipcSamples)}`)
    assert('C4 主页 Git 活动源数量等于仓库数', ev.metricCount === REPO_COUNT, `metricCount=${ev.metricCount}`)
    assert('C4 预热返回全部仓库', ev.warmupRepos === REPO_COUNT, `warmupRepos=${ev.warmupRepos}`)
    assert('C4 报告页收集到全部今日提交', ev.commitCount === REPO_COUNT, `commitCount=${ev.commitCount}`)
    assert('C4 设置页强制重扫返回全部仓库', ev.rescanCount === REPO_COUNT, `rescanCount=${ev.rescanCount}`)
    assert('C4 仓库信息可查询（repoInfo 经工作进程）', !!(ev.repoInfo && ev.repoInfo.hasLastCommit), JSON.stringify(ev.repoInfo))
  }

  // ---------- 场景 B：渲染层不上报首帧（页面异常）→ 兜底仍要启动预热（C5）----------
  console.log('\n— 场景 B：渲染层未上报首帧（空白页）时兜底启动预热 —')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!DOCTYPE html><html><body>blank</body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  // 兜底计时为 8 秒，这里给足预算（窗口 did-finish-load → 8s → 预热）
  const b = await runSync({
    ELECTRON_RENDERER_URL: `http://127.0.0.1:${port}/`,
    BACKGROUND_FALLBACK_MS: '3000',
    SMOKE_EXIT_MS: '20000',
  }, 40000)
  server.close()
  const outB = b.stdout || ''
  assert('C5 渲染层未上报时兜底启动后台任务', outB.includes('后台任务启动（兜底计时）'), `stdout 尾部=${outB.slice(-600)}`)
  assert('C5 兜底未误报为渲染层首帧', !outB.includes('后台任务启动（渲染层首帧）'), '出现了渲染层首帧启动')

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留现场便于排查 */ }
  console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('E2E 运行异常：', e); process.exit(1) })
