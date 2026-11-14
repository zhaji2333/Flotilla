# ADR-0023：命令门控接回模型代理，仅模型无法判断时进入人工复核

- 状态：Accepted
- 日期：2026-11-10
- 关联：ADR-0017、ADR-0019、P1 1.7

## 背景

ADR-0017 设计为“硬规则 + 可选便宜模型，fail-closed”。实际 executor 只有 `MODEL_PROXY_TOKEN`，没有 `LLM_API_KEY`；`command-guard.ts` 又只读取 `COMMAND_GUARD_API_KEY`/`LLM_API_KEY`，导致可疑命令在进入模型前就被 fail-closed 拒绝，等于“硬规则 + 全部可疑命令拒绝”。

用户 2026-11-10 确认：

- 接回模型代理，让 LLM 真正参与判断；
- 每条可疑命令接受约 1 次小模型调用；
- 不做逐个人工审批，只在模型真的无法判断时人工复核；
- 减少误杀，增加 Agent 自主性。

## 决策

> 2026-11-11 更新：命令门控已改用独立的 `role=guard` 模型配置，见 [ADR-0026](0026-dual-model-configs-guard.md)。以下保留本 ADR 原始决策作为实施记录。

1. **模型路由复用 API 内部模型代理**
   - `baseUrl` 指向 `/internal/model/roles/guard`（早期为 `LLM_BASE_URL`）；
   - 不追加 `/v1`（内部代理路径已完整）；
   - 不经过 target egress proxy，直接走容器内 API 网络。

2. **凭据**
   - 优先 `COMMAND_GUARD_API_KEY`，其次 `LLM_API_KEY`、`LLM_API_KEY_ENV` 指定变量，最后 `MODEL_PROXY_TOKEN`；
   - 不把 provider key 放进 executor；只使用已有的模型代理 token。

3. **判定流程**
   - 硬规则先拒绝；
   - 非可疑命令直接放行，无模型调用；
   - 可疑命令调用 cheap judge；
   - 模型返回合法 `ALLOW`/`BLOCK` 直接生效，不创建人工审批；
   - 模型超时、HTTP 错误、无 key、输出无法解析时：
     * 查询该 command hash 的 `command_review`；
     * `approved` → 放行；
     * `rejected`/`pending` → 拒绝并给出 approvalId；
     * 不存在 → 创建 `command_review` approval，拒绝本次执行；
   - 人工批准后，Agent 重试同一条命令会被允许。

4. **审计**
   - 人工复核写入 `approvals` + `events`；
   - Proxy/executor 日志记录门控结果；
   - 不逐条创建 approval，只有模型失败的 suspicious 命令才创建。

## 边界

- 命令 hash 按规范化文本（空白折叠、NUL 去除）计算；改变命令文本会生成新的复核。
- command approval 仅对同一 mission+task+hash 生效；跨任务不继承。
- 人工拒绝不代表任务失败；Agent 应换方案或换命令。
- 该路径不替代容器隔离/scope/egress proxy；命令门控只是语义安全层。
