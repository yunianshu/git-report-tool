# Harness 内嵌页误报服务未运行：问题分析

## 七要素

- 复现前置条件：Windows 安装版 1.4.41；应用顶部与底部均显示内置 Harness 进程正在运行；进入 DeepSeek Harness 内嵌页。
- 预期行为：内嵌页连接当前 `dsh web` 服务，输入区可直接使用；不显示“服务未运行”提示。
- 实际行为：内嵌页输入区上方持续显示“服务未运行”，提示无法关闭；点击提示中的“启动服务”无效。
- 可能根因（已确认）：`HarnessView.vue` 把运行中 webview 与状态占位层写成两条条件链，运行中且未发生加载错误时仍会命中第二条链的最终 `v-else`。
- 相关代码种子：`electron/harness-service.js`（服务拉起与状态）、`src/views/HarnessView.vue`（webview 导航）、`electron/main.js`（webview 与 IPC 集成）、内置 dsh 前端运行时代码。
- 最小复现步骤：启动安装版应用 → 等待宿主显示“运行中” → 打开 DeepSeek Harness → 等待前端完成握手 → 检查输入区是否出现“服务未运行/启动服务”。
- 日志证据：用户截图显示宿主状态为“运行中”、底栏端口 `127.0.0.1:3081` 且有 PID；同一时刻宿主占位层显示“服务未运行”。本机检查确认端口监听且 webview 网络进程存在两条已建立连接，排除服务未启动。

## 根因结论

状态：`confirmed`。

模板中的 `webview v-if="running"` 是独立分支；其后的加载失败层开启了另一条 `v-if` 链，最终未运行层使用无条件 `v-else`。当 `running=true`、`loadFailed=false`、`starting=false` 时，webview 正常渲染，同时第二条链落入 `v-else`，造成截图中的覆盖效果。按钮调用幂等 `start()`，已运行时状态不变，因此无法关掉提示。

## 初始验收条件

1. 相同环境进入内嵌页后，不再出现“服务未运行”误报。
2. 宿主的启动、刷新、重启、浏览器打开行为保持可用。
3. 相关 Harness 自测及渲染构建通过；真实安装环境无法覆盖的部分需明确标注。

## 范围边界

- 处理宿主应用与内置 dsh 的启动、连接或导航集成问题。
- 不修改用户的模型密钥、会话内容或项目资料。
- 不清理仓库现有未跟踪诊断文件和构建产物。

## 修复后验证

- `npm run build:renderer`：通过，2187 个模块完成生产构建。
- `node scripts/harness-e2e.cjs`：通过；真实 Electron + 全新主目录下，状态为“运行中”时 `placeholder` 为空，新增 H2c 及其余 Harness 断言全部通过。
- `npm test`：首次运行因系统优先解析到 WSL `bash.exe`，2 个部署用例出现 Windows 路径转义失败；将 Git Bash 放到本次测试进程的 PATH 首位后重跑，全部自测通过。
