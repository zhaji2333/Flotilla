# ADR-0008：P3-A1 跨任务先验工作检索（控制面摘要注入）

- 状态：已实施（2026-11-07）
- 关联：P3 计划 A1；前序 ADR-0005（Harness 执行面）、ADR-0007（独立 API）
- 相关代码：`packages/control-plane/src/repositories/trace-summary-repository.ts`、`packages/orchestrator/src/worker/main.ts`、`packages/orchestrator/src/harness/{assignment,runner,runtime-child}.ts`

## 背景

同一 mission 可能出现多个任务（Planner 拆分、依赖串行、人工追加）。此前每个 Worker 只看到自己的 assignment：后来任务无法知道前面任务已经确认了什么、哪些技术失败了、加载过哪些 SKILL、发了多少请求。结果是重复侦察、重复失败技术、重复报告同一 root cause。`task_trace` 已有完整轨迹，但只供人看，没有进入后续 Worker 的上下文。

## 决策

1. **控制面注入优先，不做 Harness 侧 DB 工具**：Worker 不获得数据库凭据；摘要由控制面在 claim 边界计算并注入 assignment prompt。可选 Harness `trace_search` 工具留到后续阶段，不作为 M1 依赖。
2. **共享投影只写一份**：`getMissionTraceSummary(pool, missionId, {excludeTaskId, taskLimit, maxDigestChars})` 位于 `packages/control-plane`，被独立 API、旧 Web API、Worker 三方共用；Worker 传入自己的 pool 避免再建连接池。
3. **两个出口，一份数据**：
   - `GET /api/missions/:id/trace-summaries`：结构化 totals + 每任务统计 + `digest`，供控制台「先验工作」面板与审计；
   - Worker injection：`digest` 以 `PRIOR WORK IN THIS MISSION` 段落进入 assignment prompt，并落 `task.prior_work_injected` 事件 + `context(source=prior_work)` 轨迹。
4. **排除当前任务**：Worker 注入时传 `excludeTaskId=当前 task`，避免恢复/重试时把自身旧轨迹当成"先验"。
5. **有界与最小化**：只注入聚合统计（state/attempt/steps/token/tool/skill/finding/evidence 计数）、任务短摘要（≤200 字符）与失败原因（≤160 字符）；默认 digest ≤1500 字符（`PRIOR_WORK_MAX_CHARS`），最多 6 个先验任务（`PRIOR_WORK_TASK_LIMIT`），`PRIOR_WORK_ENABLED=0` 可关闭。请求/响应正文永不进入注入上下文。**只统计真正被领取/运行过的任务**（`attempt > 0` 或有 worker report）：刚规划出来、尚未开始的 ready/proposed 任务不算先验工作，也不出现在 API 的 `tasks`/`totals` 中。
6. **不可信标注**：摘要可能引用目标内容，因此 assignment 明确标注为 untrusted data；它只是数据，不是系统指令。

## 安全边界

- 摘要生成只用 PostgreSQL 投影（tasks/task_trace/worker_reports/findings/evidence 计数），不读取 evidence 正文。
- 注入发生在 Worker 进程内已有授权（claim + fencing）之后，不新增网络/授权面；不改变 scope/proxy/Curator。
- 注入失败（DB 错误/摘要为空）只记录日志并继续执行，不阻塞任务。
- 审计：事件 `task.prior_work_injected {chars, tasks}` 与轨迹 context 行可回溯"模型看到了什么"。

## 备选与取舍

| 方案 | 结论 |
|---|---|
| Harness `trace_search` 工具让模型自助检索 | 需要给 Worker 内部读库能力/网络 token；上下文不可控、审计面更大。留作后续可选能力。 |
| 把摘要塞进 `task_hints` 队列 | hints 是人工/规划语义、会被消费标记；先验工作每组任务自动生成，语义不同。 |
| Worker 直接查 `task_trace` 并拼 prompt | 与 API 逻辑重复、易漂移；且缺少统一预算/脱敏。 |

## 验证

- 单测：digest 格式/截断预算/N/A（`packages/control-plane/src/repositories/trace-summary.test.ts`）与 prompt 段落顺序（`packages/orchestrator/src/harness/assignment.test.ts`）。
- 集成：`scripts/prior-work-test.mjs` 在同一 mission 追加第二个任务，断言第二个任务收到 `PRIOR WORK`、`task.prior_work_injected` 事件、`context(source=prior_work)` 轨迹且 digest 含第一个任务的 `state=done`。
- API：`scripts/api-smoke.mjs` 与 `scripts/e2e-test.mjs` 校验 `GET /api/missions/:id/trace-summaries` 结构与真实统计。

## 后果

- 后续任务上下文增加约 1.5k 字符上限的稳定前缀；对 1M 上下文可忽略。
- 项目新增 `orchestrator -> control-plane` 的 workspace 依赖（Worker 镜像已复制该包）；控制面与 API 不会反向依赖执行面。
- 若后续做 B1 typed 黑板，可复用同一投影模式，但黑板事实与轨迹摘要保持两个读模型，不互相替代。
