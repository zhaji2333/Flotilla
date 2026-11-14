# 前端对接：新建项目时上传附件（v2 优先）

> **2026-11-12 更新**：新建项目现在支持 `POST /api/missions` 的
> `multipart/form-data`，把 target/objective/附件一次提交；请优先阅读
> [mission-create-multipart-handoff.md](mission-create-multipart-handoff.md)。
> 本文保留作为 mission 创建后的补传/管理接口说明。

# 前端对接：Mission Artifact 上传与逆向任务

- 版本：v1（2026-11-12）
- 对应 ADR：ADR-0031、ADR-0032、ADR-0033
- OpenAPI：`docs/api/openapi.yaml` 已包含 `/api/missions/{id}/artifacts`、`/api/admin/artifacts/gc` 和 task `artifactIds`
- 范围：**只对接 API/UI，不直连 reverse/browser 服务**

## 1. 结论

前端需要新增两块能力：

1. **Mission 详情页上传样本**
   - 本地 APK / ELF / SO / DEX / JAR / JS 等文件；
   - 上传到 `/artifacts/<mission>/uploads/...`；
   - 只返回 artifact 元数据，不返回文件内容。

2. **手动任务选择样本**
   - 创建 manual task 时带 `artifactIds`；
   - Agent 通过 `artifact_list` / `reverse_apk` / `reverse_ida` / `reverse_search` 使用它们。

前端**不要**直接调用：

```text
reverse:9402
browser:9401
```

这些是内部服务，只有 executor/Agent 通过内部 token 调用。

---

## 2. 鉴权与权限

- 上传是 mission 变更操作，需要当前登录用户角色为 **operator 或 admin**。
- 普通 viewer 只能看 artifact 列表，不能上传。
- 请求沿用现有前端会话：
  - `credentials: 'same-origin'`；
  - CSRF：非 GET 请求需要现有 `csrfToken`，放在 `x-csrf-token`；
  - 开发模式仍使用现有 `VITE_API_TOKEN` Bearer；
  - 生产由 nginx 注入 Bearer，不要把 admin token 放进前端 bundle。
- 不要在浏览器里保存 provider key、admin token 或 artifact 原始内容。

---

## 3. API

### 3.1 上传

```http
POST /api/missions/:missionId/artifacts
```

Headers：

```http
Authorization: Bearer <由现有认证层处理>
Content-Type: application/octet-stream
X-Artifact-Filename: <encodeURIComponent(filename)>
X-CSRF-Token: <session csrf token>
```

Body：原始文件字节（**不是 multipart/form-data**）。

限制：

- 默认最大 2GB（服务端 `ARTIFACT_MAX_BYTES`）；
- 大文件流式读取，浏览器端不要先读成 string；
- 文件名只用于展示，服务端会清洗。

成功 `201`（同 mission 同 SHA 已存在时 `200`）：

```json
{
  "artifact": {
    "id": "uuid",
    "missionId": "uuid",
    "taskId": null,
    "sha256": "64hex",
    "size": 7233,
    "filename": "ctf-mobile.apk",
    "contentType": "application/octet-stream",
    "storagePath": "..",
    "createdBy": "user:...",
    "createdAt": "2026-11-12T..."
  }
}
```

前端不要依赖 `storagePath` 做文件操作；只使用 `artifactId`。

错误：

| 状态 | 含义 |
|---|---|
| 400 | missionId/文件名/空 body 非法 |
| 401 | 未登录 |
| 403 | 非 operator/admin |
| 404 | mission 不存在 |
| 413 | 超过大小限制 |
| 500 | 服务端写入失败 |

### 3.2 列表

```http
GET /api/missions/:missionId/artifacts
```

返回：

```json
{
  "artifacts": [
    {
      "id": "uuid",
      "missionId": "uuid",
      "taskId": null,
      "sha256": "64hex",
      "size": 7233,
      "filename": "ctf-mobile.apk",
      "contentType": "application/octet-stream",
      "storagePath": "internal-relative-path-ignored-by-ui",
      "createdBy": "user:...",
      "createdAt": "..."
    }
  ]
}
```

列表不返回文件正文；响应可能包含内部相对 `storagePath`，前端必须忽略它，不要拼接、展示或用于文件操作。

### 3.3 创建带样本的 manual task

```http
POST /api/missions/:missionId/tasks
```

```json
{
  "objective": "逆向该 APK，提取硬编码签名密钥并验证 API",
  "angle": "binary",
  "maxSteps": 30,
  "maxWallClockMs": 600000,
  "artifactIds": ["artifact-uuid"]
}
```

`artifactIds` 会被校验必须属于当前 mission。Agent prompt 会收到：

```text
UPLOADED ARTIFACTS ...: <ids>
```

### 3.4 项目销毁

已有：

```http
DELETE /api/admin/missions/:missionId
{ "confirmName": "<mission name>" }
```

现在除了数据库级联删除，还会删除：

```text
/artifacts/<missionId>/
```

包括上传文件、reverse/jadx/IDA 输出、browser chunk/HAR 等。

### 3.5 TTL 清理（管理端）

```http
POST /api/admin/artifacts/gc
```

```json
{ "days": 7 }
```

返回：

```json
{ "cutoff": "...", "removedFiles": 12, "removedArtifacts": 3 }
```

运维侧也可用：

```bash
API_ADMIN_TOKEN=... node scripts/artifact-gc.mjs --days 7
```

这个接口不暴露在普通页面；放管理维护区或只读展示最近运行结果。

---

## 4. Web 上传 UI 方案

### 4.1 位置

建议放在 **Mission 详情页**，不要新建全局页面：

```text
/missions/:id  →  “样本 / 逆向输入” 区块或 Tab
```

如果当前 mission 页已有「待办/触发器/审批」Tab，可增加：

```text
样本 (artifacts)
```

仅 operator/admin 显示上传按钮；viewer 只显示列表。

### 4.2 交互

1. 按钮「上传样本」+ 拖拽区；
2. 选择文件后先做客户端检查：
   - 扩展名提示（`.apk/.so/.elf/.dex/.jar/.js`）；
   - 超过 2GB 直接提示，不上传；
3. 上传中显示进度条、文件名、大小、取消按钮；
4. 成功后刷新列表；
5. 每一行显示：
   - 文件名
   - 类型/扩展名
   - 大小
   - SHA-256 前 12 位
   - 上传时间
6. 创建任务时，在「样本」区块勾选 artifact，提交 `artifactIds`。

### 4.3 建议组件

```text
MissionArtifactsPanel
  ├─ UploadDropzone
  ├─ UploadProgress
  └─ ArtifactList
```

不要把 reverse 输出直接渲染到样本列表；reverse 输出属于 task trace/artifact volume，不是上传 input。

### 4.4 错误/空态/加载

- 空态：`暂无上传样本`；
- 上传失败：显示 HTTP 状态 + 可读错误；
- 列表加载失败：可重试；
- 上传中禁用重复提交；
- 任务创建前若 artifact 已过期/被 GC 删除，API 会返回 400，前端提示重新上传。

---

## 5. 建议 API 客户端实现

在现有 `packages/frontend/src/lib/api.ts` 中增加：

```ts
export interface Artifact {
  id: string;
  missionId: string;
  taskId: string | null;
  sha256: string;
  size: number;
  filename: string;
  contentType: string;
  createdAt: string;
}

export async function listArtifacts(missionId: string): Promise<Artifact[]> {
  const response = await request<{ artifacts: Artifact[] }>(
    `/api/missions/${missionId}/artifacts`,
  );
  return response.artifacts;
}

export function uploadArtifact(
  missionId: string,
  file: File,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
): Promise<Artifact> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/api/missions/${missionId}/artifacts`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-artifact-filename', encodeURIComponent(file.name));
    if (csrfToken) xhr.setRequestHeader('x-csrf-token', csrfToken);
    if (DEV_TOKEN) xhr.setRequestHeader('authorization', `Bearer ${DEV_TOKEN}`);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, '上传网络错误'));
    xhr.onabort = () => reject(new ApiError(0, '上传已取消'));
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        const record = (body ?? {}) as { error?: string };
        reject(new ApiError(xhr.status, record.error ?? `HTTP ${xhr.status}`));
      } else {
        resolve((body as { artifact: Artifact }).artifact);
      }
    };
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
```

注意：`csrfToken` 和 `DEV_TOKEN` 目前是 `api.ts` 私有变量；应把上传函数放在同一个文件，或抽出内部 helper，不要从组件直接读取/写 token。

---

## 6. 状态与文案建议

中文标签：

```text
样本 / Artifacts
上传样本
上传中…
上传成功
上传失败
取消上传
文件过大（最大 2GB）
SHA-256
字节
```

技术名词保留英文（SHA-256、APK、ELF、SO、JADX 等）。

---

## 7. 不做的部分

- 前端不直接触发 reverse job；
- 前端不展示 / 下载反编译全量产物（后续如需要单独设计只读 artifact browser）；
- 前端不接收/显示 license 或 host 路径；
- 前端不提供“删除单个 artifact”；当前生命周期为 mission 删除或 TTL GC；
- 不把文件内容放 localStorage / URL / 日志。

---

## 8. 验收清单

- [ ] operator 上传 APK，返回 artifact id；
- [ ] 同文件重复上传命中同 mission SHA 去重；
- [ ] viewer 看不到上传按钮，直接 POST 返回 403；
- [ ] 上传进度可见，可取消；
- [ ] 列表展示文件名、大小、SHA、时间；
- [ ] 创建 manual task 带 artifactIds，Agent prompt 可见；
- [ ] Agent 调用 reverse_apk / reverse_ida 成功；
- [ ] 删除 mission 后 `/artifacts/<mission>` 消失；
- [ ] `POST /api/admin/artifacts/gc` 删除过期文件并返回计数；
- [ ] 页面刷新后列表与任务状态正确。
