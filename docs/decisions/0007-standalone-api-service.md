# ADR-0007：前后端部署解耦（独立 API 服务 + Bearer Auth + CORS）

- 状态：已实施（2026-11-07）
- 关联：ADR-0005（执行面）、docs/api/frontend-api.md + openapi.yaml（冻结契约）

## 背景

P1/P2 期间 API 路由与 PostgreSQL repositories 位于 `packages/web`（Next.js）内；独立 Vite/React 前端需要同源 nginx 反代到 `web:3000`，前后端部署仍耦合。用户要求前端交给独立 Agent 开发，后端 API 应可独立部署。

## 决策

1. **共享数据层抽包**：新增 `packages/control-plane`，承载 `db.ts` 与全部 PostgreSQL repositories；`packages/web` 与 `packages/api` 都只依赖这个包，避免契约/查询漂移。
2. **独立 API 服务**：新增 `packages/api`（Node 内置 HTTP，无额外框架依赖），按 v1 契约暴露全部 `/api/*` 路由；SSE 保持 `text/event-stream`。路径/响应不变，旧 Next API 暂留作回退。
3. **Auth**：`API_AUTH_TOKEN` Bearer Token；除 `/api/health` 外全部路由校验 `Authorization: Bearer ...`；EventSource 无法携带 header，SSE 额外接受 `?token=`。未配置 token 时启动告警并退化为开发模式（不用于部署）。
4. **CORS**：`CORS_ORIGINS` 逗号分隔允许列表；OPTIONS 预检 204；`access-control-allow-headers: content-type,authorization`。
5. **前端接入**：`packages/frontend` 的 nginx 从 `web:3000` 切到 `api:3001`，并在 nginx 侧注入 Bearer token，token 不进入浏览器 bundle；开发时用 `VITE_API_BASE_URL` + `VITE_API_TOKEN`。
6. **部署**：compose 新增 `api` 服务（127.0.0.1:3001，healthy 后 frontend 才启动）；`web` 仍可用于旧 console。

## 安全边界

- API 独立进程只访问 PostgreSQL 与控制面仓库；不接触 Worker、代理、Harness。
- 写操作（mission/hint/approval/scope-upgrade）全部经过同一 Bearer 鉴权；CORS 不启用 credentials。
- token 通过环境变量注入；文档与 `.env.example` 明确 dev 默认值不能用于暴露环境。

## 验证

- `node scripts/api-smoke.mjs`：health 无鉴权 200、无 token 401、CORS 预检测试、token 后 missions/findings/metrics/detail/board/trace 全 200。
- 浏览器入口 `http://127.0.0.1:5173` 页面 200，`/api/health`、`/api/missions` 经 nginx 200；直连 `:3001/api/missions` 无 token 401。
- `pnpm run lint/typecheck/test`（167 package tests）全绿；`go test ./...` 通过。

## 后续

- 旧 Next API 与 `packages/web` 可逐步下线（先切只读 console，再删路由）。
- token 轮换/登录会话、按角色授权、速率限制可在此服务上叠加；契约破坏性变更走 `/api/v2`。
