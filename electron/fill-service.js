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

// ─── 工时计算（纯函数，与 KnowMore plan_hours 语义一致） ───

function hm(s) {
  const [h, m] = String(s).split(':').map(Number)
  return h * 60 + m
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
 * 锚点累进法计算每条提交的工时。
 * commits: [{ time:'HH:MM', msg, projectId, projectName }] 按时间升序（内部会再排序）。
 * 跨项目合并段在工作说明中加 [项目名] 前缀，便于在禅道工时里区分来源。
 */
function planHours(commits, { workStart, lunchStart, lunchEnd, step = 30 } = {}) {
  const lunchS = hm(lunchStart || '12:00')
  const lunchE = hm(lunchEnd || '13:00')
  let anchor = hm(workStart || '08:30')
  const sorted = [...(commits || [])].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  const out = []
  for (const c of sorted) {
    const t = hm(c.time)
    const m = workMinutes(anchor, t, lunchS, lunchE)
    anchor = t
    const seg = Math.floor(m / step) * step
    out.push({ ...c, minutes: seg, hours: round2(seg / 60), rawMinutes: m, rawHours: round2(m / 60) })
  }
  // 0 段并入下一条（尾部并入上一条），保证每条 hours > 0
  const merged = []
  let pending = []
  for (const item of out) {
    if (item.minutes === 0) {
      pending.push(item)
      continue // eslint-disable-line no-continue
    }
    if (pending.length) {
      item.msg = [...pending, item].map((p) => msgOf(p, item)).join('；')
      item.mergedFrom = pending.map((p) => p.time)
      pending = []
    }
    merged.push(item)
  }
  if (pending.length) {
    if (merged.length) {
      const last = merged[merged.length - 1]
      last.msg = `${last.msg}；${pending.map((p) => msgOf(p, last)).join('；')}`
      last.mergedFrom = [...(last.mergedFrom || []), ...pending.map((p) => p.time)]
    } else {
      merged.push(...pending) // 全部为 0 的极端情况，原样返回
    }
  }
  return merged
}

/** 合并段说明：与目标项同项目则裸说明，跨项目带 [项目名] 前缀 */
function msgOf(item, target) {
  if (item.projectId && target.projectId && item.projectId !== target.projectId) {
    return `[${item.projectName || item.projectId}] ${item.msg}`
  }
  return item.msg
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
  const results = await Promise.all(
    repos.map(async ({ repo, project }) => {
      const res = await execGit(repo, [
        'log', '--all',
        `--since=${lookbackDate} 00:00:00`,
        '--no-merges',
        `--pretty=tformat:${TIMED_LOG_FMT}`,
        '--date=format:%Y-%m-%d %H:%M',
      ])
      return res.ok ? parseTimedLines(project, repo, res.stdout) : []
    }),
  )
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
    byTask.get(key).push({ date, work: p.msg, consumed: p.hours })
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
 * payload: { date: 'YYYY-MM-DD', projects: [{ id, name, repos: string[] }] }
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

  const workCfg = {
    workStart: (cfg.zentao && cfg.zentao.workStart) || '08:30',
    lunchStart: (cfg.zentao && cfg.zentao.lunchStart) || '12:00',
    lunchEnd: (cfg.zentao && cfg.zentao.lunchEnd) || '13:00',
  }
  const planned = planHours(commits, workCfg).map((p) => ({
    time: p.time,
    hours: p.hours,
    rawHours: p.rawHours,
    msg: p.msg,
    hash: p.hash,
    projectId: p.projectId,
    projectName: p.projectName,
    mergedFrom: p.mergedFrom || [],
  }))

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

  // 汉印条目（容错：未配置/接口失败不阻断禅道计划，仅提示）
  let hpItems = []
  let hpUnmatched = []
  let hpError = ''
  const hanprintConfigured = !!(cfg.hanprint && cfg.hanprint.baseUrl && cfg.hanprint.account && store.getHanprintPwd())
  if (hanprintConfigured) {
    try {
      const groups = await hanprint.getGroups()
      const built = buildHpItems(tasks, groups, date)
      hpItems = built.items
      hpUnmatched = built.unmatched
    } catch (e) {
      hpError = (e && e.message) || String(e)
    }
  } else {
    hpError = '汉印未配置：将只填报禅道工时（可到「设置 → 一键填报」配置汉印账号）'
  }

  return {
    date,
    workConfig: workCfg,
    planned,
    tasks,
    unmatchedProjects,
    bindings: boundProjects,
    suggested,
    ztTasks,
    ztError,
    hpItems,
    hpUnmatched,
    hpError,
    identitiesMissing,
    commitCount: commits.length,
  }
}

/**
 * 提交工时（双平台）。payload: { tasks: [{ taskId, rows }], dryRun, hp?: { items } }
 * - 禅道：逐任务调用 recordEstimate；dryRun=true 只回显表单不写入
 * - 汉印：传入 hp.items（plan 阶段构造的百分比条目）时调用 workhour/add
 */
async function submit(payload) {
  const { tasks, dryRun, hp } = payload || {}
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('没有可提交的工时数据')
  for (const t of tasks) {
    if (!t.taskId || !Array.isArray(t.rows) || !t.rows.length) throw new Error('任务数据不完整（缺少 taskId 或工时行）')
  }
  const client = await zentao.ensureClient()
  const results = []
  for (const t of tasks) {
    // eslint-disable-next-line no-await-in-loop
    const r = await client.recordEfforts(t.taskId, t.rows, !!dryRun)
    results.push({ taskId: t.taskId, taskName: t.taskName || '', consumed: round2(t.rows.reduce((s, x) => s + x.consumed, 0)), ...r })
  }
  let hpResult = null
  if (hp && Array.isArray(hp.items) && hp.items.length) {
    const hpClient = await hanprint.ensureClient()
    hpResult = await hpClient.add(hp.items, !!dryRun)
  }
  return { dryRun: !!dryRun, results, hp: hpResult }
}

module.exports = {
  hm,
  workMinutes,
  planHours,
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
