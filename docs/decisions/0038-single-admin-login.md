# ADR-0038：单管理员登录、首次强制改密码

- 状态：Accepted
- 日期：2026-11-13
- 关联：ADR-0007、ADR-0017

## 背景

控制台此前默认 `AUTH_MODE=legacy`，并且 nginx 对**所有**请求注入 `API_LEGACY_TOKEN`
（`Bearer dev-admin-token`）。结果是：

- 浏览器访问 SPA 时，`GET /api/auth/me` 直接返回 `service:api`（admin）身份；
- 登录页永远不会成为门槛，任何人都能用控制台；
- `users` 表还带有账号创建/改角色/重置密码接口，但部署只需要一个管理员。

## 决策

### 1. 单管理员 + 默认账号

- API 启动时（`applySchema` 之后）调用 `ensureDefaultAdmin()`：
  仅当 `users` 表为空时创建 `admin` / `admin123`，`role=admin`、`must_change_password=true`。
  已存在用户时不覆盖、不重置。
- 用户名/初始密码可用 `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` 覆盖。
- 删除账号管理接口（`POST /api/admin/users`、`PATCH /api/admin/users/:id`、
  `POST /api/admin/users/:id/reset-password`）与 `POST /api/auth/setup`；前端删除账号页与导航。
  单管理员忘记密码时用 SQL/运维手段重置，不提供 Web 自助。

### 2. 首次登录强制改密码

- 登录成功后会话携带 `must_change_password`；此时除
  `/api/health`、`/api/auth/me`、`/api/auth/password`、`/api/auth/logout` 之外的所有路由返回
  `403 {"error":"password_change_required"}`（服务端强制，不是前端提示）。
- 改密码成功后：`changeOwnPassword` 置 `must_change_password=false` 并吊销全部会话，API 立即
  签发新会话 cookie 返回，前端直接进入控制台。

### 3.1 首次改密的字段语义（2026-11-13 补充）

- `当前密码` = **刚才登录时用的密码**（首次登录就是初始密码 `admin123`），不是想设置的新密码；
- `新密码 / 确认新密码` = 想设置的那个；
- 服务端错误信息区分两种情况：当前密码错误返回
  `{error: "当前密码不正确：首次登录的当前密码仍是初始密码（默认 admin123）…", field: "currentPassword"}`；
  强度不足返回 `400 validation failed` + `issues[].path = ["newPassword"]`；
- 改密页提供「显示密码」开关与字段说明，避免大小写/特殊字符输错。

### 3. 密码强度

- 至少 12 位，且同时包含大写字母、小写字母、数字、特殊字符（非字母数字）；
- 服务端 `packages/api/src/password-policy.ts` 为唯一权威（zod `superRefine`），
  前端 `packages/frontend/src/lib/password.ts` 只是同规则的实时清单，两侧都有测试。

### 4. 真正的浏览器登录

- 默认 `AUTH_MODE=accounts`（compose 默认值同步修改）。
- nginx 不再对浏览器注入服务 token：只有当请求**没有** `Sec-Fetch-*` 头（即脚本/curl 等自动化）
  时才注入 `API_LEGACY_TOKEN`；浏览器请求只能靠会话 cookie 认证。
- 自动化（E2E/smoke/运维脚本）继续用 `Authorization: Bearer <API_AUTH_TOKEN>`，行为不变。

## 代价与残余

- 默认密码是公开的，必须配合首次改密码；不改密码时控制台**不可用**（只有改密码页）。
- `API_AUTH_TOKEN` 仍可直连 API 绕过登录——这是自动化通道，部署上必须视为等价于管理员密码，
  生产需替换为强随机值并限制来源。
- 单管理员没有 RBAC/多租户；需要多人时再引入账号体系。

## 验证

- 单测：`packages/api/src/password-policy.test.ts`、`packages/frontend/src/lib/password.test.ts`、
  `tests/spa-auth-proxy.test.mjs`（nginx 模板必须按 `Sec-Fetch-*` 门控 `API_LEGACY_TOKEN`）。
- 实机（2026-11-14）：临时设置 `API_LEGACY_TOKEN='Bearer dev-admin-token'` 后
  - 无 `Sec-Fetch-*` 的 curl → 200（自动化兜底生效）；
  - 带 `Sec-Fetch-Mode/Site/Dest`（浏览器形态）→ 401（必须会话登录）；
  - 显式 `Authorization: Bearer` → 200；恢复默认空后无头请求 401。
- 手工：`admin/admin123` 登录 → `/api/missions` 返回 403 `password_change_required` →
  弱密码 400 → 强密码 200 且返回新会话 → 控制台可用；重启 API 不会重置已存在账号。
