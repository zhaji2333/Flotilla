# ADR-0006：P2 证据闭环（六道闸/去重/Grant 升级/回放/指标/策略门限）

- 状态：已实施（2026-11-07）
- 承接：ADR-0002（证据落 PostgreSQL）、ADR-0005（执行面与审计边界）
- 目标：假点进不了报告；重复 Finding 自动合并；越界可审批升 Grant；一切可回放；指标可持续度量。

## 1. Curator 六道证据闸（控制面权威）

插件里仍先跑一次 curate() 给模型即时反馈，但**接受与否由控制面重新裁决**：worker 在 `finishTask` 事务里用持久化后的 evidence 重新执行同一套闸门，插件不可信。

| 闸 | 机械检查 |
|---|---|
| baseline+proof | ≥2 条不同 traffic；哈希必须与真实 evidence 一致；baseline/proof 请求不能完全相同 |
| 匿名闸 | `claimsAnonymous` 时请求包中不得出现 Authorization/Cookie/X-API-Key 等认证头 |
| 认钥闸 | `isCredentialLeak` 需 ≥3 条证据、至少两个不同凭据值（false value 对照组），且响应可区分 |
| 定级闸 | high/critical 需要可观察差异（baseline/proof 响应哈希不同）或产物（FLAG/secret）证明 |
| 禁写闸 | 私钥/AWS Key/SSN/银行卡/破坏性命令/DoS 标题/超长报告 → review |
| 复现包闸 | evidence 必须有请求/响应正文、完整 SHA-256；target 流量原始请求包必须含 Host 头 |

不通过 → `needs_review`（不再静默丢弃），并自动生成 pending `approvals(type='finding_review')`，人工批准后转 accepted、拒绝则转 rejected（审计事件 `finding.reviewed`）。

## 2. 去重 / 置信度 / supersedes

- `root_cause_key = sha256(category | normalized(title) | host + normalized(path))`；`(mission_id, root_cause_key)` 唯一。
- 重复 finding 在同一事务内合并：severity 取高、status accepted 优先、evidence_ids 并集、merged_count+1、`finding.merged` 事件；不产生重复行。
- `confidence`：observed（有产物或 baseline/proof 响应差异）/ inferred（只有描述性证据）/ unverified（未过闸）。
- `superseded_by` 列预留，供后续人工确认新 finding 取代旧 finding 时使用（P3 血缘视图）。

## 3. Grant 版本化与升级审批

- 审批行 `scope_upgrade` payload 带 `scopeExtras`（来自 URL/IP/域名派生）。
- 批准后事务：同 grant id 插入 version+1 的新 Grants 行 → 更新 mission.grant_version → 重绑所有 open/retry_wait/blocked tasks 的 grant 版本 → `grant.upgraded` 事件；approval.payload 记录 `appliedGrantVersion` 防重复应用。
- 入口：任务页「申请授权升级」或拦截记录「一键申请升级」（按 URL host 匹配最近活跃 mission）；审批中心批准即生效，proxy DB scope provider 在刷新周期内加载新 scope。
- `finding_review` 审批走复核闭环，不修改 Grant。

## 4. 线索板（board）

- `GET /api/missions/:id/board` 返回八节投影：scope / assets / facts / capabilities / negatives / findings / todo / evidence；版本等于 mission 最大事件 seq，并给出 baseVersion 与 conflicts；`/missions/:id/board` 只读渲染。
- 投影是权威表的派生读模型（事件序列一致）；P3 若引入 P4 蒸馏线索板，再升级为物化投影（单写者 + base_version 三向合并）。

## 5. events 回放

- 新增 `task.created`（mission 创建/Planner 建 task）与 `task.<state>` 终态事件；`GET /api/missions/:id/replay?toSeq=N` 按 seq 重放 mission/task/grant 状态并与实时投影比较，`matchesCurrent` + `diffs` 暴露写路径漏事件。
- 当前回放范围：mission state / task state / grant version（核心审计投影）；findings/evidence 由数据库事务保证，P3 若要求全事件溯源再扩展。

## 6. 指标看板 v1

`GET /api/metrics` + `/metrics`：Validated Findings、复核率、验证率、重复合并率、Stuck Rate、Time to First Fact、平均任务时长、Policy Denial Rate、证据/拦截计数，全部由 PostgreSQL 投影聚合。

## 7. P2 策略门限（EGRESS_MODE=policy）

- `scope`：默认，target grant + `INTERNET_ALLOWLIST`。
- `policy`：在 scope 语义上增加每 host 每分钟请求上限（`POLICY_RATE_LIMIT_PER_MIN`，默认 120，0=不限）；超限返回 429 平台管控信封并记录 `proxy_denials(kind='policy_denied')`（该全局表后于 ADR-0019 删除）。
- `open`：临时全放行（用户显式指定；仍审计），仅供授权靶场调试。P2 完成后默认推荐 `policy`，`open` 不应长期开启。
- 插件 `http_request` 仍做客户端 scope 检查；`open` 时跳过客户端检查，`policy` 时保留。

## 8. P2.6 技能质量评测 v1

- `evals/skills/cases.json`：覆盖 16 个 pack 的 32 个路由场景（每个 pack ≥2），由 ck-router 30 秒分诊表派生。
- `scripts/skills-eval.mjs`：
  - 静态审计：manifest/目录一致、frontmatter 与描述、每 pack ≤8KB、ck-router 覆盖全部 pack、rules 目录、用例覆盖；
  - 轨迹指标：worker 运行数、skill 调用覆盖率、调用成功率、首调 ck-router 率、加载过的 pack（来自 `task_trace`）；
  - `--live`：停 resident worker，起一个隔离 Harness run 读 ck-router 后对 32 场景输出路由 JSON，与期望比对。
- **实测**：静态审计全绿；实时路由 **32/32 = 100%**；历史轨迹含 CkSKILLS 打包修复前的失败调用，因此成功率指标从修复后开始会更有意义（下一步做带技能/不带技能效果对照时按时间窗口过滤）。
- **证据闸语料 v1**：`evals/curator/cases.json`（12 cases：positive/fake_point/out_of_scope/injection，覆盖六道闸）由 `packages/curator/src/eval-cases.test.ts` 常驻执行；带技能/不带技能的 artifacts/steps/tokens 效果对照见 `scripts/skills-effect-eval.mjs`：小样本 SSRF 10→19 steps、128K→281K tokens（技能明显加速），LFI 基本持平略增，需扩大样本。
- 后续：每个 pack 的“3 正 + 3 假点 + 2 越界 + 1 注入”完整矩阵。

## 9. 验证

- Curator 单测覆盖六闸、confidence、root key、伪造证据；控制面重审 + 合并集成通过 e2e。
- e2e（open 模式，真实 LAN 靶场）：CkSKILLS 镜像、任务闭环、轨迹、board/replay/metrics/scope-upgrade 全链路。
- `pnpm run verify`（140+ tests + skills）与 `go test ./...`（含 policy 限速单测）。
