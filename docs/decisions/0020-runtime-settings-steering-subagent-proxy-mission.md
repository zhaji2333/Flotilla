# ADR-0020：运行时设置全量生效、Executor 全双工 steering、Worker subagent 与 proxy mission 关联

- 状态：Accepted
- 日期：2026-11-10
- 关联：ADR-0011/0017/0018/0019

## 背景

审计发现五个具体缺口：

1. `runtime_settings` 只有 finding review/summary 从 DB 读取；Planner 并发/frontier、mission context、trace search、dedupe mode/TTL 仍读 module-load env，管理页“可调但无效”。
2. Worker 改为 executor-only 后，`inprocess` runtime 的 `pullHints`/`agent.steer()` 没有跨进程通道；生产路径只剩初始 hint，运行中 steering 实际失效。
3. Worker 精简 profile 停用了 subagent 工具，无法在单任务内拆独立侦察子代理。
4. `proxy_traffic` 是全局表，没有 mission 关联；项目删除不能清理自己的代理审计。
5. 新接口/内部协议缺少文档，前端和后续维护者只能读源码。

## 决策

### 1. runtime_settings 是唯一运行时策略源

- Planner 在每次 snapshot/apply 读取 `getRuntimeSettings()`：`planner.maxOpenTasks`、`planner.parallelTasks`、`planner.frontierEnabled`。
- Dispatcher 新增 `/internal/dispatch/runtime-settings`，Worker 在任务开始读取；用于 `missionContextEnabled`、`traceSearchEnabled`、`requestDedupeMode`。
- `mission-context` 由 dispatcher 读取 `requestDedupeTtlMinutes` 并传给 request-index 查询。
- UI/allowlist 不再有“可调但无效”的字段。
- 设置仍只在任务边界生效，不做 per-step 热切换；这是为了避免单任务中途改变安全/预算语义。

### 2. Executor 默认使用 isolated in-process runtime + 共享 hint 文件

- Worker 远程任务设置 `runtime=inprocess`（summary 仍 CLI）。
- Worker 在 task 运行期间持续 claim hint，追加到共享卷：
  `/runs/<taskId>/steering-hints-<attempt>.jsonl`
- Executor 从文件增量读取新行，传给 in-process runtime；runtime child 调用 `agent.steer()` 在下一个模型轮次注入。
- 每 attempt 一个文件，避免重试重复注入；文件由 worker/executor 清理。
- 该方案不新增 Worker→Dispatcher 以外的控制网络，不把 dispatcher token 交给 executor。

### 3. Worker 保留 subagent 工具

- `LEAN_DISABLED_PLUGINS` 不再包含 `subagent*`/`tool-subagent*`。
- subagent 继承当前 Worker 的 mission scope、proxy 与工具边界；prompt 要求整合子代理结果后再报告。
- 仍不启用 goal/workflow/plan-mode 等与单任务执行无关的插件。

### 4. proxy_traffic 以 mission_id 关联并级联删除

- 迁移 0007 增加 `mission_id UUID REFERENCES missions(id) ON DELETE CASCADE`。
- `http_request`/`web_fetch` 自动设置 `X-SRC-Mission-Id`；proxy 读取后**在转发前删除**，不泄露给目标。
- Bash 目标流量由 proxy 用 active mission 的 grant scope 反查 mission。
- 无法归属的 internet 流量保留 `mission_id=NULL`；仍审计，但不会被误删。
- 项目删除由 FK cascade 清理关联代理审计；不再需要全表扫描。

### 5. 文档

- 前端接口：`docs/api/frontend-api.md`。
- 内部接口（worker/dispatcher/executor/proxy）：`docs/api/internal-services.md`。

## 代价与边界

- In-process runtime 每个 executor job 启动独立 child；比 CLI 多一次 Node 启动，但保留了崩溃隔离和 per-agent toolset。
- Hint 文件是共享卷上的追加文件，依赖 worker/executor 同一 `/runs` 卷；这是现有部署前提。
- 归属只覆盖 target scope 与显式 header；无 header 的 bash internet 流量仍无 mission。
- 设置仍不做 per-step 动态调整；运行中变化只影响下一任务/下一轮 Planner。
