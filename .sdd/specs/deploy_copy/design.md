# Design：部署配置整套复制

## 实现模型

凭据以加密形态存储于主进程 `userData/deploy-projects.json`（deploy-projects.js），
渲染层拿到的 list() 已脱敏。因此复制必须由主进程完成：新增 IPC
`deploy:projects:copyConfig`，在原始数据层深拷贝源项目部署字段并追加到目标项目，
直接 persistAll（不经过 save() 的 mergeSecret——那会把已加密的 secret 当明文二次加密）。

## 接口设计

### 主进程 deploy-projects.js

- 抽出 `applyCopyConfig(from, to)`：整体字段（deployMode/composeFile/version/deploy/scriptMode）+ targets 深拷贝（每个新 genId）追加，返回复制数量；`copyConfig` 复用。
- 新增 `pickCopySource(projects, excludeId)`：过滤出"有至少一个 server.host 非空目标"的其他项目，取 updatedAt 最大者；无则 null。
- `save()` 检测新项目（projects 中无该 id）→ persist 前用 pickCopySource + applyCopyConfig 带入默认配置，返回值增加 `copiedFrom`（源项目名）与 `copiedTargets`；再次保存（idx>=0）不触发。

### IPC / preload

- main.js：`ipcMain.handle('deploy:projects:copyConfig', (_e, args) => deployProjects.copyConfig(args))`
- preload.js：`deployProjectsCopyConfig: (args) => ipcRenderer.invoke('deploy:projects:copyConfig', args)`

## 渲染层

### DeployConfigDrawer.vue

- 新增 prop `projects`（部署项目列表，供选择源项目）
- 「基本信息」卡头部加「从其他项目复制」按钮 → 打开小对话框：el-select 选源项目（排除当前 form.id）
  + 警告文案（复制范围、未保存修改将丢弃）→ 确认后 emit('copy-config', sourceId)

### DeployView.vue

- 传入 `:projects="state.deploy.projects"`
- 处理 @copy-config：调 `deployProjectsCopyConfig({ fromProjectId, toProjectId: form.id })`
  → 成功后 loadProjects()（重拉列表并 fillForm 当前项目）→ 把 activeTargetId 切到新追加的
  第一个目标 → connResult 清空 → ElMessage 提示复制了几个环境；失败报错
- saveProject：保存前记录 form.targets 数量；返回 `copiedTargets > 0`（新建默认带入）时
  提示来源与环境数，fillForm 后把 activeTargetId 切到第一个带入的环境

## 设计决策与 spec 回溯

| 决策 | 对应规则 |
|---|---|
| 主进程复制而非渲染层拼装 | R2（凭据明文不出主进程） |
| 不走 save()/mergeSecret，直接改 raw + persistAll | R2（避免二次加密破坏凭据） |
| 复制目标重新生成 id | R3（id 冲突） |
| 复制后渲染层重拉 fillForm，不做局部合并 | R5（避免渲染层与主进程状态漂移） |

## 与现有代码的契约

- fillForm 会把 server.secret 清空、留空=保持既有凭据（DeployView.vue 现有逻辑），
  复制来的加密凭据在后续保存时由 mergeSecret 的 oldSecret 分支原样保留，不受影响。
