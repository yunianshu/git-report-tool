# Bug 分析：切换项目后部署页发布区域状态不跟随变化

## 问题来源

用户报告：切换项目后，部署页中发布区域的状态没有跟着变化；要求同时检验其他状态是否需要跟随切换。

## 复现前置条件

- 应用已打开，存在至少两个可部署项目 A、B
- 在项目 A 的部署页执行过一次发布（或回滚），产生阶段状态与日志
- 通过顶栏「当前项目」下拉切换到项目 B

## 预期行为

发布区域所有"与项目绑定"的状态应回到新项目 B 的初始视角：
阶段 chips 全部复位为 waiting、发布日志清空、进度计数清零。

## 实际行为

- 阶段 chips（`state.deploy.stages`）仍显示项目 A 上次发布的结果（✓/✗ 标记）
- 发布日志（`state.deploy.logs`）仍显示项目 A 的服务器输出
- 进度计数（packageCount / uploadPercent / datasyncPercent）残留项目 A 的值

## 切换链路

顶栏 selectProject（useProjects.js:37）→ 更新 `state.projects.currentId`
→ DeployView.vue:301 watch → onSelectProject（DeployView.vue:186）。

## 全量状态审计（切换项目时应否变化）

| 状态 | 位置 | 切换后实际行为 | 结论 |
|---|---|---|---|
| form（环境/版本/脚本配置） | DeployView.vue:152 fillForm | 重填新项目 | ✓ 正常 |
| activeTargetId | fillForm:174 | 重置为第一个目标 | ✓ 正常 |
| 本地版本 detected | detectVersion | 重新识别 | ✓ 正常 |
| 连接结果 connResult | onSelectProject:189 | 清空 | ✓ 正常 |
| dirty / publishVersion | computed | 随 form 重算 | ✓ 正常 |
| releases / rollbackVersion | RunPanel resetSelection:306 | 清空 | ✓ 正常 |
| 线上版本 currentVersion | onSelectProject:190 | 清空（显示"未知"，点查询刷新） | ✓ 正常 |
| 发布历史 | DeployHistoryTable watch projectId | 跟随刷新 | ✓ 正常（3decdaf 已修） |
| 阶段 chips stages | store.js:71 | **未清空** | ✗ 本 bug |
| 发布日志 logs | store.js:72 | **未清空** | ✗ 本 bug |
| 进度计数三个字段 | store.js:73-75 | **未清空**（当前 UI 未直接展示，但同属上次运行残留） | ✗ 顺带清理 |

## 根因

`onSelectProject` 重置了 releases/rollbackVersion/currentVersion/connResult，
但遗漏了 store 中同属"一次发布运行"的展示状态 stages/logs/进度计数。
这些状态只在 `resetStages`（DeployRunPanel.vue:152，点发布时调用）里清空。

## 修复方案（最小补丁）

在 DeployView 增加 `resetRunDisplay()`，在 `onSelectProject` 与 `newProject` 中调用：
清空 stages/logs/packageCount/uploadPercent/datasyncPercent。
当 `state.deploy.running === true` 时跳过清空——store 注释明确运行状态"跨视图保留，
切换 tab 不中断进度/日志"，发布进行中切换项目不应丢失在途进度展示。

## 根因结论

`confirmed`：静态代码链路完整（onSelectProject 未重置上述字段，且无其他清理点），
字段值随 store 持久存在直至下次发布覆盖。

## 验证方式

- 构建：npm run build 通过
- 人工验证路径：项目 A 发布（或仅观察到阶段状态/日志非空）→ 顶栏切换到项目 B
  → 发布卡阶段 chips 全部为"·"、日志区显示"暂无日志"
