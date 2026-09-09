/**
 * 端到端验证：内置 DeepSeek Harness（dsh web）的启动、进入与关闭
 *
 * 验收标准（源自需求）：
 *   H1 打开软件自动开启端口 —— 应用启动后自动拉起 dsh web，stdout 出现就绪行
 *   H2 进入 harness —— 侧栏「DeepSeek Harness」可进入，内嵌 webview 真实加载 GUI
 *   H3 服务可达且鉴权正确 —— 内嵌页经 token 握手后落到干净根地址（非 401）
 *   H4 关闭软件关闭服务 —— 应用退出后 dsh 子进程树消失、端口释放
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/harness-e2e.cjs
 *      E2E_EXE=<win-unpacked 可执行文件> node scripts/harness-e2e.cjs   # 验证打包产物
 */
const { spawnSync, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const USER_DATA = path.join(os.tmpdir(), `pm-harness-e2e-${Date.now()}`)
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

  // 等待 webview 真正挂载（dsh 首次启动需加载插件与前端资源）
  let wv = null
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    const el = q('webview')
    if (el && typeof el.getWebContentsId === 'function') {
      try { el.getWebContentsId(); wv = el; break } catch (e) { /* 尚未附加 */ }
    }
    await sleep(500)
  }
  r.webviewAttached = !!wv
  r.pill = (q('.harness-pill') || {}).textContent?.trim() || ''
  r.footer = (q('.harness-footer') || {}).textContent?.replace(/\\s+/g, ' ').trim() || ''
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
      r.guestBody = String(await wv.executeJavaScript('document.body.innerText.slice(0, 160)')).replace(/\\s+/g, ' ').trim()
    } catch (e) { r.guestBodyError = String(e && e.message || e) }
  }
  return r
})()`

const env = {
  ...process.env,
  PROJECT_MANAGER_USER_DATA: USER_DATA,
  SMOKE_HARNESS: '1',
  SMOKE_EXIT_MS: '100000',
  SMOKE_EVAL: EVAL,
  SMOKE_EVAL_MS: '1000',
  SMOKE_CLICK_MS: '600000', // 禁用冒烟默认切页，交由 EVAL 自己点击
}

const EXE = process.env.E2E_EXE || ''
const label = EXE ? '打包产物' : '开发版'
console.log(`=== DeepSeek Harness 内置服务 E2E（${label}） ===`)
console.log(`userData=${USER_DATA}`)

/** 统计仍存活的 dsh web 进程数 */
function dshProcessCount() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('wmic', ['process', 'where', "name='node.exe'", 'get', 'ProcessId,CommandLine', '/format:csv'], { encoding: 'utf8' })
      return out.split(/\r?\n/).filter((l) => l.includes('dsh') && l.includes('web')).length
    }
    const out = execFileSync('bash', ['-lc', "ps -eo args | grep -c '[d]sh web'"], { encoding: 'utf8' })
    return Number(out.trim()) || 0
  } catch { return -1 }
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
  { cwd: EXE ? path.dirname(EXE) : ROOT, encoding: 'utf8', timeout: 240000, env },
)
const stdout = String(p.stdout || '')

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
  console.log('未取到渲染层结果，stdout 尾部：')
  console.log(stdout.slice(-3000))
  process.exit(1)
}
const r = JSON.parse(evalLine.slice(evalLine.indexOf('[SMOKE][eval]') + '[SMOKE][eval]'.length).trim())
console.log('  渲染层结果:', JSON.stringify(r))

assert('H2 侧栏可进入 Harness 且 webview 挂载', r.menuFound === true && r.webviewAttached === true, `menu=${r.menuFound} webview=${r.webviewAttached} placeholder=${r.placeholder}`)
assert('H2b 服务状态显示运行中', r.pill === '运行中', `pill=${r.pill}`)
assert('H3 内嵌页握手后落到干净根地址（token 已换取 cookie）',
  !!r.guestUrl && !r.guestUrl.includes('token=') && new URL(r.guestUrl).pathname === '/',
  `guestUrl=${r.guestUrl}`)
assert('H3b GUI 真实渲染（非 401 空白页）',
  !!r.guestBody && !/401/.test(r.guestBody) && r.guestBody.length > 5,
  `body="${(r.guestBody || r.guestBodyError || '').slice(0, 120)}"`)

// H4：退出后服务消失
const after = dshProcessCount()
assert('H4 关闭软件后 dsh 服务进程消失', after >= 0 && after <= before, `before=${before} after=${after}`)
assert('H4b 监听端口已释放', !portBusy(PORT), `port ${PORT} 仍在监听`)

if (failed) {
  console.log('--- stdout 尾部 ---')
  console.log(stdout.slice(-2000))
}
console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过')
process.exit(failed ? 1 : 0)
