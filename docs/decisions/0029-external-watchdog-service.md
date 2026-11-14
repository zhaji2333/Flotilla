# ADR-0029：外部独立 watchdog service

- 状态：Accepted
- 日期：2026-11-11
- 关联：ADR-0017、ADR-0019、ADR-0025

## 背景

P1-γ 的 watchdog 在 dispatcher/worker 循环内运行，只做重复 URL 和 running 无新 finding；它无法独立于 worker 生命周期观察，也不会主动形成稳定告警。

## 决策

- 新增独立进程/容器 `watchdog`（`packages/orchestrator/src/watchdog`）：
  - 独立于 dispatcher/worker 进程和 tick；
  - 只读 PostgreSQL 投影（missions/tasks/proxy_traffic/findings/task_trace）；
  - 不持有目标网络/执行工具，不执行 exploit；
  - 通过 dispatcher `POST /internal/dispatch/watchdog/observe` 写入 trigger + hint（dispatcher 仍是唯一 DB writer）。
- 检测规则（确定性 fallback）：
  - `duplicate_url`：窗口内同一 URL 请求数 ≥ 阈值；
  - `no_progress`：running 超过阈值且窗口内无新 finding（即使还有 trace/工具活动，也提示改变方向）。
- 去重由 dispatcher 已有 `recordWatchdogObservation` 负责（同 rule/30min 窗口）。
- **LLM agent 层（可选，默认开启）**：`WATCHDOG_LLM_ENABLED=1` 时，watchdog 读取 mission objective/task objective/recent trace/findings，经 API 模型代理调用默认模型（`WATCHDOG_MODEL_ROUTE=default`，可改 `roles/guard`），输出 `ok/stalled/drift`；非 ok 转 `direction_drift` observation。provider key 不进入 watchdog（只有 MODEL_PROXY_TOKEN）。
- 默认 60s interval；LLM 每任务 5min 复核一次；容器 healthz `:9400/healthz`；`WATCHDOG_ENABLED=0` 可停用观察循环。
- 保留 dispatcher 内置 watchdog tick 作为兼容；两边 observation 会去重，不重复插入同一 rule 的 hint。

## 边界

- 规则层始终运行；LLM 层不可用时自动降级为规则层（不阻塞）。
- 只写 bounded hint/trigger，不自动 pause/cancel；人工仍可暂停/取消。
- 读取 PG 与该服务受信任边界一致；worker/executor 仍无 PG 访问。
- 数据库仍是单点；watchdog 本身无高可用（单副本），但它是可重启的观察者，不影响主流程。

## 验证

- `docker compose up watchdog` 后 `/healthz` 200；
- 构造 running 超阈值无新 finding 的任务，observer 产出 `no_progress`；
- dispatcher 的 `/watchdog/observe` 写入 task_hint + trigger；
- 重复 observation 在去重窗口内不重复写入。


## 实测记录（2026-11-13）

在本地栈（3 worker + 2 dispatcher + 外部 watchdog）实测：

- `watchdog` 容器为默认栈成员，`docker compose up -d` 即启动，`:9400/healthz` 返回 `{"ok":true,"role":"watchdog","intervalMs":60000}`。
- 构造 mission `running` + task `running` 30 分钟且无 trace/finding：
  - 规则层产出 `no_progress`，LLM 层产出 `stalled`（转 `direction_drift`）；
  - 日志：`llm review task=… verdict=stalled …`、`observations=2 recorded=2`；
  - `triggers`：`source=watchdog`、`kind=no_progress|direction_drift`、`route=direct`、`state=processed`；
  - `task_hints`：`source=watchdog:no_progress|watchdog:direction_drift`，内容为"pivot / report a dead end"类提示。
- 去重窗口 30 分钟（`WATCHDOG_DEDUPE_MINUTES`），同一 rule 不重复写 hint。
- dispatcher 内置 `watchdogTick` 仍存在，由 worker 每 8 个 tick 调用（约 24s，`WATCHDOG_ENABLED=0` 关闭）；该路径依赖 worker 存活，外部服务不依赖。
