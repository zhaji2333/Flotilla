# ADR-0015：M5 修订——单项目自主闭环（取代原 portfolio 定位）

- 状态：已实施（2026-11-08；A/B 评测报告待跑）
- 取代：ADR-0014 中 **B5 portfolio** 的 M5 定位；B6 保活/help-report 与 A6 eval 看板保留
- 后续修订（2026-11-08）：B5 portfolio 已**删除**（代码/API/表/profile）；M5-4 轨迹检索改为 Worker 动态 API；Worker 固定 x86；默认 3 副本；旧 `packages/web` 已删除
- 方案：[p3-m5-revised-implementation-plan.md](../plans/p3-m5-revised-implementation-plan.md)；架构：[single-project-architecture-draft.md](../plans/single-project-architecture-draft.md)
- 相关代码：`mission-overview-repository.ts`、`mission-context-repository.ts`、`worker-trace-repository.ts`、`asset-graph-repository.ts`、`mission-tools.ts`、`packages/orchestrator/src/planner/*`、`worker/main.ts`

## 背景

原 M5 计划是跨 mission portfolio commander。用户/架构评审确认：当前产品是**单项目（Project，字段仍叫 mission）+ 单 Planner + 多 Worker**。跨项目总指挥与单项目模型冲突，因此：

- 原 B5 portfolio **删除**（不是仅关闭）：`packages/orchestrator/src/portfolio`、`portfolio-repository*`、`/api/portfolio*`、compose profile、数据库表全部移除；
- 新 M5 目标是补齐“单项目自主闭环”：Planner 能看到项目态势并并发派 Task，Worker 拿到任务简报与项目内只读工具，跨 Worker 轨迹可检索，项目内资产图可查询，默认 3 个 Worker 并发；
- B6（单 key/storm guard/help-report）与 A6（eval_runs/dashboard）保留并继续使用。

## 决策

1. **项目概览读模型**：新增 `getMissionOverview` + `GET /api/missions/:id/overview?maxChars=`，统一给 Planner/Worker/前端；只读、同 mission、硬 JSON 预算、无请求/响应正文。
2. **Planner 增强**：Snapshot v2 注入 facts/hints/negatives/traceSummary/coverage/budget；允许一个 plan 创建 ≤3 个独立 Task，有依赖必须 `dependsOn`；`PLANNER_MAX_OPEN_TASKS=3` 强制上限；新增 `update_todo {todoId,status}`；frontier 默认开启（`PLANNER_FRONTIER_ENABLED=1`，保留 0 做 A/B）；新 hint 创建写 `planner_signals(kind=hint_created)` 触发下一轮规划。
3. **Worker 简报 + 项目工具**：claim 时生成 run-local `mission-context.json`（≤512KB，超限分层截断），prompt 注入 ≤2500 字符 `MISSION BRIEF`；插件新增 7 个只读工具：`mission_brief`、`mission_recall`、`mission_frontier`、`mission_fact`、`mission_findings`、`search_worker_traces`、`mission_assets`。全部同 project、输出截断、无网络/DB。
4. **跨 Worker 轨迹检索**：`searchMissionWorkerTraces` + `GET /api/missions/:id/worker-traces/search`；只查当前 mission、排除当前 task、结果标记 `untrusted`、不返回原始 body。
5. **项目内资产图/覆盖度**：`getMissionAssetGraph` + `GET /api/missions/:id/assets/graph`；资产节点 + task/finding/evidence 锚点；覆盖度按 task/evidence/fact 引用推导；不引入全局资产表/跨项目图。
6. **默认 3 Worker**：文档化 `docker compose up -d --scale worker=3`；`WORKER_ID` 为空时由 hostname 派生唯一 ID；`multi-worker-plan-test.mjs` 验证 3 个独立 Task 无重复领取、全部完成、mission completed；可缩回 1。
7. **旧 portfolio 删除**：代码/API/profile/数据库表移除；不保留回退。旧 `packages/web` 容器与源码同时移除，前端只走 5173 SPA/nginx。
8. **M5-4 动态轨迹检索**：Worker 工具 `search_worker_traces` 直接调用控制面 `/api/missions/:id/worker-traces/search`（同 mission、排除当前 task、untrusted、无原始 body）；claim 快照只作 API 不可用 fallback。
9. **Worker 平台**：3 个 worker 容器固定 `linux/amd64`，compose 默认 `deploy.replicas: 3`。
10. **不做**：浏览器/Playwright、跨项目 portfolio/资产图、把文件图当事实源、tmux、硬 token/成本上限、修改 scope/Grant/Curator/审批/代理边界。

## 安全边界

- overview/context/trace/asset 全部按 mission 隔离；跨 mission 返回 404/空。
- context/trace 不含原始请求/响应正文；trace 结果 `untrusted=true`；context brief 对敏感 fact 值/ key 脱敏。
- mission 工具只读本地 context；不访问网络/DB，不扩大 egress。
- 3 Worker 并发不改变 claim/lease/fencing；每个 Task 仍单独审计。
- Portfolio 即使开启也只能产生 pending 人工审批动作；默认关闭且不接前端。

## 回退

- `MISSION_CONTEXT_ENABLED=0` 关闭简报/工具；
- `PLANNER_FRONTIER_ENABLED=0`、`PLANNER_PARALLEL_TASKS=0`、`PLANNER_MAX_OPEN_TASKS=1` 回退 Planner 行为；
- `docker compose up -d --scale worker=1` 缩回单 Worker；
- portfolio 已删除；旧数据库表在 schema 启动时 `DROP TABLE IF EXISTS` 清理；回滚需从历史 commit 恢复。
