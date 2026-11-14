# ADR-0017：执行面隔离、命令门控与自动 finding review

> 2026-11-10 更新：命令门控已接回 API 模型代理；只有模型无法判断时才进入 `command_review` 人工复核，见 [ADR-0023](0023-command-gate-model-proxy-review.md)。

- 状态：已实施（2026-11-08）
- 关联：P0 隔离、命令门控、finding review、key pool、coverage gate
- 影响：Worker/Planner 网络、API 鉴权、Harness 子进程、报告路径、评测脚本

## 背景

审计发现执行面存在三个结构性问题：

1. Worker 只有 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，Docker 网络仍可直连外网；Agent 可用 `--noproxy '*'` 绕过代理审计。
2. Harness 子进程通过 `{...process.env}` 继承 Worker 的 `PG_PASSWORD`、`API_AUTH_TOKEN`、`API_ADMIN_TOKEN` 等控制面凭证；审批 API 又没有独立的 admin 保护，Agent 理论上可以自己批准审批。
3. Harness 以 `danger-full-access` + `approval-policy never` 运行，`rm`、数据库破坏、停服务等命令没有门控。

同时 finding review 队列持续积累人工待办，A/B 也无明确收益，执行效率需要可度量地改善。

## 决策

### 1. 网络

- 新增 `backend`（`internal: true`）网络：Worker 只能访问 proxy/postgres/api。
- proxy 同时接入 `backend` 和 `edge`（外部网络）；Worker 没有默认路由，`--noproxy '*'` 无法直连互联网。
- e2e 增加“Worker 直连外网必须失败”的反向检查。

### 2. 凭证

- API 新增只读 token（`API_READ_TOKEN`）：只允许 GET mission/trace 读路径；审批决策、hint/模型配置等仍要求 admin token。
- Worker 的 `SRC_AGENT_MISSION_API_TOKEN` 改为只读 token；不再使用主/管理员 token。
- Harness 子进程 env 由 `sanitizeHarnessEnv` 清洗：删除 `PG_*`、`API_AUTH_TOKEN`、`API_ADMIN_TOKEN`；只保留任务级只读 token。
- Worker/Planner 入口脚本把 `PG_PASSWORD` 写入 `/tmp` 权限 0600 文件，unset 环境变量，controller 读取后立即删除文件；`/proc/1/environ` 不再含密码。
- 明确残余：模型 key 仍在 Agent 可见的 env 中（模型调用需要）；后续用模型代理/短期 token 解决。Worker controller 仍直连 DB，独立 executor 容器是下一步。

### 3. 命令门控

- 在 DSH `tools/pre-execute` 挂钩，覆盖 bash/run_code 等执行工具。
- 确定性硬规则直接拒绝：删根/关键路径、格式化、写块设备、DROP/TRUNCATE、停服务、改账号/防火墙、fork bomb 等。
- 可疑命令交给便宜模型，使用 Sentinel Gatekeeper 风格的“只拦截直接破坏” prompt；模型超时/失败默认 fail-closed。
- 正常侦察、SQL 注入、文件上传、弱口令、路径遍历等授权测试命令不因“敏感”被拦。
- 被拦命令作为 tool error 返回原因，不等待人工。

### 4. 自动 finding review

- Curator 六道证据闸仍是硬边界；`FINDING_REVIEW_MODE=auto` 时：
  - 修复与证据矛盾的 claim（匿名声明、凭据泄露声明、过高定级）；
  - 修复后通过 → accepted；
  - 硬证据失败（baseline/proof/hash/复现包/禁写闸）→ rejected；
  - 仍在 auto 模式无法判定 → rejected，不制造人工 pending；
  - `manual` 模式保留 pending approval 行为。
- 每次自动处理写 `finding.auto_reviewed` 事件，保留原因/规范化项。

### 5. 效率与完成语义

- `LLM_API_KEYS` + `ModelKeyPool`：按 attempt 轮换 key，429/瞬态失败冷却当前 key；`LLM_API_KEY` 保持单 key 兼容。
- 可选 `coverageGate`：mission 创建时可要求资产覆盖比例（及可选 accepted finding）；未满足时以 `failed/coverage_incomplete` 或 `coverage_no_assets` 结束，不由模型单方宣布完成。
- `MISSION_CONTEXT_ENABLED` 仍默认开启；A/B 的 no_clear_gain 结论保留，后续需要重测。

## 验证

- `pnpm run verify`
- `api-smoke`（read token 不能读 approvals；可以读 mission）
- `mission-completion-test`（coverage gate 无资产 → failed/coverage_no_assets）
- `multi-worker-plan-test`
- e2e 130/0（含 worker 直连外网被拒）
- 单元测试：command guard、auto review、coverage gate、key pool、env sanitize。

## 未解决 / 后续

1. 独立 executor 容器（真正 Worker 不碰 DB、Agent 不共享 PID/env 空间）。
2. 模型 key 不下发到 Agent（本地模型代理/短期 token）。
3. Summary/补漏 Agent、浏览器、二进制/APK 工具链。
4. A/B 在索引和隔离后重测 2–3 次/臂。
