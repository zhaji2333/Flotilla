# ADR-0019：Dispatcher-only Worker、模型代理与全局拦截审计退场

- 状态：已实施（2026-11-09）
- 取代/补充：ADR-0017、ADR-0018 的残余项
- 影响：Worker/Dispatcher/Planner/API/compose、模型调用链、指标目录、审计表

## 背景

ADR-0018 完成后仍有三类残余：

1. Worker controller 自己持有 PostgreSQL 凭证并执行 claim/finish 等写操作；Agent 虽在 executor 中，但 controller 仍是数据库客户端。
2. Summary 仍在 Worker 本地执行，没有走独立 executor。
3. 模型 provider key 仍通过 executor env/任务 override 对 Agent 子进程可见；同时 `proxy_denials` 是无 mission 外键的全局审计，项目删除无法覆盖。

## 决策

### 1. Dispatcher-only controller

- 新增 `dispatcher` 服务（同 orchestrator 镜像，`src/dispatcher/main.ts`），是唯一执行控制面 SQL 的 controller 进程。
- Worker 通过带 `x-dispatcher-token` 的内部 HTTP API 完成 claim/start/heartbeat/hints/events/finish/trace/request-index/context/prior-work/model-config/scheduler/watchdog。
- Worker 容器不再有 `PG_*` 环境变量，也不在 PostgreSQL 所在网络；只加入 `ctl`（dispatcher）和 `execnet`（executor）。
- Dispatcher 继续使用现有 worker-repository/scheduler/trace/control-plane 函数，不复制 SQL 语义。
- Planner 仍是独立 DB 服务（只读快照 + 事务 apply），不属于 Worker controller；其模型调用改走同一代理。

### 2. Summary 走 executor

- 删除 Worker 本地 summary 特例；所有任务（含 `summary`）统一提交 executor。
- 保留 summary 专用的只读 mission tools、`submit_summary` 和既有 bounded 输出/失败不阻塞语义。
- executor 共享 `/runs` 卷读取 worker 写入的 context/request-index；outcome 仍由 dispatcher 持久化。

### 3. API 内部模型代理

- API 进程是唯一持有 provider key 的在线进程（env 或 `model_configs`）。
- 新增 `/internal/model/configs/:id/<openai-path>` 与 `/internal/model/default/<openai-path>`：
  - 校验 `MODEL_PROXY_TOKEN`（Bearer 或 `x-model-proxy-token`）；
  - 解析 model config / env fallback；
  - 把 `developer` role 规范为 `system`（兼容 DeepSeek）；
  - 注入 provider key、流式转发上游响应；不记录 prompt/key。
- Worker/executor/planner 只得到代理 URL + scoped token；provider key 不再进入 executor/Agent/planner env。
- DB model key 仍为明文存储（ADR-0011 的用户决定未改变）；模型代理将 key 的在线暴露面收窄到 API。

### 4. 删除 proxy_denials 全局审计

- `proxy_denials` 没有 mission 外键，无法满足项目级删除；移除表、proxy 持久化、Web 拦截页、API `/api/denials*`、指标中的 denial 字段和 watchdog denial-spike 规则。
- 越界请求仍在 proxy 被 403 阻断（网络边界不变）；成功目标流量继续写 `proxy_traffic`。
- 迁移 `0006-drop-global-proxy-denials.sql` 删除旧表；指标目录由 13 项变为 12 项（移除 `policy_denial_rate`）。

## 代价与残余

- 删除全局 denial 审计后，越界尝试只体现在 403 响应和代理日志，不再有可查询的全局表；这是为了满足项目删除的完整性要求。
- Worker 仍可读 `/runs` 运行目录（不是数据库）；executor 仍持有 scoped model-proxy token，可消耗该模型配额但不能读取 provider key。
- Planner 仍直接访问 DB（它需要快照/事务 apply），但无 provider key。
- Dispatcher 曾是单点 controller；2026-11-11 ADR-0025 增加多副本 + advisory-lock leader 选主（数据库仍单点）。

## 验证

- Worker 容器无 PG env/network；dispatcher 是唯一 controller DB writer。
- 任务、summary、planner smoke 均经 executor/模型代理成功执行。
- `pnpm run verify`、API smoke、mission-context、mission-completion、multi-worker-plan、watchdog、model-config smoke。
- 完整 e2e 172/0（含 dispatcher、executor、summary、模型代理、direct-egress 反向检查）。
