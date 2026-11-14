# ADR-0031：独立 Browser capability service

- 状态：Accepted
- 日期：2026-11-12
- 关联：ADR-0017、ADR-0019

## 背景

现有 worker/executor 只能发 HTTP；现代 SPA 的 webpack lazy chunk、source map、DOM 路由和运行时签名逻辑需要真实浏览器执行。把 Chromium 放进通用 executor 会放大镜像、内存、安全与故障域。

## 决策

- 新增独立 `browser` 服务（Playwright + Debian Chromium），不接 DB/provider key。
- 只接 `execnet`，通过 `proxy:8080` 出站；请求携带 mission/task 头。
- 每个 task 独立 browser context；任务结束/TTL 回收。
- 工具：`browser_open`、`browser_snapshot`、`browser_act`、`browser_network`、`browser_chunks`、`browser_eval`（默认关闭）、`browser_close`。
- `browser_network` 将捕获的响应写为 target evidence；chunk/source map 写 artifact volume。
- 允许 `--no-sandbox`，但仅限一次性容器、无宿主挂载、cap_drop ALL、无秘密；这是以容器隔离换取 Chromium 可运行性，必须保持边界。
- 任务 scope 增加 `browser` 类别；proxy 仍是最终 scope 边界。
- 浏览器内容 untrusted；不得升级为系统指令。

## 边界

- 不是通用浏览器自动化平台；不支持下载、扩展、持久化 session、任意 OS 交互。
- `browser_eval` 默认关闭；开启时仍是受任务 scope 约束的执行面。
- 认证、登录流程可以由 Agent 操作 DOM，但凭据不得写入日志/报告；只允许任务内临时使用。

## 验证

- `services/browser` 单测（URL/网络解析）通过；
- 真实 worker 任务调用 `browser_open` 打开 webpack 靶场，捕获 3 个 JS chunk / login lazy chunk；
- 页面 title、DOM snapshot、traffic_id 落库；
- 越界 scheme 和跨 scope 导航拒绝。
