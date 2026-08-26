/**
 * Git 服务 —— 仓库扫描 / 提交收集 / 仓库信息（跨平台，纯 Node 实现，不依赖系统 find）
 */
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

/** 默认按目录名包含匹配排除的目录（第三方克隆 / SDK / 缓存 / 系统目录） */
const DEFAULT_CONTAINS_EXCLUDES = [
  'node_modules', 'FlutterSDK', 'fvm_cache', '__MACOSX', '.cache',
  'android-sdk', 'androidsdk', 'jdk', 'Program Files', 'Pods',
  'System Volume Information', '$RECYCLE.BIN', '.gradle', '.idea', 'go/pkg'
]

/** 单次 git 命令执行（不经过 shell，避免注入与路径转义问题） */
function execGit(repo, args, maxBuffer = 64 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, ...args], { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() })
      resolve({ ok: true, stdout })
    })
  })
}

/** 全局 git 命令（如 git config --global） */
function execGitGlobal(args, maxBuffer = 16 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', args, { maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() })
      resolve({ ok: true, stdout })
    })
  })
}

/** 路径归一化（Windows 转小写+统一斜杠），用于防环集合 */
function normalizePath(p) {
  return process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p
}

/** 仓库内部常见的重型目录：下钻找嵌套仓库时跳过（几乎不可能含独立仓库） */
const REPO_HEAVY_DIRS = ['build', 'out', 'target', 'dist', 'bin', '.cxx', 'CMakeFiles', '.dart_tool', '.hvigor']

/**
 * 递归扫描根目录，发现 Git 仓库（含浅层嵌套仓库），自动排除系统/缓存目录。
 *
 * 性能策略（实测：9 大项目目录 45s → ~3s，15 倍提速，召回率不变）：
 * - 同步 readdirSync 顺序遍历：Windows 上比异步(经 libuv 线程池)更快
 * - 发现仓库后不再深度下钻：只在其内部继续找最多 REPO_SUB_DEPTH 层嵌套仓库
 *   （覆盖子模块/嵌套工程，跳过 build/out/target 等重型目录）
 * - 不逐目录 realpath：路径归一化 + 深度上限防环
 * - 主进程阻塞不影响渲染进程（独立进程），流式事件照常推送
 *
 * @param onProgress 目录遍历进度回调（节流）
 * @param onRepo 每发现一个仓库立即回调（流式增量展示）
 */
async function scanRepos(roots, excludes, onProgress, onRepo) {
  const REPO_SUB_DEPTH = 4
  const contains = [...DEFAULT_CONTAINS_EXCLUDES, ...(excludes || [])]
  const visited = new Set()
  const repos = []
  let scanned = 0
  let progressCount = 0

  const stack = []
  for (const root of roots || []) {
    if (root && fs.existsSync(root)) stack.push({ dir: root, depth: 0, repoBase: -1 })
  }

  let processed = 0
  while (stack.length > 0) {
    // 每处理一批目录就让出事件循环，避免长时间阻塞主进程
    // （否则渲染进程的 IPC 请求如 configLoad 会排队，导致界面卡住无法切换）
    if (++processed % 200 === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    const { dir, depth, repoBase } = stack.pop()
    if (depth > 16) continue
    // 已处于某个仓库内部且下钻超过上限 → 停止（避免遍历仓库完整内部树）
    if (repoBase >= 0 && depth - repoBase > REPO_SUB_DEPTH) continue
    const norm = normalizePath(dir)
    if (visited.has(norm)) continue
    visited.add(norm)

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    scanned += 1
    if (onProgress) {
      progressCount += 1
      if (progressCount % 40 === 0) {
        try { onProgress({ scanned, current: dir }) } catch { /* noop */ }
      }
    }

    const isRepo = entries.some((e) => e.name === '.git')
    if (isRepo) {
      repos.push(dir)
      if (onRepo) {
        try { onRepo(dir) } catch { /* noop */ }
      }
    }
    const childBase = isRepo ? depth : repoBase
    for (const entry of entries) {
      if (entry.name === '.git') continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (contains.some((p) => p && entry.name.includes(p))) continue
      // 仓库内部跳过重型目录，减少无效遍历
      if (isRepo && REPO_HEAVY_DIRS.some((p) => entry.name.includes(p))) continue
      stack.push({ dir: path.join(dir, entry.name), depth: depth + 1, repoBase: childBase })
    }
  }

  return repos
}

/** 获取仓库展示信息：远程地址、当前分支、最近一次提交 */
async function getRepoInfo(repo) {
  const [remote, branch, last] = await Promise.all([
    execGit(repo, ['remote', 'get-url', 'origin']),
    execGit(repo, ['branch', '--show-current']),
    execGit(repo, ['log', '-1', '--pretty=%ad|%s', '--date=short']),
  ])
  return {
    remote: remote.ok ? remote.stdout.trim() : '',
    branch: branch.ok ? branch.stdout.trim() : '',
    lastCommit: last.ok ? last.stdout.trim() : '',
  }
}

/** 提交行解析格式：hash ⇥ 日期 ⇥ 作者名 ⇥ 邮箱 ⇥ 主题 */
const COMMIT_FMT = '%H%x09%ad%x09%an%x09%ae%x09%s'

// 关键：git 对裸日期(YYYY-MM-DD)的 --since/--until 解析在部分版本异常
// （实测 2.53.0 将 --since=2026-08-04 误判），统一转为带精确时间格式
const normDate = (d) => (d && !d.includes(' ') ? `${d} 00:00:00` : d)

/** 裸日期（YYYY-MM-DD）：仅此类输入支持按天对齐的无缝增量补查 */
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 本地时区当天（YYYY-MM-DD） */
function todayLocal() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function tryCall(fn, payload) { try { fn(payload) } catch { /* noop */ } }

/**
 * 收集结果缓存 —— 进程内存 LRU（上限 8 条）：
 * - 相同参数重复收集直接复用（反复生成/切换视图不再重扫历史）
 * - 新范围为某缓存条目的超集时仅补查缺口区间（如日报→周报只补差额天数）
 * - 仓库列表（含顺序）/作者/合并参数任一变化自动视为不同 key
 *
 * 正确性约定：历史日期的提交视为不可变（rebase/amend 改写历史不在覆盖范围）；
 * 范围触及「今天及以后」的条目仅在 FRESH_TTL 内允许复用，过期后整体重查，避免漏掉新提交。
 */
const COLLECT_CACHE_LIMIT = 8
/** 含「今天/未来」的条目允许复用的时长（毫秒） */
const COLLECT_FRESH_TTL = 120 * 1000
const collectCache = new Map()
/** 进行中任务的并发去重：相同参数的并发调用共享同一 Promise（后续加入者收不到中间进度） */
const collectInflight = new Map()

/** 归一化收集参数并预计算签名（authors 参与 key：排序后拼接，OR 语义与顺序无关） */
function normCollectOpts(opts) {
  const o = opts || {}
  const authors = Array.isArray(o.authors) ? o.authors.filter(Boolean) : []
  return {
    since: o.since || '',
    until: o.until || '',
    includeMerges: !!o.includeMerges,
    authors,
    authorsSig: [...authors].sort().join('\u0000'),
  }
}

/** 构造单仓库 git log 参数（多 --author 为 git 原生 OR 语义，单次遍历覆盖全部作者） */
function buildLogArgs({ since, until, includeMerges, authors }) {
  const args = ['log', '--all', `--since=${normDate(since)}`]
  if (until) args.push(`--until=${normDate(until)}`)
  if (!includeMerges) args.push('--no-merges')
  args.push(`--pretty=tformat:${COMMIT_FMT}`, '--date=short')
  for (const a of authors) args.push(`--author=${a}`)
  return args
}

/** 解析单仓库 git log 输出为提交对象数组 */
function parseCommitLines(repo, stdout) {
  const list = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const [hash, date, authorName, authorEmail, ...rest] = parts
    if (!hash || !date) continue
    list.push({ repo, hash: hash.slice(0, 10), date, authorName, authorEmail, subject: rest.join('\t') })
  }
  return list
}

/** 单仓库查询（失败返回空，不影响其它仓库） */
async function queryRepo(repo, args) {
  const res = await execGit(repo, args)
  return res.ok ? parseCommitLines(repo, res.stdout) : []
}

/** 固定并发池：按序消费任务队列，返回与任务等长的结果数组 */
async function runPool(tasks, job, concurrency = 8) {
  const results = new Array(tasks.length)
  let next = 0
  // 并发数取 8：git 子进程为短时 CPU/IO 任务，8 路已能打满磁盘与调度余量
  const workers = Math.max(1, Math.min(concurrency, tasks.length))
  await Promise.all(Array.from({ length: workers }, async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= tasks.length) return
      // eslint-disable-next-line no-await-in-loop
      results[i] = await job(tasks[i], i)
    }
  }))
  return results
}

/** 执行收集任务并回报进度（进度折算到 done/total=仓库数，保持既有事件语义） */
async function runCollectTasks(repos, tasks, onProgress) {
  const total = tasks.length
  let done = 0
  return runPool(tasks, async (t) => {
    const list = await queryRepo(t.repo, t.args) // eslint-disable-line no-await-in-loop
    done += 1
    if (onProgress) {
      const scaled = total ? Math.round((done / total) * repos.length) : repos.length
      tryCall(onProgress, { done: Math.min(scaled, repos.length), total: repos.length, current: t.repo })
    }
    return list
  })
}

function groupCommitsByRepo(commits) {
  const m = new Map()
  for (const c of commits) {
    if (!m.has(c.repo)) m.set(c.repo, [])
    m.get(c.repo).push(c)
  }
  return m
}

/** 缓存条目是否可复用：纯历史范围永久有效；含今天/未来/开放区间则要求新鲜 */
function cacheUsable(entry) {
  if (entry.until && BARE_DATE_RE.test(entry.until) && entry.until <= todayLocal()) return true
  return Date.now() - entry.createdAt <= COLLECT_FRESH_TTL
}

/**
 * 收集提交（并发池 + 结果缓存 + 增量补查）。输出语义与串行版本一致：
 * - 结果严格按传入仓库顺序排列，单仓库内按 git log 逆时间序
 * - 进度 { done, total, current } 中 done 为已完成仓库数（缓存命中时直接满格）
 */
async function collectCommits(repos, opts, onProgress) {
  const o = normCollectOpts(opts)
  const repoList = repos || []
  const reposSig = repoList.join('\u0000')
  const key = [reposSig, o.since, o.until, o.includeMerges ? 1 : 0, o.authorsSig].join('\u0001')

  // 1) 精确命中：直接复用（LRU 触碰保活跃度）
  const hit = collectCache.get(key)
  if (hit) {
    if (cacheUsable(hit)) {
      collectCache.delete(key)
      collectCache.set(key, hit)
      if (onProgress) tryCall(onProgress, { done: repoList.length, total: repoList.length, current: '' })
      return hit.commits
    }
    collectCache.delete(key) // 过期条目移除，整体重查
  }

  // 2) 并发去重：相同参数的进行中收集直接共享结果
  if (collectInflight.has(key)) return collectInflight.get(key)

  const task = (async () => {
    // 3) 增量：寻找被当前范围完全覆盖的最小缓存基
    let base = null
    if (BARE_DATE_RE.test(o.since) && BARE_DATE_RE.test(o.until)) {
      for (const [k, v] of collectCache) {
        if (v.reposSig !== reposSig) continue
        if (v.includeMerges !== o.includeMerges || v.authorsSig !== o.authorsSig) continue
        if (!cacheUsable(v) || !BARE_DATE_RE.test(v.since) || !BARE_DATE_RE.test(v.until)) continue
        if (o.since <= v.since && o.until >= v.until) {
          const span = Date.parse(v.until) - Date.parse(v.since)
          const baseSpan = base ? Date.parse(base.until) - Date.parse(base.since) : Infinity
          if (span < baseSpan) base = { ...v, cacheKey: k }
        }
      }
    }

    let commits
    if (base) {
      // 缺口均为半开按天对齐区间：右 [base.until, until)、左 [since, base.since)，与缓存体无缝不重叠
      const tasks = []
      if (o.until > base.until) for (const r of repoList) tasks.push({ repo: r, side: 'right' })
      if (o.since < base.since) for (const r of repoList) tasks.push({ repo: r, side: 'left' })
      const results = await runCollectTasks(repoList, tasks.map((t) => ({
        repo: t.repo,
        args: buildLogArgs({
          since: t.side === 'left' ? o.since : base.until,
          until: t.side === 'left' ? base.since : o.until,
          includeMerges: o.includeMerges,
          authors: o.authors,
        }),
      })), onProgress)

      const rightBy = new Map()
      const leftBy = new Map()
      tasks.forEach((t, i) => {
        const bucket = t.side === 'left' ? leftBy : rightBy
        if (!bucket.has(t.repo)) bucket.set(t.repo, [])
        bucket.get(t.repo).push(...(results[i] || []))
      })
      const baseBy = groupCommitsByRepo(base.commits)
      commits = []
      for (const r of repoList) {
        if (rightBy.has(r)) commits.push(...rightBy.get(r))
        if (baseBy.has(r)) commits.push(...baseBy.get(r))
        if (leftBy.has(r)) commits.push(...leftBy.get(r))
      }
    } else {
      // 4) 全量收集
      const results = await runCollectTasks(
        repoList,
        repoList.map((r) => ({ repo: r, args: buildLogArgs(o) })),
        onProgress,
      )
      commits = []
      for (const list of results) {
        if (list && list.length) commits.push(...list)
      }
    }

    // 5) 写缓存（LRU 淘汰最旧）
    collectCache.set(key, {
      reposSig,
      authorsSig: o.authorsSig,
      since: o.since,
      until: o.until,
      includeMerges: o.includeMerges,
      commits,
      createdAt: Date.now(),
    })
    while (collectCache.size > COLLECT_CACHE_LIMIT) {
      collectCache.delete(collectCache.keys().next().value)
    }
    return commits
  })()

  collectInflight.set(key, task)
  try {
    return await task
  } finally {
    collectInflight.delete(key)
  }
}

/** 读取本机全局 git 身份 */
async function getIdentity() {
  const name = await execGitGlobal(['config', '--global', 'user.name'])
  const email = await execGitGlobal(['config', '--global', 'user.email'])
  return {
    name: name.ok ? name.stdout.trim() : '',
    email: email.ok ? email.stdout.trim() : '',
  }
}

module.exports = { scanRepos, getRepoInfo, collectCommits, getIdentity, execGit }
