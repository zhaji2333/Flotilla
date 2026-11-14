# ADR-0037：删除项目先取消运行中的任务

- 状态：Accepted
- 日期：2026-11-13
- 关联：ADR-0019、ADR-0024

## 背景

`DELETE /api/admin/missions/:id` 之前的流程是：校验确认名 → 在一个事务里把 tasks 置 `cancelled`
→ 立刻级联删除 tasks/events/findings 等行。

问题：事务提交时 task 行已不存在，worker 的取消轮询（每 2s 查一次 task 状态）看不到 `cancelled`，
因此不会触发 executor 硬取消（ADR-0024）。结果：

- 被删项目的 Harness 进程继续跑完（继续打靶、烧 token）；
- 它发出的目标请求已经不属于任何 task，写动作以 `task_id = NULL` 落 `action_ledger`；由于这些请求
  没有 mission header，会被代理按 URL 匹配归到**当时唯一同 target 的新 mission** 名下；
- 新 mission 的 bootstrap task 因此被判为 `write_actions_require_confirmation` 而阻塞。

## 决策

删除拆成三步：

1. 校验确认名（只读），名字不符直接 400，不做任何状态修改；
2. `cancelMissionTasksForDeletion`：单独提交，把该 mission 的 open tasks 置 `cancelled`
   （`last_error='mission deleted'`）并写 `mission.delete_cancel_observed` 事件；
3. 等待 4 秒让 worker 的取消轮询发现并让 executor 中止 Harness 子进程，然后再执行原有级联删除。

只有真的存在 open task 时才等待，已终态的 mission 删除仍是即时的。

## 代价

- 删除运行中项目会多 4 秒延迟。
- 若 worker 恰好不在线，等待仍然发生但无人取消；executor job 会自行跑完（无 task 行可写，
  outcome 被 fencing/不存在丢弃）。这是可接受的降级：不再产生"新一轮 mission 被旧流量污染"的问题。

## 验证

- 手工：创建 mission 让 bootstrap 运行中，`DELETE`（带 `confirmName`）→ 4s 内 executor 日志出现
  job cancelled，任务不再产生目标流量。
- 名字不符的删除请求返回 400 且任务状态不变。
