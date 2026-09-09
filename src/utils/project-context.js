function normalizedPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
}

/** 返回当前项目目录覆盖到的 Git 仓库；项目本身不要求是 Git 仓库。 */
export function reposForProject(project, repos = []) {
  const root = normalizedPath(project?.localPath)
  if (!root) return []
  return repos.filter((repo) => {
    const path = normalizedPath(repo.path)
    return path === root || path.startsWith(`${root}/`)
  })
}

export function commitsForProject(project, commits = []) {
  const repos = reposForProject(project, commits.map((item) => ({ path: item.repo })))
  const paths = new Set(repos.map((repo) => normalizedPath(repo.path)))
  return commits.filter((commit) => paths.has(normalizedPath(commit.repo)))
}

export function deploymentConfigured(project) {
  return !!project?.targets?.some((target) =>
    target?.server?.host && target?.remotePath
  )
}

export function projectStatusLabel(status) {
  return { active: '进行中', paused: '已暂停', archived: '已归档' }[status] || '进行中'
}
