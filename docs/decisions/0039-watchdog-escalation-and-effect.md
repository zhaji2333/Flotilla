# ADR-0039：Watchdog 升级动作、trace 感知与效果回采（含看板）

- 状态：Accepted
- 日期：2026-11-14
- 关联：ADR-0029（外部 watchdog 服务）、ADR-0019（dispatcher 唯一 DB writer）、ADR-0018

## 背景

ADR-0029 的 watchdog 只会写 trigger + hint：任务反复停滞时每 30 分钟最多提示一次，
既没有升级动作，也无法回答"提示到底有没有用"。另外 `no_progress` 只以"窗口内无新 finding"
为唯一进展信号，长时间侦察（有工具轨迹、还没有 finding）会被误判为停滞。

## 决策

### 1. 连续 stalled 升级（同一任务）

- 新增 `watchdog_task_state`：每个 task 记录 `stalled_streak` / `escalated_streak`。
- 规则 `no_progress` 与 LLM `direction_drift` 累加 streak；LLM `verdict=ok`（progress=true）
  或人工复核 reject 时归零。
- 连续达到 `WATCHDOG_ESCALATE_AFTER`（默认 2）时，一次升级动作（每个停滞周期只做一次）：
  1. 写 `planner_signals(kind='watchdog_stall')` —— planner 下一次 reason pass 会读到并重新规划；
  2. 创建 `approvals(type='stalled_task')` 人工复核：
     - **approve** → `cancelTask` 取消该任务（并把决定写审计）；
     - **reject** → 清空 streak，任务继续；
  3. 写一条 `watchdog:escalation` hint 给该任务，说明"已提交 planner + 等待人工复核"。
- 同一次升级复用已存在的 pending `stalled_task` approval，不会重复建单；同一停滞周期内
  不会重复发 planner signal（`escalated_streak > 0` 即视为本周期已升级）。

### 2. trace 感知的 no_progress

- 规则改为：`running >= 阈值` **且** 窗口内既无新 finding **也无 task_trace 活动** 才告警。
- 外部 observer 与 dispatcher 内置 tick 的 SQL 都补上 `has_recent_trace`，`evaluateWatchdog`
  与 `shouldWarnNoProgress` 接受该信号（缺省 false，兼容旧调用）。

### 3. hint 效果回采

- 新增 `watchdog_observations`：每次 observation 一行，记录 rule/source/action/streak/
  hint/approval/signal。
- 新增 sweep：对超过 `WATCHDOG_OUTCOME_DELAY_MS`（默认 10 分钟）仍 `pending` 的 observation，
  统计观察时间之后：
  - 新增 accepted/pending finding 数（同任务或同 mission）；
  - mission 首次出现的 target URL 数；
  任一 > 0 → `outcome=progress`，否则 `no_progress`，明细存 `outcome_detail`。
- 命中率 = `progress / (progress + no_progress)`，在此之前为 `null`。

### 3.1 Planner 自动取消（2026-11-14 追加）

升级动作之后如果 Planner 也判断任务无用，可以**自动取消**，不需要人工再点一次：

- 升级写入的 `planner_signals(kind='watchdog_stall')`（payload 含 taskId/rule/streak/detail）
  会被 Planner 下一次 reason pass 消费；
- Planner prompt 新增 WATCHDOG STALLS 规则：判定为重复/死路/偏离目标 → `cancel_task {taskId, reason}`；
  仍在产出（长侦察）→ 只 `add_hint` 重定向，不取消；
- `cancel_task` 应用时额外做两件事：
  1. 把该 task 上 pending 的 `stalled_task` 审批自动关闭为
     `status=rejected, decided_by=planner:auto, payload.resolution=planner_cancelled`，
     并写 `approval.resolved` 审计事件——避免审批中心留下"任务已不存在"的僵尸单；
  2. 删除该 task 的 `watchdog_task_state`，看板不再显示已取消任务的停滞计数。

边界：Planner 是独立 profile（默认不启动）。Planner 未运行时不会自动取消，升级仍只生成人工复核单；
Planner 的取消同样受"summary task 不可取消"保护。

### 4. Watchdog 看板

- `GET /api/admin/watchdog?days=7&limit=50`（admin）返回窗口内 summary（观测/提示/去重/升级/
  待回采/命中率/按规则/按天）、最近观测、升级记录、停滞任务 streak 榜。
- 前端 `设置 → Watchdog`（`/settings/watchdog`）展示这些数据，支持 1d/7d/30d 切换。
- 所有写入仍只经 dispatcher（`/internal/dispatch/watchdog/observe`、`/internal/dispatch/watchdog/sweep`）。

## 代价与边界

- 升级仍是"建议 + 人工按钮"，不会自动取消（approve 才取消）；planner 不在线时信号留在
  `planner_signals`，planner 启动后会消费。
- `escalated_streak` 语义：本停滞周期已升级；只有 progress 或 reject 才开启新周期。
- 效果回采是启发式：新 URL/新 finding 只说明"有变化"，不证明因果；10 分钟窗口对长任务偏短，
  用 `WATCHDOG_OUTCOME_DELAY_MS` 调整。
- sweep 与 observe 不做 leader 门控（幂等写：hint 有窗口去重、streak 是单行 upsert、
  outcome 只更新仍 pending 的行），避免非 leader 副本丢事件。
- 看板只做只读聚合，不新增第二事实源。

## 验证

- `scripts/watchdog-escalation-test.mjs`（24 项断言）：两次 observation 升级一次、planner signal +
  approval + escalation hint 落库、approve 取消任务、reject 清 streak、progress 重置、
  sweep 判定 progress/no_progress、`/api/admin/watchdog` 返回聚合。
- `packages/orchestrator/src/scheduler/watchdog.test.ts`：trace 活动不触发 no_progress。
- `scripts/watchdog-smoke.mjs`、`pnpm run verify`、完整 E2E 回归。
