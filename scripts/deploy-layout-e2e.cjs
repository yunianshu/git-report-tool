/**
 * E2E（真实 Electron + 沙箱主目录）：部署页布局——发布日志在发布卡右侧，发布历史下方通栏
 *
 * 需求：
 *   1) 发布日志区域显示在发布区域的右边
 *   2) 发布历史区域适应剩余宽度（占满下方整行）
 *
 * 验收标准（源自需求）：
 *   A1 三个卡片均渲染（发布 / 发布日志 / 发布历史）
 *   A2 发布日志卡在发布卡右侧且顶部对齐（同一行）
 *   A3 发布历史卡在下方，左右边界与容器一致（宽度=容器宽度）
 *   A4 发布历史与上排两卡不重叠
 *   A5 内容区无横向溢出
 *   B1 窄窗口（minWidth 1080，命中 1180px 断点）退化为单列：日志在发布下方，历史在最下方，三者同宽
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/deploy-layout-e2e.cjs
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-e2e-layout-${Date.now()}`)
const USER_DATA = path.join(SANDBOX, 'appdata')
const SHOT_DIR = path.join(SANDBOX, 'shots')
const PROJECT_DIR = path.join(SANDBOX, 'project')
const PROJ_FILE = path.join(USER_DATA, 'deploy-projects.json')
const PROJECT_ID = 'dp_e2e_layout'

function preseed() {
  fs.mkdirSync(USER_DATA, { recursive: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  fs.mkdirSync(PROJECT_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROJECT_DIR, 'docker-compose.yml'), 'services:\n  app:\n    image: nginx\n')
  fs.writeFileSync(PROJ_FILE, JSON.stringify({
    projects: [{
      id: PROJECT_ID,
      name: '布局验证项目',
      localPath: PROJECT_DIR,
      version: { strategy: 'manual', manual: '1.0.0' },
      composeFile: 'docker-compose.yml',
      deploy: {
        backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
        dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
        keepReleases: 10, keepBackups: 10,
      },
      targets: [{
        id: `${PROJECT_ID}_t1`, name: '环境甲',
        server: { host: '127.0.0.1', port: 59999, username: 'root', authType: 'password', keyPath: '' },
        remotePath: '/opt/apps/layout',
        health: { enabled: false, url: '', timeout: 90, interval: 3 },
        dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
      }],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(USER_DATA, 'deploy-history.json'), JSON.stringify({ records: [] }, null, 2))
}

/** 渲染层探针：返回三个卡片与容器的几何信息（同一视口坐标系，可横向/纵向比较） */
const EVAL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    if (document.querySelector('.deploy-main-column > .card')) break
    await sleep(150)
  }
  const cards = [...document.querySelectorAll('.deploy-main-column > .card')]
  const titleOf = (c) => (c.querySelector('.el-card__header')?.textContent || '').replace(/\\s+/g, ' ').trim()
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }
  }
  const box = document.querySelector('.deploy-main-column')
  const area = document.querySelector('.content-area')
  return {
    titles: cards.map(titleOf),
    cardCount: cards.length,
    box: rect(box),
    // 按内容定位，避免「发布」与「发布日志」标题前缀相同导致误判
    publish: rect(cards.find((c) => c.querySelector('.publish-btn'))),
    log: rect(cards.find((c) => c.querySelector('.log-box'))),
    history: rect(cards.find((c) => c.querySelector('.el-table'))),
    areaOverflowX: area ? area.scrollWidth - area.clientWidth : null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  }
})()`

function launch(evalScript, shotName, width, height) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: USER_DATA,
    SMOKE_EXIT_MS: '20000',
    SMOKE_VIEW: '部署',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '5000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '9000',
    SMOKE_WIDTH: String(width),
    SMOKE_HEIGHT: String(height),
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

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}
const near = (a, b, tol = 2) => Math.abs(a - b) <= tol

console.log('=== 部署页布局：发布日志在发布右侧 + 发布历史通栏 ===')
preseed()

// ─── 宽窗口（默认 1320）：日志在发布右侧，历史下方通栏 ───
console.log('\n[1] 默认窗口 1320×860')
const wide = launch(EVAL, 'layout-wide.png', 1320, 860)
const w = parseEval(wide.stdout || '')
if (!w) {
  console.log('  FAIL  未取到 eval 结果')
  console.log((wide.stdout || '').slice(-2500))
  failed++
} else {
  console.log('  几何:', JSON.stringify({ box: w.box, publish: w.publish, log: w.log, history: w.history }))
  assert('A1 三个卡片渲染（发布/发布日志/发布历史）',
    w.cardCount === 3 && w.log && w.history && w.publish, `titles=${JSON.stringify(w.titles)}`)
  assert('A2 发布日志在发布卡右侧（同一行）',
    w.log.left >= w.publish.right - 2 && near(w.log.top, w.publish.top, 3),
    `log.left=${w.log.left} publish.right=${w.publish.right} log.top=${w.log.top} publish.top=${w.publish.top}`)
  assert('A3 发布历史下方通栏（左右与容器一致）',
    near(w.history.left, w.box.left, 2) && near(w.history.right, w.box.right, 2) && near(w.history.width, w.box.width, 2),
    `history=[${w.history.left},${w.history.right}] box=[${w.box.left},${w.box.right}]`)
  assert('A4 发布历史与上排不重叠',
    w.history.top >= Math.max(w.publish.bottom, w.log.bottom) - 1,
    `history.top=${w.history.top} maxBottom=${Math.max(w.publish.bottom, w.log.bottom)}`)
  assert('A5 内容区无横向溢出', w.areaOverflowX !== null && w.areaOverflowX <= 1, `overflowX=${w.areaOverflowX}`)
}

// ─── 窄窗口（1080=minWidth，命中 1180 断点）：单列堆叠 ───
console.log('\n[2] 最小窗口 1080×700')
const narrow = launch(EVAL, 'layout-narrow.png', 1080, 700)
const n = parseEval(narrow.stdout || '')
if (!n) {
  console.log('  FAIL  未取到 eval 结果')
  console.log((narrow.stdout || '').slice(-2500))
  failed++
} else {
  console.log('  几何:', JSON.stringify({ box: n.box, publish: n.publish, log: n.log, history: n.history }))
  assert('B1 单列堆叠：日志在发布下方',
    near(n.log.left, n.publish.left, 2) && n.log.top >= n.publish.bottom - 1,
    `log.left=${n.log.left} publish.left=${n.publish.left} log.top=${n.log.top} publish.bottom=${n.publish.bottom}`)
  assert('B1 单列堆叠：历史在日志下方且三者同宽',
    n.history.top >= n.log.bottom - 1
      && near(n.history.width, n.publish.width, 2) && near(n.history.width, n.log.width, 2),
    `history.top=${n.history.top} log.bottom=${n.log.bottom} widths=${n.publish.width}/${n.log.width}/${n.history.width}`)
  assert('B1 窄窗口无横向溢出', n.areaOverflowX !== null && n.areaOverflowX <= 1, `overflowX=${n.areaOverflowX}`)
}

console.log('\n截图目录:', SHOT_DIR)
console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
process.exit(failed ? 1 : 0)
