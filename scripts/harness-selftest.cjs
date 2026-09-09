/**
 * 临时健壮性验证：端口占用 / 未安装 / 重启 / 幂等
 * 运行：node scripts/_verify-harness-robust.cjs
 */
const net = require('net')
const os = require('os')
const path = require('path')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!cond) failed++
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

async function occupy(port) {
  return await new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

;(async () => {
  // ── B1 端口占用 → 自动改用空闲端口 ──
  const blocker = await occupy(3080)
  const svc = require('../electron/harness-service')

  // ── B5 运行时优先级：内置优先于本机全局安装 ──
  const launch = svc.resolveLaunch()
  check('B5 优先使用内置运行时', launch.runtime === 'bundled', `runtime=${launch.runtime} dir=${launch.runtimeDir}`)

  const s1 = await svc.start({ port: 3080 })
  check('B1 端口被占用时自动换端口', s1.status === 'running' && s1.port !== 3080,
    `status=${s1.status} port=${s1.port} error=${s1.error}`)

  // ── B4 幂等：重复 start 复用同一进程 ──
  const s2 = await svc.start({ port: 3080 })
  check('B4 重复 start 复用同一进程', s2.pid === s1.pid && s2.status === 'running', `pid ${s1.pid} → ${s2.pid}`)

  // ── B3 重启：旧进程消失、新进程接管 ──
  const oldPid = s1.pid
  const s3 = await svc.restart({ port: 3080 })
  await sleep(1200)
  check('B3 重启后新进程接管', s3.status === 'running' && s3.pid !== oldPid, `pid ${oldPid} → ${s3.pid}`)
  check('B3b 重启后旧进程已退出', !alive(oldPid), `oldPid=${oldPid} alive=${alive(oldPid)}`)
  svc.stop()
  blocker.close()
  await sleep(500)

  // ── B6 启动中点停止：作废进行中的启动，随后仍可正常重新拉起 ──
  // （必须在 B2 前执行：B2 会把环境变量指向空目录以模拟未安装，污染后续用例）
  delete require.cache[require.resolve('../electron/harness-service')]
  const svc3 = require('../electron/harness-service')
  const inflight = svc3.start({ port: 0 })
  await sleep(1500) // 进入 starting（加载插件 / 等待服务地址）
  svc3.stop()
  const s6 = await inflight
  check('B6 启动中停止后结果为 stopped（不被就绪覆盖）', s6.status === 'stopped', `status=${s6.status}`)
  await sleep(800)
  const s7 = await svc3.start({ port: 0 })
  check('B6b 作废后可重新启动', s7.status === 'running' && s7.pid > 0, `status=${s7.status} error=${s7.error}`)
  svc3.stop()
  await sleep(500)

  // ── B2 未安装 → 明确安装提示（屏蔽内置运行时 + 临时空环境屏蔽本机 dsh）──
  const empty = path.join(os.tmpdir(), `pm-harness-empty-${Date.now()}`)
  process.env.APPDATA = empty
  process.env.ProgramFiles = empty
  process.env.USERPROFILE = empty
  process.env.DSH_HOME = path.join(empty, '.dsh')
  process.env.DSH_RUNTIME_DIR = path.join(empty, 'runtime') // 指向空目录 = 无内置运行时
  delete process.env.DSH_CLI
  // 重新加载模块以清空内部状态
  delete require.cache[require.resolve('../electron/harness-service')]
  const svc2 = require('../electron/harness-service')
  const s4 = await svc2.start()
  check('B2 未安装时给出安装提示', s4.status === 'error' && /npm i -g @deepseek-ai\/dsh/.test(s4.error), `error=${s4.error}`)

  console.log(failed ? `\n结果：${failed} 项失败` : '\n结果：全部通过')
  process.exit(failed ? 1 : 0)
})()
