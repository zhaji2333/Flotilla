# ADR-0025：Dispatcher 多副本与 PostgreSQL advisory-lock leader 选主

- 状态：Accepted
- 日期：2026-11-11
- 关联：ADR-0019

## 背景

ADR-0019 把控制面 DB 写收敛到 dispatcher，但 dispatcher 仍是单副本：重启期间 Worker 无法 claim/finish，scheduler/watchdog 也停摆。

## 决策

- dispatcher 默认 2 副本（`DISPATCHER_REPLICAS`，默认 2）。
- 所有副本都可服务幂等的任务写：claim（`FOR UPDATE SKIP LOCKED`）、start、heartbeat、finish（fencing）、events、traces、request-index 等；DB 事务/行锁/fencing 负责并发正确性。
- **只有 leader** 执行周期性 scheduler/watchdog tick：
  - 使用 PostgreSQL session advisory lock（固定 int4 key）；
  - 持有专用连接；连接断开/进程退出自动释放；
  - 非 leader 每 2s 重试获取；
  - `/healthz` 返回 `leader` 标记；
  - 非 leader 的 scheduler/watchdog 返回 `skipped:true`，不报错。
- `deploy.replicas` 支持 Compose 本地多副本；Worker 仍通过 `dispatcher:9300` DNS 访问，任意副本可 claim。
- 生产部署可扩展副本数；数据库仍是唯一协调点，不引入 etcd/Redis。

## 边界

- leader 故障后最多约 2s 切换；切换期间 Worker 可能短暂 claim 失败，已有 storm guard/重试。
- 非 leader 仍会接受 claim/finish 请求；不是只读副本。
- 仍只有一个数据库；HA 目标是 dispatcher 进程/容器故障，不是数据库 HA。
- `scripts/*` 中按服务名 `docker compose exec dispatcher` 的脚本需要指定副本索引；这是测试脚本兼容项，不改变运行协议。

## 验证

- 启动 dispatcher-1/-2，只有一个 `/healthz` 返回 `leader:true`。
- 停止 leader 容器，约 2–4s 后另一副本成为 leader。
- 重启旧 leader，它保持 follower。
- 非 leader scheduler tick 返回 `skipped:true`，leader 正常执行。
