# ADR-0034：纯附件项目与任意网络外联

- 日期：2026-11-13
- 状态：已接受（用户明确确认）
- 相关：ADR-0001、ADR-0031、ADR-0033

## 背景

项目有时以本地 APK/ELF/SO/JS 等附件为核心目标，没有预先指定的网络 URL/IP/域名。
最初的实现把这个场景建模成“scope 为空”，因而也切断了 Worker 的网络能力；这
不符合用户要求：纯附件项目仍需要向附件中发现的 URL、API 或外部服务发起请求。

## 决策

1. 新建项目支持 `targetMode=attachment`：
   - `target` 可省略；
   - 必须至少上传一个 artifact；
   - bootstrap task 在附件落库前保持 `blocked`。
2. mission target 存为 `{type:"file", value:"attachments"}`。
3. 纯附件 mission 的 grant scope 为 `{..., allowAll:true}`：
   - 允许任意外联；
   - 所有请求仍必须经过 audited proxy，不能直连；
   - 不是通过关闭 proxy 或绕过审计实现。
4. 前端负责目标类型选项、附件必填 UX；后端负责强制校验和 scope 生成。
5. JSON 创建禁止 `targetMode=attachment`；file target 只能由 multipart 附件流程产生。

## 安全后果

`allowAll` 是显式的 mission grant，不是模型可控字段。但当前 proxy 的目标 scope 是
活跃 mission scope 的**并集**：当一个纯附件 mission 活跃时，并集 scope 会变为
allowAll，其他 mission 的目标流量也可能被放行/审计归因到附件 mission。该风险
必须由后续 per-mission authorization 收口；生产部署不应在不受信任的多 mission
并发环境中开启纯附件项目。

## 验证

- 纯附件 multipart 创建成功，scope 返回 `allowAll:true`；
- 纯附件 Worker 实际通过 `http_request` 访问目标，返回 HTTP 200；
- 证据请求 Host 保持真实目标 host，不含容器别名；
- `pnpm run verify` 通过。
