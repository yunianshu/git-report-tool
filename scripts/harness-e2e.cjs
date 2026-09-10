/**
 * 端到端验证：内置 DeepSeek Harness（dsh web）的启动、进入与关闭
 *
 * 验收标准（源自需求）：
 *   H1 打开软件自动开启端口 —— 应用启动后自动拉起 dsh web，stdout 出现就绪行
 *   H2 进入 harness —— 侧栏「DeepSeek Harness」可进入，内嵌 webview 真实加载 GUI
 *   H3 服务可达且鉴权正确 —— 内嵌页经 token 握手后落到干净根地址（非 401）
 *   H4 关闭软件关闭服务 —— 应用退出后 dsh 子进程树消失、端口释放
 *   H5 无需用户安装 —— 使用安装包内置运行时（bundled），并在全新主目录下自举
 *   H6 无需手工配置 —— 全新机器首次启动即写入内置 provider 配置（不含密钥）
 *   H7 配置真实生效 —— dsh 模型设置页出现内置 provider（汉印 / zai-coding-cn）
 *
 * 前置：npm run build:renderer（打包产物验证还需 npm run build:dir）
 * 用法：node scripts/harness-e2e.cjs
 *      E2E_EXE=<win-unpacked 可执行文件> node scripts/harness-e2e.cjs   # 验证打包产物
 */
const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseDocument } = require('yaml')

const ROOT = path.resolve(__dirname, '..')
const USER_DATA = path.join(os.tmpdir(), `pm-harness-e2e-${Date.now()}`)
/** 全新主目录：模拟「用户机器从未用过 dsh」——~/.dsh 不存在，需由内置运行时自举 */
const HOME_SANDBOX = path.join(os.tmpdir(), `pm-harness-home-${Date.now()}`)
const PORT = Number(process.env.HARNESS_E2E_PORT) || 3080

const EVAL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const r = {}

  // 进入「DeepSeek Harness」视图
  const menu = [...document.querySelectorAll('.el-menu-item')]
  const item = menu.find((e) => e.textContent.trim() === 'DeepSeek Harness')
  r.menuFound = !!item
  if (item) item.click()

  // 等待 webview 真正挂载（打包产物首跑还要先解包内置运行时，约 30 秒）
  let wv = null
  const t0 = Date.now()
  while (Date.now() - t0 < 150000) {
    const el = q('webview')
    if (el && typeof el.getWebContentsId === 'function') {
      try { el.getWebContentsId(); wv = el; break } catch (e) { /* 尚未附加 */ }
    }
    await sleep(500)
  }
  r.webviewAttached = !!wv
  r.pill = (q('.harness-pill') || {}).textContent?.trim() || ''
  r.footer = (q('.harness-footer') || {}).textContent?.replace(/\\s+/g, ' ').trim() || ''
  r.pid = Number((r.footer.match(/PID (\\d+)/) || [])[1] || 0)
  r.placeholder = (q('.harness-placeholder') || {}).textContent?.replace(/\\s+/g, ' ').trim().slice(0, 300) || ''

  if (wv) {
    // 等待握手重定向落到干净根地址
    const t1 = Date.now()
    let guestUrl = ''
    while (Date.now() - t1 < 30000) {
      guestUrl = wv.getURL() || ''
      if (guestUrl && !guestUrl.includes('token=')) break
      await sleep(500)
    }
    r.guestUrl = guestUrl
    r.guestTitle = wv.getTitle() || ''
    try {
      r.guestBody = String(await wv.executeJavaScript('document.body.innerText.slice(0, 4000)')).replace(/\\s+/g, ' ').trim()
    } catch (e) { r.guestBodyError = String(e && e.message || e) }

    // 进设置页 → 模型：内置 provider 若被 dsh 加载，会出现在模型设置里
    try {
      const clickText = async (text) => String(await wv.executeJavaScript(
        "(() => {const els=[...document.querySelectorAll('button, [role=button], a, div, span, li')];"
        + "const el=els.reverse().find((e)=>{const b=e.getBoundingClientRect();"
        + "return b.width>0 && b.height>0 && e.textContent.trim()===" + JSON.stringify(text) + "});"
        + "if(!el)return 'NO_BUTTON';el.click();return 'CLICKED';})()"))
      r.settingsClick = await clickText('设置')
      await sleep(2500)
      r.modelsClick = await clickText('模型')
      await sleep(2500)
      r.modelsText = String(await wv.executeJavaScript('document.body.innerText.slice(0, 3000)')).replace(/\\s+/g, ' ').trim()
    } catch (e) { r.settingsError = String(e && e.message || e) }
  }
  return r
})()`

const EXE = process.env.E2E_EXE || ''
const label = EXE ? '打包产物' : '开发版'
const env = {
  ...process.env,
  PROJECT_MANAGER_USER_DATA: USER_DATA,
  // 全新主目录（Windows 用 USERPROFILE，POSIX 用 HOME）：保证 ~/.dsh 不存在
  USERPROFILE: HOME_SANDBOX,
  HOME: HOME_SANDBOX,
  SMOKE_HARNESS: '1',
  // 打包产物首跑要先把内置运行时归档解包（约 30 秒），再启动 dsh
  SMOKE_EXIT_MS: process.env.SMOKE_EXIT_MS || (EXE ? '180000' : '100000'),
  SMOKE_EVAL: EVAL,
  SMOKE_EVAL_MS: '1000',
  SMOKE_CLICK_MS: '600000', // 禁用冒烟默认切页，交由 EVAL 自己点击
}

// 全新主目录（空目录，模拟从未用过 dsh 的机器）
fs.mkdirSync(HOME_SANDBOX, { recursive: true })
console.log(`=== DeepSeek Harness 内置服务 E2E（${label}） ===`)
console.log(`userData=${USER_DATA}`)
console.log(`全新主目录=${HOME_SANDBOX}`)

/**
 * 统计仍存活的 dsh web 进程数（内置模式下由 Electron 自身以 Node 模式运行，不能按 node.exe 过滤）。
 * 只统计本次被测形态（开发态 electron.exe / 打包产物 exe），避免把同时运行的另一形态计入。
 */
function dshProcessCount() {
  const marker = (EXE ? path.basename(EXE) : 'electron.exe').toLowerCase()
  if (process.platform === 'win32') {
    // 新系统（Win11 22H2+ / 新 Server）已默认移除 wmic（ENOENT）：
    // 优先 PowerShell CIM 查询，wmic 仅作老系统兜底，均失败才返回 -1
    try {
      const ps = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
        + 'Get-CimInstance Win32_Process | Where-Object CommandLine '
        + '| ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
      return out.split(/\r?\n/).filter((l) => /bin\.js/i.test(l) && /dsh/i.test(l) && /\bweb\b/.test(l)
        && l.toLowerCase().includes(marker)).length
    } catch { /* 回退 wmic */ }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const out = execFileSync('wmic', ['process', 'get', 'ProcessId,CommandLine', '/format:csv'], { encoding: 'utf8' })
        return out.split(/\r?\n/).filter((l) => /bin\.js/i.test(l) && /dsh/i.test(l) && /\bweb\b/.test(l)
          && l.toLowerCase().includes(marker)).length
      } catch { /* 重试 */ }
    }
    return -1
  }
  try {
    const out = execFileSync('bash', ['-lc', "ps -eo args | grep -c '[b]in.js.*dsh.*web'"], { encoding: 'utf8' })
    return Number(out.trim()) || 0
  } catch { return -1 }
}

/** 查询进程可执行文件路径（用于确认 dsh 跑在 Electron 自身而非额外 Node 上） */
function exePathOf(pid) {
  if (!pid) return ''
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'ExecutablePath', '/format:csv'], { encoding: 'utf8' })
      return out.split(/\r?\n/).map((l) => l.split(',').pop().trim()).filter(Boolean)[1] || ''
    }
    return execFileSync('bash', ['-lc', `ps -p ${pid} -o args= | head -1`], { encoding: 'utf8' }).trim()
  } catch { return '' }
}

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function portBusy(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' })
    return out.split(/\r?\n/).some((l) => l.includes(`127.0.0.1:${port}`) && l.includes('LISTENING'))
  } catch { return false }
}

const before = dshProcessCount()
const p = spawnSync(
  EXE || process.execPath,
  EXE ? [] : [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'],
  { cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: EXE ? 330000 : 150000, env },
)
const stdout = String(p.stdout || '')
if (process.env.E2E_DEBUG) {
  console.log('--- 子进程 SMOKE 日志 ---')
  for (const l of stdout.split('\n')) if (l.includes('[SMOKE]')) console.log(l.trim())
  console.log('--- 子进程 SMOKE 日志结束 ---')
}

let failed = 0
const assert = (name, cond, detail) => {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

// H1：应用启动即自动拉起服务
const startedLine = stdout.split('\n').find((l) => l.includes('[harness] 已启动')) || ''
assert('H1 打开软件自动开启端口（主进程自动拉起并输出就绪地址）', /\[harness\] 已启动 http:\/\/127\.0\.0\.1:\d+/.test(startedLine), startedLine || '(无输出)')

const evalLine = stdout.split('\n').find((l) => l.includes('[SMOKE][eval]'))
if (!evalLine) {
  // EVAL 抛错行出现在启动早期，会被后面的 harness 日志挤出尾部——先单独捞出
  const errLine = stdout.split('\n').find((l) => l.includes('[SMOKE][eval-err]'))
  if (errLine) console.log('渲染层 EVAL 抛错:', errLine.trim())
  console.log(`进程退出：status=${p.status} signal=${p.signal}${p.error ? ` error=${p.error.message}` : ''}`)
  console.log('未取到渲染层结果，stdout 尾部：')
  console.log(stdout.slice(-3000))
  process.exit(1)
}
const r = JSON.parse(evalLine.slice(evalLine.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
console.log('  渲染层结果:', JSON.stringify(r))

assert('H2 侧栏可进入 Harness 且 webview 挂载', r.menuFound === true && r.webviewAttached === true, `menu=${r.menuFound} webview=${r.webviewAttached} placeholder=${r.placeholder}`)
assert('H2b 服务状态显示运行中', r.pill === '运行中', `pill=${r.pill}`)
assert('H2c 服务运行中不显示“未运行”占位层', r.pill !== '运行中' || r.placeholder === '',
  `pill=${r.pill} placeholder=${r.placeholder}`)
assert('H3 内嵌页握手后落到干净根地址（token 已换取 cookie）',
  !!r.guestUrl && !r.guestUrl.includes('token=') && new URL(r.guestUrl).pathname === '/',
  `guestUrl=${r.guestUrl}`)
assert('H3b GUI 真实渲染（非 401 空白页）',
  !!r.guestBody && !/401/.test(r.guestBody) && r.guestBody.length > 5,
  `body="${(r.guestBody || r.guestBodyError || '').slice(0, 120)}"`)
assert('H5 使用安装包内置运行时（用户机器无需安装 dsh/Node）',
  /内置运行时/.test(r.footer || ''),
  `footer="${r.footer}"`)
assert('H5b 全新主目录下自动完成首次自举（生成 ~/.dsh）',
  fs.existsSync(path.join(HOME_SANDBOX, '.dsh')),
  `home=${HOME_SANDBOX} 内容=${fs.existsSync(HOME_SANDBOX) ? fs.readdirSync(HOME_SANDBOX).join(',') : '(不存在)'}`)
// 内置运行时以单文件归档随包分发，首次启动解包到 userData/runtime（安装包不必逐文件解压 2.6 万个文件）
const extractedDir = EXE
  ? path.join(USER_DATA, 'runtime')
  : path.join(ROOT, 'build', 'harness-runtime')
assert('H5c 内置运行时按需解包到用户数据目录且不含独立 Node 目录（复用 Electron 自带 Node）',
  fs.existsSync(path.join(extractedDir, 'dsh')) && !fs.existsSync(path.join(extractedDir, 'node')),
  `dir=${extractedDir} 内容=${fs.existsSync(extractedDir) ? fs.readdirSync(extractedDir).slice(0, 8).join(',') : '(不存在)'}`)
const shippedArchive = EXE
  ? path.join(path.dirname(EXE), 'resources', 'harness-runtime.tar.gz')
  : path.join(ROOT, 'build', 'harness-runtime.tar.gz')
assert('H5d 安装包以单个归档分发运行时（安装器只写 1 个文件，不再逐文件解压）',
  fs.existsSync(shippedArchive), `archive=${shippedArchive}`)

// H6/H7：内置默认 provider 配置（不含密钥）随安装包分发到全新机器
const sandboxSettings = path.join(HOME_SANDBOX, '.dsh', 'settings.yaml')
const sandboxText = fs.existsSync(sandboxSettings) ? fs.readFileSync(sandboxSettings, 'utf8') : ''
let sandboxProviders = null
try { sandboxProviders = parseDocument(sandboxText).toJS()['llm-pi-ai'].providers } catch { /* 解析失败下面断言会报 */ }
assert('H6 全新机器首次启动即写入内置 provider 配置',
  !!(sandboxProviders && sandboxProviders.hprt && sandboxProviders['zai-coding-cn']),
  `file=${sandboxSettings} providers=${sandboxProviders ? Object.keys(sandboxProviders).join(',') : '(无)'}`)
assert('H6b 内置配置只写凭据名、不含任何密钥值',
  /apiKeyEnv:\s*(HPRT|ZAI_CODING_CN)_API_KEY/.test(sandboxText) && !/sk-[A-Za-z0-9]|7aa4e4cf/.test(sandboxText))
assert('H7 dsh 模型设置页出现内置 provider（汉印 / zai-coding-cn）',
  /汉印/.test(r.modelsText || '') && /zai-coding-cn/.test(r.modelsText || ''),
  `modelsText=${(r.modelsText || r.settingsError || '').slice(0, 200)}`)

// H4：退出后服务消失
const after = dshProcessCount()
assert('H4 关闭软件后 dsh 服务进程消失', after >= 0 && after <= before, `before=${before} after=${after}`)
assert('H4a 状态栏所报服务进程已退出', r.pid > 0 && !alive(r.pid), `pid=${r.pid} alive=${alive(r.pid)}`)
// 端口以实际监听为准：3080 被其他实例占用时服务会回退到系统分配的空闲端口
const actualPort = Number((String(r.footer || '').match(/127\.0\.0\.1:(\d+)/) || [])[1] || PORT)
assert('H4b 监听端口已释放', !portBusy(actualPort), `port ${actualPort} 仍在监听`)

if (failed) {
  console.log('--- stdout 尾部 ---')
  console.log(stdout.slice(-2000))
}
console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过')
process.exit(failed ? 1 : 0)
