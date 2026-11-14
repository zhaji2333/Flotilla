# ADR-0018：独立 executor、Summary、请求去重、账号与管理面

- 状态：已实施（2026-11-09）
- 关联：独立执行容器、Summary/补漏、请求指纹、历史复核清理、账号/参数/项目删除
- 影响：Worker/Planner/API/compose、执行面网络、前端登录与管理页

## 背景

ADR-0017 已把 Harness 子进程的 PG/管理员凭证剥离，并加入命令门控和自动 finding review。但仍有四个结构缺口：

1. Agent 仍与 Worker controller 同容器；controller 崩溃/环境变量泄漏会重新暴露执行面。
2. 任务完成后没有“覆盖/缺失证据”的独立复审，容易提前收尾或漏 finding。
3. 同项目跨任务的重复请求没有共享索引，A/B 中重复 HTTP 仍多。
4. 系统只有静态 token，没有人类账号、角色、参数调整和项目删除能力。

## 决策

### 1. 独立 executor

- 新增 `executor` compose 服务（同 orchestrator 镜像，`src/executor/main.ts`）。
- executor 只加入 `execnet` internal 网络；可访问 proxy 和 API（只读 token），**不能访问 postgres**，无 PG/管理员 env。
- Worker controller 通过 `POST /internal/run` 派发任务；共享 named volume `src_agent_runs:/runs` 承载 workspace/report/session/outcome/trace。
- executor 写 `outcome.json`/`trace.json`，worker 读取后继续现有 `finishTask`/`recordTaskTrace`；executor 不写 DB。
- `SRC_AGENT_EXECUTOR_URL` 未配置时 worker 保留本地 CLI fallback；compose 默认 remote。
- Summary 是只读复审，当前由 worker 本地 CLI 执行（不占 executor 并发，避免 summary 阻塞普通任务）；普通任务仍走 executor。

### 2. Summary/补漏

- 新 task 类型 `summary`；mission 没有 open task 且 summary 尚未执行时，`finalizeMissionState` 插入一个 bounded summary task（默认最多 1 轮）。
- Summary task 使用只读 mission tools + `submit_summary`；不发送目标请求，不产生 finding。
- 输出写入 `mission_summaries`；gaps 转成最多 3 条 task_hints，可选创建最多 3 个 proposed 补漏 task。
- 失败/超时只标记 summary failed，不阻塞 mission 最终完成；Planner 的 `cancel_task` 不得取消 summary task。
- API `GET /api/missions/:id/summary`；前端 mission detail 展示摘要/缺口。

### 3. 请求去重

- 新表 `mission_request_index`：mission/method/normalized URL hash/body hash/auth hash/status/task/traffic ref/hits。
- Controller 在任务完成后从 trace 的 `http_request` tool_call 写入索引；不保存原始 body/auth header。
- Claim 时把最近 100 条写入 `request-index.json`；插件 `http_request` 发请求前计算相同指纹并追加 `[dedupe]` 提示。
- 默认 `warn`，不阻止、不复用响应；避免误伤需要重复验证的授权测试。

### 4. 历史 finding 清理

- `scripts/finding-review-backlog.mjs` + `packages/orchestrator/scripts/finding-review-backlog.ts`。
- 默认 dry-run；`--apply` 才改状态。逐条事务，调用现有 `autoReviewFinding`；写 `finding.auto_reviewed_backlog`/`approval.resolved` 事件，不删除原 finding/approval 行。

### 5. 账号 / 权限 / 参数 / 删除

- 迁移 `0002-auth-admin.sql`：`users`、`sessions`、`admin_audit`、`runtime_settings`。
- 密码 scrypt（Node 内置）；session 只存 SHA-256 token hash；Cookie HttpOnly/SameSite=Lax；session mutation 需 CSRF token。
- 角色：viewer（读）、operator（任务/hint/finding review）、admin（scope upgrade、模型配置、参数、账号、删除项目）。
- 服务 token 保留：`API_AUTH_TOKEN`/`API_ADMIN_TOKEN`/`API_READ_TOKEN`。`AUTH_MODE=legacy|accounts` 支持渐进迁移；nginx 的 legacy token 由 `API_LEGACY_TOKEN` 控制，accounts 模式设为空。
- 首次启动 `POST /api/auth/setup` + `SETUP_TOKEN` 创建 admin；之后登录 `POST /api/auth/login`。
- 运行时参数仅允许非秘密白名单；API 修改写审计；worker 的 finding review/summary 读取 DB 设置，环境变量是 fallback。
- `DELETE /api/admin/missions/:id`：admin + 精确项目名确认；事务按 FK 顺序删除全部业务数据，写 `admin_audit`（不含业务正文）；通过 executor `/internal/cleanup` 删除运行目录。
- 前端新增 `/login`、`/setup`、`/admin/users`、`/settings/runtime`、项目删除按钮和 Summary 面板。

## 未解决

- Worker controller 仍直连 DB；真正 dispatcher-only 写入需把 claim/report 也迁到 API。
- 模型 key 仍通过 executor env 给 Agent；需要模型代理/短期 token。
- 部分 runtime_settings（planner、mission context、dedupe mode）目前仍由 env/进程启动决定，尚未全部热生效。
- Summary 在 worker 本地执行，未走 executor；后续可把只读 summary 也迁到 executor。
- `proxy_denials` 已由 ADR-0019 删除（原全局审计无 mission 外键）。

## 验证

- `pnpm run verify`
- `api-smoke`、`mission-context-smoke`、`multi-worker-plan-test`
- 完整 e2e（含 executor、summary、direct egress 反向检查）
- auth/role/CSRF/delete/settings 手工与脚本检查
