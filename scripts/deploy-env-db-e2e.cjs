/**
 * E2E（真实 Electron + 沙箱主目录）：数据库备份配置按部署环境独立
 *
 * 背景：数据库备份配置原为项目级（deploy.backupDatabase/dbType/dbContainer/dbName/dbUser），
 * 同一项目发布到测试/生产时用的是同一份配置——多环境下必然把 A 环境的容器名/库名用到 B 环境
 * （测试与生产是两个数据库实例）。现改为按部署目标存放（targets[].db），
 * 旧格式在读取时自动迁移到各目标，并已从项目级移除避免两份真源。
 *
 * 验收标准（源自需求「多环境各自的数据库备份配置」）：
 *   A1 部署设置出现「数据库备份（当前目标）」卡片；「部署选项」卡片不再包含该配置
 *   A2 旧格式（项目级）配置迁移到环境：首启即显示迁移后的容器名/库名，且开关为启用
 *   A3 切到另一个环境，显示的同样来自迁移（每个环境各自迁移）；编辑后保存互不覆盖
 *   A4 保存后磁盘：两个环境各自保留自己的 db 配置，项目级不再残留旧键
 *   B1 二启基线不脏（新增字段键集与主进程一致，无「有未保存修改」误报）
 *   B2 发布页「数据库备份」按钮按当前环境显隐：启用备份的环境出现、未启用的消失
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物，不依赖 vite dev）
 * 用法：node scripts/deploy-env-db-e2e.cjs [phase1|phase2|both]
 *   PM_E2E_SANDBOX=<目录> 可复用已有沙箱单独重跑 phase2
 *   PM_E2E_TARGET_EXE=<release/<版本>/win-unpacked/*.exe> 改跑打包成品（发版冒烟）
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = process.env.PM_E2E_SANDBOX
  ? path.resolve(process.env.PM_E2E_SANDBOX)
  : path.join(os.tmpdir(), `pm-e2e-env-db-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const PROJ_FILE = path.join(USER_DATA, 'deploy-projects.json')

const LEGACY = { container: 'pg-legacy', name: 'db_legacy', user: 'ulegacy' }
const TEST_NEW = { container: 'pg-test', name: 'db_test', user: 'utest' }

const phase = process.argv[2] || 'both'
if (!['phase1', 'phase2', 'both'].includes(phase)) {
  console.error('用法: node scripts/deploy-env-db-e2e.cjs <phase1|phase2|both>')
  process.exit(2)
}

/** 预置：一个项目两个环境，数据库备份配置仍是旧格式（项目级 deploy 下，target 无 db 字段） */
function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const mkTarget = (id, name, host, remotePath) => ({
    id,
    name,
    server: { host, port: 22, username: 'root', authType: 'password', keyPath: '' },
    remotePath,
    health: { enabled: false, url: '', timeout: 90, interval: 3 },
    dataSync: {
      enabled: false, localDir: 'data', remoteDir: 'shared/data',
      importMode: 'none', importCommand: '', importUser: '', importSecret: null,
    },
  })
  const project = {
    id: 'dp_e2e_envdb',
    name: '环境数据库验证',
    localPath: 'D:\\tmp\\some-project',
    version: { strategy: 'manual', manual: '1.0.0' },
    composeFile: 'docker-compose.yml',
    // 旧格式：数据库备份配置在项目级
    deploy: {
      backupCode: true, backupDatabase: true, dbType: 'postgres', dbContainer: LEGACY.container,
      dbName: LEGACY.name, dbUser: LEGACY.user, autoRollback: true, deleteUploadAfterSuccess: true,
      keepReleases: 10, keepBackups: 10,
    },
    targets: [
      mkTarget('t_env_prod', '生产', '192.0.2.20', '/opt/apps/env-prod'),
      mkTarget('t_env_test', '测试', '192.0.2.21', '/opt/apps/env-test'),
    ],
  }
  fs.writeFileSync(PROJ_FILE, JSON.stringify({ projects: [project] }, null, 2))
  fs.writeFileSync(path.join(USER_DATA, 'deploy-history.json'), JSON.stringify({ records: [] }, null, 2))
}

const sleep = 'const sleep=(ms)=>new Promise(r=>setTimeout(r,ms))'

/** 共享交互辅助（文本注入 eval） */
const helpers = `
  ${sleep}
  const btnByText = (txt) => [...document.querySelectorAll('button')].find(b => b.textContent.includes(txt))
  const waitFor = async (fn, ms = 8000, step = 120) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step) }
    return null
  }
  /** 选择器点击展开 → 选中指定文本的可见选项（EP 下拉经 teleport 挂在 body 上） */
  const pickOption = async (selEl, text) => {
    if (!selEl) return 'no-select'
    const trigger = selEl.querySelector('.el-select__wrapper') || selEl
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const opt = await waitFor(() => [...document.querySelectorAll('.el-select-dropdown__item')]
      .find(x => x.textContent.trim() === text && x.offsetParent !== null), 4000)
    if (!opt) return 'no-option'
    opt.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(450)
    return 'ok'
  }
  const setInput = async (el, text) => {
    if (!el) return false
    el.focus()
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(250)
    return el.value === text
  }
  /** 抽屉内「数据库备份（当前目标）」卡片的当前值 */
  const dbCard = () => [...document.querySelectorAll('.deploy-config-drawer .el-card')]
    .find(c => (c.querySelector('.el-card__header')?.textContent || '').includes('数据库备份（当前目标）'))
  const dbVal = () => {
    const card = dbCard()
    if (!card) return null
    const inputs = [...card.querySelectorAll('input')]
    const byPh = (ph) => inputs.find(i => (i.getAttribute('placeholder') || '') === ph)
    return {
      enabled: !!card.querySelector('.el-checkbox.is-checked'),
      container: (byPh('数据库容器名') || {}).value || '',
      name: (byPh('库名') || {}).value || '',
      user: (byPh('用户(可选)') || {}).value || '',
    }
  }
`

/** Phase 1：迁移可见 → 切环境编辑 → 保存 */
const EVAL1 = `(async () => {
  ${helpers}
  const r = { phase: 1 }
  const openBtn = await waitFor(() => btnByText('部署设置'))
  if (!openBtn) return { ...r, fatal: '部署页未就绪：找不到「部署设置」按钮' }
  // 基线：未改动时不应报脏（新增 db 字段的键集必须与主进程一致）
  r.baselineDirty = [...document.querySelectorAll('.el-tag')].some(t => t.textContent.includes('有未保存修改'))
  openBtn.click()
  await sleep(500)
  // A1 卡片归属
  const titles = [...document.querySelectorAll('.deploy-config-drawer .el-card__header')].map(h => h.textContent.replace(/\\s+/g, ' ').trim())
  r.cardTitles = titles
  r.dbCardExists = !!dbCard()
  const optCard = [...document.querySelectorAll('.deploy-config-drawer .el-card')]
    .find(c => (c.querySelector('.el-card__header')?.textContent || '').includes('部署选项'))
  r.optionsCardHasDb = optCard ? optCard.textContent.includes('发布前备份数据库') : null
  // A2 首个环境（生产）显示迁移后的旧配置
  r.prodVal = dbVal()
  // A3 切到测试环境：应同样拿到迁移值，再改成测试库
  const targetSel = await waitFor(() => document.querySelector('.deploy-config-drawer .target-row .el-select'))
  r.swTest = await pickOption(targetSel, '测试')
  r.testValBefore = dbVal()
  const card = dbCard()
  const inputs = card ? [...card.querySelectorAll('input')] : []
  const byPh = (ph) => inputs.find(i => (i.getAttribute('placeholder') || '') === ph)
  r.editContainer = await setInput(byPh('数据库容器名'), ${JSON.stringify(TEST_NEW.container)})
  r.editName = await setInput(byPh('库名'), ${JSON.stringify(TEST_NEW.name)})
  r.editUser = await setInput(byPh('用户(可选)'), ${JSON.stringify(TEST_NEW.user)})
  // 取消勾选「发布前备份数据库」：该环境不启用（用于 Phase 2 验证按钮随环境显隐）
  const cb = card && card.querySelector('.el-checkbox')
  if (cb && cb.classList.contains('is-checked')) { cb.querySelector('input').click(); await sleep(300) }
  r.testValAfterEdit = dbVal()
  const saveBtn = await waitFor(() => btnByText('保存部署设置'))
  if (!saveBtn) return { ...r, fatal: '找不到保存按钮' }
  saveBtn.click()
  const closed = await waitFor(() => !document.querySelector('.deploy-config-drawer .el-drawer'), 10000)
  r.savedDrawerClosed = !!closed
  return r
})()`

/** Phase 2：二启基线 + 发布页按环境显隐「数据库备份」按钮 */
const EVAL2 = `(async () => {
  ${helpers}
  const r = { phase: 2 }
  const openBtn = await waitFor(() => btnByText('部署设置'))
  if (!openBtn) return { ...r, fatal: '部署页未就绪' }
  await sleep(600)
  r.baselineDirty = [...document.querySelectorAll('.el-tag')].some(t => t.textContent.includes('有未保存修改'))
  const dbBtn = () => [...document.querySelectorAll('button')].find(b => b.textContent.includes('数据库备份'))
  const waitBtn = async (expect, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (!!dbBtn() === expect) return true; await sleep(120) }
    return false
  }
  const envSel = () => document.querySelector('.bar-card .el-select')
  // 生产启用备份 → 按钮出现
  r.swProd = await pickOption(envSel(), '生产')
  r.btnOnProd = await waitBtn(true)
  // 测试未启用 → 按钮消失（同一份项目配置，仅环境不同）
  r.swTest = await pickOption(envSel(), '测试')
  r.btnOnTest = await waitBtn(false)
  return r
})()`

function launch(evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '45000',
    SMOKE_VIEW: '部署',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '28000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '6000',
  }
  // 成品 stdout 中文经管道是 GBK 乱码，断言只依赖布尔/ASCII 字段
  if (process.env.PM_E2E_TARGET_EXE) {
    return spawnSync(process.env.PM_E2E_TARGET_EXE, [], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env })
  }
  return spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, env,
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

let failedCount = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failedCount++ }
}

if (phase === 'phase1' || phase === 'both') {
  console.log('=== Phase 1：旧配置迁移可见 → 切环境编辑 → 保存 ===')
  preseed()
  const p1 = launch(EVAL1, 'phase1.png')
  const stdout1 = p1.stdout || ''
  if (p1.status !== 0) console.log(`  (electron 退出码 ${p1.status})`)
  const ev = parseEval(stdout1)
  if (!ev) {
    console.log('  FAIL  未取到 eval 结果')
    console.log(stdout1.slice(-3000))
    failedCount++
  } else {
    if (ev.fatal) assert('抽屉打开并渲染', false, ev.fatal)
    assert('基线无「有未保存修改」（db 字段键集一致）', ev.baselineDirty === false, `dirty=${ev.baselineDirty}`)
    assert('A1 出现「数据库备份（当前目标）」卡片', ev.dbCardExists === true, `titles=${JSON.stringify(ev.cardTitles)}`)
    assert('A1 「部署选项」卡片已不含数据库备份配置', ev.optionsCardHasDb === false, `hasDb=${ev.optionsCardHasDb}`)
    assert('A2 生产环境显示迁移后的容器名',
      ev.prodVal && ev.prodVal.container === LEGACY.container, `prod=${JSON.stringify(ev.prodVal)}`)
    assert('A2 生产环境显示迁移后的库名与用户',
      ev.prodVal && ev.prodVal.name === LEGACY.name && ev.prodVal.user === LEGACY.user, `prod=${JSON.stringify(ev.prodVal)}`)
    assert('A2 生产环境备份开关为启用（继承旧配置）', ev.prodVal && ev.prodVal.enabled === true, `prod=${JSON.stringify(ev.prodVal)}`)
    assert('A3 切换环境成功', ev.swTest === 'ok', `swTest=${ev.swTest}`)
    assert('A3 测试环境同样拿到迁移值（每个环境各自迁移）',
      ev.testValBefore && ev.testValBefore.container === LEGACY.container, `testBefore=${JSON.stringify(ev.testValBefore)}`)
    assert('A3 环境级编辑生效', ev.editContainer && ev.editName && ev.editUser, `edits=${ev.editContainer}/${ev.editName}/${ev.editUser}`)
    assert('保存后抽屉关闭', ev.savedDrawerClosed === true, `closed=${ev.savedDrawerClosed}`)
  }
  if (ev) {
    try {
      const data = JSON.parse(fs.readFileSync(PROJ_FILE, 'utf8'))
      const proj = data.projects[0]
      const prod = proj.targets.find((t) => t.id === 't_env_prod')
      const test = proj.targets.find((t) => t.id === 't_env_test')
      assert('A4 生产环境配置未被测试环境编辑覆盖',
        prod.db.container === LEGACY.container && prod.db.enabled === true, `prod.db=${JSON.stringify(prod.db)}`)
      assert('A4 测试环境保存为其自身配置（容器/库名/用户）',
        test.db.container === TEST_NEW.container && test.db.name === TEST_NEW.name && test.db.user === TEST_NEW.user,
        `test.db=${JSON.stringify(test.db)}`)
      assert('A4 测试环境未启用备份（开关按环境独立）', test.db.enabled === false, `enabled=${test.db.enabled}`)
      assert('A4 项目级不再残留旧数据库键',
        !('backupDatabase' in proj.deploy) && !('dbContainer' in proj.deploy) && !('dbName' in proj.deploy) && !('dbType' in proj.deploy),
        `deploy=${JSON.stringify(proj.deploy)}`)
    } catch (e) { console.log(`  FAIL  磁盘断言异常: ${e.message}`); failedCount++ }
  }
}

if (phase === 'phase2' || phase === 'both') {
  console.log('=== Phase 2：二启基线 + 发布页按钮随环境显隐 ===')
  if (!fs.existsSync(PROJ_FILE)) {
    console.log('  FAIL  沙箱无 phase1 数据（先运行 phase1）'); failedCount++
  } else {
    const p2 = launch(EVAL2, 'phase2.png')
    const ev = parseEval(p2.stdout || '')
    if (!ev) {
      console.log('  FAIL  未取到 eval 结果')
      console.log((p2.stdout || '').slice(-3000))
      failedCount++
    } else {
      if (ev.fatal) assert('页面就绪', false, ev.fatal)
      assert('B1 二启基线无「有未保存修改」', ev.baselineDirty === false, `dirty=${ev.baselineDirty}`)
      assert('B2 切到生产环境成功', ev.swProd === 'ok', `swProd=${ev.swProd}`)
      assert('B2 生产环境（已启用备份）显示「数据库备份」按钮', ev.btnOnProd === true, `btnOnProd=${ev.btnOnProd}`)
      assert('B2 切到测试环境成功', ev.swTest === 'ok', `swTest=${ev.swTest}`)
      assert('B2 测试环境（未启用备份）不显示该按钮', ev.btnOnTest === true, `btnOnTest=${ev.btnOnTest}`)
    }
  }
}

console.log(`\n沙箱: ${SANDBOX}`)
console.log(failedCount === 0 ? '\n[全部通过]' : `\n[存在失败]（${failedCount} 项）`)
process.exit(failedCount ? 1 : 0)
