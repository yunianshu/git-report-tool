# Tasks：部署配置整套复制

1. [R1][R2][R3] 主进程 deploy-projects.js 实现 copyConfig（raw 深拷贝 + 新目标 id + persistAll）并导出
2. [R1] main.js 注册 `deploy:projects:copyConfig` IPC，preload.js 暴露 `deployProjectsCopyConfig`
3. [R4] DeployConfigDrawer.vue 增加复制入口按钮、源项目选择对话框与确认文案，emit copy-config
4. [R5] DeployView.vue 传入项目列表并处理 copy-config：调用 IPC、刷新表单、切换选中目标、清空连接结果
5. [R1-R5] 构建验证（npm run build）+ 人工验收路径记录
