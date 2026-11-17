# ADR-0054：v1.0.2 实战可靠性硬化（deadline / disposition / handoff / preflight）

- 状态：已采纳（Phase 0 契约与迁移已落地）
- 日期：2026-11-17
- 依据：`docs/plans/v1.0.2-development-plan.md`、`Flotilla_CTF/docs/reports/2026-11-17-run-new-image-retrospective.md`
- 范围：P0/P1 可靠性语义；**不包含 `ssh_exec` 或任意远程命令执行**

## 背景

实战长任务暴露四类问题：时间失控（没有硬 deadline 和 reporting 阶段）、上下文断裂（worker 重启/重试后重复 recon）、无效重试（同目标/同技术反复打）、覆盖与证据不可证明（部分目标被静默跳过）。v1.0.2 在现有 prior-work、fingerprint、retry_wait、watchdog、Curator 之上做语义硬化，不新增攻击面。

## 决策

1. **Deadline 是 mission 级**：`missions.deadline_at` 为绝对时间；`missions.phase` 为 `active → reporting → closed`；进入 `reporting` 后不再创建新的攻击/验证 task，只允许证据补齐、报告/影响确认与 disposition 收尾。默认 `reporting_lead_ms=900000`（15 分钟），可配置。
2. **No silent abandonment**：每个 terminal task 必须有 `disposition`（`completed | exhausted | blocked | out_of_scope | insufficient_evidence | cancelled | timeout`）；mission 完成条件从“所有 task done”改为“所有授权 target/attack surface 都有 task / finding / negative result / explicit disposition，且报告可交付”。
3. **Handoff 是结构化合同**：`TaskHandoff` 只包含 target/scope 引用、access state、credential/evidence 引用、confirmed facts、failed hypotheses、2–3 个 next actions、blockers、approvals；禁止明文凭据与 raw CoT/响应正文；存入 `task_handoffs`，下一次 claim 只注入有界 digest（`TaskHandoffDigestSchema`）。
4. **Preflight 阻断“带错身份打错目标”**：worker 发目标请求前检查 mission phase/deadline、Grant scope、target 版本、credential 版本、未批准的 destructive/write action；失败记录 `task_preflight_checks`，按 `blocked/out_of_scope/retry_wait` disposition 处理，不启动 worker。
5. **Watchdog 默认 observe-only**：`WATCHDOG_MODE=observe` 为默认；`no_progress`/`duplicate_url` 只写 observation/hint，不自动 cancel/park；安全信号（scope change、destructive command、credential leak）仍走既有 approval。
6. **Retry 治理**：fingerprint 复用现有去重；`task_retry_state` 记录 attempt/next_at/last_error；默认指数 backoff + jitter、最多 3 attempts、每 target 默认 1 个 active task（可配置为 2）；超过上限转 `exhausted` 交人工。
7. **Coverage / ROI / reporting endgame**（P1）：`coverage_requirements` 由授权 target/asset 派生，Planner 计划校验覆盖率并在缺失时补 task；排序只用通用特征（target criticality、coverage gap、attempts、expected findings、tool needs、remaining budget），不写死 benchmark/challenge 名称；deadline 前自动进入 reporting 并生成 coverage/disposition/blockers 摘要。
8. **`web_search` DLP**：mission 级 `search_policy=disabled|limited|allowed`，默认 `limited`；目标域名/IP/凭据/客户名脱敏；搜索审计 + untrusted 标记；搜索原文不得直接作为 finding 证据。

## 数据模型

迁移 `0013-v102-reliability.sql`（additive only，`schema.sql` baseline 同步）：

- `missions`：`deadline_at`、`phase`、`reporting_lead_ms`、`search_policy`；
- `tasks`：`disposition`、`handoff_version`、`deadline_at`、`preflight_status`；
- 新表：`task_handoffs`、`task_preflight_checks`、`task_retry_state`、`coverage_requirements`；
- 旧 mission/task：新列可空或带默认值，读取时按 terminal state 派生 disposition，不破坏既有行为；迁移只新增，不删列、不改旧枚举。

## 开关与回滚

| Flag | 默认 | 说明 |
|---|---|---|
| `V102_MISSION_DEADLINE` | off | 新 deadline/reporting 行为 |
| `V102_TASK_DISPOSITION` | off | 新完成语义 |
| `V102_TASK_HANDOFF` | off | handoff 生成/注入 |
| `V102_PREFLIGHT_STRICT` | off | preflight 严格阻断 |
| `V102_RETRY_BACKOFF` | off | 新 backoff/并发上限 |
| `V102_WATCHDOG_OBSERVE_ONLY` | on | 默认 observe-only 兜底 |
| `V102_SEARCH_GOVERNANCE` | off | 搜索 DLP |
| `V102_PLANNER_COVERAGE_INVARIANT` | off | coverage 校验 |
| `V102_PLANNER_ROI` | off | ROI 排序 |
| `V102_REPORTING_ENDGAME` | off | 收尾阶段 |

关闭对应 flag 即回到 v1.0.1 行为；迁移不删除任何列/表；报告字段向后兼容。

## 非目标

- 不做 `ssh_exec`、任意远程命令执行或横向移动自动化；
- 不写死 challenge/benchmark 编号或固定靶场参数；
- 不改变认证/审批/Grant 模型，不绕过 Curator 与人工审批；
- deadline 压力不得成为越界理由。

## 后果

- Phase 0 先落地契约（zod schema + 类型 + 单测）、迁移、repository 骨架与 ADR；
- Phase 1 按 T1.1–T1.6 垂直切片实现，每片保持 `pnpm test`/`pnpm run typecheck` 通过并受 flag 保护；
- `scripts/v102-e2e.mjs` 与冻结用例在 Phase 3 补齐；旧 e2e/Curator/approval/proxy/frontend 必须无回归。
