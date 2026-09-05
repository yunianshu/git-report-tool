/**
 * E2E（真实 Electron 环境）：部署设置 → 数据同步 → 应用登录密码输入框
 *
 * 背景：该输入框曾用「闭包变量 + 可写 computed」做输入缓冲，getter 无响应式依赖导致
 * 缓存永不失效，el-input 每次输入后会把输入框同步回旧值——表现为无法输入，且只把
 * 最后一个按键的字符写入表单落盘。修复后直绑 dataSync.importSecret（与 SSH 密码同一
 * 模式）；同时修复 dirty 检查未排除 dataSync 凭据键导致加载后恒报「有未保存修改」。
 *
 * 验收标准（源自需求「部署设置中的应用登录密码无法输入」+ 既有凭据语义）：
 *   A1 密码框逐字输入后内容保留（不被 el-input 的 modelValue 同步清空）
 *   A2 SSH 登录密码框仍可正常输入（回归）
 *   A3 加载已保存项目后基线不脏（无「有未保存修改」标记、测试连接可点击）
 *   A4 保存后磁盘为 safeStorage 加密对象，明文不落盘；importMode/importUser 持久化
 *   A5 二次启动显示掩码占位（留空保持）；留空保存后已存密文原样保留（不重加密、不清除）
 *
 * 前置：npm run build:renderer（驱动 dist/ 打包产物，不依赖 vite dev）
 * 用法：node scripts/deploy-import-secret-e2e.cjs [phase1|phase2|both]
 *   phase1 = 预置沙箱 + 首启（输入并保存）；phase2 = 二启（掩码 + 留空保持）
 *   PM_E2E_SANDBOX=<目录> 可复用已有沙箱单独重跑 phase2
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
// PM_E2E_SANDBOX 可复用已有沙箱（例如单独重跑 phase2）
const SANDBOX = process.env.PM_E2E_SANDBOX
  ? path.resolve(process.env.PM_E2E_SANDBOX)
  : path.join(os.tmpdir(), `pm-e2e-import-secret-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const PW = 'Smoke-Pass-123'
const SSH_PW = 'Ssh-Pass-9'
const SHOT_DIR = path.join(SANDBOX, 'shots')

const phase = process.argv[2] || 'both'
if (!['phase1', 'phase2', 'both'].includes(phase)) {
  console.error('用法: node scripts/_tmp-e2e-import-secret.cjs <phase1|phase2|both>')
  process.exit(2)
}

// ── 沙箱预置：一个已保存项目（dataSync 启用但未配导入命令，importSecret 未配置） ──
function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  const project = {
    id: 'dp_e2e_import',
    name: '冒烟项目',
    localPath: 'D:\\tmp\\some-project',
    version: { strategy: 'auto', manual: '' },
    composeFile: 'docker-compose.yml',
    deploy: {
      backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
      dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
      keepReleases: 10, keepBackups: 10,
    },
    targets: [{
      id: 't_e2e_1',
      name: '测试环境',
      server: { host: '192.0.2.10', port: 22, username: 'root', authType: 'password', keyPath: '' },
      remotePath: '/opt/apps/smoke',
      health: { enabled: true, url: '', timeout: 90, interval: 3 },
      dataSync: {
        enabled: true, localDir: 'data', remoteDir: 'shared/data',
        importMode: 'none', importCommand: 'bash {dataDir}/../deployer/import.sh {dataDir}',
        importUser: '', importSecret: null,
      },
    }],
  }
  fs.writeFileSync(path.join(USER_DATA, 'deploy-projects.json'), JSON.stringify({ projects: [project] }, null, 2))
  fs.mkdirSync(SHOT_DIR, { recursive: true })
}

const sleep = 'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))'

/** 在渲染层找按钮/复选框并点击的辅助（作为文本注入 eval） */
const helpers = `
  ${sleep}
  const btnByText = (txt) => [...document.querySelectorAll('button')].find(b => b.textContent.includes(txt))
  const checkboxByText = (txt) => [...document.querySelectorAll('.el-checkbox')].find(l => l.textContent.includes(txt))
  const waitFor = async (fn, ms = 5000, step = 100) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step) }
    return null
  }
  const typeInto = async (el, text) => {
    el.focus()
    const perChar = []
    for (const ch of text) {
      el.value += ch
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(60)
      perChar.push(el.value) // 每敲一键后的实时值（bug 场景会被清空）
    }
    await sleep(300) // 留足 el-input handleInput 的 nextTick + setNativeInputValue
    return { perChar, final: el.value }
  }
`

/** 首启：基线断言 → 开抽屉 → 勾导入命令 → 输入两处密码 → 保存 */
const EVAL1 = `(async () => {
  ${helpers}
  const r = { phase: 1 }
  // 等部署页就绪（项目列表已加载，出现「部署设置」按钮）
  const openBtn = await waitFor(() => btnByText('部署设置'))
  if (!openBtn) return { ...r, fatal: '部署页未就绪：找不到「部署设置」按钮' }
  // A3 基线：未修改任何内容时不应有「有未保存修改」，测试连接可点击
  r.baselineDirty = [...document.querySelectorAll('.el-tag')].some(t => t.textContent.includes('有未保存修改'))
  const connBtn = btnByText('测试连接')
  r.testConnDisabled = !connBtn || connBtn.disabled
  openBtn.click()
  await sleep(400)
  // 勾选「同步后执行导入命令」（数据同步本身已启用）
  const impCb = await waitFor(() => checkboxByText('同步后执行导入命令'))
  if (!impCb) return { ...r, fatal: '抽屉内找不到导入命令复选框' }
  impCb.querySelector('input').click()
  await sleep(300)
  // A1 应用登录密码：逐字输入
  const pwInput = await waitFor(() => document.querySelector('input[placeholder="应用登录密码"]'))
  if (!pwInput) return { ...r, fatal: '密码输入框未渲染' }
  const pw = await typeInto(pwInput, ${JSON.stringify(PW)})
  r.pwPerChar = pw.perChar
  r.pwRetained = pw.final === ${JSON.stringify(PW)}
  // 顺带填应用账号用户名（非凭据字段，验证整行可用）
  const userInput = document.querySelector('input[placeholder="应用登录用户名"]')
  if (userInput) { userInput.focus(); userInput.value = 'smoke-admin'; userInput.dispatchEvent(new Event('input', { bubbles: true })); await sleep(150) }
  // A2 SSH 登录密码回归
  const sshInput = document.querySelector('input[placeholder="SSH 登录密码"]')
  if (!sshInput) { r.sshMissing = true } else {
    const ssh = await typeInto(sshInput, ${JSON.stringify(SSH_PW)})
    r.sshRetained = ssh.final === ${JSON.stringify(SSH_PW)}
  }
  // 保存
  const saveBtn = await waitFor(() => btnByText('保存部署设置'))
  if (!saveBtn) return { ...r, fatal: '找不到保存按钮' }
  saveBtn.click()
  const closed = await waitFor(() => !document.querySelector('.deploy-config-drawer .el-drawer'), 8000)
  r.savedDrawerClosed = !!closed
  return r
})()`

/** 二启：掩码占位 + 留空保存保持密文 */
const EVAL2 = `(async () => {
  ${helpers}
  const r = { phase: 2 }
  const openBtn = await waitFor(() => btnByText('部署设置'))
  if (!openBtn) return { ...r, fatal: '部署页未就绪' }
  // 首启保存后 reload + fillForm，基线仍不应脏
  await sleep(500)
  r.baselineDirty = [...document.querySelectorAll('.el-tag')].some(t => t.textContent.includes('有未保存修改'))
  openBtn.click()
  await sleep(500)
  // A5 掩码占位（importSecretConfigured=true）。注意抽屉里有两个密码框：
  // SSH 密码占位符是「留空保持不变」，导入密码是「留空保持，输入新值替换」，按文案区分
  const masked = await waitFor(() => [...document.querySelectorAll('.deploy-config-drawer input[type="password"]')]
    .find(i => (i.getAttribute('placeholder') || '').includes('输入新值替换')))
  if (!masked) return { ...r, fatal: '导入密码输入框未渲染' }
  r.pwPlaceholder = masked.getAttribute('placeholder') || ''
  r.maskedShown = r.pwPlaceholder.includes('留空保持，输入新值替换')
  r.maskValueOk = r.pwPlaceholder.includes('••••••123')
  r.pwBlank = masked.value === ''
  // 留空直接保存 → 主进程应保留既有密文（不清除、不重加密）
  const saveBtn = await waitFor(() => btnByText('保存部署设置'))
  if (!saveBtn) return { ...r, fatal: '找不到保存按钮' }
  saveBtn.click()
  const closed = await waitFor(() => !document.querySelector('.deploy-config-drawer .el-drawer'), 8000)
  r.savedDrawerClosed = !!closed
  return r
})()`

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '25000',
    SMOKE_VIEW: '部署',
    SMOKE_CLICK_MS: '3000',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6500',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '5000',
  }
  return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], {
    cwd: ROOT, encoding: 'utf8', timeout: 90000, env,
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

function readSaved() {
  const f = path.join(USER_DATA, 'deploy-projects.json')
  return { raw: fs.readFileSync(f, 'utf8'), data: JSON.parse(fs.readFileSync(f, 'utf8')) }
}

let failedCount = 0
function assert(name, cond, detail) {
  if (cond) { console.log(`  PASS  ${name}`) } else { console.log(`  FAIL  ${name}  ${detail || ''}`); failedCount++ }
}

// ── 执行 ──
if (phase === 'phase1' || phase === 'both') {
  console.log('=== Phase 1：首启（沙箱预置 → 输入密码 → 保存）===')
  preseed()
  const p1 = launch(EVAL1, 'phase1.png')
  const stdout = p1.stdout || ''
  if (p1.status !== 0) console.log(`  (electron 退出码 ${p1.status})`)
  if (p1.stderr && /Error:/.test(p1.stderr)) console.log(`  stderr: ${p1.stderr.slice(0, 500)}`)
  const ev = parseEval(stdout)
  if (!ev) { console.log('  FAIL  未取到 eval 结果'); console.log(stdout.slice(-3000)); failedCount++ } else {
    if (ev.fatal) assert('页面就绪', false, ev.fatal)
    assert('A3 基线无「有未保存修改」', ev.baselineDirty === false, `baselineDirty=${ev.baselineDirty}`)
    assert('A3 测试连接未被禁用', ev.testConnDisabled === false, `disabled=${ev.testConnDisabled}`)
    assert('A1 应用登录密码逐字输入保留', ev.pwRetained === true, `final="${ev.pwFinal !== undefined ? ev.pwFinal : ''}" perChar=${JSON.stringify(ev.pwPerChar)}`)
    assert('A2 SSH 密码输入保留（回归）', ev.sshRetained !== false && !ev.sshMissing, `retained=${ev.sshRetained} missing=${ev.sshMissing}`)
    assert('保存后抽屉关闭', ev.savedDrawerClosed === true, `closed=${ev.savedDrawerClosed}`)
  }
  if (ev) {
    // 磁盘断言（保存失败时跳过部分）
    try {
      const { raw, data } = readSaved()
      const t = data.projects[0].targets[0]
      const ds = t.dataSync
      const isEnc = (o) => o && typeof o === 'object' && (o.enc || o.plain)
      assert('A4 importMode=command 已持久化', ds.importMode === 'command', `importMode=${ds.importMode}`)
      assert('A4 importUser 已持久化', ds.importUser === 'smoke-admin', `importUser=${ds.importUser}`)
      assert('A4 importSecret 为加密对象', isEnc(ds.importSecret), `value=${JSON.stringify(ds.importSecret)}`)
      assert('A4 SSH secret 为加密对象', isEnc(t.server.secret), `value=${JSON.stringify(t.server.secret)}`)
      if (ds.importSecret && ds.importSecret.enc) assert('A4 应用密码明文未落盘', !raw.includes(PW))
      if (t.server.secret && t.server.secret.enc) assert('A4 SSH 密码明文未落盘', !raw.includes(SSH_PW))
      fs.writeFileSync(path.join(SANDBOX, 'phase1-importSecret.json'), JSON.stringify(ds.importSecret))
    } catch (e) { console.log(`  FAIL  磁盘断言异常: ${e.message}`); failedCount++ }
  }
}

if (phase === 'phase2' || phase === 'both') {
  console.log('=== Phase 2：二启（掩码占位 → 留空保存保持密文）===')
  if (!fs.existsSync(path.join(USER_DATA, 'deploy-projects.json'))) {
    console.log('  FAIL  沙箱无 phase1 数据（先运行 phase1）'); failedCount++
  } else {
    const p2 = launch(EVAL2, 'phase2.png')
    const ev = parseEval(p2.stdout || '')
    if (!ev) { console.log('  FAIL  未取到 eval 结果'); console.log((p2.stdout || '').slice(-3000)); failedCount++ } else {
      if (ev.fatal) assert('页面就绪', false, ev.fatal)
      assert('A3 二启基线无「有未保存修改」', ev.baselineDirty === false, `baselineDirty=${ev.baselineDirty}`)
      assert('A5 密码框显示掩码占位（已配置）', ev.maskedShown === true, `placeholder="${ev.pwPlaceholder}"`)
      assert('A5 掩码为完整密码末 3 位（非单字符）', ev.maskValueOk === true, `placeholder="${ev.pwPlaceholder}"`)
      assert('A5 密码框留空（保持语义）', ev.pwBlank === true, `value="${ev.pwBlank}"`)
      assert('A5 留空保存成功', ev.savedDrawerClosed === true, `closed=${ev.savedDrawerClosed}`)
      try {
        const { raw, data } = readSaved()
        const enc1 = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'phase1-importSecret.json'), 'utf8'))
        const enc2 = data.projects[0].targets[0].dataSync.importSecret
        assert('A5 留空保存后密文保留且字节一致', JSON.stringify(enc1) === JSON.stringify(enc2), `before=${JSON.stringify(enc1)} after=${JSON.stringify(enc2)}`)
        if (enc2 && enc2.enc) assert('A5 明文仍未落盘', !raw.includes(PW))
      } catch (e) { console.log(`  FAIL  磁盘断言异常: ${e.message}`); failedCount++ }
    }
  }
}

console.log(`\n沙箱: ${SANDBOX}`)
if (failedCount > 0) process.exitCode = 1
console.log(failedCount === 0 ? '\n[全部通过]' : `\n[存在失败]（${failedCount} 项）`)
