# ADR-0021：任务级人工控制与目标写动作账本

- 状态：Accepted
- 日期：2026-11-10
- 关联：P1 1.7、P1-γ、ADR-0012、ADR-0019

## 背景

P1 1.7 计划包含“手动派 Intent、取消单任务、steering 命令通道”。此前只完成了暂停/续跑、hint 和 SSE，没有任务级人工写路径；同时任务 lease/transient 重试可能重复 POST/PUT/PATCH/DELETE，而数据库 fencing 只能防止重复报告，不能防止目标侧副作用重复。

## 决策

### 1. 人工控制是同步事务，不是异步队列

新增：

- `POST /api/missions/:id/tasks`：直接插入 `intent` 任务（proposed），仍由 scheduler/readiness 决定执行；
- `POST /api/missions/:id/tasks/:taskId/cancel`：状态机允许的 non-terminal 状态 → cancelled；
- 每个动作同时写入 `steering` 表作为审计记录（processed=true）。

没有把 `steering` 做成异步命令队列；当前单用户控制面直接事务执行，避免额外的消费者和竞态。

### 2. 取消是 controller-level 软取消

运行中的 executor 可能继续到当前运行结束；任务状态已取消，迟到的 Worker 报告被 fencing 丢弃。后续可再做 executor 硬取消，但不在本 ADR 范围。

### 3. action_ledger 记录目标写动作

- 表 `action_ledger`（迁移 0008）由 proxy 写入；
- 只记录 target 流量的 POST/PUT/PATCH/DELETE；
- `mission_id` 由 proxy 的 active grant 解析/请求头确定；`task_id` 由工具请求的 `X-SRC-Task-Id` 指定；
- 该 header 在 proxy 转发前删除，不泄露给目标；
- 项目删除通过 mission FK `ON DELETE CASCADE` 清理。

### 4. 重试前核对

- Worker 在本地 transient retry 前调用 dispatcher `/internal/dispatch/retry-guard`；
- Scheduler 在把 `retry_wait` 提升为 `ready` 前检查 action ledger；
- 若存在未确认写动作，任务进入 `blocked`，`last_error=write_actions_require_confirmation`；
- `POST /api/missions/:id/tasks/:taskId/confirm-retry` 是唯一放行路径，写入 `write_actions_confirmed_at=now()`；
- 之后的新写动作（observed_at > confirmed_at）会重新阻断。

## 代价与边界

- 依赖 proxy 对写方法/任务归属的正确记录；bash 等无任务 header 的写动作按 mission + 任务开始时间保守归入。
- 代理审计写入失败只记录日志，不阻断已授权请求；任务 ledger 缺失时无法阻断重试，这是可观测性缺陷而非授权旁路。
- 取消不是强杀 executor；需要强制终止时后续增加 executor cancel 协议。
- header 归属是内部可信假设；不把 `X-SRC-Task-Id` 当作授权依据，只作为审计/重试关联。
