# ADR-0011：模型配置模块（UI 可配 key，明文 + 权限控制）

- 状态：已实施（2026-11-08）
- 关联：P3-B2；用户 2026-11-08 明确「UI 上也能配 key：明文+权限控制实现」
- 相关代码：`packages/contracts/src/db/schema.sql`（model_configs / model_config_audit）、`packages/control-plane/src/repositories/model-config-repository.ts`、`packages/api/src/server.ts`、`packages/orchestrator/src/harness/{config,runner}.ts`、`packages/orchestrator/src/worker/main.ts`、`packages/orchestrator/src/planner/{main,runner}.ts`

## 背景

M3 前的模型路由只来自环境变量：换 key/base_url/model 需要改 `.env` 并重启容器，无法由 UI 运维。用户要求 M3 增加“整体模型配置模块”，并且明确 **key 也在 UI 配置、明文存储 + 权限控制**。

## 决策

1. **PostgreSQL 为配置真源，环境变量为回退**：`model_configs` 存储 name/base_url/api_key/model_name/api_key_env/context_window/max_output_tokens/reasoning_effort/compat/role/tier/enabled/is_default。Worker/Planner 每次按 role 读取启用的配置；没有配置或读取失败时使用原 env 路线（行为与 M2 完全一致）。
2. **key 明文存储**（用户明确要求）：`api_key` 不加密、不哈希；列表/详情 API 只返回 `apiKeyMasked` + `apiKeySet`；只有 admin token 的 `reveal` 接口返回明文，且每次 reveal 写 `model_config_audit`。
3. **权限控制**：
   - 新增 env `API_ADMIN_TOKEN`；模型配置的全部路由（list/detail/create/update/delete/reveal/audit）要求 admin token。
   - 普通 `API_AUTH_TOKEN` 仍可访问业务读路径，但调模型配置路由返回 403；未授权返回 401。
   - 未配置 `API_ADMIN_TOKEN` 时回退：普通 API token 也可管理（仅限开发环境，启动日志告警）。
4. **单一默认配置**：数据库部分唯一索引保证至多一个 `is_default`；创建第一条配置自动成为默认；`isDefault` 更新时事务内取消旧默认。`role/tier` 预留角色分层（P3-B2 后续），当前 Worker 以 `role=worker`、Planner 以 `role=planner` 解析：优先 role 精确匹配，否则默认配置。
5. **密钥传递边界**：DB 明文 key 只在 Worker/Planner 进程内存中转为 per-run `SRC_AGENT_MODEL_API_KEY` 环境变量传给 Harness 子进程；不写日志、不写 trace、不进入 event payload。审计只记录配置 id/name/模型名与“key 变更”布尔值。
6. **运行时范围**：CLI runtime（默认）支持 DB 配置；inprocess runtime 由单一 profile 从 env 启动，暂不应用 DB 配置（Worker 显式日志说明并回退 env）。Planner 始终 CLI，支持 DB 配置。
7. **UI 范围**：P3 内交付后端 API + 前端契约/交接文档；管理页面由前端 Agent 实现。前端必须让操作者显式提供 admin token（内存/sessionStorage，不写入 URL/日志），列表默认遮罩，reveal 需二次确认。

## 安全边界与风险

- 明文 key 落 PostgreSQL：数据库、备份、快照的访问控制是唯一保护边界；生产需磁盘/备份加密与最小权限 DB 账号（部署侧责任）。
- admin token 是静态 bearer：P3 尚未实现登录/会话/RBAC；暴露公网前必须替换为真正的管理会话（后续里程碑）。
- `reveal` 审计失败时接口失败（fail-closed），避免“无痕取 key”。
- 配置 API 不返回其他密钥类数据；审计表不记录 key 值。
- 跨 mission 不涉及此模块；配置是全局控制面数据。

## 备选与取舍

| 方案 | 结论 |
|---|---|
| key 只走 env，DB 只存非密钥配置 | 用户明确要求 UI 配 key，否决。 |
| key 加密存储（需主密钥管理/KMS） | 当前单机 compose 无 KMS；用户明确明文；留作后续加固（新 ADR）。 |
| 每条 task 单独传 key | 粒度太细、泄露面更大；按 role/default 配置 + 单 run 子进程 env 足够。 |
| 复用业务 API token 做权限 | 无法区分“能看 key”和“能读任务”；新增 admin token 最小可行。 |

## 验证

- 单测：`model-config.test.ts`（schema/默认值/掩码）、`config.test.ts`（override 不改 base、key env 名）。
- `scripts/model-config-smoke.mjs`：无 token 401、admin 创建/掩码列表/明文 reveal/审计、Worker 解析 DB 配置、真实任务写 `task.model_config_applied`、删除后 404。
- `pnpm run verify` 全绿；e2e 不依赖 DB 配置（删除后 env 回退）保持通过。
