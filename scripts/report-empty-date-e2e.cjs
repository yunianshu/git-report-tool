/**
 * E2E（真实 Electron 环境）：报告页空日期校验 + 关键页面挂载冒烟
 *
 * 验收标准（源自修复需求）：
 *  A. 报告页清空日报日期后点「生成报告」→ 出现警告提示，且不进入扫描/收集阶段
 *     （修复前：since 为空串传给 git，所有仓库查询静默失败，误报「无提交记录」）
 *  B. 设置页（Git 活动源分区）正常挂载
 *  C. Harness 页正常挂载
 *  D. 全程无渲染层 JS 错误 / 加载失败
 *
 * 前置：npm run build:renderer
 * 用法：node scripts/report-empty-date-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-r1-smoke-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
fs.mkdirSync(USER_DATA, { recursive: true })

const EVAL = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const r = {}
  // ── A: 报告页 ──
  await (async () => { const t0 = Date.now(); while (Date.now() - t0 < 8000) { if (document.querySelector('.report-toolbar')) return; await sleep(120) } })()
  r.reportToolbar = !!document.querySelector('.report-toolbar')
  // 清空日报日期（native setter + input/change 事件，模拟用户手动清空）
  const inp = document.querySelector('.report-toolbar .el-date-editor input')
  if (inp) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    inp.focus()
    setter.call(inp, '')
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new Event('change', { bubbles: true }))
    await sleep(400)
  }
  r.dateCleared = !inp || inp.value === ''
  const btn = [...document.querySelectorAll('.report-toolbar button')].find(b => b.textContent.includes('生成报告'))
  if (btn) btn.click()
  await sleep(900)
  r.warningShown = !!document.querySelector('.el-message--warning')
  r.notCollecting = !document.querySelector('.phase-card')
  // ── B: 设置页 ──
  const toSettings = [...document.querySelectorAll('.el-menu-item')].find(e => e.textContent.trim() === '设置')
  if (toSettings) toSettings.click()
  await sleep(800)
  r.settingsMounted = !!document.querySelector('.settings-page')
  const toGit = [...document.querySelectorAll('.settings-sections .el-segmented__item, .settings-sections label')].find(e => e.textContent.includes('Git 活动'))
  if (toGit) toGit.click()
  await sleep(500)
  r.gitSection = !!document.querySelector('.settings-repo-card')
  // ── C: Harness 页 ──
  const toHarness = [...document.querySelectorAll('.el-menu-item')].find(e => e.textContent.includes('Harness'))
  if (toHarness) toHarness.click()
  await sleep(900)
  r.harnessMounted = !!document.querySelector('.harness-page')
  return r
})()`

const env = {
  ...process.env,
  USERPROFILE: SANDBOX,
  PROJECT_MANAGER_USER_DATA: USER_DATA,
  SMOKE_EXIT_MS: '40000',
  SMOKE_VIEW: '活动报告',
  SMOKE_EVAL: EVAL,
  SMOKE_EVAL_MS: '8000',
}
const p = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], {
  cwd: ROOT, encoding: 'utf8', timeout: 70000, env,
})
const out = String(p.stdout || '')
let ev = null
for (const line of out.split('\n')) {
  if (line.includes('[SMOKE][eval]')) { try { ev = JSON.parse(line.slice(line.indexOf('[SMOKE][eval]') + 14).trim()) } catch {} }
}
const rendererErrors = out.split('\n').filter(l => l.includes('[SMOKE][renderer:error]') || l.includes('[SMOKE][did-fail-load]'))
let failed = 0
const assert = (name, cond, detail) => { if (cond) console.log(`  PASS  ${name}`); else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ } }
if (!ev) {
  assert('取到 eval 结果', false, out.slice(-2000))
} else {
  assert('报告页工具条渲染', ev.reportToolbar)
  assert('日报日期已清空', ev.dateCleared)
  assert('空日期点生成出现警告提示（修复点）', ev.warningShown)
  assert('空日期不进入收集阶段（修复点）', ev.notCollecting)
  assert('设置页挂载', ev.settingsMounted)
  assert('Git 活动源分区可见', ev.gitSection)
  assert('Harness 页挂载', ev.harnessMounted)
}
assert('无渲染层错误', rendererErrors.length === 0, rendererErrors.join(' | '))
try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
console.log(failed ? `失败 ${failed} 项` : '全部通过')
process.exit(failed ? 1 : 0)
