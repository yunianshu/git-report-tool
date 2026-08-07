# Git 项目报告工具

跨平台桌面工具（Windows / macOS / Linux）：扫描本机 Git 仓库，一键生成**项目日报 / 周报 / 双周报 / 月报**。

## 功能

- **仓库扫描**：递归发现指定根目录下的全部 Git 仓库，自动排除 SDK/缓存目录，展示远程地址、分支、最近提交
- **报告生成**：
  - 周期：日报 / 周报 / 双周报 / 月报 / 自定义起止日期
  - 作者：只看本人 / 全部作者 / 指定作者
  - 统计卡片 + ECharts 图表（项目提交分布、每日提交趋势）
  - 提交明细按项目折叠展示
  - 导出 Markdown 报告
- **AI 助手**（可选，主页即聊天）：
  - 启动后主页即为聊天页，在「设置 → AI 模型」配置接口地址 / API Key / 模型（支持 OpenAI、DeepSeek、Kimi、通义千问、Ollama 等兼容接口）
  - 选好周期点击「AI 生成报告」或直接对话，自动收集提交数据作为上下文，AI 流式输出报告
  - 报告可在聊天中一键「保存为文件」（Markdown）或复制
  - API Key 明文仅存主进程（safeStorage 加密落盘），渲染层仅显示脱敏片段

## 技术栈

Electron 33 · Vue 3 · Element Plus · ECharts · Vite 6 · electron-builder

## 开发

```bash
npm install
npm run dev        # 开发模式（热更新）
```

## 使用（本地运行）

```bash
npm start          # 构建渲染层并启动
```

## 打包发布

```bash
npm run build:win     # Windows（NSIS 安装包 + 便携版）
npm run build:mac     # macOS（dmg）
npm run build:linux   # Linux（AppImage + deb）
```

产物输出至 `release/` 目录。

## 目录结构

```
├── electron/          # 主进程
│   ├── main.js        #   入口 + IPC
│   ├── preload.js     #   contextBridge 安全桥接
│   ├── git-service.js #   Git 扫描/收集/仓库信息（纯 Node）
│   └── store.js       #   userData 配置持久化
├── src/               # 渲染进程（Vue3）
│   ├── views/         #   扫描页 / 报告页
│   ├── components/    #   ECharts 封装
│   └── utils/         #   日期 / 报告生成
└── scripts/           # 便携版 CLI 脚本（可选）
```

## 数据口径

- 提交统计基于 `git log --all`，默认排除 merge 提交
- 「本人」身份默认为本机全局 git 身份（`git config --global user.name/email`），可在配置中调整
- 报告路径与扫描根目录、排除项保存在 `userData/config.json`

## 说明

- 本工具只需本机安装 git，无需联网。
- 首次启动若检测不到全局 git 身份，请在「报告生成」页确认本人姓名/邮箱，或在系统中配置 `git config --global user.name/email`。
