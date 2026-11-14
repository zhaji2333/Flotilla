# ADR-0032：Mission artifact store 与本地文件导入

- 状态：Accepted
- 日期：2026-11-12
- 关联：ADR-0019、ADR-0031

## 背景

本地 APK/ELF/JS 不能通过挂载宿主目录进入容器：生产 Linux VPS 不存在该路径，且会把宿主文件系统暴露给 untrusted reverse/browser 服务。

## 决策

- 增加 `artifacts` 元数据表和共享 volume `src_agent_artifacts`。
- `POST /api/missions/:id/artifacts` 接收流式原始 body；服务端计算 SHA-256、限制大小、清洗文件名并写入 `<mission>/uploads/<sha256>/<filename>`。
- 相同 mission/文件 SHA 去重；不同 mission 不自动共享。
- CLI：`node scripts/upload-artifact.mjs <file> --mission <uuid>`。
- 任务创建可带 `artifactIds`；task payload 只保存 ID，Agent/reverse 服务通过 artifact 服务或共享路径读取，不接受任意宿主路径。
- artifact 只作为输入，不执行；reverse 服务分析子进程离线。

## 边界

- 首版只做 API + CLI，Web 拖拽上传后置。
- 默认最大 2GB；TTL 清理与容量配额后续纳入运维脚本。
- 文件是 untrusted；不得在通用 executor 中执行 APK/ELF。
