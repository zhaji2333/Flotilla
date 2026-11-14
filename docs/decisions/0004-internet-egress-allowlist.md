# ADR-0004：互联网检索使用显式白名单出站

- 状态：已采纳（P0）
- 日期：2026-11-06
- 相关：[ADR-0001](0001-proxy-as-network-boundary.md)、`proxy/internet.go`、`docker-compose.yml`

## 背景

架构文档把流量分为两类：目标流量（按 Grant scope 严格校验）与互联网检索流量（查 CVE、拉 PoC、读文档，允许自由访问但限速/留痕/去毒）。但 P0 同时要求“越界请求 100% 拦截”，而“互联网任意放行”会让任何公网域名都成为可访问目标，无法向用户证明越界拦截。

## 决策

1. P0 把互联网检索收敛为**显式主机白名单** `INTERNET_ALLOWLIST`（默认 `api.deepseek.com,example.com`，逗号分隔域名后缀）。
2. 代理分类顺序：先匹配 mission grant 的 target scope；不匹配再匹配互联网白名单；都不匹配 → 403 system_block + `proxy_denials` 审计（该全局表后于 ADR-0019 删除）。
3. 互联网请求仍要求 DNS 解析结果为公网 IP（拒绝回环/私网/链路本地/保留地址）；WebSocket 升级仍拒绝。
4. Worker 的 `web_fetch` 结果统一标记 `untrusted`，全文落 `evidence(kind='internet')`；模型 API 调用也在白名单内，保证 Worker 容器没有任何绕过代理的直接出站。
5. `INTERNET_ALLOWLIST` 由 .env 配置，属于部署级授权，不随 mission 变化。

## 后果

- 越界拦截可以被演示和测试（未在白名单的域名/IP 一律 403）。
- 代价：P0 的互联网检索面积比架构文档的“自由访问”更窄；P1 若要放开，需要独立配额、类别分类与人工审批，届时用新 ADR 评估。
- 代理拒绝的记录曾进入 `proxy_denials`；该全局表已由 ADR-0019 删除。
