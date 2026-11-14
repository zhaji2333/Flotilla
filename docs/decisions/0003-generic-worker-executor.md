# ADR-0003：通用 Worker 执行器，DeepSeek Responses API 直连

- 状态：**已被 [ADR-0005](0005-use-deepseek-harness-execution-plane.md) 取代**（2026-11-06）。保留作为 P0 历史决策记录；执行面回归 DeepSeek Harness
- 日期：2026-11-06
- 相关：`packages/orchestrator/src/worker/`、`packages/orchestrator/src/llm.ts`

## 背景

P0 目标是证明“通用 Worker + 安全边界 + 证据闭环”，不是把 DeepSeek Harness 的插件机制一次接完。早期计划用 Harness Cordis 插件拦截工具调用；实际开发中发现：

- Harness 集成需要固定版本源码、插件 API 与运行时状态，接入成本和升级风险高；
- P0 只需要一个可审计的工具循环（bash / http_request / web.fetch / traffic / report），行为完全可由本仓库定义；
- 安全边界已经由出站代理承担，不依赖 Harness 内部钩子。

## 决策

1. P0 Worker 是**通用执行器**：目标、objective、成功产物数、预算来自数据库中的 mission/task，不硬编码任何任务类型（CTF/SRC/APK 只是不同数据）。
2. 模型调用使用 DeepSeek **Responses API**（无状态）：每轮回传完整 item 列表，函数调用按 `function_call` + `function_call_output(call_id)` 严格配对；上下文超限时压缩旧轮次。
3. 模型调用本身也经代理出站（`api.deepseek.com` 在互联网白名单内，Worker 信任代理 CA）。
4. 工具面保持通用：`bash`（容器内本地计算/脚本）、`http_request`（目标流量）、`web_fetch`（互联网检索，untrusted）、`traffic_*`、`insert_assets`/`list_assets`、`report_finding`。
5. `packages/orchestrator/src/harness-plugin.ts` 作为 P1 Harness 适配参考保留，但不在 P0 运行路径上。

## 后果

- P0 闭环可独立验证；升级 Harness 不会阻塞安全基线。
- 代价：重复了部分 agent loop 能力（工具调度、上下文管理），P1 若要接 Harness 需要把安全控制层映射回 Cordis 插件，届时用新 ADR 评估。
- Worker 容器因此需要自带 Node 与 Python 工具链，镜像更大（约 1GB 以内）。
