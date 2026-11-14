> **已失效（2026-11-08）**：本 ADR 的 B5 portfolio 已被 ADR-0015 取代并删除；B6/A6 保留。

# ADR-0014：M5 — portfolio 有界调度、保活增强与评测回放看板

- 状态：已实施（2026-11-08）
- 关联：P3-B5 / P3-B6 / P3-A6；用户确认 M5 不含浏览器/Playwright
- 相关代码：`packages/contracts/src/db/schema.sql`（portfolio/eval/hint kind）、`packages/control-plane/src/repositories/{portfolio,eval}-repository.ts`、`packages/orchestrator/src/portfolio/*`、`packages/orchestrator/src/worker/storm-guard.ts`、`packages/api/src/server.ts`、`docker-compose.yml`（portfolio profile）

## 背景

M5 原计划：cross-mission portfolio commander、单 key 保活/help/report、评测回放看板。用户 2026-11-08 明确：**M5 做，浏览器/Playwright 除外**；B5 默认 feature flag 关闭；B6 不做 key pool；A6 只交付后端接口 + 前端文档。

## 决策

### 1. B5 portfolio commander（默认关闭，人工审批）

- 独立 `portfolio` compose profile/进程，`PORTFOLIO_ENABLED=0` 默认关闭；启用后持有全局单例 lease（`portfolio_lease`），读取有界跨 mission 快照（最多 20 个 mission：状态、open/done 任务、accepted findings、token、stuck、pending actions），调用 Harness Planner profile 的只读工具 + `submit_plan`，产出 **最多 3 条**候选动作。
- 四种动作（payload 严格 zod，拒绝未知字段）：
  - `allocate`：调整某 mission open 任务优先级（delta -0.2..0.2，clamp 0..1）；
  - `hire`：为 mission 创建一个 proposed 任务（objective 5..800 字）；
  - `fire`：取消该 mission 一个具体 open/stale 任务；
  - `park`：暂停一个 pending/running mission。
- **只生成 pending 动作，不自动执行**。所有动作必须经管理员 API 人工 approve/reject；approve 时单事务应用、写 `portfolio.action_applied`/`mission.paused`/`task.cancelled` 等事件；reject 写 `portfolio.action_rejected`。
- 明确禁止：修改 grant/scope、增加 target、访问目标、把动作写成自动 hint；动作去重（同 pending 类型+mission+task 不重复）、每 plan 最多 3 条、每 mission 每条动作。
- 任务执行仍由单 mission Planner 决定“怎么打”；portfolio 只决定“先打谁/停谁”。

### 2. B6 单 key 保活 + 结构化 hint

- **不做 key pool**：继续单 key；provider 429/5xx/崩溃仍按现有 transient 重试（最多 3 次，线性退避）。
- 新增 **storm guard**：连续任务失败达到阈值（默认 4）后，worker 在 claim 前做有界指数退避（5s 起，最多 60s），成功即清零；超阈值动作写 `worker.storm_guard` 事件（带 consecutiveFailures/delayMs），不会无限循环。
- `task_hints` 新增 `kind`：`guidance`（默认）/`help`/`report`；创建/列表 API 返回 kind；Planner `add_hint` 可选 kind；Worker claim 时在 prompt 中加 `[help]`/`[report]` 前缀；前端提示队列按 kind 展示。
- 没有多 key 轮换、没有自动重启扩容；进程级重启由容器 restart policy 负责，storm guard 只防止紧密失败循环。

### 3. A6 评测历史 + 回放看板（只读）

- 新增 `eval_runs` 表：kind（matrix/fixture/effect/frozen/replay/other）、name、status、summary JSONB、details、recordedBy；**不把报告文件当数据库事实源**，Markdown/JSON 报告仍在 `evals/reports/`，DB 只存有界结构化摘要。
- API：
  - `POST /api/evals` 记录一条结构化结果（脚本使用）；
  - `GET /api/evals?kind=&limit=` 历史；
  - `GET /api/evals/:id`；
  - `GET /api/evals/dashboard?limit=&replayLimit=` 合并“每种 eval 最新一条 + 13 项指标 + 最近 N 个 mission 的 events replay 摘要（matched/mismatched/diffs）”。
- `skills-effect-eval.mjs`、`skills-eval.mjs`、`frozen-cases-check.mjs` 结束时通过 `scripts/lib/eval-record.mjs` 自动记录。
- UI 由前端 Agent 实现；P3 内只交付后端接口 + 前端文档。

## 安全与边界

- portfolio 不改变 Grant/scope；所有跨 mission 动作经管理员 token + 人工审批，事件可回放审计。
- portfolio 默认关闭；即使开启也只产生 pending 动作，不可能静默改任务。
- eval 历史只存摘要，不存目标正文/凭据；回放摘要只读。
- help/report hint 仍是控制面可信提示，目标内容不能被伪装成 hint；kind 只是分类，不绕过 scope 校验。
- 浏览器/Playwright 不在 M5；Worker 仍无浏览器能力。

## 验证

- `portfolio.test.ts`：动作/plan 上限、scope 字段拒绝、priority delta 越界拒绝。
- `storm-guard.test.ts`：阈值/重置/指数上限。
- `scripts/portfolio-smoke.mjs`：10 项——pending 列表、allocate/hire/fire/park 应用、reject、重复决策 409、审计事件、非法 action type 被 DB 拒绝。
- `scripts/keepalive-smoke.mjs`：6 项——help/report 创建/列表/非法 kind、worker claim kind、delivered 状态。
- `api-smoke.mjs`：eval 记录/历史/dashboard。
- `pnpm run verify` + e2e。
