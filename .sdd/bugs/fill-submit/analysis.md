# 一键填报提交修复

## 范围与证据

2026-09-11 审查已通过隔离客户端动态复现四项缺陷（confirmed），不向真实平台写入：

- 页面未传 date，后端缺省匹配全部日期：9 月 11 日的行错误复用 9 月 10 日 ID。
- recordEfforts 对 HTTP 500、HTTP 200 + result=fail 均正常返回，IPC 与页面错误显示成功。
- 同一笔 2h 工时重新生成后覆盖，剩余工时从 10→8→6，未补回被覆盖记录的旧消耗。
- 已有记录查询超时被转换为空数组，提交继续按新增执行。

调用链：FillReportView.submitFill → preload.fillSubmit → main 的 fill:submit → fill-service.submit → ZentaoClient / HanprintClient。保持现有模块结构，不创建额外规格体系。

## 修复契约

- 页面传计划日期；后端拒绝缺失、无效或与工时行不一致的日期。
- 写入前获取全部目标任务最新剩余及目标日记录，并查询所涉及的汉印记录。任一查询失败不得写入。
- 更新仅复用目标日期的 ID，不信任传入的旧 effortId；剩余按最新剩余加实际覆盖行旧消耗减新消耗计算。计划预览同步差额口径。
- 查询返回明确空列表才表示无记录；网络异常、未知结构或不完整记录不得转为空列表。
- 禅道仅在 HTTP 成功且 JSON result=success 时确认成功；未知响应要求核对记录，禁止自动重试写入。
- 不改变未涉及记录的保留策略，不承诺两个平台事务回滚；真实魔改版响应协议尚需实际环境验证。

## 回归验证

在 scripts/fill-report-selftest.cjs 中新增页面函数执行与客户端注入验证，覆盖跨日记录、重复生成与提交、工时增减、旧 ID/剩余值、查询失败不写、业务失败停止后续写入、明确成功与未知结果。原有真实 Git 仓库集成用例保留。

验证结果：`node scripts/fill-report-selftest.cjs` 74 项通过、0 失败；`npm run build:renderer` 通过（依赖的 PURE 注释有 Rollup 提示，不影响构建）；两个改动的主进程模块 `node --check` 通过；`git diff --check` 通过。未执行真实平台写入，未验证魔改版平台的实际响应格式。
