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

/**
 * 递归扫描根目录，发现所有含 .git 的仓库（含嵌套仓库），自动排除系统/缓存目录。
 * 通过 realpath + visited 集合避免符号链接 / 目录联接导致的死循环。
 */
async function scanRepos(roots, excludes, onProgress) {
  const contains = [...DEFAULT_CONTAINS_EXCLUDES, ...(excludes || [])]
  const visited = new Set()
  const repos = []
  let scanned = 0
  let progressCount = 0

  async function walk(dir, depth) {
    if (depth > 16) return
    let real
    try {
      real = fs.realpathSync(dir)
    } catch {
      return
    }
    if (visited.has(real)) return
    visited.add(real)

    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    scanned += 1
    if (onProgress) {
      progressCount += 1
      if (progressCount % 40 === 0) {
        try { onProgress({ scanned, current: dir }) } catch { /* noop */ }
      }
    }

    if (entries.some((e) => e.name === '.git')) {
      repos.push(dir)
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      if (contains.some((p) => p && entry.name.includes(p))) continue
      await walk(path.join(dir, entry.name), depth + 1)
    }
  }

  for (const root of roots || []) {
    if (root && fs.existsSync(root)) await walk(root, 0)
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
  const base = ['log', '--all', `--since=${since}`]
  if (until) base.push(`--until=${until}`)
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
