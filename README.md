# Git 报告 · OneDeploy 桌面工具箱

跨平台桌面工具（Windows / macOS / Linux），包含两大模块：

- **Git 报告**：扫描本机 Git 仓库，一键生成**项目日报 / 周报 / 双周报 / 月报**，内置 AI 助手
- **OneDeploy 一键部署**：将本地项目安全、可回滚地发布到远程 Linux Docker Compose 服务器

## 模块一：Git 报告

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

## 模块二：OneDeploy 一键部署

本地选择项目，点击一次「发布」，自动完成：版本识别 → 打包 → 上传 → 服务器备份 → 解压 → Docker 构建 → 重启 → 健康检查，失败时自动回滚。

- **多项目管理**：每个项目独立配置，持久化在 `userData/deploy-projects.json`
- **远程部署地址可配置**：服务器主机 / SSH 端口 / 用户名 / 认证方式（密码或私钥）/ 远程部署目录，均可按项目自定义
- **版本号自动识别**：按 `VERSION` → `package.json` → `pom.xml` → `build.gradle(.kts)` → `pubspec.yaml` → `*.csproj` 优先级读取，也可手动指定
- **智能打包**：自动排除 `.git`、`node_modules`、`dist`、`build` 等目录与 `*.log` 等临时文件，支持项目根目录 `.deployignore` 自定义忽略规则；上传后 SHA256 校验
- **服务器目录规范**（`<部署目录>` 下，可自定义根）：

  ```
  <部署目录>/
  ├── current -> releases/<version>   # 软链接指向运行版本
  ├── releases/  uploads/  backups/  shared/  deployer/
  ```

  `shared/.env` 等共享配置通过软链接挂入版本目录，不随版本更新丢失
- **发布流程 8 阶段可视**：检查项目 → 项目打包 → 上传文件 → 备份服务器 → 解压新版本 → Docker 构建 → 启动服务 → 健康检查
- **安全防护**：发布锁防并发（超时自动接管）、防重复点击、上传包校验、健康检查失败/连接中断自动回滚到旧版本
- **健康检查**：HTTP 探测（如 `/actuator/health`，超时/间隔可配），未配置时检查容器运行状态
- **数据库备份**（可选）：PostgreSQL / MySQL，通过 `docker exec` 导出
- **发布历史与回滚**：记录每次发布（状态/耗时/失败原因/完整日志），支持从历史版本一键回滚（不重新上传）
- **实时日志**：服务器端 `deploy.sh` 输出实时回传到客户端
- **凭据安全**：SSH 密码/私钥口令经 safeStorage 加密落盘，明文不保存、不出主进程

### 部署服务器要求

- Linux + Docker + **Docker Compose V2**（`docker compose` 子命令）
- 已安装 `unzip`、`sha256sum`（`curl` 在启用 HTTP 健康检查时需要）
- 项目内提供 `Dockerfile` 与 `docker-compose.yml`（compose 文件名可配置）
- 服务器端逻辑集中在 `deploy.sh`，由客户端自动上传，无需手工布置

## 技术栈

Electron 33 · Vue 3 · Element Plus · ECharts · Vite 6 · electron-builder · ssh2 · archiver

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
├── electron/              # 主进程
│   ├── main.js            #   入口 + IPC
│   ├── preload.js         #   contextBridge 安全桥接
│   ├── git-service.js     #   Git 扫描/收集/仓库信息（纯 Node）
│   ├── ai-service.js      #   AI 对话（流式）
│   ├── store.js           #   userData 配置持久化 + safeStorage 加密
│   └── deploy/            #   OneDeploy 一键部署模块
│       ├── deploy-service.js    #   发布编排（8 阶段 + 日志流 + 取消）
│       ├── deploy-projects.js   #   部署项目配置（凭据加密）
│       ├── ssh-service.js       #   SSH/SFTP（ssh2）
│       ├── packager.js          #   ZIP 打包 + 忽略规则 + SHA256
│       ├── version-detector.js  #   版本号识别
│       ├── history.js           #   发布历史
│       └── scripts/deploy.sh    #   服务器端部署脚本
├── src/                   # 渲染进程（Vue3）
│   ├── views/             #   扫描页 / 报告页 / 部署页 / 设置页
│   ├── components/        #   ECharts 封装
│   └── utils/             #   日期 / 报告生成
└── scripts/               # 便携版 CLI 脚本（可选）
```

## 数据口径

- 提交统计基于 `git log --all`，默认排除 merge 提交
- 「本人」身份默认为本机全局 git 身份（`git config --global user.name/email`），可在配置中调整
- 报告路径与扫描根目录、排除项保存在 `userData/config.json`
- 部署项目配置保存在 `userData/deploy-projects.json`，发布历史保存在 `userData/deploy-history.json`（完整日志在 `userData/deploy-logs/`）

## 说明

- Git 报告模块只需本机安装 git，无需联网。
- 首次启动若检测不到全局 git 身份，请在「报告生成」页确认本人姓名/邮箱，或在系统中配置 `git config --global user.name/email`。
- OneDeploy 模块需可访问目标服务器（SSH 22 或自定义端口）；数据卷请挂载到 `shared/` 或绝对路径，避免放入版本目录随发布被清理。
