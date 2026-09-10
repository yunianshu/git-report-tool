/**
 * E2E（真实 Electron + 真实 Git 仓库 + 本地假 AI 网关）：
 * 发布历史「更新内容」——查看、AI 整理成大白话、打 Git 标签、AI 不可用时的降级
 *
 * 验收标准（源自需求「发布历史要能按 Git 提交记录给出更新内容；总结必须全部中文、
 * 不带专业词汇、通俗易懂；需要能打标签」）：
 *   A1 历史里该次发布显示「更新内容 - 查看」，点开弹窗有更新说明与原始提交记录
 *   A2 配好 AI 时点「用 AI 重新整理成大白话」→ 说明替换为 AI 正文，并标注已用 AI 整理
 *   A3 AI 收到的提示词明确要求「只能用中文和数字」
 *   A4 点「打标签」→ 真实仓库里出现标签 v1.0.1，且指向该次发布的提交
 *   A5 最终显示/落盘的说明不含英文（版本号除外）
 *   A6 没配 AI 时点整理 → 界面提示 AI 用不了，说明退回本地整理且仍有内容、仍不含英文
 *
 * 前置：npm run build:renderer（驱动 dist/ 产物）
 * 用法：node scripts/deploy-release-notes-e2e.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn, execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SANDBOX = path.join(os.tmpdir(), `pm-e2e-release-notes-${Date.now()}`)
const SHOT_DIR = path.join(SANDBOX, 'shots')
const REPO = path.join(SANDBOX, 'notes-repo')
const AI_TEXT = '· 修好了订单金额算错的问题\n· 页面上的操作入口更好找了'

let failed = 0
function assert(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`)
  else { console.log(`  FAIL  ${name}  ${detail || ''}`); failed++ }
}
const git = (args) => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

// ─────────────────── 假 AI 网关（只替外部 AI 系统，其余全是真实链路） ───────────────────
const aiCalls = []
function startFakeAi() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        try { aiCalls.push(JSON.parse(body || '{}')) } catch { aiCalls.push({ raw: body }) }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          model: 'e2e-model',
          choices: [{ message: { content: AI_TEXT }, finish_reason: 'stop' }],
        }))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// ─────────────────── 真实 Git 仓库 ───────────────────
function buildRepo() {
  fs.mkdirSync(REPO, { recursive: true })
  git(['init', '-q'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'e2e'])
  git(['config', 'commit.gpgsign', 'false'])
  const commit = (msg, file) => {
    fs.writeFileSync(path.join(REPO, file), `${msg}\n${Date.now()}\n`, 'utf8')
    git(['add', '-A'])
    git(['commit', '-q', '-m', msg])
    return git(['rev-parse', 'HEAD']).trim()
  }
  commit('feat：新增登录页', 'a.txt')
  git(['tag', 'v1.0.0'])
  const shipped = commit('chore: 整理代码', 'b.txt')
  return { shipped }
}

function seed(userData, { withAi, port, shipped }) {
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(path.join(userData, 'deploy-projects.json'), JSON.stringify({
    projects: [{
      id: 'dp_e2e_rn', name: '更新内容项目', localPath: REPO,
      version: { strategy: 'manual', manual: '1.0.1' },
      composeFile: 'docker-compose.yml',
      deploy: {
        backupCode: true, backupDatabase: false, dbType: 'postgres', dbContainer: '',
        dbName: '', dbUser: '', autoRollback: true, deleteUploadAfterSuccess: true,
        keepReleases: 10, keepBackups: 10,
      },
      targets: [{
        id: 'dp_e2e_rn_t1', name: '测试环境',
        server: { host: '192.0.2.20', port: 22, username: 'root', authType: 'password', keyPath: '' },
        remotePath: '/opt/apps/dp_e2e_rn', health: { enabled: false, url: '', timeout: 90, interval: 3 },
        dataSync: { enabled: false, localDir: 'data', remoteDir: 'shared/data', importMode: 'none', importCommand: '', importUser: '', importSecret: null },
      }],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(userData, 'deploy-history.json'), JSON.stringify({
    records: [{
      id: 'h_rn1', projectId: 'dp_e2e_rn', projectName: '更新内容项目', targetId: 'dp_e2e_rn_t1', targetName: '测试环境',
      type: 'deploy', version: '1.0.1', oldVersion: '', status: 'success',
      startedAt: Date.now() - 60000, finishedAt: Date.now() - 59000, durationMs: 1000,
      host: '192.0.2.20:22', remotePath: '/opt/apps/dp_e2e_rn', message: '发布成功', logFile: '', stages: {},
      gitHead: shipped, gitTag: '', gitAnchor: '上次发布 1.0.0 之后',
      gitCommits: [{ hash: shipped, date: '2026-09-11', subject: 'chore: 整理代码' }],
      changeSummary: withAi ? '（还没有生成更新说明）' : '（旧的说明）',
      changeSummarySource: 'local', changeSummaryAt: Date.now() - 59000,
    }],
  }, null, 2))
  if (withAi) {
    fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
      ai: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'e2e-key', model: 'e2e-model' },
    }, null, 2))
  }
}

// ─────────────────── 渲染层脚本 ───────────────────
function buildEval(mode) {
  return `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, ms = 20000, step = 150) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(step) }
    return null
  }
  const visible = (el) => !!(el && el.offsetParent !== null)
  // 按钮文本里的空格不可靠（Element Plus 的图标与文字间可能是空格或换行），两边都去掉空白再比
  const btnByText = (text) => [...document.querySelectorAll('button')]
    .find((b) => visible(b) && b.textContent.replace(/\\s+/g, '').includes(text.replace(/\\s+/g, '')))
  const rowOf = (version) => [...document.querySelectorAll('.deploy-card-history .el-table__body tbody tr')]
    .find((tr) => tr.textContent.includes(version))

  const r = { mode: ${JSON.stringify(mode)} }
  const table = await until(() => document.querySelector('.deploy-card-history .el-table__body tbody tr'), 15000)
  if (!table) return { fatal: '发布历史表未渲染' }
  const row = await until(() => rowOf('1.0.1'), 15000)
  if (!row) return { fatal: '未找到 1.0.1 的历史行', rows: [...document.querySelectorAll('.deploy-card-history tbody tr')].map((t) => t.textContent.trim()) }

  // A1：行内出现「更新内容 查看」入口
  const openBtn = [...row.querySelectorAll('button')].find((b) => b.textContent.includes('查看'))
  r.hasViewButton = !!openBtn
  if (!openBtn) return { ...r, fatal: '行内没有查看入口' }
  openBtn.click()

  const summaryEl = await until(() => document.querySelector('.change-summary'), 8000)
  if (!summaryEl) return { ...r, fatal: '弹窗未打开' }
  r.summaryBefore = summaryEl.textContent.trim()
  r.headBefore = (document.querySelector('.change-head') || {}).textContent || ''
  r.commitRows = document.querySelectorAll('.change-commits .commit-row').length
  r.hasCommitsTitle = !!(document.querySelector('.change-commits .el-collapse-item__header') || {}).textContent?.includes('原始提交记录')

  // A2/A6：点「用 AI 重新整理成大白话」
  const regen = btnByText('用 AI 重新整理')
  r.hasRegenButton = !!regen
  if (regen) {
    regen.click()
    // 等 AI 结果落地（弹窗说明变化或出现提示）
    await until(() => {
      const now = document.querySelector('.change-summary')
      const msg = document.querySelector('.el-message')
      return (now && now.textContent.trim() !== r.summaryBefore) || msg
    }, 25000)
    r.summaryAfter = ((document.querySelector('.change-summary') || {}).textContent || '').trim()
    r.headAfter = (document.querySelector('.change-head') || {}).textContent || ''
    const msg = document.querySelector('.el-message')
    r.message = msg ? msg.textContent.trim() : ''
  }

  // A4：打标签
  const tagBtn = btnByText('打标签')
  r.hasTagButton = !!tagBtn
  if (tagBtn) {
    r.tagInput = (document.querySelector('.tag-input input') || {}).value || ''
    tagBtn.click()
    await until(() => ((document.querySelector('.change-meta') || {}).textContent || '').includes('已打标签'), 20000)
    r.metaAfter = ((document.querySelector('.change-meta') || {}).textContent || '').trim()
    const msg = document.querySelector('.el-message')
    r.tagMessage = msg ? msg.textContent.trim() : ''
  }
  return r
})()`
}

function launch(userData, evalScript, shotName) {
  const env = {
    ...process.env,
    USERPROFILE: SANDBOX,
    PROJECT_MANAGER_USER_DATA: userData,
    SMOKE_EXIT_MS: '60000',
    SMOKE_VIEW: '部署',
    SMOKE_EVAL: evalScript,
    SMOKE_EVAL_MS: '6000',
    SMOKE_SCREENSHOT_PATH: path.join(SHOT_DIR, shotName),
    SMOKE_SHOT_MS: '9000',
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), '.'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    // 冒烟脚本自身会退出；超时兜底杀掉，避免挂死
    const killer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 75000)
    child.on('exit', () => { clearTimeout(killer); resolve(out) })
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

/** 说明文本里是否残留英文（版本号不算） */
const hasLatin = (t) => /[A-Za-z]/.test(String(t || '').replace(/v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.\-+]*)?/g, ''))

;(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  const shipped = buildRepo().shipped
  const { server, port } = await startFakeAi()

  // ── 场景一：配好 AI ──
  console.log('=== 发布更新内容：AI 可用 ===')
  const USER_DATA_A = path.join(SANDBOX, 'appdata-ai')
  seed(USER_DATA_A, { withAi: true, port, shipped })
  const evA = parseEval(await launch(USER_DATA_A, buildEval('ai'), 'release-notes-ai.png'))
  if (!evA) {
    assert('取到界面结果', false, '未取到 [SMOKE][eval] 输出')
  } else if (evA.fatal) {
    assert('界面就绪', false, JSON.stringify(evA))
  } else {
    assert('A1 历史行有「更新内容 查看」入口', evA.hasViewButton === true)
    assert('A1 弹窗展示更新说明与原始提交记录', !!evA.summaryBefore && evA.hasCommitsTitle === true && evA.commitRows === 1,
      `summary="${evA.summaryBefore}" commits=${evA.commitRows} title=${evA.hasCommitsTitle}`)
    assert('A2 有「用 AI 重新整理」入口', evA.hasRegenButton === true, JSON.stringify(evA))
    assert('A2 AI 整理后说明被替换', evA.summaryAfter === AI_TEXT, `实际="${evA.summaryAfter}"`)
    assert('A2 标注「已用 AI 整理成大白话」', String(evA.headAfter).includes('已用 AI 整理成大白话'), `head="${evA.headAfter}"`)
    assert('A3 提示词要求只用中文和数字', aiCalls.length >= 1 &&
      aiCalls.some((c) => String(((c.messages || [])[0] || {}).content || '').includes('只能用中文和数字')),
      `调用次数=${aiCalls.length}`)
    assert('A4 界面显示已打标签 v1.0.1', String(evA.metaAfter).includes('已打标签 v1.0.1'), `meta="${evA.metaAfter}"`)
    assert('A5 说明不含英文（版本号除外）', hasLatin(evA.summaryBefore) === false && hasLatin(evA.summaryAfter) === false,
      `before="${evA.summaryBefore}" after="${evA.summaryAfter}"`)
  }

  // 落盘校验：说明与 AI 正文一致且来源为 ai
  const savedA = JSON.parse(fs.readFileSync(path.join(USER_DATA_A, 'deploy-history.json'), 'utf8')).records.find((x) => x.id === 'h_rn1')
  assert('A2 落盘：说明=AI 正文 且来源为 ai', savedA && savedA.changeSummary === AI_TEXT && savedA.changeSummarySource === 'ai',
    JSON.stringify(savedA && { s: savedA.changeSummary, src: savedA.changeSummarySource }))

  // 仓库真实标签校验（A4 的另一半：界面之外必须真的打上）
  const tags = git(['tag', '--list'])
  const tagSha = tags.includes('v1.0.1') ? git(['rev-list', '-n', '1', 'v1.0.1']).trim() : ''
  assert('A4 仓库里真实存在标签 v1.0.1 且指向本次提交', tagSha === shipped, `tags="${tags.trim()}" sha=${tagSha} 期望=${shipped}`)
  assert('A4 标签写回历史记录', savedA && savedA.gitTag === 'v1.0.1', `gitTag="${savedA && savedA.gitTag}"`)

  // ── 场景二：没配 AI（真实降级路径） ──
  console.log('=== 发布更新内容：没配 AI 时的降级 ===')
  const USER_DATA_B = path.join(SANDBOX, 'appdata-noai')
  seed(USER_DATA_B, { withAi: false, port, shipped })
  const evB = parseEval(await launch(USER_DATA_B, buildEval('noai'), 'release-notes-noai.png'))
  if (!evB) {
    assert('取到界面结果（无 AI）', false, '未取到 [SMOKE][eval] 输出')
  } else if (evB.fatal) {
    assert('界面就绪（无 AI）', false, JSON.stringify(evB))
  } else {
    assert('A6 提示 AI 用不了', /未配置/.test(String(evB.message)), `message="${evB.message}"`)
    assert('A6 说明退回本地整理且仍有内容',
      String(evB.summaryAfter).includes('这次发布共更新了') && String(evB.summaryAfter).includes('整理代码'),
      `实际="${evB.summaryAfter}"`)
    assert('A6 本地整理不含英文前缀', hasLatin(evB.summaryAfter) === false, `实际="${evB.summaryAfter}"`)
    assert('A6 旧说明被真实整理结果替换', String(evB.summaryAfter) !== '（旧的说明）')
  }
  const savedB = JSON.parse(fs.readFileSync(path.join(USER_DATA_B, 'deploy-history.json'), 'utf8')).records.find((x) => x.id === 'h_rn1')
  assert('A6 落盘来源为 local 且内容非空', savedB && savedB.changeSummarySource === 'local' && String(savedB.changeSummary).includes('整理代码'),
    JSON.stringify(savedB && { s: savedB.changeSummary, src: savedB.changeSummarySource }))

  server.close()
  console.log(failed ? `\n结果: 失败 ${failed} 项` : '\n全部通过')
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* 保留截图便于排查 */ }
  process.exit(failed ? 1 : 0)
})().catch((e) => {
  console.error(e)
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { /* noop */ }
  process.exit(1)
})
