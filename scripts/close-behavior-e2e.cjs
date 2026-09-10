/**
 * E2E（真实 Electron + 沙箱主目录）：窗口关闭行为 —— 默认不杀死程序
 *
 * 需求：点关闭按钮不再直接退出程序；先给提醒，可选最小化或退出，默认最小化（不杀死）。
 *
 * 验收标准（源自需求，非按实现反推）：
 *   C1 关闭时先询问（默认动作=最小化到托盘），取消则窗口保留 —— 原生对话框由
 *      close-dialog-gui 手工场景覆盖（自动化无法点原生弹窗），本脚本验证 ask 分支被拦截
 *   C2 选最小化：窗口隐藏、进程存活（渲染层仍可执行）、托盘/二次启动可恢复窗口
 *   C3 选退出：进程真正退出（不等超时自杀）
 *   C4 偏好持久化：closeAction 落盘 config.json；偏好为 minimize 时关闭直接隐藏不弹框；
 *      隐藏状态下 app.quit() 仍能正常退出（isQuitting 放行）
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

  // ---------- 场景 1：ask + 选最小化 → 隐藏存活 → 二次启动唤起（C1/C2/C6）----------
  console.log('\n— 场景 1：关闭选最小化，进程存活，二次启动唤起 —')
  seedConfig({ roots: [] })
  const EVAL1 = `(async () => {
    window.gitReport.winClose()
    await new Promise((r) => setTimeout(r, 1000))
    return { triggered: true } // 走到这里 = 隐藏后渲染层仍在执行（进程存活）
  })()`
  const inst1 = startInstance({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '45000',
    SMOKE_EVAL: EVAL1,
    SMOKE_EVAL_MS: '6000',
    SMOKE_CLOSE_CHOICE: 'minimize',
  }, 'inst1')

  // 等 eval 执行（窗口已隐藏）后，以普通模式（参与抢锁）启动第二实例
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
  const posChoice = out1.indexOf('[SMOKE][close-choice] minimize')
  const posHidden = out1.indexOf('[SMOKE][win-hidden]')
  const posShown = out1.indexOf('[SMOKE][win-shown]')
  assert('C2 选最小化：窗口隐藏（主进程 win-hidden 探针）', posHidden >= 0, `stdout 尾部=${out1.slice(-400)}`)
  assert('C2 走询问分支的代入选择（close-choice 日志）', posChoice >= 0)
  assert('C2 隐藏顺序正确（先选择后隐藏）', posChoice >= 0 && posHidden > posChoice)
  assert('C2 隐藏后进程存活（渲染层仍执行到返回结果）', ev1 && ev1.triggered === true, `eval=${JSON.stringify(ev1)}`)
  assert('C6/C2 二次启动唤起已隐藏窗口（win-shown 探针）', posShown >= 0 && posShown > posHidden)
  assert('C6 第二实例未双开（自行退出且退出码 0）', secondExit.code === 0, `second.code=${secondExit.code}`)
  const cfg1 = readConfig()
  assert('C4 SMOKE 代入选择不写偏好（closeAction 保持 ask，启动迁移写盘的默认值可接受）', !cfg1 || (cfg1.closeAction !== 'minimize' && cfg1.closeAction !== 'quit'), `closeAction=${cfg1 && cfg1.closeAction}`)
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
    return { triggered: true } // 走到这里 = 隐藏后渲染层仍在执行（进程存活）
  })()`
  const r3 = await runSync({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '15000',
    SMOKE_EVAL: EVAL3,
    SMOKE_EVAL_MS: '6000',
    // 刻意不设 SMOKE_CLOSE_CHOICE：必须走 config 偏好路径而非冒烟代入
  }, 60000)
  const ev3 = parseEval(r3.stdout)
  const out3 = r3.stdout || ''
  assert('C4 偏好 minimize：点关闭直接隐藏（win-hidden 探针）', ev3 && ev3.triggered === true && out3.includes('[SMOKE][win-hidden]'), `eval=${JSON.stringify(ev3)} stdout 尾部=${out3.slice(-500)}`)
  assert('C4 未走冒烟对话框代入分支（无 close-choice 日志）', !out3.includes('[SMOKE][close-choice]'), '出现了代入分支日志')
  assert('C4 隐藏状态下 app.quit 正常退出（退出码 0）', r3.code === 0, `code=${r3.code}`)

  // ---------- 场景 4：关闭选退出 → 进程真正退出（C3）----------
  console.log('\n— 场景 4：关闭选退出，进程立即结束 —')
  seedConfig({ roots: [] })
  const EVAL4 = `(async () => {
    window.gitReport.winClose()
    return { triggered: true }
  })()`
  const t4 = Date.now()
  const r4 = await runSync({
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '120000', // 刻意放大：若退出失效，进程会活满 120s 被 kill
    SMOKE_EVAL: EVAL4,
    SMOKE_EVAL_MS: '6000',
    SMOKE_CLOSE_CHOICE: 'quit',
  }, 90000)
  assert('C3 选退出：进程自行退出（不等超时）', r4.code === 0 && Date.now() - t4 < 80000, `code=${r4.code} 耗时=${Date.now() - t4}ms`)
  assert('C3 日志走 quit 分支', (r4.stdout || '').includes('[SMOKE][close-choice] quit'), `stdout=${(r4.stdout || '').slice(-400)}`)

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留现场便于排查 */ }
  console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('E2E 运行异常：', e)
  process.exit(1)
})
