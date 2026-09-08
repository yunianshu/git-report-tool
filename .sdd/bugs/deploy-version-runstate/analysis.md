# Bug 分析：选择「新版本」后发布进程状态未跟随更新

## 问题来源

用户报告：部署页中选择「新版本」后，下方发布进程状态没有更新。

## 复现前置条件

- 应用已打开，项目已保存且可发布（本地版本已识别、目标已配置）
- 该目标上执行过一次发布（无论成功或失败），阶段 chips 留下 ✓/✗ 与日志

## 预期行为

「新版本」保存成功后即进入新一轮发布准备，下方发布进程状态（阶段 chips / 发布日志 /
进度计数）应回到初始态（全部等待、无日志），与新版本待发布的状态一致。

## 实际行为

阶段 chips 仍显示上一次发布的结果（如「1 检查项目 ✗」），发布日志也仍是上一轮内容。
实测（`scripts/deploy-version-runstate-e2e.cjs` 修复前）：发布失败后 chips 为
`1检查项目✗ / is-failed`，选中候选保存后 chips 仍为 `1检查项目✗ / is-failed`。

## 链路与根因

「新版本」对话框（DeployRunPanel.vue:256 confirmVersion）→ `emit('set-version', v)`
→ DeployView.vue:279 `onNewVersion` → `saveProject`（保存版本策略/手动版本）。

`state.deploy.stages/logs/进度计数` 同属「一次发布运行」的展示状态（见
`.sdd/bugs/deploy-switch-state/analysis.md`），原先只在两处清空：

| 清空点 | 位置 | 触发时机 |
|---|---|---|
| `resetStages()` | DeployRunPanel.vue:263 | 点「发布」、点「回滚」 |
| `resetRunDisplay()` | DeployView.vue:191 | 切换项目、新建项目、复制部署配置 |

`onNewVersion` 只改版本并保存，两个清空点都没被触发，于是上一轮的 ✓/✗ 与日志一直留着。

## 修复方案（最小补丁）

`saveProject` 返回是否保存成功（`true/false`）；`onNewVersion` 在保存成功后调用
`resetRunDisplay()`，与切换项目走同一套清理逻辑，避免两处规则漂移。

- 复位范围：stages / logs / packageCount / uploadPercent / datasyncPercent（不含
  `currentVersion`——线上版本与项目+环境绑定，不属一次运行的残留）
- `resetRunDisplay()` 内已有 `state.deploy.running` 保护；「新版本」按钮本身在发布进行中
  也是禁用的，双重保证在途发布进度不被清空
- 只在保存成功后复位：保存失败时版本未变，状态保持原样
- 取消对话框不复位：实测确认（A2 断言）

## 验证方式

- 新增回归 E2E：`scripts/deploy-version-runstate-e2e.cjs`（真实 Electron + 沙箱 userData，
  9 项断言：A1 残留前置、A2 取消不复位、A3 阶段复位+发布按钮更新+磁盘持久化、A4 日志清空）
- 回归：`scripts/deploy-version-predict-e2e.cjs`（21 项）、`scripts/deploy-online-version-e2e.cjs`
  （14 项）、`scripts/deploy-history-switch-e2e.cjs` 全通过
- 前置：`npm run build:renderer`（E2E 驱动 dist/ 产物）
