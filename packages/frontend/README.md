# Flotilla Frontend (independent SPA)

面向冻结的 v1 前端 API 契约（[`docs/api/frontend-api.md`](../../docs/api/frontend-api.md)、[`docs/api/openapi.yaml`](../../docs/api/openapi.yaml)）的独立单页应用。它只通过 HTTP/SSE 消费控制面数据，不导入后端代码、不接触 PostgreSQL / Worker / 代理内部接口。

> 交接文档：[HANDOFF.md](HANDOFF.md)（必读顺序、范围、当前状态、鉴权/部署约定、验收清单）。
> 当前契约：[frontend-api.md](../../docs/api/frontend-api.md) + [openapi.yaml](../../docs/api/openapi.yaml)。

## 技术栈

- Vite 7 + React 19 + TypeScript strict
- Tailwind CSS v4（`@theme` design tokens）+ Radix Primitives（Dialog / Tabs / Tooltip）
- motion（页面进入与微交互）canvas 交互背景（尊重 `prefers-reduced-motion`）
- Lucide 图标；界面无表情符号
- 字体：Futura / Novecento Wide / 思源黑体（Source Han Sans）无衬线栈，技术正文使用等宽字体

## 设计语言

- 深黑画布（`#06070a`）+ 象牙纸色 + 信号荧光绿（`#d7ff3f`）+ 危险橙（`#ff5a2b`）
- 编辑式超大标题、细线网格、编号章节、实时 marquee、物理过渡
- 状态始终「中文 (english)」双语标注；颜色之外同时用图标/文字表达状态（无障碍）
- 只读投影 + 人工动作：新建任务、暂停/恢复、提示、审批决策；所有按钮有 pending/error/empty 状态

## 页面与契约映射

| 页面 | 路由 | 端点 |
|---|---|---|
| 登录 | `/login` | `/api/auth/login`、`/api/auth/me` |
| 总览 | `/` | health / missions / findings / approvals |
| 项目列表 | `/missions` | `GET /api/missions` |
| 新建项目 | `/missions/new` | `POST /api/missions`（JSON 或 multipart：目标 / 附件模式 + 最多 20 个文件） |
| 项目概览 | `/missions/:id/overview` | `GET /api/missions/:id/overview?maxChars=` |
| 项目详情 | `/missions/:id` | `GET /api/missions/:id` + SSE `/api/missions/:id/stream`；样本 Tab 使用 `/api/missions/:id/artifacts` |
| 执行轨迹 | `/trace/:subjectType/:subjectId` | `GET /api/traces` |
| 发现列表/详情 | `/findings`、`/findings/:id` | findings + evidence |
| 审批中心 | `/approvals` | `GET/POST /api/approvals` + decide |
| 指标看板 | `/?view=metrics` | `GET /api/metrics`（12 项 indicators） |
| 项目依赖图 | `/missions/:id/dag` | `GET /api/missions/:id` 的 `tasks[].dependsOn` / `angle`（前端布局） |
| 线索板 | `/missions/:id/board` | `GET /api/missions/:id/board` |
| 黑板 | `/missions/:id/blackboard` | `/facts` + `/frontier` + `/recall` + `/intel` |
| 探索图 | `/missions/:id/explore` | `GET /api/missions/:id/explore-graph?threshold=` |
| 资产图 | `/missions/:id/assets` | `GET /api/missions/:id/assets/graph` |
| 轨迹检索 | `/missions/:id/traces` | `GET /api/missions/:id/worker-traces/search` |
| 评测与回放 | `/settings/evals` | `GET /api/evals/dashboard`（设置子页） |
| 任务详情-授权升级 | `/missions/:id`（审批 Tab） | `POST /api/missions/:id/scope-upgrade` |
| 运行时设置 | `/settings/runtime` | `/api/admin/settings` + artifact TTL GC（admin） |
| 账号安全（主动改密） | `/settings/account` | `POST /api/auth/password` |
| 首次登录强制改密 | `/change-password` | `POST /api/auth/password`（`mustChangePassword=true` 时自动进入） |
| Watchdog 看板 | `/settings/watchdog` | `GET /api/admin/watchdog`（admin） |

## 开发与构建

```bash
# 本地开发：直连独立 API（accounts 登录走 /login；VITE_API_TOKEN 仅自动化联调用）
VITE_API_BASE_URL=http://127.0.0.1:3001 VITE_API_TOKEN=dev-admin-token pnpm --filter @src-agent/frontend dev

# Docker Compose 中 nginx 同源代理到 api:3001；浏览器用会话 cookie 登录，
# 不注入服务 token（API_LEGACY_TOKEN 默认空，仅无 Sec-Fetch-* 的自动化兜底）。

pnpm --filter @src-agent/frontend test        # vitest（布局/展示映射）
pnpm --filter @src-agent/frontend typecheck
pnpm --filter @src-agent/frontend lint
pnpm --filter @src-agent/frontend build       # 静态产物 dist/
```

Docker Compose 中 `frontend` 服务用 nginx 提供静态页面，并将 `/api` 反向代理到 `api:3001`（会话 cookie 透传、SSE 不缓冲），浏览器保持同源：

```bash
docker compose up -d frontend
# http://127.0.0.1:5173
```

## P3 M2 / M3 视图

- **黑板（任务详情 → 黑板）**：`/api/missions/:id/facts` 按 kind 分组展示事实；`frontier` 展示开放 intent 与高信号事实/计数；`recall` 提供同 mission 检索。凭据明文默认遮罩，仅本页内存「显示」，不写 URL/存储；事实/证据只读，不能作为 Grant/scope 依据。
- **设置 → 模型配置（`/settings/models`）**：先尝试当前会话 token（后端未配置 `API_ADMIN_TOKEN` 的 dev fallback）；若后端要求 admin token 则显示 token 输入（仅页面内存，不写 localStorage/sessionStorage/URL）。支持列表（掩码 key）、新建/编辑、设默认、删除、reveal（二次确认 + 30 秒自动隐藏 + 审计）与审计列表；新建/编辑弹窗和列表行支持测试连接（inline 展示 latency/model/error，不写库、不写审计、不切换默认）；不显示明文 key，不做 role/tier 路由计算。模型 key 明文落库是 ADR-0011 的明确取舍，列表/审计永不返回明文。

## Flotilla 品牌

- 产品名：**Flotilla — 自主渗透测试平台 / Flotilla — Autonomous Security Research Platform**。
- 页面标题、侧栏、登录、页头与页脚统一使用 Flotilla；登录页不暴露初始化管理员入口。

## P3 M5 视图

- **项目概览 `/missions/:id/overview`**：`/overview` 有界聚合，展示任务/事实/发现/提示/待办/资产覆盖/运行用量/轨迹摘要；默认请求 API 最大概览预算，敏感事实默认遮罩；若仍 `truncated` 会引导打开对应明细页。
- **资产图 `/missions/:id/assets`**：资产/任务/发现/证据分层图 + 覆盖度；credential 资产 label 默认遮罩，未覆盖资产弱化标「未测」。
- **轨迹检索 `/missions/:id/traces`**：`/worker-traces/search` 同项目检索，展示 tool/method/url/command/status/summary；全部结果标 `untrusted`，不展示原始 body。
- **评测与回放 `/settings/evals`**：设置子页（admin/开发分析）；`/evals/dashboard` 最新 eval、12 指标快照与 events replay 摘要；空历史合法。
- 任务详情顶部导航加入项目概览 / 资产图 / 轨迹检索；提示队列展示 guidance/help/report 徽标。

## P1 1.7 手动控制视图

- DAG 页面底部的「写动作账本」读取 `/action-ledger`，支持按选中任务过滤；「人工控制审计」读取 `/steering`，展示 spawn_intent / cancel_task / confirm_retry。
- 写动作包含 method、url、status、task、observedAt 与 request hash，不展示请求正文。
- 手动派任务 / 取消 / 确认重试、暂停/恢复、提示、审批决策、授权升级按角色隐藏或只读：viewer 只读，operator 可任务/提示/finding review，admin 额外可 scope upgrade、模型配置、参数、账号与项目删除。

## P3 M4 视图

- **任务依赖图 `/missions/:id/dag`**：完整 DAG + 任务清单，`tasks[].angle` 徽标与角度筛选；节点选择后可直接打开 Worker 轨迹（返回时回到 DAG 并恢复 task）。
- **线索板 `/missions/:id/board`**：独立整页展示八节只读投影，大尺寸任务不再挤在 Tab 中。
- **黑板 `/missions/:id/blackboard`**：facts / frontier / recall + 同 mission intel（accepted technique/artifact + credential）；凭据默认遮罩。
- **探索图 `/missions/:id/explore`**：mission/task/fact 节点与 contains/produced/observes/evidence_of 边；支持 threshold 折叠超节点、成员 ID 查看与节点跳转。
- 任务概览 `/missions/:id` 保留待办/信号/审批/Planner/先验工作，并提供四个大视图入口。

## P3 M1 视图

- **指标页**：后端固定 12 项 `indicators` 目录（ADR-0019 后；原 13 项）（质量/效率/安全/控制分组），直接展示 `value`，`null` 显示 `N/A`，单位按 `count/ratio/seconds/tokens` 格式化；每项 tooltip 展示 `definition` 与分子/分母口径；成本区展示累计 token 与「tokens / validated finding」，明确标注为成本代理而非金额。
- **任务详情-先验工作**：调用 `GET /api/missions/:id/trace-summaries`，展示 totals、已尝试任务明细、工具/SKILL 统计、可折叠 `digest`（Worker 实际看到的注入文本，标注不可信）；无记录时为空态。
- **轨迹页**：`context` 且 `payload.source=prior_work` 的事件渲染为「先验工作注入」高亮卡片，与 hint/上下文注入区分，折叠可展开原文。

## 交互约定

- **审批**：批准 / 拒绝为单击即时决策，不再要求填写理由或决策人；决策落库并写审计，409 时刷新列表。
- **发现档案**：主页面按 mission 显示任务摘要卡片（finding 数、严重度分布、任务筛选）；点击任务打开「任务发现详情」侧栏，按 10 条/页独立分页并显示「本页 10 / 共 12 findings」，不受全局归档分页影响；点击 finding 直接跳转 `/findings/:id?mission=<id>&page=<n>` 完整页面。finding 页提供「← 返回任务详情」与同任务「上一条 / 下一条」；上下文通过 URL 保留，返回时自动打开对应任务详情并恢复到原分页。
- **任务详情 DAG**：展示 Planner/手动控制的全部任务；`dependsOn` 用于布局。Planner 未运行时可能只有 bootstrap/手动任务，页面应显示当前 Planner 状态而不是假设节点数。
- **执行轨迹**：每页 100 条，提供首页/上一页/下一页/末页与页码；筛选后自动回到第 1 页。

## 鉴权

- 生产：`frontend` nginx 同源反代 `/api` 并注入鉴权头，浏览器 bundle 不含 token；SSE 由 nginx 代理。
- 开发：`VITE_API_BASE_URL` 指向 `http://127.0.0.1:3001`，`VITE_API_TOKEN` 仅开发模式附加；`streamUrl()` 在 dev 下带 `?token=`。
- 账号模式：启动时 `/api/auth/me` 返回 user/`authKind`/`authMode`/`csrfToken`；写请求带 `x-csrf-token`。legacy 模式也可使用服务 token。
- 生产构建不会嵌入 token：`DEV_TOKEN` 只在 `import.meta.env.DEV` 下取值，build 时静态消除。
- 401 统一显示「未授权」提示，不静默空列表。

## 无障碍

- 语义化 landmark、跳过导航链接、键盘可达的 DAG 节点与全部操作
- focus-visible 荧光描边；颜色不作为唯一状态信号
- loading / empty / error / disabled / pending 状态齐全
- 320px–1440px+ 响应式布局；移动端侧滑导航

## 契约纪律

- 只调用 v1 契约端点；忽略未知字段；不解析 checkpoint 业务语义
- 不猜测后端内部 ID 关系；枚举原值保留并叠加中文标签
- 契约破坏性变更走 `/api/v2`（见契约文档第 6 节）
