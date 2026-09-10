/**
 * 一键填报 —— Git 提交 → 工时计划 → 禅道任务工时
 *
 * 工时算法移植自 wenxu/KnowMore worktime-sync（锚点累进法）：
 * - 每条提交的工时 = 本提交时间 − 上一锚点（首条锚点为上班时间），自动扣除午休重叠
 * - 每段按 30 分钟向下取整（0.5h 步进，不足半小时的尾数舍弃）
 * - 取整后为 0 的段自动并入下一条提交的工作说明（尾部并入上一条）
 *
 * 与活动报告的 git-service.collectCommits 不同：这里需要每条提交的 HH:MM
 * （工时按提交时刻切分），故独立查询（--date=format:%Y-%m-%d %H:%M）。
 */
const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const store = require('./store')
const { execGit } = require('./git-service')
const zentao = require('./zentao-service')
const hanprint = require('./hanprint-service')

// ─── 工时计算（纯函数） ───
// 语义：工时与 git 提交时刻完全无关——总工时 = 页面填写的实际上班时间 → 终点
//（填报今天为点击生成报告的时刻，含加班；补填历史日期为下班时间），扣午休后按
// 0.5 小时整体向下取整；各项目按提交条数占总数的比例分配总工时（0.5h 取整、总和守恒）。

function hm(s) {
  const [h, m] = String(s).split(':').map(Number)
  return h * 60 + m
}

/** HH:MM 合法性（IPC 可被直接调用，不能只依赖页面控件产生的值） */
function validHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim())
  if (!m) return false
  const h = Number(m[1])
  const mi = Number(m[2])
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/** 两个时间点之间的工作分钟数，扣除与午休的重叠 */
function workMinutes(start, end, lunchS, lunchE) {
  if (end <= start) return 0
  const overlap = Math.max(0, Math.min(end, lunchE) - Math.max(start, lunchS))
  return (end - start) - overlap
}

/**
 * 尾段终点：页面显式填写的下班/加班结束时间优先（支持跨夜，如「00:30」表示次日凌晨）；
 * 未填写时一律取点击生成报告的当前时刻，不区分填报日期——补填历史日期时「现在」
 * 同样是已知的终点，设置页不再有固定下班时间。now 可注入以便自测。
 */
function resolveEndTime(now = new Date(), explicitEnd = '') {
  if (explicitEnd) return explicitEnd
  const p = (n) => String(n).padStart(2, '0')
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return `${p(Math.floor(nowMin / 60))}:${p(nowMin % 60)}`
}

/**
 * 工时区间是否跨夜：终点早于上班时间即视为次日
 * （如 08:30 上班、次日 00:30 加班结束）。
 */
function isCrossDay(startTime, endTime) {
  return hm(endTime) < hm(startTime)
}

// ─── 按项目聚合（一个项目一条工时记录，内容为简洁编号列表） ───

/** Conventional Commits 前缀剥离（与活动报告「复制」按钮的口径一致） */
const PREFIX_RE = /^(feat|fix|refactor|docs|style|test|chore|perf|ci|build|revert|init|types?)(\([^)]*\))?\s*[:：]\s*/i

function stripPrefix(subject) {
  return String(subject || '').replace(PREFIX_RE, '').trim()
}

/**
 * 工时分配（与提交时刻无关）：
 * - 总工时 = workMinutes(实际上班时间, endTime) 扣午休后按 step 整体取整；
 *   crossDay=true 表示终点在次日（加班跨夜，如 08:30 → 次日 00:30）
 * - 各项目工时 = 总工时 × 该项目提交数 / 总提交数，0.5h 向下取整；
 *   余量补给提交最多的项目，保证 Σ = 总工时
 * - 说明 = 去类型前缀的编号列表（同活动报告复制格式）
 */
function distributeByProject(commits, { startTime, endTime, lunchStart, lunchEnd, step = 30, crossDay = false } = {}) {
  const sorted = [...(commits || [])].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  if (!sorted.length) return []
  const startMin = hm(startTime || '08:30')
  const endMin = hm(endTime || '17:30') + (crossDay ? 24 * 60 : 0)
  const totalMin = workMinutes(startMin, endMin, hm(lunchStart || '12:00'), hm(lunchEnd || '13:00'))
  const totalHours = round2(Math.floor(totalMin / step) * step / 60)

  const groups = new Map()
  for (const c of sorted) {
    const key = String(c.projectId === undefined ? '' : c.projectId)
    if (!groups.has(key)) groups.set(key, { projectId: c.projectId, projectName: c.projectName || key, commits: [] })
    groups.get(key).commits.push(c)
  }
  const total = sorted.length
  const list = [...groups.values()].map((g) => {
    const raw = totalHours * g.commits.length / total
    const hours = Math.floor(raw * 2) / 2 // 0.5h 向下取整
    return { projectId: g.projectId, projectName: g.projectName, commits: g.commits, hours, rawHours: round2(raw) }
  })
  const assigned = round2(list.reduce((s, g) => s + g.hours, 0))
  const rest = round2(totalHours - assigned)
  if (rest !== 0 && list.length) {
    const target = [...list].sort((a, b) => b.commits.length - a.commits.length)[0]
    target.hours = round2(Math.max(0, target.hours + rest))
  }
  for (const g of list) {
    g.commitCount = g.commits.length
    g.work = g.commits.map((c, i) => `${i + 1}. ${stripPrefix(c.msg)}`).join('\n')
    delete g.commits
  }
  return list
}

// ─── 提交收集（带 HH:MM） ───

const TIMED_LOG_FMT = '%H%x09%ad%x09%an%x09%ae%x09%s'

/** 解析 git log 输出行：hash ⇥ YYYY-MM-DD HH:MM ⇥ 作者名 ⇥ 邮箱 ⇥ 主题 */
function parseTimedLines(project, repo, stdout) {
  const list = []
  for (const line of String(stdout || '').split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const [hash, datetime, authorName, authorEmail, ...rest] = parts
    if (!hash || !datetime) continue
    list.push({
      hash: hash.slice(0, 10),
      datetime,
      time: datetime.length >= 16 ? datetime.slice(11, 16) : '',
      authorName,
      authorEmail,
      msg: rest.join('\t'),
      repo,
      projectId: project.id,
      projectName: project.name,
    })
  }
  return list
}

function isMine(commit, identities) {
  return (identities || []).some(
    (id) => (id.email && commit.authorEmail === id.email) || (id.name && commit.authorName === id.name),
  )
}

/** 本地时区日期加减天数（YYYY-MM-DD） */
function addDaysLocal(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 收集多个项目全部仓库在指定日期的本人提交（并发，按时间升序稳定排序）。
 *
 * git log 的 --since 是「遍历剪枝」而非事后过滤：当分支头提交时间早于 since 时，
 * 整条链被剪掉，链上时间乱序（rebase/amend）的提交会漏。故 since 前推 7 天作
 * 保护窗，拉回后按作者日期（%ad）在内存中精确过滤到目标日；--until 同理交给
 * 内存过滤，避免 committer date 与 author date 口径不一致造成误差。
 */
/** 收集并发上限：仓库多时避免 Promise.all 同时 spawn 大量 git 进程（进程风暴） */
const COLLECT_CONCURRENCY = 8

/** 固定并发池：按序消费任务，保持结果顺序 */
async function runPool(tasks, job) {
  const results = new Array(tasks.length)
  let next = 0
  const workers = Math.max(1, Math.min(COLLECT_CONCURRENCY, tasks.length))
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= tasks.length) return
      results[i] = await job(tasks[i]) // eslint-disable-line no-await-in-loop
    }
  }))
  return results
}

async function collectTimedCommits(projects, { date, identities }) {
  const seen = new Set()
  const repos = []
  for (const project of projects || []) {
    for (const repo of project.repos || []) {
      if (!repo) continue
      const key = process.platform === 'win32' ? String(repo).replace(/\\/g, '/').toLowerCase() : repo
      if (seen.has(key)) continue
      seen.add(key)
      repos.push({ repo, project })
    }
  }
  const lookbackDate = addDaysLocal(date, -7)
  const results = await runPool(repos, async ({ repo, project }) => {
    const res = await execGit(repo, [
      'log', '--all',
      `--since=${lookbackDate} 00:00:00`,
      '--no-merges',
      `--pretty=tformat:${TIMED_LOG_FMT}`,
      '--date=format:%Y-%m-%d %H:%M',
    ])
    return res.ok ? parseTimedLines(project, repo, res.stdout) : []
  })
  const all = results.flat().filter((c) => c.datetime.slice(0, 10) === date && c.time && isMine(c, identities))
  // 升序稳定排序：同时刻提交保持收集顺序（与 KnowMore parse_commits 的稳定排序一致）
  return all.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
}

// ─── 项目 ↔ 禅道任务绑定（userData/fill-bindings.json，绑定一次长期生效） ───

function bindingsFile() {
  return path.join(app.getPath('userData'), 'fill-bindings.json')
}

function listBindings() {
  try {
    return JSON.parse(fs.readFileSync(bindingsFile(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function saveBindings(map) {
  const file = bindingsFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 })
}

function bindProject(projectId, taskId, taskName) {
  if (!projectId) throw new Error('缺少项目 ID')
  if (!taskId) throw new Error('缺少禅道任务 ID')
  const map = listBindings()
  map[String(projectId)] = { taskId: Number(taskId), taskName: String(taskName || ''), boundAt: new Date().toISOString() }
  saveBindings(map)
  return map[String(projectId)]
}

function unbindProject(projectId) {
  const map = listBindings()
  delete map[String(projectId)]
  saveBindings(map)
  return true
}

/** 按名称互相包含给出绑定建议（KnowMore 匹配规则的项目名部分；不自动绑定） */
function suggestTask(projectName, tasks) {
  const name = String(projectName || '')
  if (!name) return null
  for (const t of tasks || []) {
    if (name.includes(t.name) || t.name.includes(name)) return t.id
  }
  return null
}

// ─── 提交汇总（移植 KnowMore buildZt：left = 原剩余 − 本次总消耗，最低为 0） ───

function buildSubmitTasks(planned, ztTasks, date) {
  const byId = new Map((ztTasks || []).map((t) => [String(t.id), t]))
  const byTask = new Map()
  for (const p of planned || []) {
    if (!p.taskId) continue
    const key = String(p.taskId)
    if (!byTask.has(key)) byTask.set(key, [])
    byTask.get(key).push({ date, work: p.work, consumed: p.hours })
  }
  const tasks = []
  for (const [key, rows] of byTask) {
    const t = byId.get(key)
    const consumed = round2(rows.reduce((s, r) => s + r.consumed, 0))
    const left = Math.max(0, round2((t ? t.left : 0) - consumed))
    for (const r of rows) r.left = left
    tasks.push({
      taskId: Number(key),
      taskName: t ? t.name : '',
      taskLeft: t ? t.left : null, // 禅道当前剩余（null=任务已不在我的任务列表）
      consumed,
      left,
      rows,
    })
  }
  return tasks
}

// ─── 汉印条目构造（移植 KnowMore buildHp/buildPayload：工时 → 百分比，Σ=100） ───

/**
 * 按禅道任务聚合工时换算为汉印百分比条目。只在「软件项目(type=3)」分组中按
 * 「任务 Key === 禅道任务 ID」查找（两系统数据同源）；未匹配任务的工时占比
 * 份额并入余数补给第一条，保证 ΣPercent = 100（汉印硬约束）。
 * 返回 { items, unmatched: [taskId...] }。
 */
function buildHpItems(tasks, groups, date) {
  const total = round2((tasks || []).reduce((s, t) => s + (t.consumed || 0), 0))
  if (!total) return { items: [], unmatched: [] }
  const list = []
  const unmatched = []
  let assigned = 0
  for (const t of tasks || []) {
    const group = (groups || []).find(
      (g) => g.type === 3 && (g.tasks || []).some((x) => String(x.Key) === String(t.taskId)),
    )
    if (!group) {
      unmatched.push(t.taskId)
      continue // eslint-disable-line no-continue
    }
    const task = group.tasks.find((x) => String(x.Key) === String(t.taskId))
    const pct = Math.round(((t.consumed || 0) / total) * 100)
    assigned += pct
    list.push({ group, task, pct })
  }
  if (!list.length) return { items: [], unmatched }
  const rest = 100 - assigned
  if (rest) list[0].pct += rest
  const items = list.map(({ group, task, pct }) => ({
    Id: 0,
    ProjectType: group.type,
    ProjectTypeName: group.typeName,
    TaskTypeName: '',
    ProjectId: String(group.projectId),
    ProjectName: group.projectName,
    TaskId: String(task.Key),
    TaskName: task.Name,
    GlProjectId: task.GlProjectGuid || '',
    GlProjectName: task.GlprojectName || '',
    BigProjectId: task.BigKey || '',
    BigProjectName: task.BigName || '',
    ProductId: task.ProductKey || '',
    ProductName: task.ProductName || '',
    Percent: pct,
    PlanStartTime: task.StartTime || null,
    PlanEndTime: task.EndTime || null,
    ActualStartTime: task.StartTime2 || null,
    ActualEndTime: task.EndTime2 || null,
    UserNo: '',
    IsOp: !!task.IsOp,
    PlmTotalHour: task.PlmTotalHour || 0,
    ProductTime: task.ProductTime || null,
    Syqz: '',
    Status: 0,
    Remark: '',
    TaskRemark: '',
    DivisionName: task.DivisionName || '',
    WorkDate: date,
    AddType: 0,
  }))
  return { items, unmatched }
}

// ─── 编排：生成工时计划 / 提交禅道 ───

/**
 * 生成填报计划：收集提交 → 计算工时 → 匹配绑定 → 拉取禅道任务（容错）→ 汇总。
 * payload: { date: 'YYYY-MM-DD', startTime: 'HH:MM'（实际上班时间）, projects: [{ id, name, repos: string[] }] }
 */
async function plan(payload) {
  const { date, projects } = payload || {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('请选择填报日期')
  if (!Array.isArray(projects) || !projects.length) throw new Error('请选择要填报的项目')
  for (const p of projects) {
    if (!p.id) throw new Error('项目缺少 ID')
    if (!Array.isArray(p.repos) || !p.repos.length) throw new Error(`项目「${p.name || p.id}」没有可识别的 Git 仓库`)
  }

  const cfg = store.load()
  const identities = cfg.identities || []
  const identitiesMissing = !identities.length
  const commits = identitiesMissing ? [] : await collectTimedCommits(projects, { date, identities })

  // 总工时区间 = 页面填写的实际上班时间 → 终点（显式填写优先，否则取点击生成报告的
  // 当前时刻；终点早于上班时间即按次日跨夜）；git 提交时刻只用于收集内容与计数
  const workStart = String(payload.startTime || (cfg.zentao && cfg.zentao.workStart) || '08:30')
  if (!validHM(workStart)) throw new Error('实际上班时间格式不正确（应为 HH:MM）')
  const explicitEnd = String(payload.endTime || '').trim()
  if (explicitEnd && !validHM(explicitEnd)) throw new Error('下班时间格式不正确（应为 HH:MM）')
  const workCfg = {
    lunchStart: (cfg.zentao && cfg.zentao.lunchStart) || '12:00',
    lunchEnd: (cfg.zentao && cfg.zentao.lunchEnd) || '13:00',
  }
  const endTime = resolveEndTime(undefined, explicitEnd)
  const crossDay = isCrossDay(workStart, endTime)
  const planned = distributeByProject(commits, { startTime: workStart, endTime, ...workCfg, crossDay })
  const rangeStart = workStart

  const bindings = listBindings()
  const zentaoConfigured = !!(cfg.zentao && cfg.zentao.baseUrl && cfg.zentao.account && store.getZentaoPwd())
  let ztTasks = []
  let ztError = ''
  if (zentaoConfigured) {
    try {
      ztTasks = await zentao.ensureClient().then((c) => c.myTasks())
    } catch (e) {
      ztError = (e && e.message) || String(e)
    }
  } else {
    ztError = '禅道未配置：请到「设置 → 一键填报」填写地址、账号与密码'
  }

  const projectById = new Map(projects.map((p) => [String(p.id), p]))
  for (const p of planned) {
    const binding = bindings[String(p.projectId)]
    p.taskId = binding ? binding.taskId : null
    p.taskName = binding ? binding.taskName : ''
  }
  // 未绑定项目的建议任务（绑定弹窗预选）
  const suggested = {}
  const boundProjects = {}
  for (const [id] of Object.entries(bindings)) {
    if (projectById.has(id)) boundProjects[id] = bindings[id]
  }
  for (const p of projects) {
    if (boundProjects[String(p.id)]) continue
    const s = suggestTask(p.name, ztTasks)
    if (s) suggested[String(p.id)] = s
  }

  const tasks = buildSubmitTasks(planned, ztTasks, date)
  const unmatchedProjects = projects
    .filter((p) => commits.some((c) => c.projectId === p.id) && !boundProjects[String(p.id)])
    .map((p) => ({ id: p.id, name: p.name }))

  // 当日已有工时（提示「已提交过，将更新覆盖」；查询失败不阻断计划）。
  // 并发查询：多任务时串行延迟线性叠加，禅道同为内网接口可安全并行
  if (zentaoConfigured) {
    await Promise.all(tasks.map(async (t) => {
      try {
        const efforts = await zentao.ensureClient().then((c) => c.getTaskEfforts(t.taskId))
        const today = efforts.filter((e) => e.date === date)
        t.existingToday = { count: today.length, consumed: round2(today.reduce((s, e) => s + e.consumed, 0)) }
      } catch { /* 查询失败按无已有处理 */ }
    }))
  }

  // 汉印条目（容错：未配置/接口失败不阻断禅道计划，仅提示）
  let hpItems = []
  let hpUnmatched = []
  let hpError = ''
  let hpExisting = []
  const hanprintConfigured = !!(cfg.hanprint && cfg.hanprint.baseUrl && cfg.hanprint.account && store.getHanprintPwd())
  if (hanprintConfigured) {
    try {
      const groups = await hanprint.getGroups()
      const built = buildHpItems(tasks, groups, date)
      hpItems = built.items
      hpUnmatched = built.unmatched
      hpExisting = (await hanprint.ensureClient().then((c) => c.getByDate(date)))
        .filter((r) => r && r.ProjectType !== -2)
        .map((r) => ({ id: r.Id, taskId: String(r.TaskId), taskName: String(r.TaskName || ''), percent: Number(r.Percent || 0) }))
    } catch (e) {
      hpError = (e && e.message) || String(e)
    }
  } else {
    hpError = '汉印未配置：将只填报禅道工时（可到「设置 → 一键填报」配置汉印账号）'
  }

  return {
    date,
    workConfig: workCfg,
    rangeStart,
    rangeEnd: endTime,
    crossDay,
    endTimeManual: !!explicitEnd,
    planned,
    tasks,
    unmatchedProjects,
    bindings: boundProjects,
    suggested,
    ztTasks,
    ztError,
    hpItems,
    hpUnmatched,
    hpExisting,
    hpError,
    identitiesMissing,
    commitCount: commits.length,
  }
}

/**
 * 提交工时（双平台，已提交过则更新覆盖）。payload: { date, tasks: [{ taskId, rows }], dryRun, hp?: { items } }
 * - 禅道：逐任务查询当日已有工时记录，本次行依次复用已有记录 ID（表单键=effortID →
 *   更新覆盖）；行数超过已有记录时，多出的行按行号键追加（同 KnowMore 行为）
 * - 汉印：GetByDate 取当日已填记录，TaskId 匹配的条目带原 Id 提交（更新占比）；
 *   当日已有但本次未涉及的任务不动（不删除）
 * - dryRun=true 只回显将提交的表单/条目，不写入
 */
async function submit(payload) {
  const { date, tasks, dryRun, hp } = payload || {}
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('没有可提交的工时数据')
  for (const t of tasks) {
    if (!t.taskId || !Array.isArray(t.rows) || !t.rows.length) throw new Error('任务数据不完整（缺少 taskId 或工时行）')
  }
  const client = await zentao.ensureClient()
  const results = []
  for (const t of tasks) {
    let updated = 0
    let appended = 0
    try {
      // eslint-disable-next-line no-await-in-loop
      const today = (await client.getTaskEfforts(t.taskId)).filter((e) => !date || e.date === date)
      t.rows.forEach((row, i) => {
        if (today[i]) { row.effortId = today[i].id; updated += 1 } else { appended += 1 }
      })
    } catch { /* 查询失败按纯追加（同 KnowMore 键格式） */ appended = t.rows.length }
    // eslint-disable-next-line no-await-in-loop
    const r = await client.recordEfforts(t.taskId, t.rows, !!dryRun)
    results.push({
      taskId: t.taskId,
      taskName: t.taskName || '',
      consumed: round2(t.rows.reduce((s, x) => s + x.consumed, 0)),
      updated,
      appended,
      ...r,
    })
  }
  let hpResult = null
  if (hp && Array.isArray(hp.items) && hp.items.length) {
    const hpClient = await hanprint.ensureClient()
    // 当日已填的记录按 TaskId 匹配：带原 Id 提交即更新占比（同 workhour-h5 语义）
    let saved = []
    const workDate = hp.items[0] && hp.items[0].WorkDate
    if (workDate) {
      try {
        // eslint-disable-next-line no-await-in-loop
        saved = (await hpClient.getByDate(workDate)).filter((r) => r && r.ProjectType !== -2)
      } catch { /* 查询失败按全新增 */ }
    }
    let hpUpdated = 0
    for (const item of hp.items) {
      const hit = saved.find((s) => String(s.TaskId) === String(item.TaskId))
      if (hit) { item.Id = hit.Id; hpUpdated += 1 }
    }
    hpResult = await hpClient.add(hp.items, !!dryRun)
    hpResult.updated = hpUpdated
    hpResult.appended = hp.items.length - hpUpdated
  }
  return { dryRun: !!dryRun, results, hp: hpResult }
}

module.exports = {
  hm,
  workMinutes,
  resolveEndTime,
  isCrossDay,
  stripPrefix,
  distributeByProject,
  parseTimedLines,
  isMine,
  collectTimedCommits,
  listBindings,
  bindProject,
  unbindProject,
  suggestTask,
  buildSubmitTasks,
  buildHpItems,
  plan,
  submit,
}
