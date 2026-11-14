# ADR-0013：M4 — 同 mission intel、angle 并行、探索图投影

- 状态：已实施（2026-11-08）
- 关联：P3-B3 / P3-B4 / P3-A3；用户 2026-11-08 确认 B3 不跨 mission、B4 默认口径、A3 交付后端接口 + 前端文档
- 相关代码：`packages/contracts/src/db/schema.sql`（`tasks.angle`）、`packages/orchestrator/src/planner/*`、`packages/control-plane/src/repositories/{intel,explore-graph}-repository.ts`、`packages/api/src/server.ts`、`packages/web/src/app/api/missions/[id]/{intel,explore-graph}/`

## 背景

M4 原计划三项：B3 intel transfer、B4 angle 多角度、A3 探索图 digest。用户已明确：

- B3 **不能跨 mission**（同 mission 内只读 intel，不新增跨任务自动 hint）；
- B4 angle 枚举 web/api/infra/binary，同 mission 最多 2 个并行 angle，Planner 不自动创建；
- A3 在 P3 内交付后端接口 + 前端文档（UI 由前端 Agent 实现）。

## 决策

### 1. B4 angle（`tasks.angle`）

- 新增可空列 `tasks.angle`；Planner `create_task` 可选 `angle`（web/api/infra/binary），apply 事务写入。
- 任务 fingerprint 加入 angle：相同 objective+target 但不同 angle 允许并行；同 angle 仍去重（scheduler 的 fingerprint 冲突逻辑无需改 SQL）。
- 并发保护：apply 前统计该 mission 未终态任务的 distinct angle；新增 angle 若使 distinct >2，Plan 拒绝（`PlannerPlanError`），旧计划已应用部分回滚。
- Worker assignment 显示 `TASK ANGLE`，用于提示保持在指定角度；不影响 scope/Grant。

### 2. B3 同 mission intel（只读）

- `GET /api/missions/:id/intel`：accepted findings → technique/artifact intel；黑板 credential facts → credential intel（明文、`sensitive=true`）。
- 只查询当前 mission；**没有跨 mission 路径、没有自动跨任务 hint**。跨 mission 查询不会发生（其它 mission 的 API 不会返回本 mission 数据）。
- 数据来源为权威表派生，不新增写路径/事实源。

### 3. A3 探索图读投影 + digest 折叠

- `GET /api/missions/:id/explore-graph?threshold=150`：从 tasks + mission_facts 派生节点/边：
  - mission 根 → task（contains）；task → fact（produced）；无 task 的 fact → mission（observes）；同 finding 的 vuln → artifact（evidence_of）。
  - 节点只读，`version` 与 events max(seq) 对齐。
- 折叠纯函数 `foldExploreGraph(graph, threshold)`：节点超过阈值时按 `type:kind` 聚合为超节点（带 memberIds），所有原始节点进入且仅进入一个组/独立 mission 节点，边逐条重映射不丢弃 → 折叠前后 `original.nodes/edges` 守恒；测试覆盖。
- 当前 `explore_nodes/edges` 表保留给未来写入者，读取投影不依赖它们；后续有真实写入时可切换或合并。

## 安全与边界

- intel 明文凭据沿用 ADR-0010；前端默认遮罩。
- angle 只是执行角度提示，不改变 Grant/scope/Curator；同 angle 去重仍由 fingerprint 生效。
- 探索图只读派生，不写数据库；无新 egress。

## 验证

- 单测：`explore-graph.test.ts`（折叠守恒）、`plan.test.ts`（angle fingerprint/解析）。
- `blackboard-smoke.mjs`：intel 列表含 artifact+credential、graph 节点/边/版本、threshold 校验。
- `api-smoke.mjs`：intel/graph 路由与参数校验。
- e2e：mutation 后 graph/intel 不破坏主流程。
