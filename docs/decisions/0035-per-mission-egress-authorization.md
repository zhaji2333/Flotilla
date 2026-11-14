# ADR-0035：出站代理按 mission 授权（allowAll 隔离）

- 状态：Accepted
- 日期：2026-11-13
- 关联：ADR-0017、ADR-0019、ADR-0031、ADR-0034

## 背景

ADR-0034 允许纯附件项目使用 `grant.scope.allowAll = true`，通过审计代理发起任意出站请求。
但代理的 target 授权一直是**所有 active mission scope 的并集**（`newScopeFromGrants` 只要遇到一个
`allowAll` 就返回 `NewUnrestrictedScope()`），流量归属则靠 URL 匹配。

带来两个问题：

1. **授权放大**：只要有一个纯附件 mission 处于 `pending/running/paused`，其他所有 mission
   （包括带真实 target 的普通 mission）的出站请求都会被放行，无论是否在自己的 grant 内。
2. **审计串号**：`MissionForURL` 会命中 `allowAll` 的 mission，其他 mission 的目标流量可能被记到
   它名下。

单 mission 的 E2E 看不出来，多 mission 并发时这是真实的安全隔离缺陷。ADR-0034 已把它列为
"多 mission 生产使用前必须收口"。

## 决策

代理改为**按 mission 授权**，不再用并集决定 scope 模式的放行：

- `X-SRC-Mission-Id`（我们的工具、browser 服务会带，转发前剥离）有效且该 mission 活跃时：
  - 只用**这个 mission 自己的 grant** 校验；命中 → `target`；
  - 未命中 → 检查互联网白名单 → `internet`；
  - 都不命中 → 403，**不再回退到并集**。
- 无 header 的流量（bash/curl/脚本）：
  - 只匹配**声明了具体 host/domain/IP/URL 前缀**的 mission grant；
  - `allowAll` grant **不参与** URL 匹配，因此不能授权无归属流量；
  - 唯一例外：当前**只有一个** active mission 且它是 `allowAll`（归属无歧义），此时放行并归属到它。
- 审计归属：
  - `target` 流量优先用 header mission，但仅当该 mission 自己的 grant 确实授权了本次请求；
    否则回退到服务端 URL 匹配（同样跳过 `allowAll`）。
  - `internet` 流量沿用已验证的 header。
- Dial 时的 DNS 重绑定校验也必须用**同一个 mission 的 grant**：授权结果（mode + scope）随请求
  context 传到 `dialContext`，不再读并集 scope（否则一个 allowAll mission 会让所有 mission 的
  DNS pinning 失效）。`EGRESS_MODE=open` 行为不变（显式调试模式，仍然全部放行并审计）。

## 代价与残余风险

- 纯附件 mission 在 `scope` 模式下，**bash/curl 生成的出站流量**只有在该 mission 是唯一 active
  mission 时才放行；多 mission 并行时必须走 `http_request` / browser 工具（它们带 mission header）。
  这是有意的：无归属流量无法安全地映射到某个 allowAll 授权。
- header 由客户端提供，agent 理论上可以声称另一个活跃 mission 的 id；但授权仍以**该 mission 自己
  的 grant** 为准，所以只能拿到那个 mission 本来就被授权的范围，不会凭空扩大授权。真正的归属
  防伪需要 per-task 凭据（未实现，记录为后续项）。
- 代理每 3 秒刷新一次 mission 快照，因此新建/删除 mission 与授权生效之间有 ≤3s 延迟。

## 验证

- `proxy/mission_isolation_test.go`：
  - `TestAllowAllMissionDoesNotWidenHeaderlessTraffic`（回归：无 header 不被 allowAll 放行）；
  - `TestAttributedMissionIsLimitedToItsOwnGrant`（header mission 不能越界）；
  - `TestAttributedAllowAllMissionReachesAnyHost`（自己的流量仍可任意出站）；
  - `TestSingleAllowAllMissionAuthorizesUnattributedTraffic`；
  - `TestDBScopeProviderSnapshotIsolatesAllowAll`（真实 provider 快照语义）；
  - `TestProxyBlocksCrossMissionAllowAllBypass`（端到端 403 且不 dial 上游）；
  - `TestDialTimePinningUsesMissionGrantNotUnion`（allowAll 活跃时受限 mission 的 DNS 重绑定仍被拦截）。
- `go test ./...`、`go vet ./...`。
