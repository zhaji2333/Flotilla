# 新建项目 + 附件：后端接口逻辑文档

- 版本：v2（2026-11-12）
- 前端重做依据：本文件
- 关联 ADR：ADR-0031、ADR-0032、ADR-0033

## 1. 目标

新建项目（mission）时，直接提交：

```text
目标（target）或“纯附件”模式（attachment）
项目名 / objective
附件（APK / ELF / SO / DEX / JAR / JS ...）
```

不再要求用户先建 mission，再进入任务详情页上传附件。附件与 mission 的
bootstrap task 在同一个请求中创建，返回值直接带 `artifactIds`。

## 2. 接口

### 2.1 multipart 新建

```http
POST /api/missions
Content-Type: multipart/form-data
```

字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `targetMode` | string | 否 | `attachment` = 纯附件项目；此时 `target` 可省略且必须至少带 1 个附件 |
| `target` | JSON string | 二选一 | `{"type":"url","value":"http://..."}` / `{"type":"domain","value":"..."}` / `{"type":"ip","value":"..."}`；`targetMode=attachment` 时可省略 |
| `targetType` | string | 二选一 | `url` / `domain` / `ip`，与 `targetValue` 搭配 |
| `targetValue` | string | 二选一 | 真实目标值 |
| `objective` | string | 是 | 项目目标 |
| `name` | string | 否 | 项目名；省略时后端用 target 生成 |
| `maxSteps` | integer | 否 | 任务步数上限 |
| `maxWallClockMs` | integer | 否 | 任务墙钟上限 |
| `methodology` | string | 否 | 方法论说明 |
| `scopeExtras` | JSON string | 否 | `{domainSuffixes,ips,urlPrefixes}` |
| `priority` | number | 否 | 0..1 |
| `coverageGate` | JSON string | 否 | 覆盖闸配置 |
| `artifact` / `file` / `files` | file | 否 | 可重复，最多 20 个，单个受 `ARTIFACT_MAX_BYTES` 限制 |

> 纯附件模式：`targetMode=attachment`，后端强制要求至少一个文件；
> 纯附件仍可向外发起网络，全部经 audited proxy；其授权 scope 带 `allowAll: true`，
> 不是“scope 为空/禁网”。target 只是目标身份，不是网络能力的开关。

> 目标必须填**真实目标 host**，例如 `http://127.0.0.1:65280` 或
> `http://192.168.79.165:64280`。不要让前端填 `host.docker.internal`；
> 本地 host-only 目标的容器访问由服务端 proxy 的
> `PROXY_CONNECT_OVERRIDES` 在传输层处理，Host/证据/审计仍是真实目标。

成功 `201`：

```json
{
  "missionId": "uuid",
  "taskId": "uuid",
  "grantId": "uuid",
  "scope": {
    "domainSuffixes": [],
    "ips": ["127.0.0.1"],
    "urlPrefixes": [{"prefix": "http://127.0.0.1:65280", "ports": [65280]}],
    "exclude": []
  },
  "artifacts": [
    {
      "id": "uuid",
      "missionId": "uuid",
      "taskId": null,
      "sha256": "64hex",
      "size": 7233,
      "filename": "target.apk",
      "contentType": "application/vnd.android.package-archive",
      "storagePath": "mission/uploads/.../target.apk",
      "createdBy": "service:api",
      "createdAt": "..."
    }
  ],
  "artifactIds": ["uuid"]
}
```

后端会把 `artifactIds` 写入 bootstrap task 的 payload，Worker claim 后 prompt
中出现：

```text
UPLOADED ARTIFACTS (mission-scoped, use reverse tools when available): <ids>
```

### 2.2 JSON 新建（兼容，不带附件）

`targetMode=attachment` 的 JSON 创建会被 400 拒绝；纯附件必须走 multipart。


```http
POST /api/missions
Content-Type: application/json
```

```json
{
  "name": "my-target",
  "target": {"type": "url", "value": "http://127.0.0.1:65280"},
  "objective": "Find all flags",
  "maxSteps": 100
}
```

返回仍是原来的 `missionId/taskId/grantId/scope`，没有 `artifacts`。

### 2.3 附件列表

```http
GET /api/missions/:id/artifacts
```

返回当前 mission 的附件元数据；新建页提交成功后可直接展示，也可用于项目详情页。

### 2.4 附件生命周期

- 新建失败：后端会清理该 mission 已创建的附件和 DB 记录；
- mission 删除：删除 `/artifacts/<missionId>`；
- TTL：`POST /api/admin/artifacts/gc` 或 `scripts/artifact-gc.mjs`。

## 2.5 纯附件模式（targetMode=attachment）

结论：**前端做选项和 UX 校验，后端做权威校验和原子创建。**

前端职责：

- 目标类型增加“纯附件 / attachment”；
- 选择后隐藏/禁用 target 类型与 target 值；
- 附件区变为必填；
- 提交 `targetMode=attachment` + 至少一个 `artifact`；
- 客户端校验只是提示，不能作为安全边界。

后端职责（已实现）：

- `targetMode=attachment` 时忽略网络 target，写入 `{type:"file",value:"attachments"}`；
- 没有附件直接 `400 targetMode=attachment requires at least one uploaded artifact`；
- JSON `POST /api/missions` 不允许 `targetMode=attachment`（没有附件载体）；
- scope 为 `{allowAll:true}`，Worker 仍可向外发起网络（经 proxy 全程审计），同时只把 uploaded artifact 作为核心输入；
- bootstrap task 先 blocked，附件写入后才 activation；
- 失败回滚 mission 和 artifact 文件。

因此：**纯附件选项本身是前端 UI 功能，但“必须上传文件”的强制检查必须由后端做。**

## 3. 前端重做建议

### 3.1 新建项目表单

```text
项目名（可选）
目标类型：URL / Domain / IP
目标值（真实 host，例如 http://127.0.0.1:65280）
项目目标 objective
附件上传（拖拽/多选，可选）
高级选项（maxSteps / maxWallClockMs / scopeExtras / priority）
[创建项目]
```

目标值输入框不要做“host.docker.internal 自动替换”；这是服务端网络细节。

新增目标类型选项：`纯附件 / attachment`。
- 选择纯附件：隐藏/禁用目标类型与目标值；附件区变为必填；提交时带 `targetMode=attachment`；
- 前端必须做文件必填校验，但**后端仍会强制校验**（防止绕过 UI）；
- 纯附件项目的详情页 target 显示为 `file:attachments` 或“纯附件”，不要显示 IP/URL。

### 3.2 附件选择

- 支持 `.apk/.so/.elf/.dex/.jar/.js` 等，后端不按扩展名拒绝；
- 多文件，最多 20 个；
- 单文件 > 2GB 直接前端提示；
- 显示文件名、大小、hash 前缀、上传进度；
- 提交按钮在文件上传期间禁用；支持取消（AbortController）。

### 3.3 提交（FormData 示例）

```ts
const form = new FormData();
form.set('target', JSON.stringify({ type: 'url', value: targetValue }));
form.set('name', name);
form.set('objective', objective);
for (const file of files) form.append('artifact', file);

const xhr = new XMLHttpRequest();
xhr.open('POST', `${BASE}/api/missions`);
xhr.withCredentials = true;
if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);
if (DEV_TOKEN) xhr.setRequestHeader('authorization', `Bearer ${DEV_TOKEN}`);
xhr.upload.onprogress = event => {
  if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100));
};
xhr.onload = () => {
  if (xhr.status === 201) {
    const created = JSON.parse(xhr.responseText);
    navigate(`/missions/${created.missionId}`);
  }
};
xhr.send(form);
```

不要手动设置 `Content-Type`，让浏览器生成 multipart boundary。

### 3.4 创建后

- 直接跳转项目详情，显示 target 和已上传附件；
- 不再要求“先创建空项目再上传附件”；
- 详情页附件区可保留只读列表/补传入口（后端仍支持 `POST /api/missions/:id/artifacts`），但核心新建流程不依赖它。

## 4. 错误语义

| 状态 | 场景 |
|---|---|
| 400 | target/objective 非法、字段 JSON 非法、文件为空、multipart 解析失败 |
| 401 | 未登录 |
| 403 | 非 operator/admin |
| 413 | 文件超过 `ARTIFACT_MAX_BYTES` |
| 500 | 服务端存储/DB 失败（已尽力回滚） |

## 5. 本地 host-only 目标

如果目标只监听宿主机 `127.0.0.1`，容器无法直接访问；这是**部署侧**配置，不是前端字段：

```bash
# .env（仅单机 lab）
PROXY_CONNECT_OVERRIDES=127.0.0.1:65280=host.docker.internal:65280
```

这样：

- mission target、请求包 Host、证据 URL、审计 URL：`127.0.0.1:65280`
- proxy 实际拨号：`host.docker.internal:65280`
- 前端和报告都看不到 `host.docker.internal`
