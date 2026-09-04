/** 取路径末尾两级作为简短项目名（区分同名仓库） */
export function shortPath(p) {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
}

/** 路径归一化键：统一分隔符/大小写/尾部分隔符，用于跨路径比较（如「是否已加入项目」） */
export function pathKey(p) {
  return String(p || '').replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
}
