# ADR-0033：独立 Reverse capability service

- 状态：Accepted
- 日期：2026-11-12
- 关联：ADR-0019、ADR-0031、ADR-0032

## 背景

APK/ELF 逆向需要 JADX/ASC/Hermes/IDA 等重工具；把它们塞进通用 executor 会放大镜像、许可证和攻击面。逆向样本又经常来自目标，需要和浏览器/HTTP 证据在同一条 finding 链上。

## 决策

- 新增独立 `reverse` 服务，只读 artifact volume，无 DB/provider key。
- 采集由 executor/API 完成（本地文件走 artifact upload；目标文件走 proxy），reverse 分析核心离线。
- JADX/ASC/RN/Hermes 通过专用 job 执行；输出写 artifact volume，只返回 bounded 摘要和分页搜索。
- IDA 用 **直接 idalib Python**，不使用 MCP、不打开 GUI；通过一次单独构建把 IDA/idalib/license/EULA 固化为自包含 `reverse-ida` 镜像，运行时不再依赖外部 IDA volume 或 license 挂载。
- 工具：`artifact_list`、`reverse_apk`、`reverse_ida`、`reverse_search`。
- 工具输出 untrusted；不自动执行 APK/ELF。

## 边界

- 首版 APK 以无壳/普通包为主；脱壳仍由 CkSKILLS 工作流和单独工具处理。
- IDA 自包含镜像需要构建时有可用 license/安装；无该镜像时 `reverse_ida` 明确失败，不影响 JADX/ASC。
- 单服务默认 2 个并发 job；重任务内存与 JVM 限制由 compose 配置。

## 验证

- 对 `ctf-mobile.apk`：JADX 3.05s 完成，ASC 提取 manifest/refs，RN bundle 识别为 JavaScript，提取 `SIGN_SECRET`/`QUERY_PATH`；后续 HMAC 伪造请求获得 stage1/stage3 flag。
- IDA 9.5 安装、idalib Python 和 `ida_runner.py` 已验证可导入；当前提供的 `idapro.hexlic` 在官方未打补丁 IDA 上校验失败，IDA 能力需等待官方 license。
- `reverse_search` 可定位 decompiled 文件/行。
