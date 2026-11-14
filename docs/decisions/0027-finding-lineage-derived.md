# ADR-0027：Finding 血缘采用派生读模型

- 状态：Accepted
- 日期：2026-11-11
- 关联：ADR-0002、ADR-0012

## 背景

架构目标中的 Finding 血缘需要递归展示 proves/based_on 链并复用探索图。当前数据库没有单独的 lineage 表；finding 已有 root_cause_key、superseded_by、task_id、evidence_ids，证据是唯一事实源。

## 决策

- **不新增第二事实源表**；新增只读派生 API：
  `GET /api/findings/:id/lineage`。
- 节点来自：
  - finding 本体；
  - `task_id` 对应的 producing task；
  - `evidence_ids` 对应的证据节点（traffic_ref/method/url/untrusted）；
  - `superseded_by` 链（同 mission，最多 20）；
  - 同 mission 中共享 evidence 的其他 finding（最多 25）。
- 边类型：`produced_by`、`supported_by`、`superseded_by`、`shares_evidence`。
- 所有查询必须带 mission_id 约束；不跨 mission，不返回原始请求/响应正文。
- 前端 finding 详情页展示「发现血缘」：关联 finding、producing task、证据节点计数、superseded 提示。
- 不提供编辑/删除 lineage；它是可重建投影。

## 边界

- 证据共享不等于逻辑证明；`shares_evidence` 是线索，不是因果结论。
- superseded 链最多 20 层，相关 finding 最多 25 个，节点最多 120 个。
- 架构中的完整 proves/based_on 语义需要未来显式 schema 扩展；当前以证据和 superseded 关系近似。

## 验证

- `GET /api/findings/:id/lineage` 返回同 mission 节点/边；
- 共享证据的 finding 出现 `shares_evidence`；
- 不同 mission 的 finding/evidence 不出现；
- 前端 typecheck/build 通过。
