# Flotilla 内部服务契约（Worker / Executor / Dispatcher / Proxy）

> 面向维护者，不是前端 API。前端只看 [frontend-api.md](frontend-api.md)。
> 所有内部请求都走 Docker internal 网络；Worker/executor 不持有 PostgreSQL 或管理员凭证。

## 1. Worker → Dispatcher（`dispatcher:9300`）

认证：`x-dispatcher-token: $DISPATCHER_TOKEN`。

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| POST | `/internal/dispatch/claim` | `{workerId}` | `{task: ClaimedTask \| null}` |
| POST | `/internal/dispatch/scheduler-tick` | `{}` | `{expired,promoted,blocked}` |
| POST | `/internal/dispatch/watchdog-tick` | `{}` | `{observations,hints}` |
| POST | `/internal/dispatch/tasks/start` | `{taskId,workerId,fencingToken}` | `{ok:true}` |
| POST | `/internal/dispatch/tasks/heartbeat` | `{taskId,fencingToken}` | `{ok:true}` |
| POST | `/internal/dispatch/hints/claim` | `{missionId,taskId,limit?}` | `{hints: ClaimedHint[]}` |
| POST | `/internal/dispatch/tasks/finish` | `FinishTaskRequest` | `{ok,...}` |
| POST | `/internal/dispatch/traces` | `TraceRecordRequest` | `{inserted}` |
| POST | `/internal/dispatch/request-index` | `{missionId,taskId,fingerprints}` | `{inserted}` |
| POST | `/internal/dispatch/model-config` | `{}` | `{config: SafeModelConfig\|null}` |
| POST | `/internal/dispatch/runtime-settings` | `{}` | `{settings: RuntimeSettings}` |
| POST | `/internal/dispatch/mission-context` | `{missionId,taskId,maxBytes?,briefMaxChars?}` | `{context}` |
| POST | `/internal/dispatch/prior-work` | `{missionId,taskId,taskLimit?,maxDigestChars?}` | `{priorWork}` |

### 1.1 `runtime-settings`

新增于 2026-11-10；Worker 在任务开始读取一次，用于 mission context、trace search 和 dedupe：

```json
{ "settings": {
  "planner.maxOpenTasks": 3,
  "planner.parallelTasks": 1,
  "planner.frontierEnabled": true,
  "worker.missionContextEnabled": true,
  "worker.traceSearchEnabled": true,
  "worker.findingReviewMode": "auto",
  "worker.summaryEnabled": true,
  "worker.summaryMaxRounds": 1,
  "worker.requestDedupeMode": "warn",
  "worker.requestDedupeTtlMinutes": 30,
  "version": 4
} }
```

- 设置只来自 allowlist；不含任何 secret。
- `worker.requestDedupeTtlMinutes` 由 dispatcher 在构建 `mission-context` 时传给 `listRecentRequestIndex`，不再读 module-load env。

### 1.2 `retry-guard` 与 action ledger

`POST /internal/dispatch/retry-guard` body `{missionId,taskId}`：

```json
{ "requiresConfirmation": true, "actionCount": 2 }
```

- `actionCount` 是尚未被 `tasks.write_actions_confirmed_at` 确认的目标写动作数；
- Worker 在本地 transient retry 前调用；为 true 时不重试，让任务报告失败并由 scheduler 置 `blocked`；
- scheduler 也会在 `retry_wait → ready` 前执行同一检查。

Proxy 记录 target 写动作（POST/PUT/PATCH/DELETE）到 `action_ledger`：

- `http_request`/`web_fetch` 带 `X-SRC-Mission-Id` 和 `X-SRC-Task-Id`；
- target 归属由服务端 grant scope 解析，header 不能覆盖 target mission；
- proxy 在转发前删除两个内部头；
- bash 写动作无 task header 时按 mission + 任务开始时间保守归入；
- 项目删除 cascade 清理。

### 1.3 命令门控人工复核（executor → API）

认证：`x-model-proxy-token: $MODEL_PROXY_TOKEN`（与模型代理同一内部 token；不暴露给前端）。

- `POST /internal/command-approval`
```json
{ "missionId": "uuid", "taskId": "uuid",
  "command": "rm -rf /tmp/agent-work", "commandHash": "64-hex",
  "reason": "模型无法判断" }
```
- `GET /internal/command-approval?missionId=...&taskId=...&commandHash=...`

返回 `{ "approval": { "approvalId": "...", "status": "pending|approved|rejected" } | null }`。

触发条件：**只有** cheap judge 超时/无 key/HTTP 错误/输出无法解析时才调用；模型返回合法 ALLOW/BLOCK 不会创建人工审批。人工在审批中心决定后，Agent 重试相同命令可被放行。

## 2. Worker → Executor（`executor:9100`）

- `POST /internal/cancel`：`{jobId?, taskId, attempt?}`，鉴权 `x-executor-token`；中止运行中的 Harness child。返回 200 `{ok:true,cancelled}` 或 404。
- `POST /internal/tools/search` / `POST /internal/tools/fetch`（API 内部工具代理，`x-model-proxy-token`）：转发 DeepSeek Search/Fetch API，provider key 只在 API 进程。
- `GET /healthz`：返回 `{ok,role:'dispatcher',leader,pid}`；只有 leader 执行 scheduler/watchdog，非 leader 返回 `skipped:true`。
- `POST /internal/dispatch/watchdog/observe`（ADR-0039）：外部 watchdog 提交
  `{rule:'duplicate_url'|'no_progress'|'direction_drift', missionId, taskId?, detail, source?:'rules'|'llm', progress?:boolean}`。
  dispatcher 写 `watchdog_observations`（含 streak/action）、去重后的 task_hint + trigger；
  `progress=true` 只重置该 task 的 stall streak（不写 hint）；连续 stall 达到
  `WATCHDOG_ESCALATE_AFTER` 时升级一次：`planner_signals(kind=watchdog_stall)` +
  `approvals(type=stalled_task)` + `watchdog:escalation` hint。无 leader 门控（幂等写）。
- `POST /internal/dispatch/watchdog/sweep`：`{minAgeMs?}`；对超过
  `WATCHDOG_OUTCOME_DELAY_MS`（默认 10 分钟）仍 `pending` 的 observation 回采
  "之后是否出现新 finding / 新 target URL"，写 `outcome=progress|no_progress` 与明细。
  返回 `{checked, progress, noProgress}`。无 leader 门控（只更新仍 pending 的行）。
- Worker 的 `dispatcher` 新增 `POST /internal/dispatch/tasks/state {taskId,fencingToken}`，返回 `{state}`；Worker 每 2s 观察取消。

认证：`x-executor-token: $EXECUTOR_TOKEN`。

`POST /internal/run` body（`ExecutorJob`）：

```json
{
  "jobId": "taskId:attempt",
  "taskId": "uuid-or-smoke-id",
  "attempt": 1,
  "task": { "missionId": "...", "objective": "...", "targetUrl": "...", "scope": {}, "maxSteps": 0, "maxWallClockMs": 1200000 },
  "options": {
    "hints": ["..."],
    "priorWork": "...",
    "missionBrief": "...",
    "missionContextPath": "/runs/<task>/mission-context.json",
    "requestIndexPath": "/runs/<task>/request-index.json",
    "modelConfig": { "baseUrl": "http://api:3001/internal/model/configs/<id>", "apiKey": "", "apiKeyEnv": "MODEL_PROXY_TOKEN", "model": "deepseek-flash" },
    "runtime": "inprocess",
    "hintFilePath": "/runs/<task>/steering-hints-1.jsonl",
    "traceSearchEnabled": true,
    "requestDedupeMode": "warn"
  }
}
```

`POST /internal/cleanup` body `{taskIds}` 清理共享运行目录（项目删除 best-effort 重试调用）。

### 2.1 运行中 steering（full-duplex）

Worker 在 executor job 期间持续调用 `/internal/dispatch/hints/claim`，把新 hint 以 **一行一个 JSON 字符串** 追加到共享文件：

```text
/runs/<taskId>/steering-hints-<attempt>.jsonl
{"control-plane hint text"}
```

Executor 的 `createHintFileReader()` 只读取新行，交给 in-process runtime；runtime child 在模型轮次边界调用 `agent.steer()`：

```text
Worker pump ──append──> /runs/hints.jsonl ──read──> executor → agent.steer()
```

- 每个 attempt 独立文件，避免重试重复注入。
- `summary` 任务仍走 CLI（不需要 steering）。
- 运行日志出现 `forwarded a mid-run hint` / `steered a control-plane hint mid-run` 表示链路成功。

## 3. Executor → API 模型代理

- Base URL：`MODEL_PROXY_URL`（默认 `http://api:3001/internal/model`）。
- Token：`MODEL_PROXY_TOKEN`，仅 executor/planner/Agent 可见；provider key 不进入 executor。
- 请求体可被代理重写 `model`，并把 `developer` 角色改成 `system`。
- 该接口不是前端 API，不通过 nginx 暴露。

## 4. Proxy traffic → mission 关联

迁移 `0007-proxy-traffic-mission.sql`：

- `proxy_traffic.mission_id UUID REFERENCES missions(id) ON DELETE CASCADE`；
- 项目删除事务删除 mission 时，其代理审计行级联删除；
- 索引 `(mission_id, observed_at DESC)`。

来源：

1. **Target 请求（含 `http_request`/`web_fetch`/bash）**：proxy 用 active mission 的 grant scope 在服务端解析目标 URL；命中哪个 mission 就归属哪个。客户端 header **不能覆盖** target 归属，避免 bash 伪造 header 把流量塞进另一个 mission。
2. **Internet 请求**：工具会自动带 `X-SRC-Mission-Id`；proxy 仅在该 mission 仍 active 时才接受。无 header 的 bash internet 流量为 `NULL`（仍审计）。
3. `http_request`/`web_fetch` 仍会设置 `X-SRC-Mission-Id`，但 target 场景只是辅助；proxy 转发前删除该头。

Proxy 在发往目标前删除 `X-SRC-Mission-Id`，该内部头不会泄露给靶场。`proxy_denials` 全局表仍保持删除状态。

## 5. Worker subagent

Worker 精简 profile 不再禁用 `subagent` / `tool-subagent*`。CLI 和 isolated in-process runtime 都通过同一个 `buildHarnessPatch` 启用子代理工具；子代理继承当前 Worker 的 scope 与工具边界，Worker prompt 要求把子代理结果整合后再 `report_finding`。

## 6. 相关迁移与配置

- 新迁移：`0007-proxy-traffic-mission.sql`。
- Worker 新环境变量：`SRC_AGENT_HINT_POLL_MS`（默认 2500，控制 steering pump 轮询）。
- 不需要新 provider key；模型代理 token 仍由部署管理。

## Browser capability service

- `POST /v1/sessions`：`{missionId,taskId}` 创建浏览器 context；请求头 `x-browser-token`。
- `POST /v1/sessions/:id/{navigate,snapshot,act,network,chunks,eval}`；`network` 返回请求/响应文本，供 harness-plugin 记录 target evidence。
- `DELETE /v1/sessions/:id`、`POST /v1/close-task`。
- 服务只接 `execnet`，经 `proxy:8080`；不持有 DB/provider key。

## Mission artifact upload

- `POST /api/missions/:id/artifacts`：`application/octet-stream` 原始 body，`x-artifact-filename` 指定文件名；返回 artifact metadata。
- `GET /api/missions/:id/artifacts`：artifact 列表。
- CLI：`node scripts/upload-artifact.mjs <file> --mission <uuid>`。

## Reverse capability service

- `POST /v1/jobs`：`{kind:'apk'|'ida', storagePath, missionId, taskId}`；启动离线 job。
- `GET /v1/jobs/:id`：状态/结果；`POST /v1/jobs/:id/search`：反编译/反汇编输出分页搜索。
- `apk` 使用 vendored ASC + JADX + RN/Hermes；`ida` 使用 idalib Python（无 MCP/GUI），需要运行时 license。
- 服务只读 artifact volume，不访问目标网络/DB/provider key。
