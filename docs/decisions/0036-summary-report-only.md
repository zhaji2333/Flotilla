# ADR-0036：Summary 默认只出报告，补漏任务可选且最多 1 个

- 状态：Accepted
- 日期：2026-11-13
- 关联：ADR-0012、ADR-0018、ADR-0019

## 背景

Summary（`tasks.type = 'summary'`）在 mission 收尾前做一次只读复盘。原实现会在 `finishTask`
时把 `summary.gaps` 的前 3 个（除 confidence=low 外）自动转成 `intent` 补漏任务：

```text
SUMMARY_CREATE_TASKS !== '0'  →  最多 3 个补漏任务
```

问题：

1. **默认就会补漏**：目标已经达成（例如 4 个 flag 全部 accepted）时，仍然会自动创建 1–3 个新任务，
   mission 无法及时收敛，还会继续消耗模型/预算。
2. **数量不可控**：一次 summary 最多 3 个任务，叠加 summary 轮数后可能更多。
3. **不可关闭**：只能靠环境变量，运行期无法调整。

## 决策

1. **默认只出报告**：补漏任务默认关闭（`worker.summaryFollowUpEnabled=false`）。
2. **显式开启**：运行期设置 `worker.summaryFollowUpEnabled=true`（或 `SUMMARY_FOLLOWUP_ENABLED=1`）
   才允许创建补漏任务。
3. **最多 1 个**：`worker.summaryMaxFollowUps` 取值 0–1，硬上限 `MAX_FOLLOW_UPS = 1`；
   即使配置更大也会被 clamp 到 1。
4. **目标已达成则不再补漏**：summary 工具新增 `objective_achieved` 字段，复盘模型在
   "目标已满足（例如所有预期 flag 都已是 accepted finding）"时必须置 true；控制器看到 true
   就只保留报告，不创建任何补漏任务。低置信度（`confidence=low`）的 gap 永远不建任务。
5. 策略集中在纯函数 `packages/orchestrator/src/summary/followups.ts`
   （`selectFollowUpGaps` / `resolveFollowUpLimit`），由 `finishTask` 调用；summary 仍会写
   `mission_summaries`、gap hints 与 `mission.summary_completed` 事件
   （payload 增加 `followUps`、`objectiveAchieved`）。

## 后果

- mission 在目标达成后能立即进入终态；E2E 的完成时间不再取决于补漏任务。
- 需要持续补漏时按 mission/全局打开开关即可，无需改代码。
- 补漏任务仍是普通的 `intent` task，走同一套 scheduler/claim/fencing/scope。

## 验证

- `packages/orchestrator/src/summary/followups.test.ts`：默认不建、最多 1 个、0 上限、
  `objectiveAchieved` 抑制、低置信度过滤。
- `scripts/e2e-test.mjs`：mission 完成后 `/api/missions/:id/summary` 仍有 markdown 报告。
