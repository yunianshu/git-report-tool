/**
 * E2E（真实 Electron + 沙箱主目录）：窗口关闭行为 —— 默认不杀死程序
 *
 * 需求：点关闭按钮不再直接退出程序；先给提醒（应用内 Element Plus 询问框，风格与项目一致），
 *       可选最小化或退出，默认最小化（不杀死）。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   C1 关闭时先弹出应用内询问框（ElMessageBox）：主按钮=最小化到托盘（回车默认），
 *      提供「退出程序」与「记住我的选择」复选框；×/ESC 取消保留窗口
 *   C2 选最小化：窗口隐藏、进程存活（渲染层仍可执行）、托盘/二次启动可恢复窗口
 *   C3 选退出：进程真正退出（不等超时自杀）
 *   C4 偏好持久化：勾选「记住」后 closeAction 落盘 config.json；偏好为 minimize 时
 *      关闭直接隐藏不弹框；隐藏状态下 app.quit() 仍能正常退出（isQuitting 放行）
 *   C5 设置页「应用信息」可改关闭行为，改动即保存落盘
 *   C6 单实例：常驻实例存在时再次启动应唤起已有窗口而不是双开（第二实例立即退出）
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/close-behavior-e2e.cjs
 */
const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-close-behavior-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const CONFIG_FILE = path.join(USER_DATA, 'config.json')

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js')

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}

function seedConfig(cfg) {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return null }
}

/** 异步启动一个 Electron 实例（真实进程，收集 stdout） */
function startInstance(env, tag) {
  const child = spawn(process.execPath, [ELECTRON, '.'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stdout += d })
  const done = new Promise((resolve) => child.on('exit', (code) => resolve({ code, stdout })))
  return { child, tag, stdout: () => stdout, done }
}

function killInstance(inst) {
  try { inst.child.kill() } catch { /* 已退出 */ }
}

/** 同步驱动一轮（进程自然退出或超时），返回 { code, stdout } */
function runSync(env, timeoutMs) {
  const inst = startInstance(env, 'sync')
  const timer = setTimeout(() => killInstance(inst), timeoutMs)
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

async function main() {
  console.log('=== 窗口关闭行为 E2E（C1–C6）===')

  // ---------- 场景 1：ask → 询问框点「最小化到托盘」→ 隐藏存活 → 二次启动唤起（C1/C2/C6）----------
  console.log('\n— 场景 1：关闭询问框点「最小化到托盘」，进程存活，二次启动唤起 —')
  seedConfig({ roots: [] })
  const EVAL1 = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
    const box = () => document.querySelector('.el-message-box')
    const waitFor = async (fn, ms, step = 120) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
      return false
    }
    window.gitReport.winClose()
    const shown = await waitFor(() => box(), 8000)
    const r = { shown }
    if (shown) {
      r.title = norm(box().querySelector('.el-message-box__title')?.textContent)
      r.buttons = [...box().querySelectorAll('.el-message-box__btns button')].map((b) => norm(b.textContent))
      r.primary = norm(box().querySelector('.el-message-box__btns .el-button--primary')?.textContent)
      r.checkbox = norm(box().querySelector('.el-checkbox__label')?.textContent)
      const btn = [...box().querySelectorAll('.el-message-box__btns button')].find((b) => norm(b.textContent) === '最小化到托盘')
      if (btn) btn.click()
      r.clicked = !!btn
      r.closed = await waitFor(() => !box(), 6000)
      await sleep(800) // winCloseConfirm → 主进程隐藏窗口
      r.aliveAfterHide = true // 走到这里 = 隐藏后渲染层仍在执行（进程存活）
    }
    return r
  })()`
  const inst1 = startInstance({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '45000',
    SMOKE_EVAL: EVAL1,
    SMOKE_EVAL_MS: '6000',
  }, 'inst1')

  // 等 eval 执行（询问框已点掉、窗口已隐藏）后，以普通模式（参与抢锁）启动第二实例
  await new Promise((r) => setTimeout(r, 12000))
  const second = startInstance({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
  }, 'inst2')
  const secondExit = await Promise.race([
    second.done,
    new Promise((r) => setTimeout(() => { killInstance(second); r({ code: 'TIMEOUT' }) }, 25000)),
  ])
  if (secondExit.code === 'TIMEOUT') killInstance(second)

  const r1 = await inst1.done
  const ev1 = parseEval(r1.stdout)
  const out1 = r1.stdout || ''
  const posHidden = out1.indexOf('[SMOKE][win-hidden]')
  const posShown = out1.indexOf('[SMOKE][win-shown]')
  assert('C1 关闭弹出应用内询问框（非原生）', ev1 && ev1.shown === true, `eval=${JSON.stringify(ev1)}`)
  assert('C1 询问框标题与按钮文案正确',
    ev1 && String(ev1.title).includes('关闭') && Array.isArray(ev1.buttons) && ev1.buttons.includes('最小化到托盘') && ev1.buttons.includes('退出程序'),
    `title=${ev1 && ev1.title} buttons=${JSON.stringify(ev1 && ev1.buttons)}`)
  assert('C1 主按钮（回车默认）= 最小化到托盘', ev1 && ev1.primary === '最小化到托盘', `primary=${ev1 && ev1.primary}`)
  assert('C1 提供记住选择复选框', ev1 && String(ev1.checkbox).includes('记住我的选择'), `checkbox=${ev1 && ev1.checkbox}`)
  assert('C2 点最小化到托盘后询问框关闭', ev1 && ev1.clicked === true && ev1.closed === true)
  assert('C2 窗口隐藏（主进程 win-hidden 探针）', posHidden >= 0, `stdout 尾部=${out1.slice(-400)}`)
  assert('C2 隐藏后进程存活（渲染层仍执行到返回结果）', ev1 && ev1.aliveAfterHide === true)
  assert('C6/C2 二次启动唤起已隐藏窗口（win-shown 探针）', posShown >= 0 && posShown > posHidden)
  assert('C6 第二实例未双开（自行退出且退出码 0）', secondExit.code === 0, `second.code=${secondExit.code}`)
  const cfg1 = readConfig()
  assert('C4 询问框未勾选记住时不写偏好', !cfg1 || (cfg1.closeAction !== 'minimize' && cfg1.closeAction !== 'quit'), `closeAction=${cfg1 && cfg1.closeAction}`)
  assert('C7 隐藏状态下超时退出码为 0（isQuitting 放行 close）', r1.code === 0, `code=${r1.code}`)

  // ---------- 场景 2：设置页改关闭行为 → 落盘（C5）----------
  console.log('\n— 场景 2：设置页「应用信息」改关闭行为并落盘 —')
  seedConfig({ roots: [] })
  const EVAL2 = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
    const segItems = () => [...document.querySelectorAll('.el-segmented__item')]
    // 进「应用信息」分节
    const about = segItems().find((x) => norm(x.textContent) === '应用信息')
    if (about) about.click()
    await sleep(500)
    // 关闭行为选择器在 .close-behavior 块内（与顶部分节同名组件，必须限定范围）
    const opt = [...document.querySelectorAll('.close-behavior .el-segmented__item')]
      .find((x) => norm(x.textContent) === '最小化到托盘')
    if (!opt) return { fatal: '未找到关闭行为选项', sections: segItems().map((x) => norm(x.textContent)) }
    opt.click()
    await sleep(800)
    const active = document.querySelector('.close-behavior .el-segmented__item.is-selected')
    return { picked: norm(active && active.textContent), message: norm(document.querySelector('.el-message')?.textContent) }
  })()`
  const r2 = await runSync({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '20000',
    SMOKE_VIEW: '设置',
    SMOKE_EVAL: EVAL2,
    SMOKE_EVAL_MS: '6000',
  }, 60000)
  const ev2 = parseEval(r2.stdout)
  const cfg2 = readConfig()
  assert('C5 设置页提供「最小化到托盘」选项并可选中', ev2 && ev2.picked === '最小化到托盘', `eval=${JSON.stringify(ev2)}`)
  assert('C5 选择后提示保存成功', ev2 && String(ev2.message).includes('已保存'), `message=${ev2 && ev2.message}`)
  assert('C5 closeAction=minimize 落盘 config.json', cfg2 && cfg2.closeAction === 'minimize', `config=${JSON.stringify(cfg2)}`)

  // ---------- 场景 3：偏好 minimize → 关闭直接隐藏不弹框；隐藏态可正常退出（C4）----------
  console.log('\n— 场景 3：偏好 minimize 时关闭直接隐藏（无询问）—')
  const EVAL3 = `(async () => {
    window.gitReport.winClose()
    await new Promise((r) => setTimeout(r, 1000))
    return { triggered: true, asked: !!document.querySelector('.el-message-box') } // 走到这里 = 隐藏后渲染层仍在执行（进程存活）
  })()`
  const r3 = await runSync({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '15000',
    SMOKE_EVAL: EVAL3,
    SMOKE_EVAL_MS: '6000',
  }, 60000)
  const ev3 = parseEval(r3.stdout)
  const out3 = r3.stdout || ''
  assert('C4 偏好 minimize：点关闭直接隐藏（win-hidden 探针）', ev3 && ev3.triggered === true && out3.includes('[SMOKE][win-hidden]'), `eval=${JSON.stringify(ev3)} stdout 尾部=${out3.slice(-500)}`)
  assert('C4 偏好 minimize：不弹询问框', ev3 && ev3.asked === false, `asked=${ev3 && ev3.asked}`)
  assert('C4 隐藏状态下 app.quit 正常退出（退出码 0）', r3.code === 0, `code=${r3.code}`)

  // ---------- 场景 4：ask → 勾选记住 + 点「退出程序」→ 进程真正退出并落盘（C3/C4）----------
  console.log('\n— 场景 4：询问框勾选记住并点「退出程序」，进程退出且偏好落盘 —')
  seedConfig({ roots: [] })
  const EVAL4 = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
    const box = () => document.querySelector('.el-message-box')
    const waitFor = async (fn, ms, step = 120) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) }
      return false
    }
    window.gitReport.winClose()
    const shown = await waitFor(() => box(), 8000)
    if (!shown) return { fatal: '询问框未出现' }
    box().querySelector('.el-checkbox')?.click() // 勾选「记住我的选择」
    await sleep(300)
    const checked = box().querySelector('.el-checkbox')?.classList.contains('is-checked')
    const btn = [...box().querySelectorAll('.el-message-box__btns button')].find((b) => norm(b.textContent) === '退出程序')
    if (btn) btn.click()
    await sleep(3000) // 进程在此期间退出，eval 不会返回
    return { stillAlive: true, checked }
  })()`
  const t4 = Date.now()
  const r4 = await runSync({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '120000', // 刻意放大：若退出失效，进程会活满 120s 被 kill
    SMOKE_EVAL: EVAL4,
    SMOKE_EVAL_MS: '6000',
  }, 90000)
  const cfg4 = readConfig()
  assert('C3 点退出程序：进程自行退出（不等超时）', r4.code === 0 && Date.now() - t4 < 80000, `code=${r4.code} 耗时=${Date.now() - t4}ms`)
  assert('C3 退出前未走隐藏分支', !(r4.stdout || '').includes('[SMOKE][win-hidden]'), '出现了 win-hidden 日志')
  assert('C4 勾选记住后 closeAction=quit 落盘', cfg4 && cfg4.closeAction === 'quit', `config=${JSON.stringify(cfg4)}`)

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留现场便于排查 */ }
  console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 运行异常：', e)
  process.exit(1)
})
