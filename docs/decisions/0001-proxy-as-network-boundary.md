# ADR-0001：出站代理是目标授权的网络边界

- 状态：已采纳（P0）
- 日期：2026-11-06
- 相关：[ADR-0002](0002-evidence-on-demand-postgres.md)、`proxy/`、`packages/tool-gateway/`

## 背景

P0 验收要求“越界请求 100% 拦截，包括容器内 `curl`”。只在 TypeScript 侧校验 URL 无法覆盖 `bash` 工具里的 curl、nmap、自写 Python 脚本等路径；只在代理里做静态 scope 又会让“目标入库”失效（每换一个目标都要改部署配置）。

## 决策

1. 自研 Go 出站代理（`proxy/`）作为**唯一目标流量网络边界**：HTTP/CONNECT、TLS 拦截、逐跳重定向校验、DNS 解析后 IP 校验、默认拒绝。
2. 代理的 target scope 从 PostgreSQL **动态加载**：`SCOPE_SOURCE=db` 时每 2 秒读取 `missions`（`pending`/`running`）关联的 `grants.scope` 并取并集。没有活跃 mission 时 scope 为空、拒绝全部目标流量（fail closed）。
3. Worker 容器注入 `HTTP_PROXY`/`HTTPS_PROXY` 与代理 CA（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`、`GIT_SSL_CAINFO`），`bash` 工具继承环境变量。容器同时 `read_only`、`cap_drop: ALL`、`no-new-privileges`。
4. 拦截返回统一信封 `{blocked_by: "platform", reason: "【Flotilla 平台管控·非目标防御】…"}`，并把拦截尝试写入 `proxy_denials` 审计表（该全局表后于 ADR-0019 删除）。

## 后果

- 目标进入数据库即可在网络上生效；越界请求无论走结构化工具还是容器内脚本都被同一处拦截。
- 代价：代理需要读取 PG、需要 CA 分发；动态 scope 的刷新窗口内 scope 变更不是即时的（P0 可接受，P1 换 per-worker 代理或令牌）。
- 已知限制：P0 单 Worker/单活跃 mission 语义；多 mission 并行时 scope 取并集，P1 需要 per-worker 授权。
