# ADR-0024：任务取消升级为 executor 硬取消

- 状态：Accepted
- 日期：2026-11-11
- 关联：ADR-0012、ADR-0021

## 背景

P1 1.7 的任务取消最初是 controller-level 软取消：任务状态变为 `cancelled`，迟到报告被 fencing 丢弃，但 executor 中的 Harness 进程可能继续执行，继续消耗模型、命令和网络资源。

## 决策

取消分三层协作：

1. **API/控制面**：`cancelTask` 事务化写入 `tasks.state='cancelled'`、事件和 steering 审计；任务终态不会再被迟到报告覆盖。
2. **Worker**：运行期间每 2s 查询 dispatcher 的 `tasks/state`；发现 `cancelled` 后：
   - 写 `task.cancel_observed` 审计；
   - 调用 executor `/internal/cancel`（按 jobId/taskId/attempt）；
   - abort 本地 executor 请求，停止重试/结算；
   - 不调用 `finishTask`，避免迟到 outcome 覆盖取消状态。
3. **Executor**：为每个运行中 job 持有 AbortController；取消时 abort 当前：
   - in-process runtime child：标记 cancelled、kill child；
   - CLI Harness 子进程：SIGTERM，超时 SIGKILL；
   - 取消响应 HTTP 499；不再写入 outcome/trace。

## 边界

- 取消是尽力而为：进程已退出/已结束时 cancel 返回 404，不报错。
- 取消后不写入部分 finding/evidence；executor 不提交 outcome。
- 已产生的目标写动作仍保留在 action ledger；不可撤销。
- `finishTask` 对 `cancelled` 任务抛 fencing error，确保迟到报告无法复活任务。
- 该机制不替代容器隔离/scope；只解决运行中资源浪费和迟到报告。

## 验证

- 手工创建长任务，取消后 worker 日志出现 `hard-cancelling executor job`，executor 日志 `cancel request ... matched=1`，任务保持 `cancelled` 且无 `task.completed`/迟到报告。
- 事件包含 `task.cancelled` + `task.cancel_observed`。
