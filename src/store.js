import { reactive } from 'vue'

/** 跨视图共享状态 */
export const state = reactive({
  /** 已启用的仓库路径（扫描页勾选后用于报告生成） */
  repos: [],
  /** 扫描发现的全部仓库（含 info，跨视图保留） */
  discoveredRepos: [],
  /** 表格勾选的仓库路径（切换视图后保留） */
  selectedRepoPaths: [],
  /** 应用配置 */
  config: {
    roots: [],
    excludes: [],
    identities: [],
  },
})
