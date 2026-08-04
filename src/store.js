import { reactive } from 'vue'

/** 跨视图共享状态 */
export const state = reactive({
  /** 已启用的仓库路径（扫描页勾选结果） */
  repos: [],
  /** 应用配置 */
  config: {
    roots: [],
    excludes: [],
    myIdentity: { name: '', email: '' },
  },
})
