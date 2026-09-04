# 开发项目管理

跨平台**个人项目管理工作台**（Windows / macOS / Linux），基于 Electron + Vue 3。

在本应用中，**项目是一等领域对象**：只填写项目名称即可创建，不要求必须是 Git 仓库，也不要求配置部署。Git 活动、AI 助手和部署都是项目的**可选能力**——Git 只是报告的数据来源之一，而不是产品的中心。

侧栏导航分三组、七个入口：

- **工作区**：工作台、项目
- **项目能力**：AI 助手、活动报告、部署
- **系统**：扩展管理、设置

应用顶部提供统一的当前项目选择器，切换项目后 AI、报告和部署自动使用同一项目上下文。

## 工作台

进入应用后的默认页面：展示真实的项目数量、当前项目资料完整度、Git 活动状态、部署状态和最近操作，并提供「创建项目 / 询问 AI / 生成报告 / 打开部署」快捷入口。只展示真实数据，不编造指标。

## 项目

项目列表与详情，支持新建、编辑、归档/删除（删除有危险操作确认）：

- 字段：名称、说明、本地目录、状态、标签、项目备注
- 只填名称即可创建项目；关联本地目录为可选操作
- 若目录是 Git 仓库则展示 Git 信息，但不改变项目的成立条件
- 已配置部署的旧项目自动出现在项目列表中，原有部署目标与凭据继续可用

## AI 助手

独立的对话工作区，面向整个项目而不只是报告：

- 明确显示当前项目，可勾选上下文来源：**项目资料 / Git 活动 / 报告摘要 / 部署状态**
- 提供「项目总结 / 风险梳理 / 下一步计划 / 生成项目报告」等项目级快捷问题
- 无 Git 数据时仍可基于项目说明和备注对话
- 在「设置 → AI 服务」配置接口地址 / API Key / 模型（支持 OpenAI、DeepSeek、Kimi、通义千问、Ollama 等兼容接口）
- 支持流式输出、停止、复制、保存为 Markdown 文件
- API Key 明文仅存主进程（safeStorage 加密落盘），渲染层仅显示脱敏片段；项目备注、提交文本等外部上下文均按不可信数据处理并受字符预算限制

## 活动报告

基于 Git 提交的项目开发报告（Git 是数据源之一，非 Git 项目显示明确空状态并引导使用 AI 基于项目资料整理）：

- 范围：当前项目 / 全部项目
- 周期：日报 / 周报 / 双周报 / 月报 / 自定义起止日期
- 作者：只看本人 / 全部作者 / 指定作者
- 统计卡片 + ECharts 图表（项目提交分布、每日提交趋势）、提交明细按项目折叠
- 报告历史、复制与 Markdown 导出
- 提交统计基于 `git log --all`，默认排除 merge 提交；「本人」身份默认为本机全局 git 身份，可在设置中调整

## 部署（OneDeploy）

为配置了部署的项目提供一键发布：版本识别 → 打包 → 上传 → 服务器备份 → 解压 → Docker 构建 → 重启 → 健康检查，失败时自动回滚。

- 以全局当前项目为输入；一个项目可配置任意多个部署目标（测试 / 生产 / 多台服务器），每个目标独立保存服务器主机 / SSH 端口 / 用户名 / 认证方式 / 远程目录 / 健康检查与凭据
- 服务器、健康检查、备份等低频配置收进「部署设置」面板，首屏只保留发布状态、主要动作、阶段进度、日志和历史
- **版本号自动识别**：按 `VERSION` → `package.json` → `pom.xml` → `build.gradle(.kts)` → `pubspec.yaml` → `*.csproj` 优先级读取，也可手动指定
- **智能打包**：自动排除 `.git`、`node_modules`、`dist`、`build` 等目录，支持项目根目录 `.deployignore` 自定义忽略；上传后 SHA256 校验
- **服务器目录规范**（`<部署目录>` 下，可自定义根）：

  ```
  <部署目录>/
  ├── current -> releases/<version>   # 软链接指向运行版本
  ├── releases/  uploads/  backups/  shared/  deployer/
  ```

  `shared/.env` 等共享配置通过软链接挂入版本目录，不随版本更新丢失
- **发布流程 8 阶段可视**：检查项目 → 项目打包 → 上传文件 → 备份服务器 → 解压新版本 → Docker 构建 → 启动服务 → 健康检查
- **安全防护**：发布锁防并发、防重复点击、上传包校验、健康检查失败/连接中断自动回滚
- **健康检查**：HTTP 探测（如 `/actuator/health`），未配置时检查容器运行状态；可选 PostgreSQL / MySQL 数据库备份
- **发布历史与回滚**：记录每次发布（状态/耗时/失败原因/完整日志），支持从历史版本一键回滚
- **凭据安全**：SSH 密码/私钥口令经 safeStorage 加密落盘，明文不保存、不出主进程

### 部署服务器要求

- Linux + Docker + **Docker Compose V2**（`docker compose` 子命令）
- 已安装 `unzip`、`sha256sum`（`curl` 在启用 HTTP 健康检查时需要）
- 项目内提供 `Dockerfile` 与 `docker-compose.yml`（compose 文件名可配置）
- 服务器端逻辑集中在 `deploy.sh`，由客户端自动上传，无需手工布置

## 扩展管理

统一管理本机四个 AI CLI 平台的技能（skills）与插件（plugins）：**Claude Code / Codex / Kimi CLI / Zcode**。

- **真实扫描**：读取各平台主目录（`~/.claude`、`~/.codex`、`~/.kimi`、`~/.zcode`）的技能目录与插件注册表，展示名称、描述、版本、来源市场与启用状态；支持 SKILL.md 原文预览与目录直达
- **技能启停**：采用目录迁移法（`skills/` ↔ `skills-disabled/`），与 Codex 官方禁用机制一致，可逆且不改动各 CLI 自身文件；链接技能（如 Zcode 聚合层指向 Claude Code 的 junction/symlink）启停时**级联同步源平台**——禁用会连同源平台真实目录一起移入禁用位，启用时先恢复源目录再重建链接，失败自动回滚；指向外部目录的链接仅移动链接本身；源平台直接禁用导致的悬空链接会在列表中标记「链接失效」，仍可开关处置
- **插件启停**：直接写入各平台自身的启用配置——Claude Code 写 `~/.claude/settings.json` 的 `enabledPlugins`，Zcode 写 `~/.zcode/cli/config.json` 的 `plugins.enabledPlugins`，Codex 定向翻转 `~/.codex/config.toml` 对应 `[plugins."id"]` 段（保留其余内容与换行风格）；Kimi CLI 暂无插件体系时明确提示
- **安全边界**：配置文件解析失败时拒绝写入并保留原文件；技能/插件名称做路径穿越校验；同名冲突时拒绝覆盖

## 设置

按职责分区：**AI 服务 / Git 活动采集 / 个人身份 / 应用信息**。已发现 Git 仓库仅作为报告数据源状态展示，不再承担项目管理入口。

## 技术栈

Electron 33 · Vue 3 · Element Plus · ECharts · Vite 6 · electron-builder · ssh2 · archiver

## 开发

```bash
npm install
npm run dev        # 开发模式（Vite 热更新 + Electron）
```

## 使用（本地运行）

```bash
npm start          # 构建渲染层并启动
```

## 打包发布

```bash
npm run build:renderer  # 仅构建渲染层到 dist/
npm run build:win       # Windows（NSIS 安装包 + 便携版）
npm run build:mac       # macOS（dmg）
npm run build:linux     # Linux（AppImage + deb）
```

产物输出至 `release/` 目录。

## 目录结构

```
├── electron/              # 主进程
│   ├── main.js            #   入口 + IPC
│   ├── preload.js         #   contextBridge 安全桥接
│   ├── project-service.js #   通用项目 CRUD（名称/目录/状态/标签/备注，凭据脱敏）
│   ├── extensions-service.js # 四平台技能/插件扫描与启停（Claude Code/Codex/Kimi CLI/Zcode）
│   ├── git-service.js     #   Git 扫描/收集/仓库信息（纯 Node）
│   ├── ai-service.js      #   AI 对话（流式）
│   ├── report-history.js  #   报告历史
│   ├── store.js           #   userData 配置持久化 + safeStorage 加密
│   └── deploy/            #   OneDeploy 一键部署模块
│       ├── deploy-service.js    #   发布编排（8 阶段 + 日志流 + 取消）
│       ├── deploy-projects.js   #   部署项目配置兼容层（凭据加密）
│       ├── ssh-service.js       #   SSH/SFTP（ssh2）
│       ├── packager.js          #   ZIP 打包 + 忽略规则 + SHA256
│       ├── version-detector.js  #   版本号识别
│       ├── history.js           #   发布历史
│       └── scripts/deploy.sh    #   服务器端部署脚本
├── src/                   # 渲染进程（Vue 3）
│   ├── views/             #   工作台 / 项目 / AI 助手 / 活动报告 / 部署 / 扩展管理 / 设置
│   ├── components/        #   导航、页头、项目编辑、对话面板、图表等
│   ├── composables/       #   项目加载与当前项目选择
│   └── utils/             #   项目上下文 / AI 上下文 / 报告生成 / 日期
└── scripts/               # 构建与部署辅助脚本
```

## 数据存储

- 项目数据与配置保存在 `userData/config.json`、`userData/deploy-projects.json`（兼容旧部署项目数据）
- 发布历史保存在 `userData/deploy-history.json`（完整日志在 `userData/deploy-logs/`）
- API Key 与 SSH 凭据经 safeStorage 加密落盘

## 说明

- Git 活动采集只需本机安装 git，无需联网；未安装 git 或项目不是 Git 仓库不影响项目、AI 助手等其他能力的使用。
- 首次使用报告能力时若检测不到全局 git 身份，请在「设置 → 个人身份」确认本人姓名/邮箱，或在系统中配置 `git config --global user.name/email`。
- 部署能力需可访问目标服务器（SSH 22 或自定义端口）；数据卷请挂载到 `shared/` 或绝对路径，避免放入版本目录随发布被清理。
