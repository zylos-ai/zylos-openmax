# AS 操作指南

CLI 位置:`src/cli/as.js`
调用方式:`node src/cli/as.js <command> '<json>'`

> `as.js` 在 zylos-coco-workspace 里有**双重角色**:
> - 作为 CLI:Agent 显式调用 `node src/cli/as.js <cmd>`
> - 作为库:`scripts/send.js`、`src/comm-bridge.js`、`src/cli/kb.js` 都从这个文件 `import` `uploadMedia` / `getMediaUrl` / `downloadMedia` —— 仓库**唯一**的上传/下载实现入口
>
> 所有跟二进制字节有关的事情都走这里,不要再写第二份。

状态:✅ v5 路径全部走 cws-core BFF(`/api/v1/...`),底层 cws-core 再 connect-RPC 到 cws-as。
Base URL:`COCO_API_URL`(走 cws-int gateway,跟 cws-core/kb/comm 同一个 zone,自动注入 CF Access headers)。
真实端点以 cws-core BFF 为准:`https://git.coco.xyz/coco-workspace/cws-core/internal/transport/http/upload*.go` + cws-as 仓库 `https://git.coco.xyz/coco-workspace/cws-as`。

---

## ⚠ 上传走哪条路径?IM 还是 KB?

**`as.upload` 是 双模 入口,根据有没有 `conversationId` 决定走哪条服务端路径。选错了会失败。**

| 你的目的 | 走 IM 上传 还是 KB 上传 | 怎么调 CLI |
|---|---|---|
| **聊天 / 会话里发图、发文件**(用户给 agent / agent 给用户)| **IM 上传** | `as.upload {filePath, conversationId, mediaType:"image"/"file"}` —— **必须带 conversationId** |
| **归档资料到 KB**(项目交付物、研究笔记附件)| **KB 上传** | `kb.upload {kbId, filePath, parentId?}` 或 `as.upload {filePath, parentId?}` —— **不带 conversationId** |
| Agent 出站发媒体消息(`scripts/send.js [MEDIA:image]/path`)| **IM 上传**(send.js 内部自动选)| 直接 `c4-send.js coco-workspace "[COCO DM]/<conv>" "[MEDIA:image]/path"` |

### 服务端路径对照

| 模式 | prepare 端点 | finalize 端点 | 返回字段 |
|---|---|---|---|
| **IM** | `POST /api/v1/conversations/{cid}/uploads/prepare` | `POST /api/v1/conversations/uploads/finalize` | `{media_id, artifact_id, ...}` — 给 `comm.send`/`send.js` 的 attachments 用 |
| **KB** | `POST /api/v1/uploads/prepare`(body 带 `parent_id`)| `POST /api/v1/uploads/finalize` | `{node_id, artifact_id, tree_node, ...}` — KB 树里直接出现一个 file 节点 |

### 选错了会怎样

- **要发会话却没带 conversationId** → CLI 走 KB 路径,文件挂到 KB 根目录,**不会出现在对话框里**,接收方完全看不到。
- **要归档到 KB 却带了 conversationId** → CLI 走 IM 路径,artifact 跟某条会话挂上但**不在 KB 树里**,KB 检索 / kb.search 都找不到。
- **两种路径的 artifact_id 字段位置不同**,把 IM `media_id` 当成 KB `node_id` 塞回 KB 操作(比如想用 `kb.file_create artifactId=...`)会失败。

⚠️ 这条规则跟 cws-comm/cws-kb 后端架构强相关:IM 路径下 artifact 跟 `conversation_id` 绑,KB 路径下 artifact 跟 `org_id` + `kb_id` 绑。决定走哪条**只能由调用方在 prepare 阶段定**,后期想换得重传。

---

## v5 三步上传(每次 `as.upload` 都走这条)

v5 把上传按"用途"拆成两条并行流,共享同一个 prepare → PUT → finalize 节奏,只是 prepare/finalize 的 namespace 不同。`as.upload` 根据有没有 `conversationId` 自动选分支(见上面"上传走哪条路径")。

```
                本地文件
                    │
        ┌───────────┴───────────┐
        │                       │
   有 conversationId         无 conversationId
        │                       │
        ▼                       ▼
   ┌──────────────┐        ┌──────────────┐
   │   IM 上传    │        │   KB 上传    │
   └──────────────┘        └──────────────┘
        │                       │
  1. POST /api/v1/conversations  1. POST /api/v1/uploads/prepare
     /{cid}/uploads/prepare         Body: {parent_id?, filename,
     Body: {filename,                      content_type, size_bytes}
            content_type,
            size_bytes}
        │                       │
        └───────────┬───────────┘
                    │
              共同响应字段:
              {upload_token, upload_url, headers,
               expires_at, instant_upload}
                    │
        ┌───────────┴───────────┐
        ├─► instant_upload=true ──► 跳过 PUT(秒传命中,字节已在 S3)
        │
        │  2. PUT <upload_url>
        │     Body: 原始字节
        │     Headers: 响应里的 headers(Content-Type 等)
        │     (字节直传 S3 / MinIO / R2,不经过 cws-core / cws-as)
        │
        ▼
   ┌──────────────┐        ┌──────────────┐
   │ IM finalize  │        │ KB finalize  │
   └──────────────┘        └──────────────┘
        │                       │
  3. POST /api/v1/conversations  3. POST /api/v1/uploads/finalize
     /uploads/finalize             Body: {upload_token}
     Body: {upload_token}          Resp: <tree_node>
     Resp: {media_id,                    (KB 文件节点,含 artifact_id)
            artifact_id}
        │                       │
        └───────────┬───────────┘
                    ▼
{mediaId, artifactId, [nodeId, treeNode (KB only),]
 fileName, mimeType, sizeBytes, instantUpload}
```

底层 cws-core 拿到 prepare/finalize 后通过 connect-RPC 调 cws-as 完成 artifact 注册、SHA-256 校验、状态机推进等;Agent 这一侧只看到 cws-core BFF 上面这 3 步。

**秒传 (`instant_upload`)**:服务端按 SHA-256 去查已有 active artifact,匹配就直接返回 `instant_upload=true`,客户端跳过 PUT 这一步。Agent 反复上传同一个文件(比如截图)只第一次真传字节。

**老路径已下线**:contract-v4 时代曾有 `POST /api/v1/artifacts` 直接建 artifact + `POST /api/v1/artifacts/{id}/finalize` 收尾的单流上传,v5 已经废弃,cws-core 不再注册这两条路由。如果在老代码里看到调用方式,需要迁移成上面这两条 namespace 之一。

## 命令列表

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `as.upload` | `{filePath, conversationId?, parentId?, mediaType?, contentType?, filename?}` | 双模 prepare/finalize(上面那条);`conversationId` → IM,无 → KB(见"上传走哪条路径") |
| ✅ | `as.url` | `{artifactId\|uri, inline?}` | `POST /api/v1/artifacts/resolve`(取第一条 `download_url`)|
| ✅ | `as.download` | `{artifactId\|uri, filename?}` | `as.url` + 字节下载到本地 |
| ✅ | `as.resolve` | `{uris:["artifact://<id>", ...], inline?}` | `POST /api/v1/artifacts/resolve` |

> **v5 BFF 主动收窄**:旧版 cws-as 直连的 artifact CRUD(`as.list / as.get / as.update / as.delete / as.abort`,对应 `GET\|PATCH\|DELETE /artifacts/{id}` + `POST /artifacts/{id}/abort`)**v5 已经不再通过 cws-core BFF 暴露**——这些端点都返回 404。如果以后需要恢复某项能力,要先在 cws-core BFF 加路由再补 CLI。Artifact 字节不可变,正常工作流是 `as.upload` 重新建一条新的,旧的留作历史。

### `as.upload` 详细

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `filePath` | string | **必填**,本地绝对路径 |
| `conversationId` | uuid | **设这个 → IM 上传**(会话附件)。返回里有 `mediaId` 给 `comm.send` attachments 用 |
| `parentId` | uuid | 仅 KB 上传时用,KB 树里某 folder 节点 id;不传则挂 KB 根 |
| `mediaType` | `image\|video\|audio\|voice\|file\|sticker` | 默认 `file`;影响 MIME 自动推断 |
| `contentType` | string | 显式 MIME(覆盖 mediaType 推断) |
| `filename` | string | 覆盖默认文件名(默认取 filePath basename) |

**`conversationId` 跟 `parentId` 互斥**:IM 路径不接受 parent_id,KB 路径不接受 conversation_id。同时传只有 `conversationId` 生效(走 IM)。

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
# 上传一份 PDF(KB 模式:不带 conversationId)
node src/cli/as.js as.upload '{
  "filePath":"/tmp/report.pdf",
  "mediaType":"file"
}'
# -> {artifactId:"art_...", nodeId:"...", treeNode:{...}, instantUpload:false}

# 拿临时链接分享给别人
node src/cli/as.js as.url '{"artifactId":"art_..."}'
# -> {url:"https://...", expiresAt:"...", contentType:"...", name:"..."}

# 下到本地做分析
node src/cli/as.js as.download '{"artifactId":"art_..."}'
# -> {localPath:"/home/cocoai/zylos/components/coco-workspace/media/<filename>"}

# 批量解析多个 URI(给服务间调用用)
node src/cli/as.js as.resolve '{"uris":["artifact://art_a","artifact://art_b"]}'
# -> {resolved:{...}, failed:[...]}
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
- 预签名 PUT URL TTL 1 小时;超时需要重新调对应的 prepare 端点(IM:`POST /api/v1/conversations/{cid}/uploads/prepare`;KB:`POST /api/v1/uploads/prepare`)拿新 `upload_token` + `upload_url`
- 大文件(>100MB)cws-as 会自动选 Multipart 模式(`upload_mode:"multipart"`),我们目前的 `uploadMedia()` 还是单 PUT,大文件场景需要扩展(标 TODO)
- `as.resolve` 是给 cws-comm 这种服务间调用用的:无权限的 artifact 跳过而不是 403,避免一个失败拖整批
- `media_id` / `artifactId` 是同义词(向后兼容),返回里都给

## 环境变量

- `COCO_AS_URL` — cws-as 直连地址(默认 `config.comm.as_url`)
- `COCO_AUTH_TOKEN` — Bearer token(跟 cws-core / cws-kb 共用)
- `COCO_ORG_ID` — 覆盖 `config.org_id`
