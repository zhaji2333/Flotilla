# Flotilla 前端 API 接口文档（v1）

> 面向：独立前端 Agent / 新 UI 开发。
> 目标：前端只通过 HTTP/SSE 消费控制面数据，不接触 PostgreSQL、不导入后端代码；后端可独立部署。
> 现状：契约已冻结（本文档 + `openapi.yaml`）。独立 API 服务 `packages/api`（`http://127.0.0.1:3001`，Bearer Auth + CORS）是唯一后端；前端 SPA 通过 5173 的 nginx 同源代理到该服务。旧 `packages/web` 控制台/API 已移除。

## 1. 接入约定

| 项 | 约定 |
|---|---|
| Base URL | 独立 API：`http://127.0.0.1:3001`（`API_PORT`）；前端 SPA 默认同源 `/api`（nginx 反代到 API） |
| 协议 | HTTP/1.1，JSON UTF-8；SSE 用 `text/event-stream` |
| 认证 | 默认 `AUTH_MODE=accounts`：浏览器走**会话 cookie 登录**（ADR-0038），首次登录强制改密；自动化用 `Authorization: Bearer $API_AUTH_TOKEN`（除 `/api/health` 外）；SSE 也接受 `?token=`（EventSource 无法设 header）。nginx 不再给浏览器注入 token；`API_LEGACY_TOKEN` 默认空，仅当显式设置且请求无 `Sec-Fetch-*` 头时才注入。**模型配置/管理路由要求 `API_ADMIN_TOKEN`**；未配置 admin token 时开发环境回退到普通 token |
| CORS | `CORS_ORIGINS` 逗号分隔允许列表（默认 `http://127.0.0.1:5173,http://localhost:5173`）；独立前端直连 API 时启用。同源 nginx 代理无需 CORS |
| 前端开发 | `packages/frontend` Vite dev：设置 `VITE_API_BASE_URL=http://127.0.0.1:3001` 并给请求加 `Authorization`（或经 nginx 容器） |
| 时间 | 所有时间是 ISO-8601 UTC 字符串；展示层按 `Asia/Shanghai` 本地化（前端自行格式化） |
| ID | UUID 字符串（trace.id 为数字） |
| 错误 | 非 2xx：`{"error": string}`；校验错误额外 `{"issues": ZodIssue[]}` |
| 分页 | v1 未实现游标分页；列表接口固定上限（mission 50 / findings 100 / approvals 100 / trace 3000 / trace-summaries 50 / facts 200 / frontier 30 / recall 50） |
| 空态 | 列表返回空数组，不返回 null；详情不存在 404 |

### 术语与中文口径

黑板/线索板/模型配置/回放的中英对照见 [terminology-zh.md](terminology-zh.md)；新增字段先补该表再翻译 UI。

### 前后端解耦边界

- 前端**禁止**：直连数据库、读取后端环境变量、调用 Worker/代理内部接口、根据 `egressMode` 自行决定安全策略。
- 前端**只做**：读取投影、发起人工动作（创建 mission、pause/resume、hint、approval decide）、SSE 实时刷新。
- 所有展示用中文；枚举保留英文原值，展示为「中文 (english)」，例如 `运行中 (running)`。

## 2. 枚举与状态字典（展示映射）

### Mission 完成语义（ADR-0012）

mission 不再由“产物数达标”决定完成：

- 所有 task 进入终态后（无 `proposed/ready/leased/running/retry_wait/blocked`）统一计算；
- 有任一 `done/verified` task **或** 任一 accepted finding → `completed`；
- 否则（全部 failed/exhausted/cancelled/stale/handed_back 且无 accepted finding）→ `failed`，`failureClass=no_progress`；
- Curator 在任务报告事务内同步完成，所有报告处理完即收集完毕；
- 产物数量只作为内部质量指标（`/api/metrics` 的 `findings.artifacts`），不进入任务成功/失败或 mission 完成判断；
- 中文术语见 [terminology-zh.md](terminology-zh.md)。

### Mission 状态 `mission.state`

| 原值 | 中文 | 含义 |
|---|---|---|
| `pending` | 待规划 | 已创建，等待 readiness/Planner |
| `running` | 运行中 | 有任务在调度/执行 |
| `paused` | 已暂停 | 暂停新领取，checkpoint 已保存 |
| `completed` | 已完成 | 所有任务终态，且满足 ADR-0012 完成规则 |
| `failed` | 失败 | 任务失败/无进展终止 |
| `cancelled` | 已取消 | 人工取消 |

### Task 状态 `task.state`

`proposed` 待规划 · `ready` 就绪 · `leased` 已领取 · `running` 运行中 · `reported` 已上报 · `verified` 已验证 · `done` 已完成 · `retry_wait` 等待重试 · `exhausted` 已耗尽 · `blocked` 已阻塞 · `cancelled` 已取消 · `stale` 已过期 · `handed_back` 已交还

### 其他枚举

| 字段 | 取值 |
|---|---|
| `finding.status` | `accepted` 已接受 / `needs_review` 待复核 / `rejected` 已拒绝 |
| `finding.severity` | `critical` 严重 / `high` 高危 / `medium` 中危 / `low` 低危 / `info` 信息 |
| `finding.category` | 自由字符串（常见：injection/sqli/xss/ssrf/lfi/rce/xxe/idor/access_control/misconfiguration/information_disclosure/reference） |
| `approval.status` | `pending` 待审批 / `approved` 已批准 / `rejected` 已拒绝 |
| `approval.type` | `manual` 人工审批 / `scope_upgrade` 授权范围升级 / 其他后端扩展值 |
| `trigger.source` | `watchdog` 规则看门狗 / `worker` / `planner` / `operator` |
| `trigger.kind` | `repeated_request` 重复请求 / `denial_spike` 越界拒绝激增 / `no_progress` 长时间无进展 / 其他 |
| `trigger.route` | `direct` 直通提示 / `planner` Planner 规划 |
| `trigger.state` | `open` / `routed` / `processed` / `ignored`（后端扩展） |
| `hint.state` | `pending` 待投递 / `delivered` 已投递 / `consumed` 已消费 |
| `hint.source` | `planner` / `operator` / `watchdog` / 其他 |
| `plannerRun.state` | `claimed` / `running` / `completed` / `failed` / `stale` |
| `todo.status` | `pending` 待处理 / `in_progress` 进行中 / `done` 已完成 / `blocked` 已阻塞 |
| `evidence.kind` | `target` 目标流量 / `internet` 互联网检索 |
| `denial.kind` | `scope_denied` 越权拦截 / `internet_denied` 互联网访问拦截 |
| `task.angle` | `null` / `web` / `api` / `infra` / `binary`（P3-B4；同 mission 最多 2 个并行角度） |
| `trace.eventType` | `thinking` / `text` / `tool_call` / `tool_result` / `context` / `status` / `session` / `final` / `assistant_message` |

## 3. 端点总览

| 方法 | 路径 | 用途 | 页面 |
|---|---|---|---|
| GET | `/api/health` | 健康检查、出站模式 | 启动/状态条 |
| GET | `/api/missions` | 任务列表 | 任务列表 |
| POST | `/api/missions` | 创建任务（唯一人工入口） | 新建任务 |
| GET | `/api/missions/:id` | 任务详情（DAG/Todo/触发器/提示/审批/Planner run） | 任务详情 |
| POST | `/api/missions/:id/pause` | 暂停（写 checkpoint） | 任务详情 |
| POST | `/api/missions/:id/resume` | 恢复（从 checkpoint 续跑） | 任务详情 |
| GET | `/api/missions/:id/stream` | SSE 实时快照 | 任务详情实时条 |
| GET | `/api/findings` | 发现列表 | 发现列表 |
| GET | `/api/findings/:id` | 发现详情（报告 + 证据正文） | 发现详情 |
| GET | `/api/approvals?status=` | 审批列表 | 审批中心 |
| POST | `/api/approvals` | 新建审批请求 | 审批中心/任务页 |
| POST | `/api/approvals/:id/decide` | 批准/拒绝 | 审批中心 |
| GET | `/api/hints?missionId=` | 提示队列 | 任务详情 |
| POST | `/api/hints` | 追加提示 | 任务详情 |
| GET | `/api/triggers?missionId=` | 触发器路由审计 | 任务详情 |
| GET | `/api/traces?subjectType=&subjectId=` | Worker/Planner 轨迹 | 轨迹页 |
| GET | `/api/missions/:id/trace-summaries` | 同 mission 跨任务先验工作总结（含 `digest`） | 任务详情/轨迹页 |
| GET | `/api/missions/:id/facts` | 黑板 typed facts（派生读模型） | 黑板页 |
| GET | `/api/missions/:id/frontier` | 黑板 frontier：开放意图 + 高信号事实 | 黑板页/Planner |
| GET | `/api/missions/:id/recall?q=` | 黑板事实检索 | 黑板页搜索 |
| GET | `/api/missions/:id/intel` | 同 mission intel（只读，不跨 mission） | 情报页/黑板页 |
| GET | `/api/missions/:id/explore-graph?threshold=` | 探索图读投影 + digest 折叠 | 探索图页 |
| GET | `/api/missions/:id/overview?maxChars=` | 项目概览（Planner/Worker/前端共用，M5-1） | 项目概览页 |
| GET | `/api/missions/:id/worker-traces/search?q=&excludeTaskId=&limit=` | 跨 Worker 轨迹摘要检索（M5-4） | 轨迹检索 |
| GET | `/api/missions/:id/assets/graph` | 项目内资产图 + 覆盖度（M5-5） | 资产图页 |
| POST | `/api/evals` | 记录结构化 eval 历史 | 评测/回放页（脚本用） |
| GET | `/api/evals?kind=&limit=` | eval 历史 | 评测/回放页 |
| GET | `/api/evals/:id` | eval 详情 | 评测/回放页 |
| GET | `/api/evals/dashboard` | eval + 指标 + events replay 摘要 | 评测/回放页 |
| GET | `/api/missions/:id/board` | 线索板投影（八节） | 线索板 |
| GET | `/api/missions/:id/replay?toSeq=` | events 回放校验 | 审计/回放 |
| POST | `/api/missions/:id/scope-upgrade` | 申请授权范围升级 | 任务详情/审批 |
| GET | `/api/metrics` | 指标看板 | 指标页 |
| GET/POST | `/api/model-configs` | 模型配置列表/新建（admin） | 设置-模型 |
| GET/PUT/PATCH/DELETE | `/api/model-configs/:id` | 模型配置详情/更新/删除（admin） | 设置-模型 |
| POST | `/api/model-configs/:id/reveal` | 查看明文 key（admin，审计） | 设置-模型 |
| GET | `/api/model-configs/audit` | 模型配置审计 | 设置-模型 |

## 4. 端点定义

### 4.1 GET /api/health

```json
{ "ok": true, "service": "src-agent-web", "egressMode": "open" }
```

- `egressMode`: `scope`（默认安全门禁）| `open`（临时全放行，前端可显示红色警告条）。
- 503：`{ "ok": false, "error": "..." }`。

### 4.2 GET /api/missions

```json
{
  "missions": [
    {
      "id": "uuid",
      "name": "target:http://192.168.1.10",
      "state": "running",
      "target": { "type": "url", "value": "http://192.168.1.10" },
      "objective": "Find all flags",
      "workerId": "worker-abc",
      "phase": "active",
      "deadlineAt": null,
      "reportingLeadMs": 900000,
      "searchPolicy": "limited",
      "findingsCount": 3,
      "createdAt": "2026-11-07T08:00:00.000Z",
      "completedAt": null
    }
  ],
  "total": 1
}
```

### 4.3 POST /api/missions

请求体（`.strict()`：未知字段会 400）：

```json
{
  "name": "my mission",
  "target": { "type": "url", "value": "http://192.168.79.165:64280" },
  "objective": "Find all flags; report baseline+proof evidence.",
  "maxSteps": 0,
  "maxWallClockMs": 0,
  "methodology": "optional guidance",
  "scopeExtras": { "ips": ["192.168.79.165/32"] },
  "priority": 0.7,
  "deadlineAt": "2026-11-17T12:00:00.000Z",
  "reportingLeadMs": 900000,
  "searchPolicy": "limited",
  "coverageGate": { "enabled": true, "minRatio": 1, "requireAcceptedFinding": false }
}
```

| 字段 | 必填 | 约束 |
|---|---|---|
| `name` | 否 | 1–200 字符；默认 `目标类型:目标值` |
| `target.type` | 是 | `url` / `ip` / `domain` |
| `target.value` | 是 | 非空；真实 URL/域名/IP |
| `objective` | 是 | 1–4000 字符 |
| `maxSteps` | 否 | 0–3000，0=不限；默认 env `TASK_MAX_STEPS`(0) |
| `maxWallClockMs` | 否 | 0–7,200,000，0=不限；默认 1,200,000（20min） |
| `methodology` | 否 | ≤8000 字符 |
| `scopeExtras` | 否 | 额外授权范围；域名后缀/IP/URL 前缀 |
| `deadlineAt` | 否 | ISO 时间；v1.0.2 mission 绝对截止时间（ADR-0054） |
| `reportingLeadMs` | 否 | 截止前多久进入 reporting，默认 900000 |
| `searchPolicy` | 否 | `disabled` / `limited`(默认) / `allowed`；`web_search` DLP |
| `priority` | 否 | 0–1，默认 0.5；越大越先领取 |
| `coverageGate` | 否 | 可选完成闸：`enabled`/`minRatio`(0–1)/`requireAcceptedFinding`；资产覆盖未达标时 mission 落 failed |

响应 `201`：

```json
{ "missionId": "uuid", "taskId": "uuid", "grantId": "uuid", "scope": { "domainSuffixes": [], "ips": ["192.168.79.165/32"], "urlPrefixes": [{ "prefix": "http://192.168.79.165:64280", "ports": [64280] }], "exclude": [] } }
```

错误：`400 invalid JSON body` / `400 validation failed`（带 `issues`）/ `400` 创建失败。

**已移除字段**：`successCriteria` / `expectedArtifacts` 自 ADR-0012 起不再是 API/UI 语义的一部分，发送会触发 `.strict()` 的 **400**。任务不设“必须获得 N 个产物”的完成门槛；产物数只作为内部质量指标。

### 4.4 GET /api/missions/:id

```json
{
  "mission": {
    "id": "uuid",
    "name": "...",
    "state": "running",
    "target": { "type": "url", "value": "http://..." },
    "objective": "...",
    "workerId": "worker-1",
    "phase": "active",
    "deadlineAt": null,
    "reportingLeadMs": 900000,
    "searchPolicy": "limited",
    "findingsCount": 2,
    "failureClass": null,
    "checkpoint": { "pausedAt": "...", "openTasks": 1 },
    "pausedAt": null,
    "createdAt": "...",
    "completedAt": null,
    "tasks": [
      {
        "id": "uuid", "state": "running", "type": "bootstrap", "angle": null,
        "disposition": null,
        "dependsOn": [], "attempt": 1, "priority": 0.5,
        "lastError": null, "plannerRunId": null,
        "createdAt": "...", "completedAt": null,
        "result": { "objective": "..." }
      }
    ],
    "todo": [{ "id": "uuid", "content": "...", "status": "pending", "position": 0 }],
    "triggers": [{ "id": "uuid", "source": "watchdog", "kind": "repeated_request", "route": "direct", "state": "open", "createdAt": "..." }],
    "hints": [{ "id": "uuid", "content": "...", "source": "operator", "kind": "guidance", "state": "pending", "createdAt": "...", "deliveredAt": null }],
    "approvals": [{ "id": "uuid", "missionId": "uuid", "type": "manual", "status": "pending", "payload": {}, "decidedBy": null, "decidedAt": null, "createdAt": "..." }],
    "plannerRuns": [{ "id": "uuid", "state": "completed", "actionCount": 3, "reason": "...", "signalCount": 2, "startedAt": "...", "finishedAt": "..." }]
  }
}
```

404：`{ "error": "mission not found" }`。503：DB 错误。

**DAG 页面**：前端用 `tasks[].dependsOn` 自行布局（无环），节点状态取 `task.state`，无需后端提供坐标。

### 4.5 POST /api/missions/:id/pause

响应 `200`：

```json
{ "mission": { "missionId": "uuid", "state": "paused", "pausedAt": "2026-11-07T09:00:00.000Z", "checkpoint": { "pausedAt": "...", "taskCount": 1, "openTasks": 1, "taskStates": { "running": 1 }, "todo": [], "lastEventSeq": 12, "grantId": "uuid", "grantVersion": 1 } } }
```

- 409：状态不允许暂停（completed/failed/cancelled 等）。
- 404：mission 不存在。

### 4.6 POST /api/missions/:id/resume

响应 `200`：同 pause 的 `mission` 结构；`pausedAt: null`，`checkpoint` 追加 `resumedAt/openTasks/doneTasks/acceptedFindings/artifacts/stateAfterResume`。若已无未完成任务，按 ADR-0012 规则直接落 `completed`/`failed`（有 done/verified 任务或有 accepted finding → completed；否则 failed）。

- 409：不是 paused。
- 404：不存在。

### 4.7 GET /api/missions/:id/stream（SSE）

`content-type: text/event-stream`。每 2s 一条 `data:`，示例：

```
data: {"type":"mission","missionId":"uuid","state":"running","findings":2,"tasks":1,"openTasks":1,"triggers":0,"pendingApprovals":0,"updatedAt":"2026-11-07T09:00:00.000Z"}

data: {"type":"error","error":"..."}

data: {"type":"gone","missionId":"uuid"}
```

前端用 `EventSource`，断线自动重连；`type=gone` 时停止并跳列表。

### 4.8 GET /api/findings

```json
{
  "findings": [
    {
      "id": "uuid", "missionId": "uuid", "missionName": "...",
      "title": "...", "category": "sqli", "severity": "high",
      "status": "accepted", "artifact": "FLAG{...}",
      "evidenceCount": 2, "createdAt": "..."
    }
  ],
  "total": 1
}
```

### 4.9 GET /api/findings/:id

```json
{
  "finding": {
    "id": "uuid", "missionId": "uuid", "missionName": "...",
    "title": "...", "category": "sqli", "severity": "high",
    "status": "accepted", "artifact": "FLAG{...}", "evidenceCount": 2,
    "createdAt": "...",
    "reportMd": "## ... rules/40 报告 ...",
    "curatorReasons": [],
    "evidence": [
      {
        "id": "uuid", "trafficRef": "tr_17", "kind": "target",
        "method": "GET", "url": "http://192.168.79.165:64280/...",
        "requestText": "GET /path HTTP/1.1\nHost: 192.168.79.165:64280\nUser-Agent: Mozilla/5.0 ...",
        "responseText": "HTTP 200\n...",
        "requestSha256": "...", "responseSha256": "...",
        "requestBytes": 123, "responseBytes": 456,
        "untrusted": false, "createdAt": "..."
      }
    ]
  }
}
```

- `requestText` 是**原始 HTTP 请求包**，必含 `Host:`；前端按 monospace pre 展示，可折叠 response。
- `untrusted=true`（互联网内容）显示「不可信」标记。
- 404/503。

### 4.9b GET /api/findings/:id/lineage

同 mission 的派生 Finding 血缘，不新增表：

```json
{
  "lineage": {
    "findingId": "uuid", "missionId": "uuid",
    "rootCauseKey": "...", "supersededBy": null,
    "nodes": [
      { "id": "finding:uuid", "type": "finding", "label": "...", "status": "accepted", "artifact": "FLAG{...}" },
      { "id": "task:uuid", "type": "task", "label": "...", "status": "done" },
      { "id": "evidence:uuid", "type": "evidence", "label": "POST http://...", "trafficRef": "tr_7", "kind": "target", "method": "POST", "url": "http://...", "untrusted": false }
    ],
    "edges": [
      { "source": "finding:uuid", "target": "task:uuid", "type": "produced_by" },
      { "source": "finding:uuid", "target": "evidence:uuid", "type": "supported_by" },
      { "source": "finding:uuid", "target": "finding:other", "type": "shares_evidence" }
    ],
    "relatedFindings": [
      { "id": "uuid", "title": "...", "status": "accepted", "artifact": "FLAG{...}", "sharedEvidenceCount": 2 }
    ],
    "generatedAt": "..."
  }
}
```

- 只返回同 mission；`shares_evidence` 是线索，不是因果证明。
- `produced_by` / `supported_by` / `superseded_by` / `shares_evidence` 为派生边；不返回原始请求/响应正文。
- 404 = finding 不存在；非法 UUID 400。

### 4.10 GET /api/approvals[?status=pending]

```json
{ "approvals": [ { "id": "uuid", "missionId": "uuid", "missionName": "...", "type": "manual", "status": "pending", "payload": {}, "decidedBy": null, "decidedAt": null, "createdAt": "..." } ], "total": 1 }
```

`status` 可选：`pending|approved|rejected`；无该参数时 pending 优先排序。

### 4.11 POST /api/approvals

```json
{ "missionId": "uuid", "type": "manual", "payload": { "reason": "..." } }
```

响应 `201`：`{ "approvalId": "uuid" }`。400 校验失败。

### 4.12 POST /api/approvals/:id/decide

```json
{ "decision": "approved", "decidedBy": "console", "note": "optional" }
```

响应 `200`：`{ "approval": { ...ApprovalRow } }`；409：已决策/并发/不存在。

### 4.13 GET /api/hints?missionId=:uuid

```json
{ "hints": [{ "id": "uuid", "missionId": "uuid", "taskId": null, "content": "...", "source": "operator", "kind": "guidance", "state": "delivered", "createdAt": "...", "deliveredAt": "..." }], "total": 1 }
```

400 缺少 missionId。

### 4.14 POST /api/hints

```json
{ "missionId": "uuid", "taskId": "uuid?", "content": "先看 /api/v2/health", "source": "operator", "kind": "guidance|help|report" }
```

响应 `201`：`{ "hintId": "uuid" }`。

`kind`（P3-B6，默认 `guidance`）：`guidance` 普通指导、`help` 请求协助、`report` 结果/状态报告；Worker 在 prompt 中以 `[help]` / `[report]` 前缀注入，前端提示队列按 kind 展示。

### 4.15 GET /api/triggers?missionId=:uuid

```json
{ "triggers": [{ "id": "uuid", "source": "watchdog", "kind": "repeated_request", "route": "direct", "state": "open", "createdAt": "..." }], "total": 1 }
```

### 4.17 GET /api/traces?subjectType=worker|planner&subjectId=<targetId>

```json
{
  "trace": [
    { "id": 1, "seq": 0, "eventType": "context", "payload": { "source": "assignment_hints", "text": "..." }, "createdAt": "..." },
    { "id": 2, "seq": 1, "eventType": "thinking", "payload": { "text": "..." }, "createdAt": "..." },
    { "id": 3, "seq": 2, "eventType": "tool_call", "payload": { "tool": "skill", "input": { "name": "ck-router" }, "callId": "..." }, "createdAt": "..." },
    { "id": 4, "seq": 3, "eventType": "tool_result", "payload": { "status": "completed", "result": "...", "callId": "..." }, "createdAt": "..." },
    { "id": 5, "seq": 4, "eventType": "final", "payload": { "text": "..." }, "createdAt": "..." }
  ],
  "total": 5
}
```

- `subjectType=worker` 时 `subjectId` = `mission.tasks[].id`；
- `subjectType=planner` 时 `subjectId` = `mission.plannerRuns[].id`；
- 400：参数非法；503：DB 错误。
- UI 建议：thinking/tool_result 默认折叠，`tool_call.tool==="skill"` 标记「SKILL 加载」，context 标记「上下文注入」，tool/代码/日志原文不翻译。

### 4.18 GET /api/missions/:id/board

线索板投影（P2），由权威表/事件序列推导，`version` 为事件 seq：

```json
{
  "board": {
    "missionId": "uuid",
    "version": 42,
    "baseVersion": 42,
    "conflicts": [],
    "generatedAt": "...",
    "sections": {
      "scope": { "name": "...", "state": "running", "target": {}, "grantId": "uuid", "grantVersion": 1, "scope": {} },
      "assets": [{ "host": "192.168.1.10", "source": "evidence" }],
      "facts": [{ "findingId": "uuid", "title": "...", "category": "sqli", "severity": "high", "artifact": "..." }],
      "capabilities": [{ "taskId": "uuid", "type": "bootstrap" }],
      "negatives": [{ "type": "needs_review", "findingId": "uuid", "title": "..." }],
      "findings": [{ "id": "uuid", "title": "...", "severity": "high", "confidence": "observed", "mergedCount": 0 }],
      "todo": [{ "id": "uuid", "position": 0, "content": "...", "status": "pending" }],
      "evidence": { "total": 4, "target": 3, "internet": 1, "distinctUrls": 3, "triggers": [] }
    }
  }
}
```

404/503。

### 4.19 GET /api/missions/:id/replay?toSeq=N

按 events 回放到 `toSeq`（省略=最新），并与实时投影比较：

```json
{
  "replay": {
    "missionId": "uuid",
    "toSeq": 42,
    "state": "completed",
    "grantVersion": 1,
    "tasks": [{ "id": "uuid", "state": "done" }],
    "matchesCurrent": true,
    "diffs": [],
    "current": { "state": "completed", "grantVersion": 1, "tasks": [] }
  }
}
```

400 `toSeq` 非法；404 mission 不存在；503。

### 4.20 POST /api/missions/:id/scope-upgrade

申请授权范围升级（只创建 pending approval，不改 Grant）：

```json
{ "url": "http://other-host:8080", "reason": "optional" }
```

也支持 `domainSuffixes` / `ips` / `urlPrefixes`（至少提供一种）。响应 `201`：

```json
{ "approvalId": "uuid", "missionId": "uuid", "scopeExtras": { "domainSuffixes": [], "ips": [], "urlPrefixes": [] } }
```

审批通过后：新 Grants 行（version+1）、mission.grant_version 更新、open tasks 重绑、`grant.upgraded` 事件；approval.payload 带 `appliedGrantVersion`。

### 4.22 GET /api/metrics

P3-A2 起返回指标目录（ADR-0019 后为 **12 项**）（`indicators`）+ 原有 v1 字段（保留向后兼容）。所有数值来自 PostgreSQL 投影，不读模型自报。

```json
{
  "metrics": {
    "generatedAt": "...",
    "missions": { "total": 10, "active": 1, "completed": 8, "failed": 1 },
    "findings": { "total": 20, "accepted": 15, "needsReview": 3, "rejected": 2, "merged": 1, "validated": 12, "artifacts": 14 },
    "rates": {
      "reviewRate": 0.15, "validationRate": 0.6, "policyDenialRate": 0.02, "stuckRate": 0, "duplicateMergeRate": 0.06,
      "falsePositiveRate": 0.11, "taskSuccessRate": 0.9, "taskRetryRate": 0.05, "handbackRate": 0.02, "evidenceDepth": 2.4
    },
    "timing": { "avgTimeToFirstFactSeconds": 120, "avgMissionSeconds": 600 },
    "tasks": {
      "total": 25, "running": 1, "stale": 0, "stuck": 0,
      "done": 20, "failed": 2, "exhausted": 1, "handedBack": 1, "attempted": 24, "retried": 3
    },
    "evidence": { "total": 40, "target": 30, "internet": 10 },
    "cost": { "totalTokens": 2400000, "tokensPerValidatedFinding": 200000 },
    "indicators": [
      { "id": "validated_findings", "group": "quality", "label": "已验证发现", "unit": "count",
        "definition": "status=accepted 且 evidence_ids 引用数 ≥2 的 finding 数",
        "value": 12, "numerator": 12, "denominator": null }
    ]
  }
}
```

**指标语义**：

- `indicators` 固定 **12 项、顺序稳定**（见 `docs/decisions/0009-p3-thirteen-metrics.md`），前端直接遍历渲染，不需要自己算比率。
- `value` 为 `null` 表示 **N/A（分母为空/暂无数据）**，必须显示为「N/A」而不是 0；`numerator`/`denominator` 便于显示口径与 tooltip。
- `unit`：`count` 计数 / `ratio` 比率 / `seconds` 秒 / `tokens` token（成本代理，不是账单）。
- `rates` 中的旧字段保持数字（分母为空时为 0）以兼容旧看板；新 UI 请优先使用 `indicators`。
- 12 项：validated_findings、validation_rate、review_rate、false_positive_rate、duplicate_intent_rate、evidence_depth、time_to_first_fact_seconds、stuck_rate、task_success_rate、task_retry_rate、handback_rate、tokens_per_validated_finding。

### 4.23 Finding 新增字段

`FindingListItem` / `FindingDetail` 增加：

| 字段 | 说明 |
|---|---|
| `confidence` | `observed`（已观测，有差异/产物）/ `inferred`（推断）/ `unverified`（未验证，进复核） |
| `mergedCount` | 因 root-cause 相同而自动合并的次数 |

`approvals[].type` 新增 `finding_review`（复核拒绝的 finding）。

### 4.24 GET /api/missions/:id/trace-summaries（P3-A1）

同一 mission 内跨任务的先验工作总结（轨迹统计 + 失败原因 + 工具/SKILL 统计），并给出 Worker 在下一次 claim 边界实际注入的 `digest`。只含结构化统计与短摘要，**不返回请求/响应正文**；原始轨迹仍走 `/api/traces`。

查询参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `excludeTaskId` | 否 | 排除某个任务（Worker 注入路径用它排除当前任务；前端一般不用） |

```json
{
  "summary": {
    "missionId": "uuid",
    "missionName": "p0-lab-...",
    "generatedAt": "...",
    "totals": {
      "tasks": 2, "done": 1, "failed": 1, "running": 0,
      "steps": 46, "tokens": { "input": 37647, "output": 56595, "total": 2248866 },
      "findings": 10, "acceptedFindings": 9, "evidence": 24, "toolCalls": 96,
      "toolCounts": { "http_request": 67, "bash": 11, "report_finding": 10, "skill": 2 },
      "skillsLoaded": ["ck-router", "web-recon"]
    },
    "tasks": [
      {
        "taskId": "uuid", "type": "bootstrap", "state": "done", "attempt": 1,
        "steps": 46, "tokens": { "input": 37647, "output": 56595, "total": 2248866 },
        "findings": 10, "acceptedFindings": 9, "evidence": 24,
        "toolCalls": 96, "traceEvents": 300,
        "toolCounts": { "http_request": 67, "bash": 11 },
        "skillsLoaded": ["ck-router", "web-recon"],
        "startedAt": "...", "completedAt": "...", "firstTraceAt": "...", "lastTraceAt": "...",
        "finalText": "## Mission Complete — 8 flags confirmed ...",
        "lastError": null
      }
    ],
    "digest": "TOTALS: 2 prior task(s) …"
  }
}
```

- `tasks[].finalText` / `lastError` 已截断（≤200/160 字符）；`digest` 默认 ≤1500 字符（worker 侧 `PRIOR_WORK_MAX_CHARS`）。
- `tasks` 最多 50 条（按完成/开始时间倒序），且**只包含已领取/运行过的任务**（`attempt > 0` 或有 worker report）；新规划但未开始的 `ready/proposed` 任务不出现，也不会进入注入 digest。Worker 注入路径只取最近 6 条。
- `digest` 为空字符串表示没有可注入的先验工作。
- 404：mission 不存在；400：`excludeTaskId` 不是 UUID；503：DB 错误。
- UI 建议：任务详情/轨迹页加「先验工作」面板；`digest` 可折叠展示（它正是 Worker 看到的那段文本）。
- Worker 每次注入会写 `task.prior_work_injected` 事件，并落一条 `context(source=prior_work)` 轨迹，便于审计「模型到底看到了什么」。

**审计与安全边界**：digest 由控制面生成，只含统计/工具名/技能名/失败分类/短摘要；目标正文不进入注入上下文。摘要中的模型文本可能引用目标内容，因此提示词明确标注为不可信数据。

### 4.25 GET /api/missions/:id/facts

P3-B1 黑板读模型：`mission_facts` 是 **PostgreSQL 视图**，从 assets/findings/evidence 派生，不是第二事实源（可重建）。返回 typed facts。

查询参数：`kind`（可选，如 `credential`/`vuln`/`host`/`artifact`）、`trust`（`observed`/`inferred`）、`limit`（1–500，默认 200）。

```json
{
  "missionId": "uuid",
  "facts": [
    {
      "id": "asset:uuid",
      "missionId": "uuid",
      "source": "asset",
      "sourceId": "uuid",
      "kind": "credential",
      "key": "credential:admin:plaintext-secret",
      "value": "admin:plaintext-secret",
      "summary": "admin:plaintext-secret",
      "provenance": "worker_asset",
      "trust": "inferred",
      "sensitive": true,
      "taskId": "uuid",
      "createdAt": "..."
    }
  ],
  "total": 1
}
```

- `source`：`asset`（Worker `insert_assets`）/ `finding`（accepted finding → vuln）/ `finding_artifact`（目标产物）/ `evidence`（目标主机）。
- `sensitive=true` 仅 credential；**value 为明文**（用户 2026-11-08 明确要求，ADR-0010）。前端默认遮罩，点击展开；不要写入浏览器持久化日志/URL。
- 只返回该 mission 的 facts；跨 mission 永不返回凭据。404：mission 不存在。

### 4.26 GET /api/missions/:id/frontier

黑板 frontier：开放任务意图 + 高信号 facts + 计数 + 事件版本（与 `/replay` 对齐）。

查询参数：`factLimit`（默认 30，1–100）、`intentLimit`（默认 30，1–100）。

```json
{
  "frontier": {
    "missionId": "uuid",
    "version": 42,
    "generatedAt": "...",
    "intents": [
      { "id": "uuid", "missionId": "uuid", "type": "intent", "state": "ready",
        "objective": "investigate /admin authentication with the recorded credential",
        "priority": 0.9, "dependsOn": [], "attempt": 0, "createdAt": "..." }
    ],
    "facts": [ { "...": "同 4.25 MissionFact" } ],
    "counts": { "facts": 8, "intents": 1, "sensitiveFacts": 1, "byKind": { "credential": 1, "vuln": 2, "host": 1 } }
  }
}
```

- `intents` 来自未完成 tasks（proposed/ready/leased/running/retry_wait/blocked）。
- `facts` 只含高信号 kind（credential/vuln/host/endpoint/parameter/technology/identity/file），已解决的 artifact 不进入 frontier。
- Planner 快照注入同一数据（`PLANNER_FRONTIER_ENABLED=1` 默认开启；A/B 时置 0）。
- UI 建议：frontier 作为「下一步可打点」列表；intent 可跳任务详情，fact 可搜索/复制（凭据需二次确认）。

### 4.27 GET /api/missions/:id/recall?q=

对 fact 的 `key/value/summary` 做大小写不敏感子串检索（前端搜索框/Reload 用）。

参数：`q` 必填（≤200 字符）；`kind` 可选；`limit` 1–100 默认 50。

```json
{ "missionId": "uuid", "facts": [ { "...": "同 4.25 MissionFact" } ], "total": 1 }
```

- 400：`q` 缺失/过长；404：mission 不存在。
- 检索结果同样含明文凭据（`sensitive=true`），前端按 4.25 遮罩规则处理。

### 4.28 模型配置管理（P3-B2，admin token）

**权限**：本节所有路由要求 `Authorization: Bearer $API_ADMIN_TOKEN`。普通 `API_AUTH_TOKEN` 调用返回 **403**；无 token 返回 **401**。未配置 `API_ADMIN_TOKEN` 时回退普通 token（仅开发环境）。可选的 `x-actor` 头写入审计（≤120 字符，默认 `api-admin`）。

**数据模型**（列表/详情返回，**不含明文 key**）：

```jsonc
{
  "id": "uuid",
  "name": "deepseek-flash-default",
  "baseUrl": "https://api.deepseek.com/v1",
  "modelName": "deepseek-flash",
  "apiKeyEnv": "SRC_AGENT_MODEL_API_KEY",
  "contextWindow": 1000000,
  "maxOutputTokens": 393216,
  "reasoningEffort": "max",       // low|high|max|null
  "compat": {},                    // 网关兼容字段
  "role": null,                    // null|worker|planner|scout|executor|specialist|guard
  "tier": null,                    // null|default|fast|strong
  "enabled": true,
  "isDefault": true,
  "apiKeySet": true,
  "apiKeyMasked": "sk-a••••wxyz",
  "createdAt": "...", "updatedAt": "..."
}
```

**端点**

| 方法/路径 | 说明 |
|---|---|
| `GET /api/model-configs` | `{configs:[...],total}`，按默认/更新时间排序 |
| `POST /api/model-configs` | 新建；body 必须含 `name/baseUrl/apiKey/modelName`；可选 `contextWindow/maxOutputTokens/reasoningEffort/compat/role/tier/enabled/isDefault`；`201 {config}` |
| `GET /api/model-configs/:id` | 详情（遮罩）；404 |
| `PUT/PATCH /api/model-configs/:id` | 部分更新；`apiKey` 传空串表示不修改；`200 {config}` |
| `DELETE /api/model-configs/:id` | 删除；`200 {deleted:true}` |
| `POST /api/model-configs/:id/reveal` | **返回明文 key**：`{config:{id,name,apiKey,updatedAt}}`；每次 reveal 写审计 |
| `GET /api/model-configs/audit` | 最近 200 条 `{audit:[{id,configId,configName,actor,action,detail,createdAt}],total}`；`action` = create/update/delete/reveal |

**语义**

- 第一条配置自动成为默认；`isDefault=true` 会事务内取消旧默认，数据库唯一索引保证至多一个。
- Worker 每次 claim、Planner 每次 reason pass 读取最新配置：优先 `role` 精确匹配，否则默认配置；读不到/读取失败回退 env。**保存后下一个任务/下一次 Planner 运行生效，无需重启**（Planner/Worker 容器不重启）。
- CLI runtime 支持 DB 配置；inprocess runtime 暂不应用（回退 env，Worker 日志会说明）。
- 明文 key 仅 reveal 返回，列表/详情/审计永不包含；前端不得写入 localStorage/URL/console。
- UI 建议：设置页先要求输入 admin token（仅保存在内存或 sessionStorage 且可一键清除）；列表显示名称/模型/baseUrl/角色/默认徽标 + 掩码 key；reveal 需二次确认；下方展示审计（谁在何时 reveal/修改）。

### 4.29 GET /api/missions/:id/intel（P3-B3，仅同 mission）

只读情报投影：accepted findings（technique/artifact）+ 黑板 credential facts。**没有跨 mission/跨任务自动传递**。

```json
{
  "intel": {
    "missionId": "uuid",
    "generatedAt": "...",
    "total": 2,
    "items": [
      { "id": "finding:uuid", "type": "artifact", "title": "SQLi in /search", "detail": "FLAG{...}",
        "tags": ["sqli", "high", "accepted"], "trust": "observed", "sensitive": false,
        "sourceFindingId": "uuid", "sourceTaskId": "uuid", "createdAt": "..." },
      { "id": "credential:...", "type": "credential", "title": "credential fact",
        "detail": "admin:plaintext-secret", "tags": ["credential", "inferred"], "trust": "inferred",
        "sensitive": true, "sourceFindingId": null, "sourceTaskId": "uuid", "createdAt": "..." }
    ]
  }
}
```

- `type`: `technique`（无 artifact 的 accepted finding）/ `artifact`（有 artifact）/ `credential`（黑板凭据）。
- credential 明文 + `sensitive=true`：前端默认遮罩，点击展开（遵循 4.25/ADR-0010）。
- 查询参数 `limit` 1–200 默认 100；404 mission 不存在。

### 4.30 GET /api/missions/:id/explore-graph?threshold=150（P3-A3）

探索图只读投影 + 大图 digest 折叠。数据从 `tasks` + `mission_facts` 派生，不依赖 `explore_nodes/edges` 写入。

```json
{
  "graph": {
    "missionId": "uuid",
    "version": 42,
    "generatedAt": "...",
    "threshold": 150,
    "folded": false,
    "original": { "nodes": 8, "edges": 7 },
    "nodes": [
      { "id": "mission:uuid", "type": "mission", "kind": "mission", "label": "lab" },
      { "id": "task:uuid", "type": "task", "kind": "task", "label": "enumerate /admin", "state": "ready", "angle": "web" },
      { "id": "fact:asset:uuid", "type": "fact", "kind": "credential", "label": "admin:••••", "trust": "inferred", "sensitive": true }
    ],
    "edges": [
      { "id": "contains:task:uuid", "source": "mission:uuid", "target": "task:uuid", "type": "contains" },
      { "id": "produced:fact:...", "source": "task:uuid", "target": "fact:asset:uuid", "type": "produced" },
      { "id": "observes:fact:...", "source": "mission:uuid", "target": "fact:...", "type": "observes" },
      { "id": "evidence_of:...", "source": "fact:vuln", "target": "fact:artifact", "type": "evidence_of" }
    ],
    "groups": []
  }
}
```

- `threshold` 10–500 默认 150；超过阈值时服务端折叠：`folded=true`，`groups[]` 含 `{id,type,kind,label,memberIds}`，`nodes` 只含 mission 节点 + 超节点；`edges` 逐条重映射（数量与原始一致，可能出现自环）。
- `version` 与 events max(seq) 对齐，可与 replay 对照。
- 前端渲染建议：`mission` 根节点固定；task/fact 按 kind 着色；折叠时显示超节点 + 成员数，点击展开成员 id（可再按需请求 `/facts` 或任务详情）。

### 4.32 评测历史与回放看板（P3-A6）

要点：

- `POST /api/evals` 记录结构化摘要（kind/name/status/summary/details），报告文件仍在 `evals/reports/`。
- `GET /api/evals?kind=&limit=` 历史；`GET /api/evals/:id` 详情。
- `GET /api/evals/dashboard?limit=&replayLimit=` 合并：每种 eval 最新一条 + `/api/metrics` 12 指标 + 最近 mission 的 events replay（`matched/mismatched/diffs`）。
- 允许空历史：dashboard 的 `evals` 为空数组、`replay.checked=0`。

### 4.33 GET /api/missions/:id/overview?maxChars=8000（M5-1）

项目态势只读聚合，Planner/Worker/前端共用；同 mission、无原始请求/响应正文、硬 JSON 预算（500–50000）。

```jsonc
{
  "overview": {
    "mission": { "id": "uuid", "name": "...", "state": "running", "objective": "...", "target": { "type": "url", "value": "http://..." }, "grantVersion": 1, "createdAt": "..." },
    "tasks": { "open": [/* ≤30 */], "recent": [/* ≤20 */], "counts": { "open": 1, "done": 2, "failed": 0, "total": 3 } },
    "facts": { "items": [/* ≤30 */], "counts": { "total": 4, "byKind": { "credential": 1 }, "sensitive": 1 } },
    "frontier": { /* MissionFrontier */ },
    "findings": { "accepted": [/* ≤20 */], "needsReview": [/* ≤20 */], "counts": { "accepted": 1, "needsReview": 0 } },
    "hints": { "items": [/* ≤10 */], "pending": 0 },
    "negatives": { "blocked": 0, "exhausted": 0, "stale": 0, "needsReview": 0, "total": 0 },
    "traces": { "totals": { /* ... */ }, "tasks": [/* ≤10 摘要 */] },
    "todo": { "items": [/* ≤30 */] },
    "assets": { "total": 2, "byType": { "host": 1, "credential": 1 }, "items": [/* ≤20 */] },
    "coverage": { "total": 2, "covered": 1, "ratio": 0.5 },
    "budget": { "tokens": 12345, "steps": 20 },
    "version": 42, "generatedAt": "...", "truncated": false
  }
}
```

- `maxChars` 越界 400；`truncated` 只在截断时出现；404 = mission 不存在。
- 敏感 fact 的 value 仍按黑板书目返回；前端展示需遮罩（ADR-0010）。

### 4.34 GET /api/missions/:id/worker-traces/search（M5-4）

```jsonc
{
  "search": {
    "missionId": "uuid", "q": "admin", "excludeTaskId": "uuid|null",
    "hits": [
      { "traceId": "123", "taskId": "uuid", "callId": "call_...", "seq": 4, "eventType": "tool_call",
        "tool": "http_request", "url": "http://target/admin", "method": "GET",
        "command": null, "status": null, "summary": "GET /admin",
        "createdAt": "...", "untrusted": true }
    ],
    "total": 1, "truncated": false, "untrusted": true
  }
}
```

- 只查当前 mission；`excludeTaskId` 排除当前任务；`limit` 1–20；不返回原始 body；前端必须标 `untrusted`。
- 2026-11-08 索引优化：`task_trace.search_text` + `pg_trgm` GIN，索引 tool/URL/method/command/status + ≤600 字结果摘录；`tool_result` 会通过同一 `callId` 补 `url/method/command`。搜索建议提示用户输入 URL、Host、路径、命令或状态码。

### 4.35 GET /api/missions/:id/assets/graph（M5-5）

```jsonc
{
  "graph": {
    "missionId": "uuid", "version": 42, "generatedAt": "...",
    "nodes": [
      { "id": "asset:uuid", "type": "asset", "kind": "host", "label": "target.test", "taskId": "uuid", "covered": true },
      { "id": "task:uuid", "type": "task", "kind": "task", "label": "task", "taskId": "uuid" }
    ],
    "edges": [
      { "id": "observed_by:...", "source": "asset:uuid", "target": "task:uuid", "type": "observed_by" }
    ],
    "counts": { "total": 2, "byType": { "host": 1, "credential": 1 }, "covered": 1, "ratio": 0.5 }
  }
}
```

- 节点 type：`asset/task/finding/evidence`；边 type：`observed_by/seen_in_evidence/produced`。
- 资产仍按 mission_id 隔离，无跨项目图；空资产返回合法空图。

## 5. 前端页面建议

| 页面 | 数据源 |
|---|---|
| 总览/仪表盘 | health + missions + findings + approvals(pending) |
| 任务列表 | `GET /api/missions` |
| 新建任务 | `POST /api/missions`（表单校验按 4.3） |
| 任务详情-概要 | `GET /api/missions/:id` + SSE |
| 任务详情-DAG | `tasks[].state/dependsOn/type` 前端布局 |
| 任务详情-待办/触发器/提示/审批/Planner 运行 | `mission.todo/triggers/hints/approvals/plannerRuns` |
| 轨迹页 | `GET /api/traces`（worker/planner 两类） |
| 先验工作面板 | `GET /api/missions/:id/trace-summaries`（`digest` + 每任务统计） |
| 黑板页 | `GET /api/missions/:id/facts` + `/frontier` + `/recall` |
| 情报视图 | `GET /api/missions/:id/intel`（同 mission，只读） |
| 探索图 | `GET /api/missions/:id/explore-graph?threshold=150` |
| 发现列表/详情 | `/api/findings` / `/api/findings/:id`（报告、证据） |
| 审批中心 | `/api/approvals` + decide（scope_upgrade 批准后自动升 Grant） |
| 线索板 | `/api/missions/:id/board` |
| 指标 | `/api/metrics` |
| 设置-模型配置 | `/api/model-configs`（admin token；列表遮罩、reveal 二次确认、审计） |

**操作按钮**：暂停/恢复调 4.5/4.6；加提示 4.14；审批 decision 4.12。按钮需 pending 状态防重复提交，409 时刷新列表。

## 6. 解耦与变更策略（已实施）

1. **契约冻结**：本文档 + `openapi.yaml` 为 v1。
2. **共享数据层**：`packages/control-plane`（PostgreSQL repositories）由 `packages/api`（独立 API）使用。
3. **独立 API**：`packages/api`（Node HTTP）暴露同一路径/响应；`docker compose up -d api` 启动，`API_PORT` 默认 3001。
4. **Auth/CORS**：`AUTH_MODE=accounts` 会话登录（默认，ADR-0038）+ `API_AUTH_TOKEN`（Bearer，自动化）+ `CORS_ORIGINS`；nginx 只反代、不注入 token，SPA 与 API 同源。
5. **前端切换**：`packages/frontend` 的 nginx 在 5173 同源反代到 `api:3001`；旧 `web` 容器/源码已移除，部署只保留 frontend + api。
6. **契约测试**：`node scripts/api-smoke.mjs` 校验鉴权/CORS/v1 读路径；破坏性变更走 `/api/v2` 或新增字段（前端忽略未知字段）。
7. **不建议前端依赖**：数据库表结构、`events` 原始事件、内部 checkpoint 细节（可展示但不要解析业务语义）。

## 4.36 认证、账号与管理接口（2026-11-13 修订，ADR-0038）

**单管理员部署**：API 首次启动且 `users` 为空时自动创建 `admin` / `admin123`
（`DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` 可覆盖），并置 `must_change_password=true`。
默认 `AUTH_MODE=accounts`；浏览器必须用会话 cookie 登录（nginx 只对无 `Sec-Fetch-*` 头的自动化请求注入
`API_LEGACY_TOKEN`）。账号创建/改角色/重置密码与 `/api/auth/setup` **已移除**。

### 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | `{username,password}`；成功 Set-Cookie `src_agent_session`，返回 `{user:{id,username,role,mustChangePassword},csrfToken,expiresAt}` |
| GET | `/api/auth/me` | 返回 `{user:{id,username,role,mustChangePassword},authKind,csrfToken,authMode}` |
| POST | `/api/auth/logout` | 注销 session，清 cookie |
| POST | `/api/auth/password` | `{currentPassword,newPassword}`；成功后撤销旧 session 并返回新 `{ok,user,csrfToken}` + 新 cookie |

Session mutation 必须带 `x-csrf-token`；Cookie 模式不使用 `Authorization` 头。

### 首次登录强制改密码

登录成功但 `user.mustChangePassword === true` 时，除
`/api/health`、`/api/auth/me`、`/api/auth/password`、`/api/auth/logout` 之外的所有路由返回：

```json
{ "error": "password_change_required", "message": "密码至少 12 位，且必须包含大写字母、小写字母、数字和特殊字符" }
```

前端必须在 `me`/`login` 之后检查该字段并渲染改密页；改密成功后 `mustChangePassword` 变 `false`，
可直接进入控制台（无需重新登录）。

### 密码规则（服务端权威，前端仅做实时提示）

- 至少 12 位；
- 同时包含大写字母、小写字母、数字、特殊字符（非字母数字）；
- 新密码不得与当前密码相同；
- 不满足时 `400 validation failed`，`issues[].path = ["newPassword"]`。

### 任务级人工控制（P1 1.7）

所有 mutation 需要 operator/admin 权限；viewer 只读。人工动作同步写入事务和 `steering` 审计表。

- `POST /api/missions/:id/tasks` — 手动派发一个独立 intent
```json
{ "objective": "验证 /admin 的角色越权", "angle": "api", "priority": 0.5,
  "maxSteps": 0, "maxWallClockMs": 1200000 }
```
响应 `201 { "taskId": "uuid", "state": "proposed" }`。仍受 mission scope、开放任务上限和调度器约束；不会绕过权限。

- `POST /api/missions/:id/tasks/:taskId/cancel` — 取消单任务
```json
{ "reason": "cancelled from DAG" }
```
响应 `{ "taskId": "uuid", "missionId": "uuid", "state": "cancelled" }`。取消后 Worker 的迟到报告会被 fencing 丢弃；当前执行可能自然结束。

- `POST /api/missions/:id/tasks/:taskId/confirm-retry` — 人工确认写动作后重试
  - 仅当任务因 `action_ledger` 写动作被 scheduler 置为 `blocked` 时可用；
  - 成功响应 `{ "taskId": "...", "state": "retry_wait", "actionCount": 2 }`；
  - 确认时间写入 `tasks.write_actions_confirmed_at`，之后的新目标写动作会再次阻断重试；
  - 无写动作或任务不是 `blocked` 返回 409。

- `GET /api/missions/:id/tasks/:taskId/actions?limit=50` — 该任务的写动作
- `GET /api/missions/:id/action-ledger?limit=100` — 整个 mission 的写动作
- `GET /api/missions/:id/steering?limit=100` — 人工任务控制审计（spawn_intent/cancel_task/confirm_retry）

写动作响应：
```json
{ "actions": [
  { "id": "1", "missionId": "uuid", "taskId": "uuid",
    "method": "POST", "url": "http://target/admin",
    "statusCode": 200, "requestSha256": "…", "observedAt": "..." }
], "total": 1 }
```

只在 target 流量上记录 `POST`/`PUT`/`PATCH`/`DELETE`；internet 流量不进入 ledger。任务级重试守卫使用它，避免 lease/transient 重试重复目标写操作。

### Watchdog 看板（ADR-0039，2026-11-14）

`GET /api/admin/watchdog?days=7&limit=50`（admin）只读聚合：

```json
{
  "watchdog": {
    "windowDays": 7,
    "summary": {
      "observations": 12, "hints": 10, "deduped": 2, "escalations": 1,
      "pendingOutcomes": 3, "checkedOutcomes": 9,
      "progressOutcomes": 4, "noProgressOutcomes": 5,
      "hitRate": 0.44,
      "byRule": [{ "rule": "no_progress", "count": 8, "escalations": 1 }],
      "byDay": [{ "date": "2026-11-13", "observations": 12, "escalations": 1, "progress": 4, "noProgress": 5 }]
    },
    "recent": [{ "id": "1", "missionId": "…", "missionName": "…", "taskId": "…",
      "rule": "no_progress", "source": "rules", "action": "hint|deduped|escalated",
      "stalledStreak": 2, "detail": "…", "outcome": "pending|progress|no_progress",
      "outcomeDetail": { "newFindings": 1, "newUrls": 2 }, "approvalId": null,
      "createdAt": "…", "outcomeCheckedAt": "…" }],
    "escalations": [ /* 同上结构，action=escalated */ ],
    "streaks": [{ "taskId": "…", "missionId": "…", "missionName": "…",
      "stalledStreak": 2, "escalatedStreak": 2, "lastRule": "direction_drift",
      "lastDetail": "…", "lastObservedAt": "…" }]
  }
}
```

- `hitRate` = `progressOutcomes / checkedOutcomes`，没有回采样本时为 `null`。
- `outcome` 在提示后 `WATCHDOG_OUTCOME_DELAY_MS`（默认 10 分钟）由 sweep 写入：
  观察时间之后出现新 finding 或首次出现的 target URL → `progress`，否则 `no_progress`。
- 前端页面：`设置 → Watchdog`（`/settings/watchdog`），支持 1d/7d/30d。

### 审批类型 `stalled_task`

连续 stall 达到 `WATCHDOG_ESCALATE_AFTER`（默认 2）时，控制面会创建 `type=stalled_task`
的审批（payload 含 `taskId`、`rule`、`streak`、`detail`）：

- **approved** → 取消该任务（`task.cancelled`，审计 actor=decider）；
- **rejected** → 清空该任务的 stall streak，任务继续；
- 同一停滞周期只升级一次，且复用已存在的 pending 审批，不会重复建单。
- 若启用了 Planner：Planner 会消费 `watchdog_stall` 信号；判定任务无用则自动 `cancel_task`，
  该 pending 审批会被关闭为 `status=rejected`、`decidedBy=planner:auto`、`payload.resolution=planner_cancelled`
  （前端审批中心按普通已决策项展示即可，不需要额外处理）。

### 管理员

- 账号管理接口已移除（单管理员，ADR-0038）。
- `GET /api/admin/settings`、`PATCH /api/admin/settings`
  - 请求：`{ expectedVersion?: number, values: { ...allowlist } }`
  - allowlist：`planner.maxOpenTasks` / `planner.parallelTasks` / `planner.frontierEnabled`；`worker.missionContextEnabled` / `worker.traceSearchEnabled` / `worker.findingReviewMode` / `worker.summaryEnabled` / `worker.summaryMaxRounds` / `worker.summaryFollowUpEnabled` / `worker.summaryMaxFollowUps` / `worker.requestDedupeMode` / `worker.requestDedupeTtlMinutes`
- `GET /api/admin/audit?limit=`
- `DELETE /api/admin/missions/:id`，body `{confirmName}`；硬删除项目业务数据，写 admin_audit；响应含 counts

权限：viewer 只读；operator 可任务/hint/finding review；admin 才可 scope upgrade、模型配置、参数、账号、项目删除。

### Summary

- `GET /api/missions/:id/summary`
```json
{ "summary": { "id": "uuid", "markdown": "...", "coverageAssessment": "...", "gaps": [
  { "area": "authz", "reason": "...", "suggestedCheck": "...", "confidence": "medium" }
], "createdAt": "..." } }
```
无 summary 时返回 `{ "summary": null }`。

### 审批面板中的命令复核

`command_review` 只由命令门控模型失败时产生。payload 含 `taskId/command/commandHash/reason`；批准表示允许该 task 重试同一 command，拒绝表示该命令继续阻断。原始命令只在审批详情展示，不写入浏览器 localStorage。

### 运行时参数

`GET /api/admin/settings` 响应：

```json
{ "settings": {
  "planner.maxOpenTasks": 3,
  "planner.parallelTasks": 3,
  "planner.frontierEnabled": true,
  "worker.missionContextEnabled": true,
  "worker.traceSearchEnabled": true,
  "worker.findingReviewMode": "auto",
  "worker.summaryEnabled": true,
  "worker.summaryMaxRounds": 1,
  "worker.summaryFollowUpEnabled": false,
  "worker.summaryMaxFollowUps": 1,
  "worker.requestDedupeMode": "warn",
  "worker.requestDedupeTtlMinutes": 30,
  "version": 4
} }
```

`PATCH` body：`{ "expectedVersion": 4, "values": { "worker.requestDedupeMode": "off" } }`；冲突返回 409。

### 运行时参数说明

`GET/PATCH /api/admin/settings` 只接受非秘密白名单；不支持 DB/网络/LLM key/容器副本。修改写入 `admin_audit`。

**当前所有允许项均已接线并热生效**：Planner 在下一次 reason pass 读取 `planner.*`；Worker 在下一个任务读取 `worker.missionContextEnabled`/`traceSearchEnabled`/dedupe；`worker.findingReviewMode`/`summaryEnabled`/`summaryMaxRounds`/`summaryFollowUpEnabled`/`summaryMaxFollowUps` 由 controller 在任务边界与 summary 收尾读取（补漏默认关闭，最多 1 个，见 ADR-0036）。response 仍返回完整 `settings.version`，PATCH 可带 `expectedVersion` 做乐观锁。

### 项目删除

`DELETE /api/admin/missions/:id` 要求精确项目名；事务删除 tasks/evidence/findings/assets/events/approvals/hints/traces/planner 数据/grants/mission，并尽力删除共享运行目录。全局 `proxy_denials` 审计已在 ADR-0019 删除；成功代理流量已在 `proxy_traffic` 通过 `mission_id` 关联 mission（迁移 0007，`ON DELETE CASCADE`），项目删除会级联清理关联审计。

## Artifact 上传与逆向输入

- 详细交接：[artifact-upload-frontend-handoff.md](artifact-upload-frontend-handoff.md)
- `POST /api/missions/:id/artifacts`：原始 octet-stream 上传，`x-artifact-filename`；operator/admin。
- `GET /api/missions/:id/artifacts`：artifact 元数据列表。
- manual task 支持 `artifactIds`。
- mission 删除会清理 `/artifacts/<missionId>`；TTL 清理 `POST /api/admin/artifacts/gc`。

## 新建项目 + 附件（v2）

- 详细接口逻辑：[mission-create-multipart-handoff.md](mission-create-multipart-handoff.md)
- `POST /api/missions` 支持 `multipart/form-data`：target/name/objective + 多个 `artifact` 文件；返回 `artifactIds`，并写入 bootstrap task。
- 目标值使用真实目标 host；本地 host-only 目标由 `PROXY_CONNECT_OVERRIDES` 在 proxy 传输层映射，不改 Host/证据。

## 纯附件新建

- `POST /api/missions` multipart 支持 `targetMode=attachment`：不要求网络 target，但必须至少一个 artifact；scope 为 `{allowAll:true}`，网络仍经 audited proxy。
- 前端新建页目标类型需提供「纯附件」选项；选择后 target 隐藏、附件必填。
- JSON 创建不允许 file target / targetMode=attachment。

## 模型配置测试连接

- 详细交接：[model-config-test-handoff.md](model-config-test-handoff.md)
- `POST /api/model-configs/test`：测试未保存的 baseUrl/apiKey/modelName；`POST /api/model-configs/:id/test`：测试已保存配置（可覆盖字段）。
- 两者都返回 200 + `{ok, latencyMs, httpStatus, model, reply, usage, error, errorCode, traceId}`；`ok:false` 即连接失败。
- 仅 admin；key 不回显、不落日志、不写审计。

### 4.36 GET /api/missions/:id/coverage（v1.0.2，ADR-0054）

返回该 mission 的授权覆盖要求（由 target/attack surface 派生，Planner 与报告共用）。

```json
{
  "requirements": [
    {
      "id": "uuid",
      "missionId": "uuid",
      "targetRef": "target:http://192.168.1.10",
      "attackSurface": "web",
      "status": "pending",
      "evidenceRef": null,
      "disposition": null,
      "updatedAt": "2026-11-17T08:00:00.000Z"
    }
  ]
}
```

`status`：`pending | covered | negative | dispositioned`。`V102_PLANNER_COVERAGE_INVARIANT=1` 时 Planner 会为 pending 项自动补一个 generic assessment task。
