/** 提交信息处理与 Markdown 报告生成 */

const PREFIX_RE = /^(feat|fix|refactor|docs|style|test|chore|perf|ci|build|revert|init|types?)(\([^)]*\))?\s*[:：]\s*/i

/** 去除 feat:/fix:/refactor: 等前缀 */
export function stripPrefix(subject) {
  const s = subject ? subject.replace(PREFIX_RE, '') : ''
  return s.trim()
}

/** 从路径取项目名（取最后两级，用于区分同名仓库） */
export function projectName(repo) {
  const parts = repo.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

/** 按项目分组并按提交数降序 */
export function groupByProject(commits) {
  const map = new Map()
  for (const c of commits || []) {
    if (!map.has(c.repo)) map.set(c.repo, [])
    map.get(c.repo).push(c)
  }
  const groups = [...map.entries()].map(([repo, list]) => ({
    repo,
    project: projectName(repo),
    commits: list.sort((a, b) => (a.date < b.date ? 1 : -1)),
  }))
  groups.sort((a, b) => b.commits.length - a.commits.length)
  return groups
}

/** 生成 Markdown 报告 */
export function buildMarkdown({ title, subtitle, commits, stats }) {
  const groups = groupByProject(commits)
  const lines = []
  lines.push(`# ${title}`)
  lines.push('')
  if (subtitle) lines.push(`> ${subtitle}`)
  if (stats) {
    lines.push(`> 统计：${stats.commitCount} 条提交 · ${stats.projectCount} 个项目 · ${stats.authorCount} 位作者`)
  }
  lines.push('')
  if (groups.length === 0) {
    lines.push('无提交记录')
    return lines.join('\n')
  }
  groups.forEach((g, i) => {
    lines.push(`## ${i + 1}. ${g.project}`)
    lines.push(`> 路径：\`${g.repo}\` · ${g.commits.length} 条提交`)
    lines.push('')
    g.commits.forEach((c, j) => {
      lines.push(`${j + 1}. ${stripPrefix(c.subject)}`)
    })
    lines.push('')
  })
  return lines.join('\n')
}
