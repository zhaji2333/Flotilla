# ADR-0030：CI 覆盖全镜像构建与核心包测试

- 状态：Accepted
- 日期：2026-11-11
- 关联：ADR-0016

## 背景

CI 之前只构建 `worker` 镜像；API/executor/dispatcher/frontend 的镜像错误只能在本地发现。API/model-proxy 也没有包级测试。

## 决策

- 新增 `docker-images-amd64` matrix job，构建并校验架构：
  - `packages/orchestrator/Dockerfile`（worker/executor/dispatcher/watchdog 共用）
  - `packages/api/Dockerfile`
  - `packages/frontend/Dockerfile`
  - `proxy/Dockerfile`
- `quality` 继续跑 lint/typecheck/`pnpm test`/build/compose config/audit。
- API 新增 `model-proxy.test.ts`（Node test + tsx）覆盖：
  - upstream base normalization（是否补 `/v1`）；
  - model 重写与 developer→system；
  - 非 JSON body 原样透传。
- 现有 orchestrator/curator/control-plane/frontend 测试继续纳入 `pnpm test`。
- 真实 PostgreSQL/Compose/模型/靶场 e2e 仍不在 GitHub 托管 CI 中跑（需要凭据/靶场）；本地用 compose + smoke/e2e 验证并记录结果。
- CI 仍只读 `contents: read`，动作固定 SHA。

## 边界

- Docker matrix 会显著增加 CI 时间和 runner 存储；失败矩阵 `fail-fast: false` 便于一次看到多个镜像问题。
- 没有加入 e2e job；后续可选 nightly runner + 隔离靶场/LLM 配额。
- 未引入覆盖率百分比阈值；先保证关键路径有测试，再按项目约束提高门槛。
