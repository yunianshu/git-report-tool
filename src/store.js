import { reactive } from 'vue'

/** 跨视图共享状态 */
export const state = reactive({
  /** 个人项目：AI、活动报告与部署共享的统一上下文 */
  projects: {
    items: [],
    currentId: '',
    loading: false,
  },
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
    ai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: '',
      temperature: 0.7,
    },
  },
  /** 报告生成过程（跨视图保留，切换 tab 不中断） */
  report: {
    phase: 'idle', // idle | scanning | collecting | done
    scanProgress: { scanned: 0 },
    collectProgress: { done: 0, total: 0 },
    rawCommits: [],
    openProjects: [],
    /** rawCommits 实际对应的收集范围（until 为排他上界）。报告页与 AI 页共用
     *  rawCommits，展示、复制与导出必须以此范围为准，避免数据与标题错标 */
    collectedRange: null, // { since, until, repoPaths: string[] }
  },
  /** AI 聊天状态（跨视图保留，切换 tab 不丢失对话） */
  chat: {
    messages: [], // [{ role: 'user'|'assistant', content }]
    streaming: false,
  },
  /** 一键部署（OneDeploy）运行状态（跨视图保留，切换 tab 不中断进度/日志） */
  deploy: {
    projects: [],
    currentProjectId: '',
    running: false,
    stages: {}, // { check: { status, durationMs }, ... } status: waiting|running|success|failed|skipped|rollback
    logs: [], // [{ level, text, ts }]
    packageCount: 0,
    uploadPercent: 0,
    currentVersion: '', // 服务器当前运行版本（查询 releases / 发布事件更新）
  },
})
