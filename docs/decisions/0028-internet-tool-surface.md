# ADR-0028：互联网工具面补齐 web_search / github_fetch / traffic_blob

- 状态：Accepted
- 日期：2026-11-11
- 关联：ADR-0002、ADR-0004

## 背景

架构目标中的互联网工具面只有 `web_fetch`；`web_search`、`github.fetch`、`traffic.blob` 缺失，Worker 无法主动发现参考页/PoC，也不能只读响应体。

## 决策

- 新增 `web_search`：
  - 通过 API 内部代理 `POST /internal/tools/search` 调用 **DeepSeek Search API**（`https://api.deepseek.com/v1/tools/search`）；
  - 支持 query/count/need_content，解析 `results[].title/url/snippet/summary/content/date/authority`；
  - provider key 只在 API 进程；executor 仅持有 MODEL_PROXY_TOKEN；
  - 搜索响应写入 evidence，标记 untrusted，结果不自动抓取（避免自动扩大范围）。
- 新增 `github_fetch`：
  - 只允许 `github.com`、`raw.githubusercontent.com`、`api.github.com`、`gist.githubusercontent.com`；
  - 支持 `url` 或 `repo` + `path` + `ref`（构造 raw URL）；
  - 内容写入 evidence，标记 untrusted。
- 新增 `traffic_blob`：只返回已记录 exchange 的响应体（去掉 headers），仍做 untrusted 标记；`traffic_get` 保留完整 request+response。
- API 内部工具代理同时提供 `POST /internal/tools/fetch`（DeepSeek Fetch API，Markdown 正文）；当前 `web_fetch` 保留原直接抓取路径，代理接口供后续工具/Agent 使用。
- 所有互联网请求继续经 egress proxy；scope 模式下需要 `INTERNET_ALLOWLIST`；open 模式按用户授权放行但审计。
- Agent 提示词增加三者用法；工具返回 `traffic_id` 供 finding 引用。

## 边界

- DeepSeek Search 需要可用的 provider key；API 内部代理转发，失败时工具返回错误而不是绕过代理。
- 搜索结果和 GitHub 内容都是不可信数据，不能升级为指令。
- GitHub token 不引入；匿名 API 限额由上游决定。
- `traffic_blob` 不是新的存储；只读取已有记录。

## 验证

- `parseSearchResults` 单测覆盖绝对/相对链接和 limit；
- 工具注册后 `harness-plugin` 测试通过；
- 网络受限环境下 web_search/github_fetch 会返回上游错误而不是绕过代理。
