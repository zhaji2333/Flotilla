# 中文术语口径（黑板 / 线索板 / 模型配置）

> 目的：前端翻译前先对齐口径，避免同一英文词在不同页面出现不同译法。
> 原则：**枚举原值保留英文**（UI 显示为「中文 (english)」）；Worker / Planner / Harness / Curator / SKILL / 工具名 / URL / 请求包 / 指标原值不翻译；目标内容、证据正文、代码、日志一律不翻译。
> 本表为当前建议口径，如与页面文案冲突以本表为准；后续新增字段先补表再翻译。
> 状态（2026-11-08）：前端 SPA 已按本表完成黑板/线索板/模型配置/回放相关中文化；M4 的 intel/explore-graph/angle 与 M5 的 eval/概览/资产图/轨迹检索页面由前端实现时直接复用本表。

## 1. 线索板（Clue board）

| English | 中文（建议） | 说明 |
|---|---|---|
| Clue board | 线索板 | mission 的八节状态摘要，人类可读 |
| scope | 授权范围 | 目标、grant 版本、scope 配置 |
| assets | 资产 | 证据中出现的主机/资产 |
| facts | 事实摘要 | 注意：这里是 accepted findings 的摘要，**不是**黑板 typed facts；建议 UI 标「发现事实（摘要）」 |
| capabilities | 能力 | 已完成任务类型，表示“已经会做什么” |
| negatives | 负面线索 | 待复核发现 + blocked/stale/exhausted 任务；不建议译成“失败”，它包含未决信息 |
| findings | 发现 | accepted/needs_review 的 finding 列表 |
| todo | 待办 | Planner 的串行 Todo |
| evidence | 证据 | 计数、target/internet 分类、distinct URLs、trigger 统计 |
| version | 事件版本 | 当前 mission `events.max(seq)` |
| baseVersion | 基准版本 | 投影生成时的事件水位 |
| conflicts | 投影冲突 | 空数组 = 无冲突 |
| generatedAt | 生成时间 | ISO 时间 |

## 2. 黑板（Blackboard）

| English | 中文（建议） | 说明 |
|---|---|---|
| blackboard | 黑板 | typed 事实/意图读模型（不是第二事实源） |
| fact | 类型化事实 / 事实 | 统一用「事实」，需要区分时写「类型化事实」 |
| intent | 意图 | 未完成任务的“待办意图” |
| frontier | 可打点前沿 | 开放意图 + 高信号事实；不建议直译“边陲/前沿”而让人误解 |
| recall | 检索 | 对事实 key/value/summary 的子串搜索 |
| typed | 类型化 | 保留为技术说明，不单独出现在按钮上 |
| fact `kind` | 事实类型 | 值保留英文 |
| kind=credential | 凭据 | 明文存储，默认遮罩 |
| kind=vuln | 漏洞 | accepted finding 派生 |
| kind=artifact | 目标产物 | flag/flag-like artifact 派生 |
| kind=host | 主机 | 证据 URL 派生 |
| kind=endpoint | 端点 | 资产类型保留此译法 |
| kind=parameter | 参数 | |
| kind=technology | 技术栈 | |
| kind=identity | 身份/账号 | |
| kind=file | 文件 | |
| source=asset | 资产来源 | Worker `insert_assets` 记录 |
| source=finding | 发现来源 | accepted finding |
| source=finding_artifact | 发现产物来源 | artifact 事实 |
| source=evidence | 证据来源 | 代理证据 URL 派生 |
| provenance=worker_asset | Worker 资产 | 来源链 |
| provenance=accepted_finding | 已接受发现 | |
| provenance=proxy_evidence | 代理证据 | |
| trust=observed | 已观测 | 直接来自 accepted finding / 代理证据 |
| trust=inferred | 推断 | 来自 Worker 记录的资产 |
| trust=unverified | 未验证 | 预留 |
| sensitive | 敏感 | 仅 credential；UI 默认遮罩 |
| masked | 已遮罩 | 与 sensitive 配合 |
| reveal | 查看明文 | 需二次确认并留审计 |
| frontier.counts | 计数 | facts/intents/sensitiveFacts/byKind |
| byKind | 按类型统计 | |
| version | 事件版本 | 与 replay 对齐 |
| taskId | 来源任务 | 事实来自哪个 task |

## 3. 模型配置（Model configuration）

| English | 中文（建议） | 说明 |
|---|---|---|
| model config / model profile | 模型配置 / 配置档 | 页面名「模型配置」 |
| active | 生效中 | Worker/Planner 当前实际读取的配置 |
| default | 默认配置 | `isDefault`，至多一个 |
| role | 角色 | worker/planner/scout/executor/specialist/guard（命令门控） |
| tier | 层级 | default/fast/strong |
| baseUrl | 接口地址 | 可显示 `Base URL` 括注 |
| modelName | 模型名称 | |
| apiKey | API 密钥 | 列表只显示掩码 |
| apiKeyMasked | 掩码密钥 | 例如 `sk-a••••wxyz` |
| apiKeySet | 已配置密钥 | 布尔；不展示明文 |
| apiKeyEnv | 密钥环境变量名 | 内部字段，UI 可高级模式展示 |
| contextWindow | 上下文窗口 | token 数 |
| maxOutputTokens | 最大输出 | token 数 |
| reasoningEffort | 思考强度 | low/high/max |
| compat | 兼容参数 | JSON |
| enabled | 已启用 | |
| reveal | 查看明文 | 需 admin token + 二次确认 + 审计 |
| audit | 审计 | action=create/update/delete/reveal |
| admin token | 管理员令牌 | 仅存内存/sessionStorage，可清除 |
| masked list | 掩码列表 | 列表接口永不返回明文 |
| created/updatedAt | 创建时间/更新时间 | |

## 4. 回放与一致性

| English | 中文（建议） | 说明 |
|---|---|---|
| events replay | 事件回放校验 | 只读一致性自检 |
| toSeq | 目标事件序号 | |
| matchesCurrent | 与实时投影一致 | true = 事件流可重建当前状态 |
| diffs | 漂移差异 | 列出差异位置，不改数据 |
| current | 当前投影 | |
| replayed | 回放投影 | |
| grantVersion | 授权版本 | |
| idle in transaction | 事务空闲占用 | 仅内部告警/运维，不出现在普通 UI |

## 5. 单项目自主闭环（M5 修订）

| English | 中文（建议） | 说明 |
|---|---|---|
| project | 项目 | 代码字段仍叫 mission；单项目 ≠ 单任务 |
| project overview | 项目概览 | M5-1 只读聚合，Planner/Worker/前端共用 |
| mission brief | 任务简报 | claim 时注入 prompt 的压缩项目态势 |
| mission context | 项目上下文 | run-local JSON，供只读 mission 工具使用 |
| mission tools | 项目工具 | mission_brief/recall/frontier/fact/findings/worker traces/assets |
| worker trace search | Worker 轨迹检索 | 同项目、排除当前 task、结果 untrusted |
| worker traces | Worker 轨迹 | 工具/URL/结果摘要，不含原始 body |
| asset graph | 资产图 | 项目内资产 + task/finding/evidence 锚点 |
| coverage | 覆盖度 | 资产被 task/evidence/fact 引用的比例 |
| planner snapshot | 规划快照 | Planner 看到的项目态势 |
| update_todo | 更新待办 | Planner 维护计划链路状态 |
| concurrent tasks | 并发任务 | 无依赖的独立 Task 可并行；有依赖用 dependsOn |

## 6. 认证与 Watchdog（ADR-0038 / ADR-0039）

| English | 中文（建议） | 说明 |
|---|---|---|
| session login | 会话登录 | 浏览器默认登录方式；cookie + CSRF |
| must change password | 待改密码 / 强制改密 | 首次登录必须重设 ≥12 位强密码 |
| password_change_required | 需要先改密码 | 403 错误码，前端渲染改密页 |
| API_LEGACY_TOKEN | 旧版服务 token | 默认空；仅无 `Sec-Fetch-*` 头的自动化兜底 |
| watchdog | 看门狗 / Watchdog | 项目页直接用「Watchdog」；规则为只读观察者 |
| watchdog observation | Watchdog 观测 | 规则/LLM 判定“可能有问题”的一次记录 |
| watchdog trigger | Watchdog 触发器 | 展示在项目详情；route=direct |
| stalled task | 停滞任务 | running 超时且窗口内无 finding 也无 trace |
| stall streak | 连续停滞次数 | 达到 `WATCHDOG_ESCALATE_AFTER` 才升级 |
| escalation | 升级 | 写 planner signal + 人工复核 + escalation hint |
| planner signal | Planner 信号 | 批处理输入；`watchdog_stall` 表示停滞升级 |
| stalled_task approval | 停滞任务复核 | 批准=取消任务，拒绝=清 streak 继续 |
| hint effect | 提示效果 / 回采 | 提示后 10 分钟内是否出现新 finding 或新 URL |
| hit rate | 提示命中率 | progress /（progress + no_progress） |
| outcome=progress/no_progress | 有效果 / 无效果 | 回采结论，不是任务最终状态 |

## 7. 通用保留词

- **Worker / Planner / Harness / Curator / SKILL / MCP / token / sandbox / scope / grant** 保留英文；需要解释时用「中文（English）」。
- 状态值沿用 [frontend-api.md](frontend-api.md) 第 2 节的「中文 (english)」映射。
- 指标名用 `/api/metrics` 返回的 `label`（已是中文），不要逐页硬编码。
- 工具名（`http_request`、`insert_assets`…）、URL、原始请求包、证据正文、模型输出、代码块：**不翻译**。
