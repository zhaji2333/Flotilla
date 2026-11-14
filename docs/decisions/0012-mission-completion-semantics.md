# ADR-0012：任务/任务集完成语义（移除 expectedArtifacts 门槛）

- 状态：已实施（2026-11-08）
- 关联：用户 2026-11-08 决策；影响 `contracts`、`control-plane`、`orchestrator`、Web/SPA、API 契约、e2e/脚本
- 相关代码：`packages/contracts/src/index.ts`、`packages/control-plane/src/repositories/{mission-repository,read-repository,mission-control-repository}.ts`、`packages/orchestrator/src/{harness,worker,planner}`、`packages/harness-plugin/src`、`scripts/mission-completion-test.mjs`

## 背景

P0–P2 的 completion 语义来自 CTF 场景：mission 创建时要求 `successCriteria.expectedArtifacts`（正整数，默认 1），Worker 报告里 `artifacts.length >= expected` 才把任务标记 `done`，否则判 `no_progress`；并且每个任务报告会立即把 mission 置 `completed`/`failed`。

在 SRC/红队/真实授权测试中：

- 侦察、信息收集、横向移动、提权等任务**没有“产物数”**，硬门槛会把有效工作判失败；
- 一个 mission 往往有多任务/多意图，第一个任务结束就把 mission 收尾是错的；
- 是否“打成功”应由实际证据/发现与任务终态决定，而不是 CTF flag 数量。

用户决定：`expectedArtifacts` 从 API/UI 语义中移除，只保留内部质量指标；mission 完成改为“所有 task 终态 + Curator 收集完毕”。

## 决策

1. **移除 API/UI 字段**：`POST /api/missions` 不再接受 `successCriteria`/`expectedArtifacts`（`.strict()` 返回 400）；mission 详情不再返回 `successCriteria`；Web/SPA 新建表单、任务详情、Planner action 均移除该字段。数据库 `missions.success_criteria` 列仅作历史遗留保留，不参与逻辑。
2. **任务成功 = Harness 正常运行结束**：CLI runtime 以 `exitCode=0`、无 wall-clock/step limit、无 runtime error（chunking 时还要求最后一段自然完成）为 `done`；inprocess runtime 以无 limit/runtime error/turn error 为 `done`。超时/崩溃仍为 `failed`，但已产生的 evidence/findings 照常持久化。
3. **Curator 同步收集**：所有报告在 `finishTask` 事务内完成六道闸/落库，报告处理完即“收集完毕”；没有额外异步队列。
4. **mission 终态聚合（规则 A）**：仅当没有 open task（`proposed/ready/leased/running/retry_wait/blocked`）时计算：
   - 任一 task 为 `done/verified` **或** 存在 `accepted` finding → `completed`；
   - 否则（全部 failed/exhausted/cancelled/stale/handed_back 且无 accepted finding）→ `failed`，`failureClass=no_progress`。
   - 聚合在 `finishTask` 事务内、lease-expiry 调度路径、pause/resume 三条路径共用 `finalizeMissionState` 语义，避免多任务提前收尾。
5. **产物只做内部质量指标**：`findings.artifacts`（accepted finding 中非空 artifact 计数）保留在 `/api/metrics` 的 `findings` 对象，供看板/评测观察；不作为任务/ mission 完成条件。任务结果里的 `artifacts` 列表继续保留用于审计/报告。
6. **Planner**：`create_task` action 移除 `expectedArtifacts`；mission snapshot 不再有 expected；Planner 仍按 objective/frontier 规划。

## 安全/兼容影响

- API 破坏性变更：旧客户端发送 `successCriteria` 会 400；前端需按新契约更新（M1/M2/M3 交接文档已同步）。
- 历史数据库行 `success_criteria` 保留但忽略；无需迁移/删列。
- 任务“正常结束但没结论”现在会 `done`；质量风险由 metrics/Curator/review/watchdog 与人工复核覆盖，而不是完成门槛。
- 不会放宽 scope/proxy/Grant/Curator 闸；只是完成判定变化。

## 验证

- `scripts/mission-completion-test.mjs`：
  - `successCriteria` 被 400 拒绝；
  - 零产物正常任务 = `done`；
  - 多任务 mission 在第一任务完成后仍 `running`，最后一个任务完成后 `completed`；
  - 全部任务 exhausted 且无 accepted finding → mission `failed/no_progress`；
  - mission API 不再返回 `successCriteria`；内部 artifacts 指标为 0 仍可完成。
- e2e / api-smoke / 各 smoke 更新为新契约后通过。
