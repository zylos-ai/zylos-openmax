# AS 操作指南

CLI 位置:`src/cli/as.js`
调用方式:`node src/cli/as.js <command> '<json>'`

> `as.js` 在 zylos-coco-workspace 里有**双重角色**:
> - 作为 CLI:Agent 显式调用 `node src/cli/as.js <cmd>`
> - 作为库:`scripts/send.js`、`src/comm-bridge.js`、`src/cli/kb.js` 都从这个文件 `import` `uploadMedia` / `getMediaUrl` / `downloadMedia` —— 仓库**唯一**的上传/下载实现入口
>
> 所有跟二进制字节有关的事情都走这里,不要再写第二份。

状态:✅ cws-as 已暴露每个端点。本 CLI 直连 cws-as(不走 cws-core BFF)。
Base URL:`config.comm.as_url`(env `COCO_AS_URL` 可覆盖)
真实端点以 cws-as 仓库为准:`https://git.coco.xyz/coco-workspace/cws-as`

## cws-as 三步上传(每次 `as.upload` 都走这条)

```
本地文件
  │
  │  1. POST /api/v1/artifacts
  │     Body: {name, mime_type, size_bytes, content_hash (SHA-256), description?}
  │     Resp: {artifact:{id, status:"creating", ...},
  │            upload:{upload_mode, upload_url, required_headers, expires_at},
  │            instant_upload: bool}
  │
  ├─►  instant_upload=true ──► 短路返回(秒传命中,字节已在 S3)
  │
  │  2. PUT <upload.upload_url>
  │     Body: 原始字节
  │     Headers: upload.required_headers(Content-Type + x-goog-content-sha256 等)
  │     (字节直传 S3 / MinIO / R2,不经过服务端)
  │
  │  3. POST /api/v1/artifacts/{id}/finalize
  │     Body: {content_hash, content_length}
  │     Resp: {artifact:{status: "pending_verification", ...}}
  │     (服务端异步计算 SHA-256 → "active" 或 "hash_mismatch")
  │
  ▼
{mediaId, artifactId, status, sizeBytes, mimeType, fileName, instantUpload}
```

**秒传 (`instant_upload`)**:服务端按 `content_hash` 去查已有 active artifact,匹配就直接返回。Agent 反复上传同一个文件(比如截图)只第一次真传字节。

## 命令列表

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `as.upload` | `{filePath, mediaType?, contentType?, description?, metadata?}` | 3-step(上面那条) |
| ✅ | `as.list` | `{pageSize?, pageToken?, mime?, status?, producer?}` | `GET /api/v1/artifacts` |
| ✅ | `as.get` | `{artifactId}` | `GET /api/v1/artifacts/{id}` |
| ✅ | `as.update` | `{artifactId, name?, description?, metadata?}` | `PATCH /api/v1/artifacts/{id}` |
| ✅ | `as.delete` | `{artifactId}` | `DELETE /api/v1/artifacts/{id}` |
| ✅ | `as.url` | `{artifactId, mode?}` | `GET /api/v1/artifacts/{id}/download` |
| ✅ | `as.download` | `{artifactId, filename?}` | `as.url` + 字节下载到本地 |
| ✅ | `as.abort` | `{artifactId}` | `POST /api/v1/artifacts/{id}/abort` |
| ✅ | `as.resolve` | `{uris:["as://org_x/art_y", ...]}` | `POST /api/v1/artifacts/resolve` |

`as.update` 只能改 metadata(name / description / metadata),**字节不可变**;要换内容就 `as.upload` 重新建 artifact。
`as.delete` 是软删除(status 转 `deleted`),保留期后真删除;期间 `as.list` 加 `status=deleted` 还能找回来。

### `as.upload` 详细

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `filePath` | string | **必填**,本地绝对路径 |
| `mediaType` | `image\|video\|audio\|voice\|file\|sticker` | 默认 `file`;影响 MIME 自动推断 |
| `contentType` | string | 显式 MIME(覆盖 mediaType 推断) |
| `description` | string | 描述文字,落到 artifact metadata |
| `metadata` | object | 自由结构 metadata,服务端原样存 |

返回:

```json
{
  "mediaId":       "art_01JDKF7M2NQRSTUVWXYZ012345",
  "artifactId":    "art_01JDKF7M2NQRSTUVWXYZ012345",
  "status":        "pending_verification",
  "sizeBytes":     5242880,
  "mimeType":      "application/pdf",
  "fileName":      "Q2-产品规划.pdf",
  "instantUpload": false
}
```

`mediaId` 是 `artifactId` 的别名(向后兼容历史调用方)。`status` 通常返回 `pending_verification`(等服务端校验 SHA-256),约 1 秒内转 `active`。

### `as.url` 详细

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `artifactId` | string | 必填 |
| `mode` | `download` / `preview` | 默认 `download`(Content-Disposition: attachment),`preview` 走 inline 用于浏览器内嵌预览 |

返回 `{url, expiresAt}`。URL 是预签名的(GCS / S3),TTL 默认 15 分钟。

### `as.download` 详细

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `artifactId` | string | 必填 |
| `filename` | string | 落地文件名,默认 `media-<timestamp>` |

返回 `{localPath}`,落到 `~/zylos/components/coco-workspace/media/<filename>`。内部 = `as.url` + 字节 GET。Agent 拿到 `localPath` 即可作为 vision/文件读取输入。

### `as.resolve` 详细

批量把 `as://<org_id>/<artifact_id>` 形式的 URI 解析成预签名下载 URL,带 Redis 缓存。无权限的 artifact 不会 403,而是返回 `partial results`(列在 `errors` 字段)。

```bash
node src/cli/as.js as.resolve '{"uris":["as://org_x/art_y","as://org_x/art_z"]}'
# -> {resolved:[{uri,url,expires_at}, ...], errors:[{uri,reason}, ...]}
```

## 典型流程

### Agent 发图给用户(`scripts/send.js` 自动走这条)

```bash
# 通过 C4 出站:
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js \
  coco-workspace '[COCO DM]/<conv-uuid>' '[MEDIA:image]/tmp/chart.png'
```

`scripts/send.js` 内部:

1. 解析 `[MEDIA:image]/tmp/chart.png`
2. `as.uploadMedia('/tmp/chart.png', {mediaType:'image'})` → `{artifactId, mediaId, ...}`
3. `POST /api/v1/conversations/{id}/messages` body `{content:[{type:"image", body:"<media_id>"}], ...}`

### Agent 看用户发来的图(`comm-bridge.js` 自动走这条)

WS 推过来一帧 `{content:{media_id:"art_xyz"}, ...}`,comm-bridge 内部:

1. `as.getMediaUrl("art_xyz")` → `{url:"https://storage.googleapis.com/.../signed?...", expiresAt}`
2. `as.downloadMedia(url, filename)` → `/home/cocoai/zylos/components/coco-workspace/media/<file>`
3. 把本地路径塞进 C4 出站文本里 `---- image: <localPath>` —— Agent 看见 tag 自动调用 vision

### Agent 主动调用 CLI

通常**不需要直接调 as.js CLI**,因为 send.js 和 comm-bridge 自动用了。手动管理时:

```bash
# 上传一份 PDF
node src/cli/as.js as.upload '{
  "filePath":"/tmp/report.pdf",
  "mediaType":"file",
  "description":"Q2 报告终版"
}'
# -> {artifactId:"art_...", instantUpload:false, status:"pending_verification"}

# 列出我的 artifact
node src/cli/as.js as.list '{"pageSize":20,"mime":"application/pdf"}'

# 拿临时链接分享给别人
node src/cli/as.js as.url '{"artifactId":"art_...","mode":"download"}'
# -> {url:"https://...", expiresAt:"..."}

# 下到本地做分析
node src/cli/as.js as.download '{"artifactId":"art_..."}'
# -> {localPath:"/home/cocoai/.../<filename>"}
```

## 选型对照

| 信号 | 走哪里 |
| --- | --- |
| 内容能用 Markdown 表达 | KB Page(`kb.page_create`) |
| 二进制(图片 / PDF / 数据集) | `as.upload` + 在消息/KB 里引用 `media_id` |
| 体积大(MB / GB 级) | `as.upload` —— 走预签名 PUT 直传 S3,字节不经服务端 |
| 临时分享到对话里 | `as.upload` + `comm.send` 引用 |
| 项目交付物长期引用 | `as.upload` + KB 页面登记 `as://` URI |
| 多次上同一文件 | 服务端按 SHA-256 自动秒传(`instant_upload=true`) |

## 注意事项

- Artifact 不可变,"修改"=新建,旧的留作历史
- `artifact_id` 是 ULID 形态(`art_01JDKF...`,服务端生成)
- 单文件大小上限 5 GB(超出返回 `payload_too_large` 413)
- `mime_type` 黑名单:可执行文件(`.exe` / `.sh` 等)返回 `unsupported_media_type` 415
- 预签名 PUT URL TTL 1 小时;超时需要重新 `POST /artifacts` 拿新 URL
- 大文件(>100MB)cws-as 会自动选 Multipart 模式(`upload_mode:"multipart"`),我们目前的 `uploadMedia()` 还是单 PUT,大文件场景需要扩展(标 TODO)
- `as.resolve` 是给 cws-comm 这种服务间调用用的:无权限的 artifact 跳过而不是 403,避免一个失败拖整批
- `media_id` / `artifactId` 是同义词(向后兼容),返回里都给

## 环境变量

- `COCO_AS_URL` — cws-as 直连地址(默认 `config.comm.as_url`)
- `COCO_AUTH_TOKEN` — Bearer token(跟 cws-core / cws-kb 共用)
- `COCO_ORG_ID` — 覆盖 `config.org_id`
