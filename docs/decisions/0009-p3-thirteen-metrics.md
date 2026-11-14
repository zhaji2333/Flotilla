# ADR-0009：P3-A2 十三项指标目录与口径

- 状态：已实施（2026-11-07）
- 关联：P3 计划 A2；P2 metrics v1（ADR-0006）；API 契约 `docs/api/frontend-api.md`、`openapi.yaml`
- 相关代码：`packages/control-plane/src/repositories/read-repository.ts`（`buildMetricsSummary` / `getMetrics`）

## 背景

P2 metrics v1 只有一组固定字段（有效发现、复核/验证率、Stuck/Denial 率、TTFF、平均时长）和若干计数，架构文档要求"十三节指标可持续度量"，但 13 项具体口径从未写死。不同人问"误报率/成本/重试率"时没有唯一答案，前端也不敢自行计算。P3-A2 的目标是把指标变成**有目录、有公式、有 N/A 语义、可由 PostgreSQL 聚合**的契约。

## 决策

1. **固定 13 项目录（ADR-0019 删除 policy_denial_rate 后为 12 项）**，顺序稳定，作为 `metrics.indicators[]` 返回；前端遍历渲染，不自行算比率。每项含 `id/group/label/unit/definition/value/numerator/denominator`。
2. **`value=null` 表示 N/A**（分母为 0 / 无数据），不是 0。旧 `rates.*` 字段保留数字语义（分母空时为 0）以兼容旧看板；新 UI 用 `indicators`。
3. **成本是 token 代理，不是金额**：不设 token/成本上限（ADR-0005），只统计 Harness 累计 token 用量与单位验证成本。

### 13 项口径

| # | id | group | unit | 公式/口径 | 数据来源 |
|---|---|---|---|---|---|
| 1 | `validated_findings` | quality | count | status=accepted 且 `evidence_ids` 长度 ≥2 | findings |
| 2 | `validation_rate` | quality | ratio | validated / findings.total | findings |
| 3 | `review_rate` | quality | ratio | needs_review / findings.total | findings.status |
| 4 | `false_positive_rate` | quality | ratio | rejected / (accepted + rejected)；排除待复核 | findings.status |
| 5 | `duplicate_intent_rate` | quality | ratio | merged / (accepted + merged) | findings.merged_count |
| 6 | `evidence_depth` | quality | ratio | accepted finding 的 evidence 引用总数 / accepted 数 | findings.evidence_ids |
| 7 | `time_to_first_fact_seconds` | efficiency | seconds | 每个有 finding 的 mission：首 finding 时间 - mission 创建时间，取平均 | missions + findings |
| 8 | `stuck_rate` | safety | ratio | running/leased 且 started_at < now()-15min / tasks.total | tasks |
| 9 | ~~`policy_denial_rate`~~ | safety | ratio | 已由 ADR-0019 删除（原全局 denial 表无 mission 外键） | — |
| 10 | `task_success_rate` | efficiency | ratio | done / (done + failed + exhausted)；人工 cancelled 不计入分母 | tasks.state |
| 11 | `task_retry_rate` | efficiency | ratio | attempt>1 / attempt>0 的任务 | tasks.attempt |
| 12 | `handback_rate` | control | ratio | handed_back / attempt>0 的任务 | tasks.state |
| 13 | `tokens_per_validated_finding` | efficiency | tokens | worker_reports 累计 token 用量 / validated findings | worker_reports.report.tokens |

token 取值优先 `tokens.total`（Harness 累计用量），缺失时回退 `input+output`；所有分母为 0 时 `value=null`。

## 安全与数据边界

- 只读 PostgreSQL 投影/事件，不接受模型自报的任何"指标"。
- 不新增写路径、不改变调度；指标不用于自动降级或预算熔断（用户明确不要硬成本上限）。
- `worker_reports` 只取 token 数学字段，不读取报告正文。

## 备选与取舍

| 方案 | 结论 |
|---|---|
| 前端自行从各接口算 13 项 | 口径漂移、每页各算一遍；否决。 |
| 引入 Prometheus/外部时序库 | 当前单实例、P3 目标只是可持续度量；PostgreSQL 足够，避免新基础设施。 |
| 用金额成本 | 模型单价会变、无账单口径；只用 token 代理并明确标注。 |

## 验证

- 单测 `packages/control-plane/src/repositories/read-repository.test.ts`：固定 13 项/顺序、公式、N/A 语义、cancelled 不进成功率分母。
- `scripts/api-smoke.mjs` / `scripts/e2e-test.mjs`：真实 DB 上 `indicators.length===13` 且 `value` 为 number 或 null。
- `pnpm run verify` 全绿（lint/typecheck/包测试/build）。

## 后果

- 指标契约冻结为 13 项；新增指标应走 v2 或追加字段，不改变既有顺序/含义。
- 看板 UI 由前端 Agent 消费 `indicators`；旧字段至少保留到前端完全切换。
