# cws-as 依赖接口覆盖清单

本文档列出 **zylos-coco-workspace** 当前依赖的 cws-as HTTP 接口,逐项说明:

- 该接口在 **cws-as** 中是否已实现
- 该接口在 **cws-core** 中是否有转发定义
- 接口干什么(Summary / Description 直接采自 cws-as 的 `huma.Operation` 注册)
- 入参(path + query + body)
- 出参(响应 body)

依赖端来源:仅 `src/cli/as.js`。coco-workspace 中所有调用 cws-as 的入口都通过 `src/lib/client.js` 的 `asClient()` 走这一个文件。

服务端来源:

- cws-as 路由:`cws-as/internal/transport/http/{artifact,upload,download,resolve}_handler.go`
- cws-core 路由:`cws-core/internal/transport/http/`(全量 grep,详见下文 "Coverage Summary")

> 文档生成时间 2026-05-28。**接口描述与参数定义以 cws-as 服务为准**。两端路由表有变更时,需重新生成本文。

---

## Coverage Summary

下表 8 列,涵盖所有 9 条依赖。"入参 / 出参"列仅展示关键字段简写(`*` 标记 required;完整字段表见每个接口的"逐项详解"小节)。

| # | Method + Path | as.js 调用点 | cws-as | cws-core 转发 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|---|
| 1 | `POST /api/v1/artifacts` | `as.js:103`(`uploadMedia` step 1) | ✅ `artifact_handler.go:189` | ❌ | 创建 artifact 元数据。上传流水线的第 1 步(只要元数据 stub 时也可单独调) | body:`name*`、`mime_type*`、`size_bytes*`、可选 `description` / `mime_category` / `storage_class` / `producer_*` / `artifact_class` / `is_confidential` / `contains_pii` / `metadata` | `artifactBody`(完整 artifact 元数据,见"通用类型") |
| 2 | `POST /api/v1/artifacts/{id}/finalize` | `as.js:138`(`uploadMedia` step 3) | ✅ `upload_handler.go:114` | ❌ | "校验已上传内容,将 artifact 切到 active 状态,返回更新后的 artifact" | path:`artifact_id`;body:`session_id*` | `artifactBody` |
| 3 | `POST /api/v1/artifacts/{id}/abort` | `as.js:160`(`as.abort`) | ✅ `upload_handler.go:139` | ❌ | "取消进行中的上传会话,释放预留配额" | path:`artifact_id`;body:`session_id*` | 空 body |
| 4 | `GET /api/v1/artifacts/{id}/download` | `as.js:173`(`as.download`) | ✅ `download_handler.go:35` | ❌ | "生成 artifact 的预签名下载 URL。`mode=preview` 为内嵌展示,`mode=download`(默认)为附件下载" | path:`artifact_id`;query:`mode`(`download` / `preview`) | `{ download_url, expires_at, content_type, content_length, filename }` |
| 5 | `POST /api/v1/artifacts/resolve` | `as.js:204`(`as.resolve`) | ✅ `resolve_handler.go:41` | ❌ | "批量解析最多 100 个 `as://{orgId}/{artifactId}/{fileName}` URI 为预签名下载 URL。无法解析的(org 错、未找到、非 active)写入 `failed`" | body:`uris*`(string[],最多 100)、可选 `inline`(bool) | `{ resolved: map[uri → {download_url, expires_at, content_type, content_length, name}], failed: string[] }` |
| 6 | `GET /api/v1/artifacts` | `as.js:225`(`as.list`) | ✅ `artifact_handler.go:258` | ❌ | 按过滤条件 + cursor 分页列出 artifact | query:`mime_category` / `status` / `producer_type` / `class` / `cursor` / `limit`(1..200,默认 50) | `{ artifacts: artifactBody[], next_cursor }` |
| 7 | `GET /api/v1/artifacts/{id}` | `as.js:237`(`as.get`) | ✅ `artifact_handler.go:241` | ❌ | 按 ID 获取单个 artifact 元数据 | path:`artifact_id` | `artifactBody` |
| 8 | `PATCH /api/v1/artifacts/{id}` | `as.js:244`(`as.update`) | ✅ `artifact_handler.go:306` | ❌ | "仅 active / archived 的 artifact 可更新。可改字段:`name`、`description`、`metadata`、`is_confidential`、`contains_pii`、`artifact_class`" | path:`artifact_id`;body(全可选,partial 更新):`name` / `description` / `metadata` / `is_confidential` / `contains_pii` / `artifact_class` | `artifactBody` |
| 9 | `DELETE /api/v1/artifacts/{id}` | `as.js:255`(`as.delete`) | ✅ `artifact_handler.go:338` | ❌ | "软删 artifact"(在 8-state 状态机中切到 `deleted`,后续由 `hard_delete_after` 驱动硬删) | path:`artifact_id` | 空 body |

**结论:**

- **cws-as 侧** 9/9 全部实现。
- **cws-core 侧** 0/9 —— `grep -rn artifact cws-core/` 整个工程 0 命中,没有 handler、没有 proxy、router 也没注册。

另外有一个非 endpoint 步骤:`as.js:135` 用 `PUT` 直接打 cws-as 在 step 1 返回的预签名 URL。该 URL 实际指向底层对象存储(S3 / MinIO),不属于 cws-as 的路由表,故不计入。

---

## 逐项详解

下文每节中,"入参 / 出参"的字段名和类型直接抄自 cws-as 端 `huma.Operation` 的 struct tag。

### 1. `POST /api/v1/artifacts` —— 创建 artifact

预留 artifact 元数据。上传流水线的第 1 步;若只需要元数据 stub 也可单独调。

**入参(body):**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | Artifact 名称 |
| `description` | string | | 可选描述 |
| `mime_type` | string | ✅ | MIME 类型 |
| `mime_category` | string | | MIME 大类 |
| `size_bytes` | int64 | ✅ | 文件字节数 |
| `storage_class` | string | | 存储级别 |
| `producer_issue_id` | string | | |
| `producer_task_id` | string | | |
| `producer_principal_id` | string | | |
| `producer_type` | string | | |
| `artifact_class` | string | | |
| `is_confidential` | bool | | |
| `contains_pii` | bool | | |
| `metadata` | object | | |

**出参(body):** 完整 `artifactBody`(详见[通用类型](#通用类型))。

---

### 2. `POST /api/v1/artifacts/{artifact_id}/finalize` —— Finalize 上传会话

cws-as 原文描述:"Verify the uploaded content, transition the artifact to active status, and return the updated artifact."(校验已上传内容,将 artifact 切到 active 状态,返回更新后的 artifact)

**入参:**

- path: `artifact_id`(string)
- body: `{ "session_id": string }`(必填)

**出参(body):** 完整 `artifactBody`。

---

### 3. `POST /api/v1/artifacts/{artifact_id}/abort` —— Abort 上传会话

cws-as 原文描述:"Cancel an in-progress upload session and release reserved quota."(取消进行中的上传会话,释放预留配额)

**入参:**

- path: `artifact_id`(string)
- body: `{ "session_id": string }`(必填)

**出参:** 空 body(204 / 200 no content)。

---

### 4. `GET /api/v1/artifacts/{artifact_id}/download` —— 生成预签名下载 URL

cws-as 原文描述:"Returns a presigned GET URL for downloading an artifact. Use `mode=preview` for inline content disposition or `mode=download` (default) for attachment."

**入参:**

- path: `artifact_id`(string)
- query: `mode` —— `download`(默认,`Content-Disposition: attachment`)或 `preview`(inline 内嵌)

**出参(body):**

| 字段 | 类型 | 说明 |
|---|---|---|
| `download_url` | string | 预签名下载 URL |
| `expires_at` | int64 | URL 到期时间(Unix ms) |
| `content_type` | string | MIME 类型 |
| `content_length` | int64 | 文件字节数 |
| `filename` | string | 原始文件名 |

---

### 5. `POST /api/v1/artifacts/resolve` —— 批量解析 `as://` URI

cws-as 原文描述:"Resolves up to 100 `as://{orgId}/{artifactId}/{fileName}` URIs into presigned download URLs. URIs that cannot be resolved (wrong org, not found, inactive) are returned in the `failed` list."

**入参(body):**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `uris` | string[] | ✅ | `as://` URI,最多 100 |
| `inline` | bool | | inline 展示 + 更短 TTL |

**出参(body):**

| 字段 | 类型 | 说明 |
|---|---|---|
| `resolved` | map[string → resolvedURI] | URI → `{download_url, expires_at, content_type, content_length, name}` |
| `failed` | string[] | 无法解析的 URI |

---

### 6. `GET /api/v1/artifacts` —— 列出 artifact

按过滤条件 + cursor 分页列出 artifact。

**入参(query):**

| 字段 | 类型 | 说明 |
|---|---|---|
| `mime_category` | string | 按 MIME 大类过滤 |
| `status` | string | 按状态过滤 |
| `producer_type` | string | 按生产者类型过滤 |
| `class` | string | 按 artifact_class 过滤 |
| `cursor` | string | 分页游标 |
| `limit` | int | 1..200,默认 50 |

**出参(body):**

| 字段 | 类型 | 说明 |
|---|---|---|
| `artifacts` | artifactBody[] | 当前页 artifact 列表 |
| `next_cursor` | string | 空字符串代表无后续页 |

---

### 7. `GET /api/v1/artifacts/{artifact_id}` —— 按 ID 获取 artifact

**入参:** path `artifact_id`(string)

**出参(body):** 完整 `artifactBody`。

---

### 8. `PATCH /api/v1/artifacts/{artifact_id}` —— 更新 artifact 元数据

cws-as 原文描述:"Only active or archived artifacts can be updated. Mutable fields: name, description, metadata, is_confidential, contains_pii, artifact_class."(仅 active / archived 的 artifact 可更新;可改字段:name / description / metadata / is_confidential / contains_pii / artifact_class)

**入参:**

- path: `artifact_id`(string)
- body(全部可选,均为指针类型 —— partial 更新):

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | *string | 新名称 |
| `description` | *string | 新描述 |
| `metadata` | object | 新 metadata |
| `is_confidential` | *bool | |
| `contains_pii` | *bool | |
| `artifact_class` | *string | |

**出参(body):** 完整 `artifactBody`。

---

### 9. `DELETE /api/v1/artifacts/{artifact_id}` —— 软删 artifact

将 artifact 在 8-state 状态机中切到 `deleted`。硬删是独立流程,由 `hard_delete_after` 驱动。

**入参:** path `artifact_id`(string)

**出参:** 空 body。

---

## 通用类型

### `artifactBody`

create / get / list / update / finalize 的响应中复用。字段集(取自 `artifact_handler.go:20`):

| 字段 | 类型 | 说明 |
|---|---|---|
| `id`                    | string    | Artifact ID |
| `org_id`                | string    | |
| `name`                  | string    | |
| `description`           | string    | 可选 |
| `mime_type`             | string    | |
| `mime_category`         | string    | |
| `size_bytes`            | int64     | |
| `content_hash`          | string    | 可选 |
| `storage_uri`           | string    | 可选 |
| `status`                | string    | 8-state 状态机:`creating` → `pending_verification` → `active` → `archived` → `deleted` → `hard_deleted`;另有 `hash_mismatch`、`blocked` |
| `storage_class`         | string    | |
| `current_version`       | int       | |
| `version_count`         | int       | |
| `producer_issue_id`     | string    | 可选 |
| `producer_task_id`      | string    | 可选 |
| `producer_principal_id` | string    | 可选 |
| `producer_type`         | string    | 可选 |
| `artifact_class`        | string    | |
| `is_confidential`       | bool      | |
| `contains_pii`          | bool      | |
| `scan_status`           | string    | |
| `scan_result`           | object    | 可选 |
| `metadata`              | object    | 可选 |
| `created_by`            | string    | |
| `created_at`            | timestamp | |
| `updated_at`            | timestamp | |
| `finalized_at`          | timestamp | 可选 |
| `archived_at`           | timestamp | 可选 |
| `deleted_at`            | timestamp | 可选 |
| `hard_delete_after`     | timestamp | 可选 |
| `last_accessed_at`      | timestamp | 可选 |

---

## 写文档时顺带发现的协议错位

下面这些不属于"是否覆盖"的核心问题,但任何把本文当真理引用的人都该知道。

### F1 —— `uploadMedia` 漏了 initiate-upload 这一步

cws-as 实际的上传流是 **3 次服务端跳转**:

1. `POST /api/v1/artifacts` —— 创建 artifact 元数据,返回 `artifactBody`(**不返回 `upload_url`**)
2. `POST /api/v1/artifacts/{id}/upload` —— 发起上传会话,返回 `{ session_id, upload_url, headers, expires_at, instant_upload }`
3. `POST /api/v1/artifacts/{id}/finalize` —— body `{ session_id }`,返回最终 `artifactBody`

而 `src/cli/as.js:103-141` 现在的做法是:

1. `POST /api/v1/artifacts` 多塞了 `content_hash`、`description`、`metadata`(第 1 个 createArtifactInput 不接,被静默丢弃;后两个合法)
2. 直接从这个响应里读 `init.upload.upload_url` 和 `init.instant_upload` —— 而 **cws-as 的 create-artifact 今天不返回这俩字段**
3. `POST /api/v1/artifacts/{id}/finalize` 发的是 `{ content_hash, content_length }` —— 但 cws-as 的 `finalizeUploadInput` 要的是 `{ session_id }`

净效果:任何非 dedup 的非空上传走 `as.upload`,在 step 1 之后就会因为没有 `upload_url` 而炸。修复方式:在 step 1 / step 3 之间补一次 `POST /api/v1/artifacts/{id}/upload`,把返回的 `session_id` 透传给 finalize。

### F2 —— `as.abort` 没传 body

`src/cli/as.js:160` 直接 `asClient().post(\`/api/v1/artifacts/${artifactId}/abort\`)`,没 body。但 cws-as 的 `abortUploadInput.Body.SessionID` 是 `required:"true"`。需要把 `session_id` 也传进来。

### F3 —— cws-as 还暴露但我们没用的接口

- `POST /api/v1/artifacts/{id}/upload` —— 发起上传会话(本应被 F1 调用)
- `POST /api/v1/artifacts/batch` —— 按 IDs 批量取元数据(cws-comm 和 cws-kb 在用)

如果以后把 artifact 附件接入 `kb.upload`,`POST /artifacts/batch` 是用来把一组 artifactId 转成元数据的最自然入口。

---

## 重新生成本文

cws-as 增删改路由时:

```bash
cd cws-as
grep -rnE 'Path:\s*"/api/v1' internal/transport/http/
```

检查 cws-core 转发覆盖时:

```bash
cd cws-core
grep -rnE "artifact" internal/ pkg/ cmd/
```
