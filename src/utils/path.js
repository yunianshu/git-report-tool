/** 取路径末尾两级作为简短项目名（区分同名仓库） */
export function shortPath(p) {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}
