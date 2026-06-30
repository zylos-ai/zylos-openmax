# AS 操作指南

**作用**:ArtifactStore 操作——文件 / 媒体的字节上传 + 下载 URL 解析。覆盖会话附件(IM 模式)和 KB 文件节点(KB 模式)两条上传路径,以及 artifact 的预签名 URL 解析与本地下载。

**何时加载本文档**:

- 要把本地文件作为会话附件发出去(图片 / PDF / 录音等),走 `as.upload` IM 模式(带 `conversationId`)
- 要把文件归档到 KB 树,走 `as.upload` KB 模式(不带 `conversationId`,可选 `parentId`)或 `kb.upload`
- 收到 `artifact://<id>` 形式的引用,要拿预签名 URL(`as.url` 单条 / `as.resolve` 批量)
- 要把远端 artifact 的字节下载到本地做分析(`as.download`)
- 排查为什么文件"上传成功了但发不出去"或"挂到 KB 但 search 找不到"(基本都是 IM vs KB 模式选错)

**不在本文档范围**:

- KB page / folder / tree node 操作 → `references/kb-operations.md`
- 发消息引用附件 → `references/comm-operations.md`(`comm.send` 的 `content` 字段)
- 任务 / Issue / Blueprint workflow → `references/tm-operations.md`
- **artifact CRUD**(list / get / update / delete / abort)→ **v5 已下线**,cws-core BFF 不暴露;字节不可变,改内容就重传

**依赖前置**:

- IM 上传要先有 `conversationId`(从 `comm.create_dm` / `comm.list_conversations` 拿)
- KB 上传的 `parentId`(folder node id)从 `kb.tree_roots` / `kb.node_children` 拿;不传则挂 KB 根
- `as.url` / `as.download` 需要已经拿到 `artifactId` 或 `artifact://` URI(通常来自之前 `as.upload` 的响应,或别人发过来的引用)
- 完整参数依赖树见 [`SKILL.md` 效率捷径 > 参数解析](../SKILL.md)

---

> Layer 3 操作参考。本文档与 `src/cli/as.js` dispatch 表保持 1:1 对应。
> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`

CLI 位置:`src/cli/as.js`
调用方式:`node src/cli/as.js <command> '<json>'`

> `as.js` 在 zylos-openmax 里有**双重角色**:
> - 作为 CLI:Agent 显式调用 `node src/cli/as.js <cmd>`
> - 作为库:`scripts/send.js`、`src/comm-bridge.js`、`src/cli/kb.js` 都从这个文件 `import` `uploadMedia` / `getMediaUrl` / `downloadMedia` —— 仓库**唯一**的上传 / 下载实现入口
>
> 所有跟二进制字节有关的事情都走这里,不要再写第二份。

状态:✅ v5 路径全部走 cws-core BFF(`/api/v1/...`),底层 cws-core 再 connect-RPC 到 cws-as。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF 基地址 |
| `COCO_API_PREFIX` | `/api/v1` | 路径前缀 |
| `COCO_AUTH_TOKEN` | (空) | Bearer token(跟 tm / kb / comm / core CLI 共用) |
| `COCO_ORG_ID` | (空) | 覆盖 `config.org_id` |

---

## ⚠ 上传走哪条路径?IM 还是 KB?

**`as.upload` 是双模入口,根据有没有 `conversationId` 决定走哪条服务端路径。选错了会失败。**

| 你的目的 | 走 IM 上传 还是 KB 上传 | 怎么调 CLI |
|---|---|---|
| **聊天 / 会话里发图、发文件**(用户给 agent / agent 给用户) | **IM 上传** | `as.upload {filePath, conversationId, mediaType:"image"/"file"}` —— **必须带 conversationId** |
| **归档资料到 KB**(项目交付物、研究笔记附件) | **KB 上传** | `kb.upload {kbId, filePath, parentId?}` 或 `as.upload {filePath, parentId?}` —— **不带 conversationId** |
| Agent 出站发媒体消息(`scripts/send.js [MEDIA:image]/path`) | **IM 上传**(send.js 内部自动选)| 直接 `c4-send.js openmax "<conv>" "[MEDIA:image]/path"` |

### 服务端路径对照

| 模式 | prepare 端点 | finalize 端点 | 返回字段 |
|---|---|---|---|
| **IM** | `POST /api/v1/conversations/{cid}/uploads/prepare` | `POST /api/v1/conversations/uploads/finalize` | `{media_id, artifact_id, ...}` — 给 `comm.send` / `send.js` 的 attachments 用 |
| **KB** | `POST /api/v1/uploads/prepare`(body 带 `parent_id`) | `POST /api/v1/uploads/finalize` | `{node_id, artifact_id, tree_node, ...}` — KB 树里直接出现一个 file 节点 |

### 选错了会怎样

- **要发会话却没带 conversationId** → CLI 走 KB 路径,文件挂到 KB 根目录,**不会出现在对话框里**,接收方完全看不到。
- **要归档到 KB 却带了 conversationId** → CLI 走 IM 路径,artifact 跟某条会话挂上但**不在 KB 树里**,KB 检索 / `kb.search` 都找不到。
- **两种路径的 artifact_id 字段位置不同**,把 IM `media_id` 当成 KB `node_id` 塞回 KB 操作(比如想用 `kb.file_create artifactId=...`)会失败。

⚠️ 这条规则跟 cws-comm / cws-kb 后端架构强相关:IM 路径下 artifact 跟 `conversation_id` 绑,KB 路径下 artifact 跟 `org_id` + `kb_id` 绑。决定走哪条**只能由调用方在 prepare 阶段定**,后期想换得重传。

---

## v5 三步上传(每次 `as.upload` 都走这条)

v5 把上传按"用途"拆成两条并行流,共享同一个 prepare → PUT → finalize 节奏,只是 prepare / finalize 的 namespace 不同。`as.upload` 根据有没有 `conversationId` 自动选分支。

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

底层 cws-core 拿到 prepare / finalize 后通过 connect-RPC 调 cws-as 完成 artifact 注册、SHA-256 校验、状态机推进等;Agent 这一侧只看到 cws-core BFF 上面这 3 步。

**秒传 (`instant_upload`)**:服务端按 SHA-256 去查已有 active artifact,匹配就直接返回 `instant_upload=true`,客户端跳过 PUT 这一步。Agent 反复上传同一个文件(比如截图)只第一次真传字节。

**老路径已下线**:contract-v4 时代曾有 `POST /api/v1/artifacts` 直接建 artifact + `POST /api/v1/artifacts/{id}/finalize` 收尾的单流上传,v5 已经废弃,cws-core 不再注册这两条路由。如果在老代码里看到这种调用方式,迁移成上面两条 namespace 之一。

## 命令清单

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `as.upload` | 双模上传:有 `conversationId` 走 IM(会话附件),没有走 KB(归档进 KB 树) | `{filePath, conversationId?, parentId?, mediaType?, contentType?, filename?}` | 双模 prepare/finalize(见上面流程图) |
| ✅ | `as.url` | 拿单个 artifact 的预签名下载 URL(默认 attachment,可选 inline 预览) | `{artifactId\|uri, inline?}` | `POST /api/v1/artifacts/resolve`(取第一条 `download_url`) |
| ✅ | `as.download` | `as.url` + 字节 GET,下载到 `~/zylos/components/openmax/media/<filename>` | `{artifactId\|uri, filename?}` | `as.url` + 字节下载到本地 |
| ✅ | `as.resolve` | 批量解析 `artifact://<id>` URI 数组拿预签名 URL(服务间调用用) | `{uris:["artifact://<id>", ...], inline?}` | `POST /api/v1/artifacts/resolve` |

> **v5 BFF 主动收窄**:旧版 cws-as 直连的 artifact CRUD(`as.list / as.get / as.update / as.delete / as.abort`,对应 `GET\|PATCH\|DELETE /artifacts/{id}` + `POST /artifacts/{id}/abort`)**v5 已经不再通过 cws-core BFF 暴露**——这些端点都返回 404。如果以后要恢复某项能力,要先在 cws-core BFF 加路由再补 CLI。Artifact 字节不可变,正常工作流是 `as.upload` 重新建一条新的,旧的留作历史。

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

返回(IM 模式):

```json
{
  "mediaId":       "art_01JDKF7M2NQRSTUVWXYZ012345",
  "artifactId":    "art_01JDKF7M2NQRSTUVWXYZ012345",
  "fileName":      "Q2-产品规划.pdf",
  "mimeType":      "application/pdf",
  "sizeBytes":     5242880,
  "instantUpload": false
}
```

KB 模式额外带 `nodeId` + `treeNode` 字段。`mediaId` 是 `artifactId` 的别名(向后兼容历史调用方)。

### `as.url` 详细

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `artifactId` / `uri` | string | 必填(`artifact://<id>` 形式或裸 id 都接受) |
| `inline` | bool | true → 走 inline disposition(浏览器内嵌预览),false → attachment(强制下载) |

返回 `{url, expiresAt, contentType, contentLength, name}`。URL 是预签名的(GCS / S3),TTL 默认 15 分钟。

### `as.download` 详细

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `artifactId` / `uri` | string | 必填 |
| `filename` | string | 落地文件名,默认从 artifact 元数据取 |

返回 `{localPath}`,落到 `~/zylos/components/openmax/media/<filename>`。内部 = `as.url` + 字节 GET。Agent 拿到 `localPath` 即可作为 vision / 文件读取输入。

### `as.resolve` 详细

批量把 `artifact://<id>` 形式的 URI 解析成预签名下载 URL,带 Redis 缓存。无权限的 artifact 不会 403,而是返回 partial results(列在 `failed` 字段)。

```bash
node src/cli/as.js as.resolve '{"uris":["artifact://art_y","artifact://art_z"]}'
# -> {resolved:{...}, failed:[...]}
```

## 典型流程

### Agent 发图给用户(`scripts/send.js` 自动走这条)

```bash
# 通过 C4 出站:
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js \
  openmax '<conv-uuid>' '[MEDIA:image]/tmp/chart.png'
```

`scripts/send.js` 内部:

1. 解析 `[MEDIA:image]/tmp/chart.png`
2. `as.uploadMedia('/tmp/chart.png', {mediaType:'image'})` → `{artifactId, mediaId, ...}`
3. `POST /api/v1/conversations/{id}/messages` body `{content:[{type:"image", body:"<media_id>"}], ...}`

### Agent 看用户发来的图(`comm-bridge.js` 自动走这条)

WS 推过来一帧 `{content:{media_id:"art_xyz"}, ...}`,comm-bridge 内部:

1. `as.getMediaUrl("art_xyz")` → `{url:"https://storage.googleapis.com/.../signed?...", expiresAt}`
2. `as.downloadMedia(url, filename)` → `/home/cocoai/zylos/components/openmax/media/<file>`
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
# -> {localPath:"/home/cocoai/zylos/components/openmax/media/<filename>"}

# 批量解析多个 URI(给服务间调用用)
node src/cli/as.js as.resolve '{"uris":["artifact://art_a","artifact://art_b"]}'
# -> {resolved:{...}, failed:[...]}
```

## 选型对照

| 信号 | 走哪里 |
| --- | --- |
| 内容能用 Markdown 表达 | KB Page(`kb.page_create`) |
| 二进制(图片 / PDF / 数据集) | `as.upload` + 在消息 / KB 里引用 `media_id` |
| 体积大(MB / GB 级) | `as.upload` —— 走预签名 PUT 直传 S3,字节不经服务端 |
| 临时分享到对话里 | `as.upload`(IM 模式)+ `comm.send` 引用 |
| 项目交付物长期引用 | `as.upload`(KB 模式)+ KB 页面登记 `artifact://` URI |
| 多次上同一文件 | 服务端按 SHA-256 自动秒传(`instant_upload=true`) |

## 与 SKILL.md 的关系

本文档是 [`SKILL.md`](../SKILL.md) 的 Layer 3 子 skill,只负责 AS CLI 的**命令机制**(加上 IM vs KB 双模这个独特的"选哪条路径"问题)。下面这些行为面内容**在 SKILL.md 里**,本文档不重复:

| 想看 | 去 SKILL.md 的哪节 |
|---|---|
| Lead 经验沉淀 vs Worker 任务产出时该挂哪 | [角色模型](../SKILL.md)(KB 写入那行) |
| `as.upload` 的产物如何通过 `contextPageIds` 传给 Task | [效率捷径 > 上下文传递](../SKILL.md) |
| 通用错误防护(不要 curl 直传 / 不要绕 CLI) | [行为护栏 > 常见错误](../SKILL.md) |

## AS 专属注意事项

- Artifact 不可变,"修改"=新建,旧的留作历史
- `artifact_id` 是 ULID 形态(`art_01JDKF...`,服务端生成)
- 单文件大小上限 5 GB(超出返回 `payload_too_large` 413)
- `mime_type` 黑名单:可执行文件(`.exe` / `.sh` 等)返回 `unsupported_media_type` 415
- 预签名 PUT URL TTL 1 小时;超时需要重新调对应的 prepare 端点(IM:`POST /api/v1/conversations/{cid}/uploads/prepare`;KB:`POST /api/v1/uploads/prepare`)拿新 `upload_token` + `upload_url`
- 大文件(>100MB)cws-as 会自动选 Multipart 模式(`upload_mode:"multipart"`),目前的 `uploadMedia()` 还是单 PUT,大文件场景需要扩展(标 TODO)
- `as.resolve` 是给服务间调用用的:无权限的 artifact 跳过而不是 403,避免一个失败拖整批
- `media_id` / `artifactId` 是同义词(向后兼容),返回里都给
- IM 模式 vs KB 模式选错是最常见的踩坑——返回字段不同 + 后续操作可见性不同,详见上面"⚠ 上传走哪条路径"
