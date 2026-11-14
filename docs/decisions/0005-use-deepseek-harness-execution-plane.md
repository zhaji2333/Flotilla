# ADR-0005：执行面改用 DeepSeek Harness（取代 ADR-0003）

- 状态：已采纳（2026-11-06），取代 [ADR-0003](0003-generic-worker-executor.md)
- 相关：`docs/decisions/0003-generic-worker-executor.md`、`packages/orchestrator`、`deepseek-harness`（固定版本）、`dsh-superagent-prototype-main/`

## 背景

P0 为了让安全边界和证据闭环先跑通，用自研最小 agent loop（`llm.ts` + `worker/runner.ts`）代替了原架构中的 DeepSeek Harness。实测后确认：

- 自研 loop 重复实现了 Harness 已经成熟的能力：agent 调用/编排、工具协议、上下文编译与压缩、skills 加载、subagent、MCP 客户端、session 持久化、jobs/后台任务、模型路由与重试；
- 这些能力是后续 P1（多 Worker/Planner/steering）和 P2（回放/审批）的基础，自研版本会持续欠账；
- Harness 已发布可安装的 npm 包（`@deepseek-ai/dsh@0.2.2-rc.1`，Node >= 24.9），本地验证 `dsh --profile headless` 可一条命令完成“模型→工具→最终答案”的完整闭环（实测 `harness-ok`）。

## 决策

1. **执行面 = DeepSeek Harness**。Worker 不再实现 agent loop；由 Harness 负责模型调用、工具循环、上下文压缩、skills、subagent、MCP、session 持久化与恢复。
2. **控制面仍然是我们的**：Web 入口、mission/task/grant、PostgreSQL 状态与证据、目标授权（动态 scope）、出站代理、Curator 证据闸、审计、审批记录。Harness 不负责授权与证据真实性。
3. **集成方式（H1 起步）**：每个任务由 Worker 启动一次 `dsh --profile headless --json --patch <src-agent patch>` 一次性运行，任务结束即退出；跨轮 steering 通过 `--session-id` 恢复同一 Harness Session。Worker 负责 claim/租约/fencing/evidence/findings 落库。后续若需要常驻会话，可升级为官方 SDK（`@deepseek-ai/dsh-sdk-client`）并经 ADR 评审。
4. **自定义工具以 Harness 插件形式提供**：`packages/harness-plugin` 作为 Cordis bundle（`cordis.patch.yml`）挂载 `http_request`、`web_fetch`、`traffic_*`、`insert_assets`、`report_finding` 等工具；`bash`/文件/skill/todo/subagent 等直接使用 Harness 内置工具，不重复实现。
5. **证据与解锁**：`report_finding` 只接受本任务真实记录过的 traffic_id，由插件在 Harness 进程内校验并写入任务报告文件，Worker 退出后落库；授权仍由容器外 Go 代理兜底，Harness 内部工具不得绕过。
6. **版本固定**：Harness 依赖精确固定 `0.2.2-rc.1`（含 lockfile 与镜像内版本一致性）；Worker 镜像 Node 版本提升到 Node 24（Harness engines `>=24.9`）。升级 Harness 必须单独 ADR + e2e 回归。
7. **CkSKILLS 通过 Harness 的 skill 机制加载**（`dsh-skill-filesystem` 指向仓库 `skills/`），不再自研 SkillProvider。

## 后果

- 删除自研 `llm.ts` 工具循环与 `worker/runner.ts` 的上下文管理逻辑（保留任务编排/DB/安全部分）。
- Worker 镜像体积与构建时间增加（Harness 656 个包，安装后约 0.9GB）；CI 需 Node 24。
- 依赖 `0.2.2-rc.1` 是 RC 版本，存在 API 漂移风险；通过精确版本 + 锁定 lockfile + e2e 回归管理。
- Harness 的网络默认行为必须再包一层：容器出站仍只经代理（环境变量 + 代理 CA），自定义工具不旁路。
- P0 的 DB 协议、代理、Curator、Web 全部保留，Harness 只替换 L2 执行面；ADR-0001/0002/0004 不受影响。

## 验证记录（H0 spike）

- `npm i @deepseek-ai/dsh@0.2.2-rc.1`（npmmirror，656 包）成功，CLI `dsh --version` = `0.2.2-rc.1`。
- `DSH_HOME=/tmp/dsh-spike/home DEEPSEEK_API_KEY=… dsh --profile headless --json "Reply with exactly the word: harness-ok"` 返回 `harness-ok`，session 事件流正常（`session/status/thinking/text/final`）。
- 默认模型 `deepseek-official/deepseek-flash`（与项目选型一致）；DeepSeek 适配器走 Messages API（默认 base `https://api.deepseek.com/anthropic`），不要覆盖为 OpenAI 兼容根路径。
- headless profile 自带：bash、文件、web、skill（`dsh-skill-filesystem`）、compaction、subagent、todo；MCP 客户端可按 patch 启用。

## H1 验证记录（2026-11-06）

- Worker 镜像升级到 `node:24-bookworm-slim`，安装 `@deepseek-ai/dsh@0.2.2-rc.1`（npm mirror，585 个新增包），镜像约 2.8GB。
- `packages/harness-plugin` 以 Cordis bundle 形式挂载，用 esbuild 打包为 `dist/index.js`（Harness 以 plain ESM 加载，避免 tsx 与原生 addon 冲突），通过运行时生成的 patch 以绝对路径注入 headless profile。
- `node scripts/harness-smoke.mjs` 在 worker 镜像内验证通过：Harness headless 经代理调用 DeepSeek → 模型调用 `http_request` 记录两条目标流量 → `report_finding` 证据校验通过 → 任务报告文件写入，1 条 finding accepted、2 条 evidence 哈希与正文一致、报告符合 rules/40。
- 关键约束与坑：Node 24.9+；只读根文件系统需 `NARB_DISABLE_NATIVE_CACHE=1`（原生 addon 缓存不能写入）；Harness 插件 patch 的包名解析相对 profile 目录，运行时用绝对路径引用打包后的插件；DSH 依赖需要 zod 4，不能与我们的 zod 3 用全局 override 混用；DeepSeek 适配器走 Messages API（默认 `/anthropic`）。
- 下一步 H2：Worker 执行路径改为 `claim → dsh headless --json → 读报告 → finishTask`，删除自研工具循环。

## 模型接入：统一走 OpenAI 兼容协议（2026-11-06 补充）

- 使用 Harness 的 `@deepseek-ai/dsh-llm-pi-ai` 适配器 + `openai-completions` 协议，而不是 DSH 原生的 DeepSeek Messages 适配器。原因：大多数模型/gateway（DeepSeek、OpenAI、vLLM、各类中转）都提供 OpenAI Chat Completions 兼容接口，换模型只改 `LLM_BASE_URL`/`LLM_MODEL`，不改执行面代码。
- 环境变量约定：`LLM_BASE_URL`（OpenAI 兼容 base，如 `https://api.deepseek.com/v1`；无 `/v1` 时由 worker 归一化）、`LLM_API_KEY`、`LLM_MODEL`；Worker 运行时生成 profile patch，把 `llm-pi-ai.providers.<route>` 注入 headless profile，并把 `agent-default-model` 指向该 route。
- 已验证（host spike）：`api: openai-completions` + `baseURL: https://api.deepseek.com/v1` + `apiKeyEnv: DEEPSEEK_API_KEY` 跑通 headless（返回 `pi-ok`，含 usage）。DeepSeek 的 OpenAI 兼容端点直接可用。
- 若网关的 function calling/思考字段不标准，用 pi-ai 的 `compat`（如 `thinkingFormat`、`maxTokensField`）在 patch 里按网关微调；不在代码里写死。
- **模型容量与思考强度（部署要求）**：声明 `contextWindow = 1,000,000`（`LLM_CONTEXT_WINDOW`）、单次最大输出 `maxTokens = 393,216`（384K，`LLM_MAX_OUTPUT_TOKENS`）；DeepSeek thinking 默认开启且 `LLM_REASONING_EFFORT=max`，通过 `LLM_COMPAT_JSON={"thinkingFormat":"deepseek"}` + `LLM_REASONING_EFFORTS_JSON={"off":"none","high":"high","max":"max"}` 映射到 wire 参数。
- **明确不设任务级 token/成本上限**（2026-11-06 决策）：`contextWindow`/单次输出上限是模型能力声明；worker 只保留步数与墙钟安全限制（防挂死），token 用量仅记录用于观测/审计，不触发 kill。

## H2 验证记录（2026-11-06）

- `packages/orchestrator/src/harness/`：`config`（DSH/插件/模型 route 解析）、`patch`（运行时 profile patch：插件绝对路径、禁用内置 web/DeepSeek Messages、`llm-pi-ai` OpenAI 兼容 route）、`assignment`（任务→提示词）、`events`（NDJSON 解析/用量统计）、`report`（插件报告→evidence/findings）、`runner`（子进程 + 墙钟/步数安全限制 + 退出/报告处理）。
- Worker 主循环：`schedulerTick` → claim（fencing/租约）→ `markTaskRunning` + heartbeat → `runHarnessTask` → `finishTask`（证据/报告落库）。自研 LLM/工具循环已删除。
- Web 任务创建改为 `proposed` 状态，由 worker 的 readiness 提升为 `ready`（与 P1 状态机一致）。
- `scripts/harness-smoke.mjs`（runner 级）：通过。
- `scripts/e2e-test.mjs`（ARTEX 限制生效前，显式预算）：**54 通过 / 0 失败**。越界拦截（含容器内 curl）、拒绝审计、web.fetch untrusted + 全文留痕、证据哈希、rules/40、Web 投影全部通过；Worker 通过 Harness **自主拿到 4/4 flag**（26 步，约 59 万 tokens，session-e94b83d1…；thinking=max、上下文 1M、单次输出上限 384K）。
- 关键增益：开启 DeepSeek thinking（`compat.thinkingFormat=deepseek` + `reasoningEfforts` 映射 + `LLM_REASONING_EFFORT=max`）后，同一套 Harness 执行面从 2/4 提升到 4/4。
- 结论：执行面切换完成且可审计。下一步 H3：CkSKILLS skill packs 通过 `dsh-skill-filesystem` 接入 + worker 精简 agent preset；随后进入 P1 调度/Planner。

## 安全限制：直接采用 ARTEX 的超时配置（2026-11-06）

调研 ARTEX-0.3.15 后的结论与映射（0 = 不限制）：

| ARTEX 机制 | ARTEX 默认 | 我们的对应 |
|---|---|---|
| `agents.run_seconds` 单次 run 墙钟 | **1200s（20 分钟）**，可按 agent 配置，0=不限 | `TASK_MAX_WALL_CLOCK_MS` 默认 `1200000`，0=不限 |
| `agents.max_turns` 单次 run 步数 | **0 = 不限**（可配） | `TASK_MAX_STEPS` 默认 `0`（不限） |
| `tasks.timeout_seconds` 任务级 deadline | **0 = 不限**（可选） | mission 的 `maxWallClockMs`（可选；无则不限） |
| 有效单次预算 | `min(任务 deadline 剩余, run_seconds)`（`agent/taskclock.go`） | 有任务 deadline 时取剩余，否则用 run wall clock |
| 达到限制后的收尾 | settlement/wrap-up：注入收尾提示，**10 轮**预算，先落库事实/资产/finding 再总结；run 以 timeout/max_turns 结束，意图标记 exhausted（非失败）供 Planner 换方向 | **待实现（H2.1）**：当前直接结束；计划用 `dsh --session-id` 恢复会话执行收尾提示并限制 10 轮 |
| 单次回复输出上限 | `MaxTokens`，0=provider 默认 | `LLM_MAX_OUTPUT_TOKENS=393216`（384K，用户要求） |
| 任务累计 token/成本上限 | **无** | **无**（已移除） |

- 不设任务 token/成本上限；`run_seconds`/`max_turns`/task deadline 只是防挂死与可预测执行，不是成本闸门。
- e2e 不再指定步数/墙钟，直接使用上述默认值。

## H2 验收（ARTEX 限制生效后复测）

- `scripts/e2e-test.mjs`（ARTEX 限制生效）：**50 通过 / 0 失败**；Worker 经 Harness 自主拿到 **4/4 flag**（30 步，约 94 万 tokens，无步数上限，20 分钟 run wall clock 内完成）。
- H2.1/H2.2 后再测：**48 通过 / 0 失败**；4/4 flag（48 步，约 150 万 tokens）。另有 settlement 专项验证：`SMOKE_MAX_WALL_CLOCK_MS=8000` 强制首轮超时，断言 `settled=true`、`limitReason=run_timeout`、session 捕获成功。

## H2.1 收尾（settlement）与 H2.2 重试（借鉴 ARTEX + dsh-superagent）

### H2.1 超时/步数到限后的收尾
- **不再硬杀**：runner 对每次 Harness run 设墙钟/步数看门狗；到限先 `SIGTERM`，最多等 **10s**（superagent `KILL_WAIT_MS`）再 `SIGKILL`。
- **收尾 pass**：若首轮非正常完成且已拿到 Harness session id，则用 `dsh --session-id <same>` 追加一次收尾 run：ARTEX 风格提示（先把已识别内容落库、不再开新探测、最后一句总结），上限 **10 轮 / 120s**；结束后再统一读取报告。
- **跨进程可恢复**：每个 task 使用稳定 run 目录（`/tmp/src-agent-runs/<taskId>`）：patch、DSH_HOME（session 持久化）、report 文件都在其中。插件启动时从 report 文件**恢复既有 traffic/findings/assets**，因此收尾/重试进程仍能引用首轮产生的 `traffic_id` 并补报 finding。
- 验证：`harness-smoke.mjs` 以 `SMOKE_MAX_WALL_CLOCK_MS=8000` 强制首轮超时，断言 `settled=true`、`limitReason=run_timeout`、session 捕获成功。

### H2.2 瞬态失败重试（superagent 模式）
- `harness/retry.ts` 移植 `transient()`：HTTP 408/429/5xx、ECONNRESET/REFUSED/TIMEDOUT/EAI_AGAIN/ENOTFOUND/EPIPE/UND_ERR/socket hang up/fetch failed/network error/overloaded/rate limit 视为瞬态；**超时/步数限制不重试**（没有新信息）。
- 参数：`TRANSIENT_TRIES=3`（总尝试次数）、`TRANSIENT_BACKOFF_MS=15s × 尝试序号`（可配 `WORKER_TRANSIENT_TRIES`）；重试时恢复同一 Harness session 并追加 recovery note（"这是第 N 次尝试，上次因 X 中断；先 list_assets/traffic_search，避免重复已完成工作"）。
- 每次重试写 `events(task.retry)`，成功后清空 run 目录。

### Agent 调度（P1-α 增强，借鉴 superagent Effects）
- **持久化重试节流**：`tasks.retry_after` + `tasks.last_error`；租约过期进入 `retry_wait` 时按 attempt 指数退避（15s 起，封顶 2min），`schedulerTick` 只提升到期的 retry_wait；避免崩溃/回收后的热循环。
- **恢复提示**：claim 返回上次 `last_error`；attempt>1 的 task 在 assignment 前自动附加 recovery note（跨 worker 重启仍有效）。
- **优先级**：`POST /api/missions` 支持 `priority`（0–1），claim 按 `priority DESC, created_at ASC` 领取，为人启动/紧急任务留出插队能力。
- 未采用：superagent 的进程内 SQLite Effects / WorkerSlots——我们保留 PG 状态机 + SKIP LOCKED/fencing，后续 P1-γ 再接 steering 投递水位。

## H3：CkSKILLS 技能接入 + 精简 Worker profile（2026-11-07）

- **技能入库**：`CkSKILLS_v2/.agents/skills` 的 16 个包（格式与 DSH `skill-filesystem` 完全兼容：目录包 + `SKILL.md` frontmatter `name`/`description`）全量复制到仓库 `skills/`，另把 `rules/` 纪律文档放到 `ck-router/references/rules/`；`skills/manifest.json` 由 frontmatter 生成，`scripts/skills-check.mjs` 校验 frontmatter/漂移/大小预算并纳入 `verify:repo`。
- **挂载**：worker 镜像 `COPY skills /app/skills`；运行时 patch 增加 `skill-filesystem` 覆盖：`{includeDefaultRoots:false, customSkillDirs:['/app/skills'], watch:false}`。目录可用 `SRC_AGENT_SKILLS_DIR` 覆盖。Agent 通过内置 `skill` 工具按需加载（catalog 只含 name/description，正文进上下文时才付费）；assignment 明确要求先 `skill("ck-router")` 再加载 1–2 个主包。
- **精简 Worker profile**：headless profile 没有 agent-preset 层，因此用 patch 按 id 停用与单任务执行无关的插件：`goal`/`tool-goal`/`goal-round-driver`/`command-goal`、`plan-mode`、`user-questions`、`subagent*`/`tool-subagent*`、`ptc-runtime`/`workflow-ptc`/`tool-workflow`、`tool-cordis`/`tool-plugin-manager`、`tool-working-directory`、`tool-pwsh`/`pwsh-sandbox`。保留 bash/jobs/fs/fs-search/skill/todo/compaction/token-meter/timeout-policy/spill 与 Flotilla 插件。`SRC_AGENT_LEAN_TOOLSET=0` 可关闭精简。
- **Planner 不受影响**：Planner 是独立编排 profile（P1-β），会显式启用 goal/plan/todo/subagent 与调度工具；Worker 侧"调用 worker agent"的跨进程形态是通过 PG `tasks` 表 + claim/fencing 派发（不是同进程 subagent），Planner 侧如需本地拆解可启用 subagent。
- 验证：`skills-check` 通过（16 packs）；`SMOKE_SKILLS_TEST=1` 在 worker 镜像内跑通"加载 ck-router → 模型引用正文"；完整 e2e（精简 + 技能）：**46 通过 / 0 失败**，Worker 自主 4/4 flag（35 步，约 90.5 万 tokens，较 H2.2 的 48 步/150 万 tokens 更省）。

## P1-γ 先行：hint 队列 + 下一次注入（2026-11-07）

- **契约**：`task_hints`（mission/task 级、content/source/state/delivered_at）；`POST /api/hints` 入队、`GET /api/hints?missionId=` 审计投影。
- **注入点**：Worker 在 run 边界拉取 pending hint：首次 claim、瞬态重试、settlement 收尾 pass；主 run 不追求运行中抢占（headless one-shot 限制，见 P1 计划 ④/H6）。claim 即标记 delivered（幂等，不会重复注入），并记 `task.hints_delivered` 事件。
- **Prompt**：assignment 增加 `CONTROL-PLANE HINTS` 段，settlement prompt 增加"控制面新提示"，均要求不越出授权 scope。
- **验证**：e2e 先停 worker → 建 mission → 入队 hint → 启 worker，断言 hint 行 `state=delivered`、worker 日志 `injecting 1 control-plane hint(s)`；完整 e2e **56 通过 / 0 失败**、4/4 flag。

## P1-β Planner（2026-11-07）

- **独立 profile/服务**：planner 复用 worker 镜像但跑 `src/planner/main.ts`，compose profile `planner`（默认不启动）；Planner Harness profile 的精简工具集与 Worker 相同，但插件按 `SRC_AGENT_ROLE=planner` 只注册 `read_mission_state` + `submit_plan`，**没有任何目标工具**。
- **快照与输出**：runner 把 mission/tasks/findings/assets/todo/合批 signal 写成 `state.json`；模型只能通过 `submit_plan` 提交计划；计划在编排器侧 zod 校验 + 事务 apply（模型不写 DB）。
- **单写者 + 批处理**：`reason_lease`（mission 级租约、fence）+ `planner_signals` 合批（默认防抖 5s、单批 ≤20 条）；失败时本 run 的 signal 自动回队重试；`planner_runs` 记录每次 reason 的 state/action_count/session/error。
- **审计与安全**：动作上限 6 条；create_task 只能继承 mission target/grant，依赖只能是已知任务或同计划 `new:N`（防止越界/悬空依赖）；cancel 只能作用于 open task；apply 写 `planner.plan_applied` 事件；hint 进 `task_hints`（下一轮 Worker 边界注入）。
- **验证**：`node scripts/planner-smoke.mjs`（把 bootstrap 置 done、无 finding、写 worker_report signal → 单次 planner pass）实测：`actions=6 tasks=2 todos=2 hints=1`，`planner_runs.completed`、`planner.plan_applied` 事件落库；P1-β 后完整 e2e 回归 **52 通过 / 0 失败**、4/4 flag（28 步，约 68 万 tokens）。

## P1-γ 触发路由与规则看门狗（2026-11-07）

- **triggers（②）**：`triggers` 表记录 source/kind/route/state；`routeTrigger()` 策略把 `worker_report/denial/manual` 路由到 Planner（需要判断/授权），把 `finding/asset/watchdog` 作为直通提示。`finishTask` 在插入 finding 后生成 finding trigger，并向同一 mission 的其他 open task 写入 `task_hints`（`source='trigger:finding'`），内容明确"在当前 grant scope 内自行验证、不得扩权"。`GET /api/triggers?missionId=` 提供审计投影，e2e 校验 finding trigger 路由。
- **规则 watchdog（⑥）**：worker 每 8 tick 执行 `watchdogTick()`，检测：① 窗口内同一 target URL 重复请求 ≥10；② 窗口内被代理拒绝的越界请求 ≥5；③ running 任务 ≥15 分钟无新 finding。命中即写 trigger + 直通 hint（含"不得绕过平台/换方向"话术），30 分钟去重避免刷屏；阈值/窗口由 `WATCHDOG_*` env 控制，`WATCHDOG_ENABLED=0` 可关。LLM 分析型 watchdog 留 P2。
- **验证**：`scripts/watchdog-smoke.mjs`：构造 running 无进展任务 + 6 条 denial → tick 产出 observations=2/hints=2，trigger/hint 行落库且话术包含 scope/bypass 提醒；完整 e2e 回归 **52 通过 / 0 失败**、4/4 flag（40 步，约 110 万 tokens）。

## H6a 分段续跑（chunked resume，2026-11-07）

- 目的：在 headless one-shot 限制下实现"运行中可干预"的低风险版本：把长任务拆成 step 段，段边界可注入新 hint。
- 机制：`SRC_AGENT_CHUNK_STEPS`（默认 0=关）设置每段 step 预算；仅当任务 `maxSteps=0`（不限制）时启用。每段用 `--session-id` 续跑同一 Harness session；段边界调用 `pullHints()` 拉取新 hint，注入 continuation prompt；总墙钟仍是任务的 `maxWallClockMs`（默认 1200s）；段数上限 `SRC_AGENT_CHUNK_MAX`（默认 8）。超过段数/时间后走 ARTEX settlement。
- 验证：`SMOKE_CHUNK_STEPS=2 node scripts/harness-smoke.mjs` 断言 completed + `chunks>=2`（实测通过）；普通/结算 smoke 回归通过；默认 e2e（chunk 关闭）**52 通过 / 0 失败**、4/4 flag。

## P1-γ Web DAG / SSE / 审批中心（2026-11-07）

- **DAG**：服务端 `lib/dag.ts` 按 `tasks.depends_on` 计算最长路径层级并输出 SVG（节点=任务状态色，边=依赖），不引入 React Flow/dagre；mission 页展示 tasks/todo/triggers/hints/approvals 全投影。理由：P1 只读、无拖拽编辑，SVG 更简单、可审计、构建无额外依赖。
- **SSE**：`GET /api/missions/:id/stream` 轮询 PG 每 2s 推一个快照事件；客户端 `EventSource` 仅显示实时计数并在 mission state 变化时 `router.refresh()`，避免每帧重渲染。
- **审批中心**：`approvals` 表 + `GET/POST /api/approvals` + `POST /api/approvals/:id/decide`；决策落行 + `approval.resolved` 事件；`/approvals` 页面支持 approve/reject 与 decidedBy/note。**Grant scope 的实际修改不在本增量**（P2 审批→授权升级需独立设计，禁止模型静默改 grant）。
- 验证：完整 e2e **63 通过 / 0 失败**、4/4 flag（39 步，约 112 万 tokens），其中包含 DAG 页面渲染、SSE 首帧、pending→approved 审批流。

## H6b 正式化（2026-11-07）：in-process runtime + 运行中 steering

- **双运行时开关**：`SRC_AGENT_RUNTIME=cli|inprocess`（默认 `cli`，保留回退）。`runHarnessTask` 按开关分派：CLI 路径不变；`inprocess` 走新的 `harness/inprocess.ts`。
- **in-process runtime**：`runProfile` 在 worker 进程内启动 base-only 自定义 profile（`/tmp/src-agent-runs/<taskId>/dsh-home`），`ctx.agents.create/resume` 创建/恢复 Agent，直接 `followup` 驱动；不再 spawn `dsh` 子进程、不解析 NDJSON。
- **运行中 steering**：hint 队列（`task_hints`）由 runtime 每 `SRC_AGENT_HINT_POLL_MS`（默认 2.5s）拉取一次，调用 `agent.steer()` 在下一个 step 边界注入；每次投递写 `task.hints_steered` 事件。**真正全双工**，不再依赖 chunk 边界。
- **限制/收尾**：wall-clock/step 看门狗 → `agent.cancel(reason, {keepInbox:true})` → settlement followup（同一 session），替代 SIGTERM；报告/证据/重试/cleanup 复用既有路径。
- **统计**：`session/event` 驱动 steps/toolCalls/finalText/turnReason；token 用量用 `ctx.tokenMeter.measure()` 的上下文压力估值（仅用于日志/结果，不做成本闸门）。
- **权限**：in-process 固定 `DSH_PERMISSION_MODE=danger-full-access`（与 CLI flag 等价）；无 CLI 参数依赖。
- **已知限制**：runtime 与 worker 同进程（崩溃影响面大于 CLI 子进程）；下一步可拆独立 node 子进程（IPC 控制）。插件配置仍是进程级 env（一进程一 agent 下安全）。
- **验证**：`SMOKE_RUNTIME=inprocess node scripts/harness-smoke.mjs` 通过；settlement smoke 通过；`node scripts/steer-smoke.mjs` 实测 mid-run hint 生效（final text 引用 `STEER-INPROCESS-OK`、`task_hints` delivered）；完整 e2e（worker `SRC_AGENT_RUNTIME=inprocess`）：**83 通过 / 0 失败**，mission completed，Worker 拿到 **8/4 artifacts**（本靶场共 8 个 flag，超出验收要求的 4 个），50 步，`tokenMeter` 上下文压力估值 ≈10.7 万。

## H6b 第二阶段：runtime 子进程隔离（2026-11-07）

- **进程拆分**：`harness/inprocess.ts` 现在是 supervisor，`harness/runtime-child.ts` 是独立 Node 子进程（`tsx` 启动，IPC channel 通信）。DSH profile boot/Agent 生命周期/工具执行都只在子进程内，worker 主循环不受 agent 崩溃影响。
- **IPC 协议**：父→子 `start`（任务 JSON + hints/recoveryNote/sessionId/keepRunDir）、`hint`（运行中 steer 文本）、`hints`（子进程 settlement 前 request-hints 的应答）；子→父 `progress`（steps/tools/hints）、`request-hints`、`result`（完整 `HarnessRunOutcome`）、`error`。
- **steering 全双工**：worker 端 supervisor 每 `SRC_AGENT_HINT_POLL_MS` 拉取 `task_hints` 并转发 `hint`；子进程 250ms 内 drain 队列 → `agent.steer()`；投递审计仍写 `task.hints_steered`。
- **故障语义**：子进程异常退出/启动失败 → `failureClass=runtime_crash`（计入瞬态重试，最多 3 次）；整体超时（任务墙钟 + settlement + 60s grace）→ `runtime_timeout`（不重试）。
- **环境隔离**：子进程内设置 DSH_HOME / permission / mission env，不再修改 worker 主进程 env；run dir/report/session 文件路径不变。
- **验证**：`SMOKE_RUNTIME=inprocess` 普通/结算 smoke 通过（普通 smoke 连续两次稳定，子进程隔离路径）；`scripts/steer-smoke.mjs` 通过（hint 在 sleep 期间经 supervisor→child→`agent.steer()` 注入并命中模型）；完整 e2e（worker `SRC_AGENT_RUNTIME=inprocess`）：**79 通过 / 0 失败**，mission completed，Worker 拿到 **8/4 artifacts**，57 步。

## H6b 第三阶段：per-agent 插件配置与多 agent 隔离（2026-11-07）

- **问题**：插件此前从进程 env 读取 mission/task/scope/report path，并把工具注册到全局 `ctx.tools`；一进程只能安全服务一个 Agent，无法做 runtime 池化、Planner+Worker 同进程、Worker 内 subagent 或多任务并发。
- **实现**：`packages/harness-plugin/src/toolset.ts` 新增 `createAgentToolset(config)`（独立 TrafficStore/findings/artifacts/ProxyAgent/report 快照）与 `mountToolset(ctx, toolset)`（同步注册到 agent-scoped context）；`registerAgentTools` 保留为便捷入口。每个 Agent 在 `setup(agentCtx, agent)` 中挂载自己的工具集，配置由 runtime 显式传入（不再依赖进程 env）；全局 `apply` 在无 env 时保持 inert（CLI 单任务路径不变）。
- **多 agent runtime**：IPC 协议升级为 `start-batch`（N 个 job，每个 job 携带 task + agent config + reportPath），child 一次 boot 后并发创建多个 Agent；每个 job 独立 session/report/hint inbox/看门狗/settlement。`runJobsInProcess()` 暴露多任务 API，`runTaskInProcess` 为其单任务包装。
- **角色隔离**：job 的 agent config 支持 `role=planner`（只挂 `read_mission_state`/`submit_plan`，无目标工具）；worker 与 planner 可在同一 child 进程并发互不污染。
- **并发安全**：每 Agent 独立 store/set/文件路径；同 Agent 内工具调用串行语义不变，跨 Agent 无共享可变状态。
- **验证**：`node scripts/agent-isolation-smoke.mjs` 在同一个 runtime child 中并发跑 2 个 worker（不同 mission/scope/report）+ 1 个 planner，5.2s 完成；断言两份 report 各自只含本 mission 的 asset、planner plan 文件生成、角色工具无串扰。plugin 单测新增双 toolset 隔离用例（15 tests）。完整 e2e（worker inprocess）：**85 通过 / 0 失败**，mission completed，8/4 artifacts、9 findings，52 步。
- **附带修复（重要）**：代理的拦截叶子证书原本只有 24h 有效期，运行超过一天的 proxy 容器会让所有出站 TLS 握手报 `certificate has expired`（本次 smoke 因此失败后被定位）。`proxy/cert.go` 叶子证书改为 5 年（仍以 CA 为上限），重建 proxy 后 CLI/inprocess/steer/settlement smoke 全部恢复通过。

## P1-α 多 Worker 验收（2026-11-07）

- **唯一 Worker ID**：compose 不再固定 `WORKER_ID=worker-1`；副本默认用 hostname+pid 派生，`--scale worker=3` 时每个 replicas 独立身份（claim/审计/lease 正确归属）。
- **claim 审计**：`claimTask` 已写 `task.claimed` 事件（workerId/fencingToken/attempt/target/objective），多 Worker 测试直接以事件计数验证"零双领"。
- **fencing 语义修正**：`finishTask` 现在在 report 幂等插入**之前**校验 fencing token；旧 token 无论 attempt 是否冲突都返回 `FencingError`，避免 stale writer 被误判为 duplicate。
- **验收脚本**：`scripts/multi-worker-test.mjs` 对真实靶场 `http://192.168.79.165:64280` 跑 3 workers / 4 并发 mission / stale writer / 依赖串行链，全部通过。

## P1-γ pause/resume + checkpoint（2026-11-07）

- **暂停**：`POST /api/missions/:id/pause` 在事务里把 mission 置 `paused`、写 `paused_at`，并把 checkpoint 快照（taskCount/openTasks/taskStates/todo/lastEventSeq/grantId/grantVersion）合并进 `missions.checkpoint`，同时写 `mission.paused` 事件。暂停期间 `claimTask`（join missions 状态）与 `schedulerTick`（只处理 active mission）都不会产生新 claim/提升；已在运行的 task 继续到报告返回。
- **暂停中的报告**：`finishTask` 检测 mission 已 paused 时，只把 task 结果写入 checkpoint 快照与 `mission.task_reported_while_paused` 事件，不把 mission 翻成 completed/failed。
- **恢复**：`POST /api/missions/:id/resume` 校验状态为 paused，清 `paused_at`，写 `resumedAt/openTasks/artifacts/expectedArtifacts/stateAfterResume`；若已无 open task 则按 artifacts 与预期数直接落 completed/failed（否则 running），随后 scheduler/worker 从既有 tasks/checkpoint 续跑。
- **UI**：mission 页新增 Pause/Resume 控件与 paused_at 展示。
- **验证**：`scripts/pause-resume-test.mjs`（停 worker→建 mission→pause→checkpoint/tasks/events/grant/todo 不变→启 worker 12s 无 claim→resume→claim 晚于 resume 事件；非法转换 409）。

## 临时开放出站模式（用户明确指示，2026-11-07）

- **背景**：用户在对局域网靶场（`http://192.168.79.165:64280`）实战时明确要求"放开这个限制，允许所有地址、域名、URL，之后再添加门限"。
- **实现**：新增 `EGRESS_MODE` 开关（默认 `scope` 保持原安全基线）：
  - proxy `EGRESS_MODE=open`：`classify` 对未命中 scope 的请求返回 internet 模式；`dialContext` 跳过 target scope 与 public-IP 检查；所有流量仍经 `proxy_traffic` 审计（方法/URL/状态码/哈希/大小）。启动日志打印醒目 WARNING，`OpenEgress()` 可观测。
  - plugin `http_request`：配置新增 `allowAllEgress`（来自 `EGRESS_MODE=open` 或 `SRC_AGENT_ALLOW_ALL_EGRESS=1`），跳过客户端 scope 门禁；`web_fetch` 的 untrusted 标记、证据采集、Curator、报告规则不变。
  - Web `/api/health` 返回 `egressMode`，控制台顶部显示红色 "EGRESS OPEN" 警告条。
- **保留的安全能力**：全量审计、证据链、scope 相关代码与测试、denial 记录机制都保留；恢复 `EGRESS_MODE=scope` 即恢复原门禁。
- **验证**：open 模式下 `curl http://example.net/`（原越界域）返回 200；`http_request` 对 example.net 的两次请求被接受为 evidence 并通过 Curator（mission completed）；e2e 增加 open/scope 双模式断言分支，open 模式实测 **94 通过 / 0 失败**。
- **实战验证**：用 `scripts/capture-flags.mjs` 对 `http://192.168.79.165:64280` 发起 mission，Worker 自主拿到 **8/8 全部 flag**（js_reverse_idor / sqli_waf_bypass / mfa_scope_bypass / ssrf_imds_userdata / lfi_abs_path / cmd_home_expansion / xxe_utf16 / py_sandbox），mission completed。
- **后续（P2）**：策略层（按 mission/域名/IP/风险动态门限、审批联动、限速/限额）取代这个临时开关；scope 模式代码保留为默认回归路径。

## Harness 轨迹（trace）与时间同步（2026-11-07）

- **表**：`task_trace(id, mission_id, task_id, subject_type worker|planner, subject_id, seq, event_type, payload, created_at)`；append-only，按 id 排序，按 `(subject_type,subject_id)` 查询。
- **采集**：
  - CLI runtime：`runHarnessProcess` 的 NDJSON 行 → `traceFromCliLine` 归一化为 thinking/text/tool_call/tool_result/status/final；assignment hint、recovery note、settlement prompt 额外写 `context` 事件（CLI 投影没有 user 消息）；
  - in-process runtime：child 订阅 `session/event` → `traceFromSessionEvent` 映射 thinking/text/tool_call/tool_result/context（user/developer/system message）/status/final；
  - 每条事件带捕获时间 `ts` 并落 `created_at`；payload 文本截断 6K、每个 subject 上限 3000 条，避免工具输出膨胀 DB。
- **持久化**：worker main 在 finishTask 前批量写 `task_trace`（subject_id=taskId）；planner main 在 apply plan 前写 subject_id=planner run id。
- **Web**：`GET /api/traces?subjectType=&subjectId=`；`/missions/[id]/traces/[subjectId]` 时间线页（thinking/tool_result 折叠、SKILL 高亮、context 高亮）；mission 页每个 task 与 planner run 有「轨迹」链接。
- **时间同步**：compose 全服务 `TZ=Asia/Shanghai`（默认），Web 使用 `lib/time.ts` 的 `Intl.DateTimeFormat(Asia/Shanghai)` 统一渲染，`CONSOLE_TIME_ZONE` 可配。
- **验证**：planner-smoke 后 planner trace 20 条/上下文正常；短任务 trace 13 条含 context/thinking/tool_call/tool_result/text/final，轨迹页 200 渲染；e2e 新增 worker 轨迹持久化/类型/页面断言。

## 目标请求标识与真实 URL（2026-11-07）

- **随机 UA**：`packages/harness-plugin/src/user-agents.ts` 维护 12 条主流浏览器 UA（Chrome/Edge/Firefox/Safari/移动端），每次 `http_request`/`web_fetch` 从池中随机选择且避免连续重复；模型传入的 `User-Agent` 不会覆盖随机值。`SRC_AGENT_UA_MODE=fixed` + `SRC_AGENT_UA_FIXED` 用于确定性测试。
- **请求包 Host**：`http-packet.ts` 的 `buildRawRequest` 生成真正的 HTTP/1.1 请求行（path+query，而非完整 URL）+ 显式 `Host: host[:port]` + 实际使用的 headers/body；`http_request` 与 `web_fetch` 的证据 `requestText` 统一走该函数，Web Finding 详情「证据 → 请求」可直接看到 Host。
- **真实 URL**：E2E/Smoke 默认目标改为真实 LAN 靶场 `http://192.168.79.165:64280`（`E2E_TARGET`/`SMOKE_TARGET` 可覆盖），任务、证据、报告不再使用 `host.docker.internal` 这类容器别名；`getent` 解析校验也针对真实主机。
- **验证**：同一任务两次 `http_request` 证据中 Host 均为 `192.168.79.165:64280`、User-Agent 为两条不同浏览器 UA（如 macOS Chrome/Windows Chrome），URL 为真实地址。

## 控制台汉化（zh-CN，2026-11-07）

- **范围**：Web 控制台全部展示层（导航、页面标题、表头、按钮、状态/严重度/类别/触发器/审批/拦截/轨迹标签、空态与提示文案）改为中文；**技术数据不翻译**——数据库/API/事件枚举保持英文原值，HTTP 请求包、证据正文、轨迹里的工具名与思考/输出原文、Worker 日志保持原语言。
- **术语**：Mission→任务；Worker、Planner 保留英文；Finding→发现；Evidence→证据；Artifact→产物；Target→靶标；Scope/Grant→授权范围/授权；Curator→证据审查；Trace→轨迹；Trigger→触发器；Hint→提示；Approval→审批；Denial→拦截记录；DAG→任务依赖图。
- **状态格式**：`中文 (english)`，例如 `运行中 (running)`、`已上报 (reported)`、`待审批 (pending)`，便于和 DB/日志对照。实现集中在 `packages/web/src/lib/i18n.ts` 的 label maps + `biLabel/zhLabel`，页面不散落翻译逻辑；DAG 等空间受限处用中文短标签。
- **语言策略**：先纯中文（无语言切换）；字典结构后续可扩展到英文切换。`layout.tsx` 的 metadata/导航同步中文（品牌 Flotilla 保留）。

## CkSKILLS 打包回归修复（2026-11-07）

- **范围澄清**：CkSKILLS 全量 16 包接入属于 P1/H3（执行面技能接入），**不是 P2 的工作**；P2 只在 2.6 为每个 pack 建评测集（3 正 + 3 假点 + 2 越界 + 1 注入），P4 才做蒸馏。
- **发现的回归**：worker 镜像的 Dockerfile 缺少 `COPY skills /app/skills`，导致 `skill-filesystem` 的 customSkillDirs 为空、运行中 `skill("ck-router")` 返回 `unknown or no longer available`；此前 repo 层 skills/ 与 manifest 完整，但镜像运行时不完整。
- **修复**：Dockerfile 增加 `COPY skills /app/skills`（在 useradd/chown 之前，worker 只读可访问）；重新构建后容器内 16 个 pack + manifest/README 就位。
- **回归防线**：
  - `tests/skills-image.test.mjs`：静态断言 Dockerfile COPY、`skill-filesystem` 的 `customSkillDirs`、`SRC_AGENT_SKILLS_DIR=/app/skills`、manifest 16 包及每个 `SKILL.md` 存在；`verify:repo` 改为跑 `tests/*.test.mjs`。
  - e2e 新增「Worker 镜像包含 CkSKILLS」检查（运行中容器内文件与数量）。
  - `SMOKE_SKILLS_TEST=1 node scripts/harness-smoke.mjs` 实测 `✅ ck-router skill loaded` / `✅ model saw the skill body`；同时修复该 smoke 内嵌脚本引用未定义 `TARGET` 的回归（改用容器 env `SMOKE_TARGET`）。
