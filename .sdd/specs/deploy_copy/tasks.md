# Tasks：部署配置复制 / 新建默认带入 / 发布页新版本

1. [R1][R2][R3] 主进程 deploy-projects.js 实现 copyConfig（raw 深拷贝 + 新目标 id + persistAll）并导出
2. [R1] main.js 注册 `deploy:projects:copyConfig` IPC，preload.js 暴露 `deployProjectsCopyConfig`
3. [R4] DeployConfigDrawer.vue 增加复制入口按钮、源项目选择对话框与确认文案，emit copy-config
4. [R5] DeployView.vue 传入项目列表并处理 copy-config：调用 IPC、刷新表单、切换选中目标、清空连接结果
5. [R6] 主进程 save() 新项目默认带入：applyCopyConfig/pickCopySource 抽取复用，返回 copiedFrom/copiedTargets；DeployView.saveProject 提示并选中新环境
6. [R7] DeployRunPanel 发布卡加「新版本」入口：对话框预测 patch/minor/major 候选（基准取本地/线上/历史最高版本，线上未知时静默查询）+ 自定义输入 → set-version 事件；DeployView.onNewVersion 切手动版本并保存
7. [R1-R7] harness 扩展验证 R6 + npm run build + 静默安装本地
8. [R7] 版本工具抽到 src/utils/version.js（parse/bump/compare/highest）；单元 + 真实 Electron E2E 验证候选预测与保存后发布版本
