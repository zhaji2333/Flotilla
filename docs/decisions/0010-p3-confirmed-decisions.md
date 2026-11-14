# ADR-0010：P3 剩余决策确认（M2 开工基线）

- 状态：已确认（2026-11-08，用户逐项拍板）
- 关联：P3 计划 `docs/plans/p3-implementation-plan.md`、ADR-0008/0009
- 影响：M2（B1 黑板 + A/B）、M3（B2/A4）、M4（B3/B4/A3）、M5（B5/B6/A6）

## 背景

P3 计划第 8 节列出 4 个待拍板项，M1 又新增若干契约/安全口径。用户于 2026-11-08 逐项确认，本文固化，后续开发不再重复询问。

## 已确认决策

### 1. 十三指标（P3-A2）——签字认可

- 接受 M1 已实现的 13 项：validated_findings、validation_rate、review_rate、false_positive_rate、duplicate_intent_rate、evidence_depth、time_to_first_fact_seconds、stuck_rate、policy_denial_rate、task_success_rate、task_retry_rate、handback_rate、tokens_per_validated_finding。
- `value=null` 表示 N/A；旧 `rates.*` 字段保留到 P3 结束。

### 2. M2 A/B 评测口径——认可建议

- 用例：`evals/` fixture 的 3–4 个任务（SSRF/LFI 等确定性正例）。
- 对照：同一任务「带 frontier 注入 / 不带 frontier 注入」各跑 2–3 次。
- 判定：**artifacts 不下降且 tokens 降 ≥15%**，或 **artifacts 净提升**，才算黑板有效；否则 B1 停在读模型，不投入 B3/B5。
- 评测产物落结构化 JSON（`evals/blackboard/`），不把生成物当数据库事实源。

### 3. 黑板凭据/敏感事实——**明文存储**（用户明确要求）

- `mission_facts` 读模型中的 credential 类事实**保存明文 secret**（落 PostgreSQL；写路径为 Worker `insert_assets type=credential`，经 assets 权威表派生）。
- 用户明确覆盖“只存脱敏/引用”的保守方案；实现按明文执行，并接受以下风险与补偿：
  - 目标：数据库/备份/快照的访问控制成为唯一保护边界；生产部署需磁盘加密与备份加密（部署侧责任）。
  - 模型：Planner 的 frontier 注入会包含明文凭据，等同于发送给模型 provider（`LLM_BASE_URL`）。这是使用明文黑板的直接代价。
  - API：`/api/missions/:id/facts` 在 Bearer 鉴权后返回明文；前端默认折叠/遮罩显示，点击可展开（UI 责任，后端不额外脱敏）。
  - 审计：credential 事实带 `provenance=worker_asset`、`trust=inferred`，可追溯到 task/asset；不进入跨 mission 查询。
- 不同 mission 之间永不返回凭据事实；跨 mission 事实/情报传递被禁止（见第 7 条）。

### 4. 模型 tier（M3/B2）——单模型 + 后续配置模块

- P3 内 scout/executor/specialist 暂定都使用 `deepseek-flash`（同一 `LLM_BASE_URL`/key）。
- 后续新增**模型配置模块**（M3 扩展）：集中配置 key、base_url、model_name（含按 role/tier 覆盖），作为 P3-B2 的一部分实现；不引入硬性成本上限。
- 无 tier 配置时行为与当前完全一致。

### 5. 冻结用例库（M3/A4）——认可建议

- 先冻结现有：144 证据闸矩阵 + 48 路由场景 + eval fixture 正例/假点/越界/注入。
- 人工确证真实案例作为后续增量；合成矩阵不伪装成人工确证（`source=generated`）。
- 版本号固定；规则变更必须跑冻结集（CI/本地门禁）。

### 6. A1 形态——不加 Harness `trace_search` 工具

- 保持控制面注入（ADR-0008）；不向 Worker 开放内部读库/检索接口。后续若需要，另立 ADR。

### 7. B3 intel transfer——**不跨 mission**

- 用户明确：不能跨 mission。P3 内 intel/fact 只在同一 mission 内可见；跨 mission 自动/审批路径均不实现。
- 同 mission 内是否允许 task→task 自动提示，留到 M4 实现时按“不跨 mission、可审计、不改变授权”原则再细化；默认不新增跨任务自动 hint。

### 8. B4 angle——采纳默认

- 枚举：web/api/infra/binary；同 mission 最多 2 个并行 angle；Planner 不得自动创建并行 angle，必须人工/Planner 显式且受并发上限约束。
- fingerprint 加入 angle；Curator 仍按 root cause 合并。

### 9. B5 portfolio commander——采纳默认（M5、默认关闭）

- 本期做 bounded 版本但默认 feature flag 关闭；只能 allocate/hire/fire/park，不改 Grant/scope；动作事务化 + 审计 + 人工可查。

### 10. B6 保活——采纳默认（单 key）

- 暂无多 key：只做单 key 指数退避 + storm guard；不实现 key pool。429/进程崩溃重试上限沿用现有 runtime_crash/retry 语义并加可观测计数。

### 11. A3/A6——P3 内交付后端接口 + 前端文档

- A3：探索图读投影 + digest 折叠（>150 节点）后端接口/纯函数，交付前端契约与手交文档；UI 由前端 Agent 实现。
- A6：eval 历史/replay/指标合并的只读后端接口（结构化 JSON 索引），交付前端契约与手交文档；UI 由前端 Agent 实现。

## 后果

- M2 可以直接开工：B1 数据模型（派生视图/读模型，凭据明文）、facts/frontier/recall API、Planner frontier 注入、A/B 脚本。
- M3 增加模型配置模块；B2 的 role/tier 路由复用该配置。
- 后续前端 Agent 需要消费：facts/frontier/recall API、门闩 UI（凭据折叠）、A3/A6 接口。
- 与原始“最小化敏感数据”原则的偏离已由用户明确授权，记录在此 ADR；后续如需收紧，以新 ADR 取代。
