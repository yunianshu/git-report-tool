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

/**
 * 收集提交。与已验证的 bash 逻辑一致：
 * - git log --all --since=... [--until=...] --no-merges
 * - 使用 --pretty=tformat（每条提交后强制换行，避免相邻仓库首尾行粘连）
 * - 指定作者时按作者逐个收集
 */
async function collectCommits(repos, opts, onProgress) {
  const { since, until, authors, includeMerges } = opts || {}
  const fmt = '%H%x09%ad%x09%an%x09%ae%x09%s'
  // 关键：git 对裸日期(YYYY-MM-DD)的 --since/--until 解析在部分版本异常
  // （实测 2.53.0 将 --since=2026-08-04 误判），统一转为带精确时间格式
  const normDate = (d) => (d && !d.includes(' ') ? `${d} 00:00:00` : d)
  const base = ['log', '--all', `--since=${normDate(since)}`]
  if (until) base.push(`--until=${normDate(until)}`)
  if (!includeMerges) base.push('--no-merges')
  base.push(`--pretty=tformat:${fmt}`, '--date=short')

  const out = []
  const targets = authors && authors.length ? authors : [null]

  for (let i = 0; i < repos.length; i += 1) {
    const repo = repos[i]
    if (onProgress) {
      try { onProgress({ done: i + 1, total: repos.length, current: repo }) } catch { /* noop */ }
    }
    for (const a of targets) {
      const args = [...base]
      if (a) args.push(`--author=${a}`)
      // eslint-disable-next-line no-await-in-loop
      const res = await execGit(repo, args)
      if (!res.ok) continue
      for (const line of res.stdout.split('\n')) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        if (parts.length < 5) continue
        const [hash, date, authorName, authorEmail, ...rest] = parts
        if (!hash || !date) continue
        out.push({
          repo,
          hash: hash.slice(0, 10),
          date,
          authorName,
          authorEmail,
          subject: rest.join('\t'),
        })
      }
    }
  }
  return out
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
