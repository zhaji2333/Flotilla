# ADR-0016：版本化数据库迁移（baseline schema + one-time migrations）

- 状态：已实施（2026-11-08）
- 关联：技术债清理；`packages/contracts/src/db/schema.sql`、`packages/contracts/src/db/migrations/`、`packages/control-plane/src/db-schema.ts`
- 影响：API / Worker / Planner 启动、数据库升级、CI

## 背景

此前所有数据库变更都写在 `schema.sql`，由 worker/planner 在启动时重复执行。该文件包含幂等的 `CREATE TABLE IF NOT EXISTS`、`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`，也混入了少数一次性清理：

- `DROP TABLE IF EXISTS traffic_evidence`；
- `DROP TABLE IF EXISTS portfolio_*`（M5 修订后删除跨项目 portfolio）。

这样虽然能让旧 checkout 收敛，但有两个问题：

1. **破坏性操作每次启动都会执行**，且没有版本/审计记录；
2. schema 既承担“当前结构”又承担“历史清理”，无法判断哪些操作只应执行一次。

## 决策

1. **baseline schema**：`schema.sql` 只保留幂等的建表/列/索引/视图；不再包含 `DROP TABLE` 等一次性破坏性操作。
2. **versioned migrations**：`packages/contracts/src/db/migrations/NNNN-*.sql` 按文件名排序执行；每个文件只执行一次，记录到 `schema_migrations(version, applied_at)`。
3. **统一执行器**：`packages/control-plane/src/db-schema.ts` 提供 `applySchema`：
   - 先执行 baseline；
   - 再用 PostgreSQL advisory lock 串行化 migration，避免 API/worker/planner 同时启动重复执行；
   - 每个 migration 在事务内执行，失败回滚。
4. **所有服务使用同一入口**：API 启动时也执行 `applySchema`（不再依赖 worker 先建表）；worker/planner 保持原 `../db/schema.js` 导入，实际 re-export 同一实现。
5. **一次性清理迁移**：`0001-drop-legacy-tables.sql` 删除 `traffic_evidence` 与旧 `portfolio_*` 表；新库上执行也是安全的。
6. **守卫**：仓库测试禁止 baseline schema 出现 `DROP TABLE`，并要求 migrations 文件名有序、存在已知清理迁移。

## 未来规则

- 新增表/列/索引：可继续写入 baseline（幂等），也可以写 migration；破坏性/不可逆变更必须写 migration。
- migration 只追加、不改已发布文件；回滚用新的 migration，不删除历史。
- 生产发布前需要备份；迁移失败会阻止对应服务启动。

## 验证

- 启动 API/worker/planner，`schema_migrations` 有 `0001-drop-legacy-tables.sql`；
- 重复启动不重复执行；
- `portfolio_*` 表不存在；
- `tests/repository.test.mjs` 校验 baseline 无 `DROP TABLE` 且 migration 文件有序；
- 实际启动日志出现 `[schema] applied migration 0001-drop-legacy-tables.sql`；`schema_migrations` 有记录；重复启动不重复执行；e2e 201/0。
