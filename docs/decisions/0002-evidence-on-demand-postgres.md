# ADR-0002：取消 MinIO，证据按需存 PostgreSQL

- 状态：已采纳（P0），取代早期架构文档中的 MinIO 流量存储
- 日期：2026-11-06
- 相关：[ADR-0001](0001-proxy-as-network-boundary.md)、`packages/contracts/src/db/schema.sql`、`packages/orchestrator/src/worker/executor.ts`

## 背景

原架构把“流量留痕”设计为 MinIO 对象存储 + PostgreSQL 元数据。实际跑 P0 靶场后发现：

- 全量流量包体积大、增长快，MinIO 让本地基础设施和安全边界都变臃肿；
- P0 真正需要的证据只是“证明漏洞的 baseline + proof 两条交换”；
- 引入对象存储后还要处理 bucket 初始化、失败回滚、凭据分发，与 P0 两周目标不成比例。

## 决策

1. 删除 MinIO 服务、`traffic_evidence` 表与对象存储依赖。
2. 出站代理只存**审计元数据**：方法、URL、状态码、请求/响应 SHA-256、字节数、时间、kind（`target`/`internet`）。
3. 目标流量正文只在 Worker `report_finding` 时按需落库：`evidence` 表保存被引用的 baseline+proof 全文与哈希，`UNIQUE (task_id, traffic_ref)` 幂等。
4. `web.fetch` 的互联网检索结果全部留痕到 `evidence`（`kind='internet'`, `untrusted=true`）。
5. 证据引用必须能被 Worker 解析为本任务真实记录过的 `traffic_id`；找不到即拒绝上报，不允许伪造 hash。

## 后果

- 零额外基础设施；证据量受“被上报的 Finding 数”约束，可审计且可回放。
- 代价：代理不保留全量流量，事后无法回放未上报的交换；如果 P1 需要全量回溯，应新增冷存储而不是把 MinIO 塞回控制面。
- 数据库 schema 因此仍是“全量、幂等”的单文件，worker 启动时应用，兼容旧开发库。
