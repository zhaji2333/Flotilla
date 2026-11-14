# 前端对接：模型配置「测试连接」

- 版本：v1（2026-11-13）
- 关联：ADR-0009（十二项指标）、ADR-0011（key 明文落库）、ADR-0026（角色回退）
- OpenAPI：`docs/api/openapi.yaml` → `POST /api/model-configs/test`、`POST /api/model-configs/{id}/test`

## 1. 用途

在保存/启用模型配置前，验证：

```text
网关 baseUrl 是否可达
provider key 是否有效
modelName 是否被该 key 授权
上游是否真的返回 completion
```

因为是**真实调用**，会产生少量 token 费用；探针只发一句 `Reply with exactly: OK`，
`max_tokens` 最大 512。

## 2. 权限

- 仅 **admin**（与模型配置管理一致：`API_ADMIN_TOKEN`）。
- 普通/只读 token 返回 `403 {"error":"forbidden"}`。
- 前端不要缓存 admin token，不要写 localStorage/URL。

## 3. 接口

### 3.1 测试未保存的草稿（新建表单）

```http
POST /api/model-configs/test
Content-Type: application/json
```

```json
{
  "baseUrl": "https://tokenrhythm.studio/v1",
  "apiKey": "sk-...",
  "modelName": "deepseek-v4.1-flash-1017",
  "maxOutputTokens": 384000
}
```

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `baseUrl` | 是 | 网关根，含 `/v1`；后端会归一化尾部斜杠 |
| `apiKey` | 是 | 明文，仅用于本次探测，不回显、不落日志 |
| `modelName` | 是 | 上游模型 ID |
| `maxOutputTokens` | 否 | 只用于限制探针；缺省 512 |

### 3.2 测试已保存的配置（列表页/编辑页）

```http
POST /api/model-configs/:id/test
Content-Type: application/json
```

```json
{}
```

默认复用已保存的 `baseUrl` / `modelName` / **已保存的 key**；可传同名字段覆盖：

```json
{ "modelName": "neohorse-1-9b" }
```

编辑场景推荐：

- 用户**没改 key** → 传 `{}`，由后端用库里保存的 key；
- 用户**改了 key** → 传 `{ "apiKey": "sk-new..." }`。

> 也可以一个接口走到底：`POST /api/model-configs/test` 带 `id` + 只改动的字段。
> 例如 `{ "id": "<uuid>", "modelName": "neohorse-1-9b" }`。

## 4. 响应

HTTP 状态始终是 **200**（只要请求本身合法），成败看 `ok`：

```json
{
  "ok": true,
  "latencyMs": 568,
  "httpStatus": 200,
  "model": "neohorse-1-9b",
  "reply": "OK",
  "usage": {
    "completion_tokens": 12,
    "prompt_tokens": 73,
    "total_tokens": 85
  },
  "error": null,
  "errorCode": null,
  "traceId": "trace_..."
}
```

失败示例（网关拒绝该模型）：

```json
{
  "ok": false,
  "latencyMs": 243,
  "httpStatus": 403,
  "model": null,
  "reply": null,
  "usage": null,
  "error": "鉴权/权限失败 (MODEL_ACCESS_DENIED)：当前模型仅对灰度用户开放",
  "errorCode": "MODEL_ACCESS_DENIED",
  "traceId": "trace_..."
}
```

DNS/网络失败：

```json
{
  "ok": false,
  "latencyMs": 150,
  "httpStatus": null,
  "error": "无法连接模型网关：getaddrinfo ENOTFOUND no-such-gateway.invalid",
  "errorCode": "NETWORK"
}
```

超时：

```json
{ "ok": false, "httpStatus": null, "error": "连接超时（>30000ms）：model probe timed out after 30000ms", "errorCode": "TIMEOUT" }
```

字段：

| 字段 | 说明 |
|---|---|
| `ok` | 是否可用（2xx 且拿到 content/reasoning） |
| `latencyMs` | 端到端耗时（含网络） |
| `httpStatus` | 上游 HTTP 状态；网络失败为 `null` |
| `model` | 上游回显的模型 ID（用于确认网关真的路由到该模型） |
| `reply` | 上游文本（截断 500 字符，已脱敏） |
| `usage` | token 用量（用于估算费用） |
| `error` | 归一化的中文错误描述 |
| `errorCode` | 上游错误码或 `NETWORK` / `TIMEOUT` / `EMPTY_COMPLETION` |
| `traceId` | 上游 trace id（少量网关返回）；排查时贴给供应商 |

### 错误码语义

| errorCode / httpStatus | 含义 | 前端建议 |
|---|---|---|
| `401` / `UNAUTHORIZED` | key 无效或过期 | 提示重新填 key |
| `403` / `MODEL_ACCESS_DENIED` | key 无该模型权限（如灰度未开放） | 换模型或申请权限 |
| `404` / 接口不存在 | baseUrl 路径或 modelName 不对 | 检查是否多/少 `/v1` |
| `429` | 上游限流 | 稍后重试 |
| `5xx` | 上游异常 | 稍后重试 |
| `NETWORK` | DNS/连接失败 | 检查 baseUrl 与网络 |
| `TIMEOUT` | 超过 30s | 换更快模型或重试 |
| `EMPTY_COMPLETION` | 2xx 但无文本（预算被推理耗尽） | 增大 `maxOutputTokens` |

## 5. 界面建议

### 5.1 新建/编辑弹窗

在 `apiKey` 输入框旁边放一个「测试连接」按钮：

```text
[ baseUrl ] [ modelName ]
[ apiKey ............ ]  [测试连接]
```

点击后：

1. 前端先校验 `baseUrl` / `modelName` / `apiKey`（新建）；
2. 按钮进入 loading（禁用重复点击）；
3. 调 `/api/model-configs/test`（新建）或 `/:id/test`（编辑、key 未改）；
4. 结果以**内联状态条**展示，不用 toast 弹一次就没了：

```text
✅ 连接成功 · 568ms · neohorse-1-9b · 85 tokens
❌ 鉴权/权限失败 (MODEL_ACCESS_DENIED)：当前模型仅对灰度用户开放
```

5. 失败时把 `error` 原样展示，`errorCode`/`traceId` 放小字（可复制）。

### 5.2 列表行

每行加一个「测试」图标按钮，调 `/:id/test`，成功后显示延迟徽章：

```text
deepseek-v4.1-flash-1017   worker · 默认   ✅ 1056ms
```

失败显示红色「不可用」，不自动改配置状态（测试是只读探测，不写库）。

## 6. 前端实现示例

```ts
export interface ModelConfigTestResult {
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  model: string | null;
  reply: string | null;
  usage: Record<string, number> | null;
  error: string | null;
  errorCode: string | null;
  traceId: string | null;
}

export function testModelConfigDraft(
  adminToken: string,
  actor: string,
  input: { baseUrl: string; apiKey: string; modelName: string; maxOutputTokens?: number },
): Promise<ModelConfigTestResult> {
  return request<ModelConfigTestResult>('/api/model-configs/test', {
    method: 'POST',
    headers: { 'x-admin-token': adminToken, 'x-actor': actor },
    body: JSON.stringify(input),
  });
}

export function testModelConfigStored(
  adminToken: string,
  actor: string,
  id: string,
  override?: { apiKey?: string; modelName?: string; baseUrl?: string },
): Promise<ModelConfigTestResult> {
  return request<ModelConfigTestResult>(`/api/model-configs/${id}/test`, {
    method: 'POST',
    headers: { 'x-admin-token': adminToken, 'x-actor': actor },
    body: JSON.stringify(override ?? {}),
  });
}
```

> 现有 `lib/api.ts` 的 `adminHeaders()` 已经处理了 admin token/actor 头，直接复用。

## 7. 注意

- 测试**不会**修改配置、不会切换默认模型、不写 `model_config_audit`。
- 测试**不会**把 key 写进响应或日志；前端也不要把 key 放进 URL/埋点。
- 测试只调用 `chat/completions`，不验证 tool-calling 行为；工具调用能力靠真实任务验证。
- 单次测试有 30s 超时（`MODEL_TEST_TIMEOUT_MS` 可调）。
- 免费/限免模型（如 `neohorse-1-9b`）仍会产生调用记录，但当前单价为 0。
