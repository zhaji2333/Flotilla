# ADR-0026：普通 Agent 模型与命令门控模型分离

- 状态：Accepted
- 日期：2026-11-11
- 关联：ADR-0011、ADR-0019、ADR-0023

## 背景

ADR-0023 把命令门控接回 API 模型代理后，它原先复用 executor 的普通模型路由（`/internal/model/configs/default` 或 `LLM_BASE_URL`）。这样会有两个问题：

1. 一旦调整正常 Worker/Planner 的模型配置，命令门控的模型也会被一起换掉；
2. 无法给门控选择更便宜/更快的模型，也无法单独审计门控模型。

用户明确要求：**正常模型接入和审批判断模型分开接入，两套配置。**

## 决策

### 1. 双配置

- `model_configs.role='worker'`：普通 Agent 任务模型（Worker/默认）。
- `model_configs.role='guard'`：命令门控/审批判断模型，独立 URL、key、model、reasoning effort、compat。
- 任意 role 无匹配配置时，统一回退到 `is_default=true` 的模型；guard 配置存在时优先 guard。

### 2. 路由

API 模型代理新增：

```text
POST /internal/model/roles/:role/<openai-path>
```

- `role=worker` → 普通任务模型；
- `role=guard` → 命令门控模型；
- 查询按 role 精确匹配，未找到回退默认（`getActiveModelConfig` 逻辑）；
- provider key 仍然只存在于 API 进程，executor/Agent 只有 `MODEL_PROXY_TOKEN`。

### 3. 命令门控

- executor `COMMAND_GUARD_BASE_URL` 默认 `http://api:3001/internal/model/roles/guard`；
- 本地回退可用 `MODEL_PROXY_URL` → `.../roles/guard`；
- 门控不再直接复用 `LLM_BASE_URL`（除非显式指定 `COMMAND_GUARD_BASE_URL`）；
- 配置 guard 后，正常 Worker 任务换模型不会影响命令门控判断。

### 4. 管理

- `/api/model-configs` 的 `role` 枚举加入 `guard`；
- 前端模型配置页新增「命令门控 (guard)」选项；
- 仍遵守 ADR-0011：列表掩码、admin reveal、审计、明文落库的既有边界。

## 边界

- guard 与 normal 的 key 都明文落库（ADR-0011 未变）。
- 环境变量回退仍是单一 key；key pool/cooldown 目前只覆盖 env fallback（DB 配置每 role 单 key）。
- 未配置 guard 时不阻塞升级：回退默认配置并记录在文档/日志中。

## 验证

- 普通 `/configs/default` 请求仍走默认配置；
- `/roles/guard` 请求返回 guard 配置的模型；
- 命令门控 `guardCommand` 实际调用 guard 路由返回 `source=model`；
- 前端类型/构建通过。
