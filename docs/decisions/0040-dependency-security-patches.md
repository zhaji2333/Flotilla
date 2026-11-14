# ADR-0040：依赖安全补丁（zod 4 升级与 undici/zod overrides）

- 状态：Accepted
- 日期：2026-11-14
- 触发：首次推送 `main` 后 CI `quality` 失败——`pnpm audit --prod --audit-level high` 出现新的 high 公告：
  - `GHSA-mrhx-c7xc-m3w5` zod `<4.6.6`（约束集合校验可耗尽内存）；
  - undici `>=8.0.0 <8.12.2` 四个 high 公告（DoS / 跨源缓存投毒 / TLS 校验绕过）。
  同时 `docker-images-amd64 (proxy)` 因 CI 用仓库根做 build context、Dockerfile 里 `COPY go.mod` 找不到文件而失败。

## 决策

1. **zod 从 3.24.1 升级到 `^4.6.6`**（workspace 全部包）。zod 3.x 没有 backport，唯一修复版本是 4.6.6+。
   - 兼容性修复：`z.record(value)` → `z.record(z.string(), value)`（v4 要求显式 key schema）；
     `httpUrlSchema()` 返回类型从 `z.ZodTypeAny` 收窄为 `z.ZodString`；
     一个测试对 v4 的数组长度错误措辞放宽为 `/at most 6|<=6/`。
2. **用 `pnpm-workspace.yaml#overrides` 强制修复传递依赖**：
   - `zod: ^4.6.6` —— DSH 0.2.2-rc.1 内部仍锁 4.4.3（受同一公告影响），语义版本内兼容；
   - `undici: ^8.12.3` —— DSH 的 `dsh-http-proxy` 锁 8.11.2（受公告影响）。
   - pnpm 11 不再读取 `package.json#pnpm`，overrides 必须放 `pnpm-workspace.yaml`。
3. **CI 的 proxy 镜像改用 `proxy/` 作为 build context**（与 compose `build: ./proxy` 一致），
   matrix 增加可选 `context` 字段，默认 `.`。

## 代价与边界

- zod 4 是 major 升级：错误消息措辞有变化（测试已按语义放宽），`.strict()`/`.uuid()` 等旧接口仍可用
  （v4 提供兼容路径）；未使用 `zod/v3` 兼容子路径，后续新增 schema 直接按 v4 写。
- overrides 让 DSH 内部依赖与本仓库版本一致；若未来 DSH 官方升级到已修复版本，可移除 overrides
  并重新 `pnpm install` 验证。
- 仍存在 2 个 **moderate** 公告（低于 CI high 门槛），保留观察；不降低 `--audit-level high`。

## 验证

- `pnpm audit --prod --audit-level high --registry=https://registry.npmjs.org` → exit 0（仅 2 moderate）。
- `pnpm run verify` 全绿（lint/typecheck/全部单测/build），`pnpm test` 96/96（orchestrator）等。
- 本地 `docker build -f packages/api/Dockerfile .` 成功（frozen lockfile + overrides）。
