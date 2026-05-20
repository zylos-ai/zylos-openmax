# AS 操作指南

CLI 位置:`src/cli/as.js`
调用方式:`node src/cli/as.js <command> '<json>'`

> `as.js` 在 zylos-coco-workspace 里有**双重角色**:
> - 作为 CLI:Agent 通过 `node src/cli/as.js <cmd>` 显式调用
> - 作为库:`scripts/send.js`、`src/comm-bridge.js`、`src/cli/kb.js` 都从这个文件 `import` `uploadMedia` / `getMediaUrl` / `downloadMedia` —— 这是仓库里**唯一**的上传/下载实现入口
>
> 所有跟二进制字节有关的事情都走这里,不要再写第二份。

状态:**全部 ⏳** —— cws-core OpenAPI 当前没有 `/media/*` 端点。调用会 404,但接口形态按 cws-comm api-design.md §5.8 / 单步上传约定就位。

## 概念

媒体附件按"挂在哪"分两类,但流程统一:

```
                       ┌──────────────────┐
本地文件 + 元数据 ──►  │ as.uploadMedia()  │ ──► media_id (服务端登记)
                       └──────────────────┘
                                │
        ┌───────────────────────┴───────────────────────┐
        ▼                                               ▼
 IM 消息引用 media_id                          KB 节点引用 media_id
 POST /conversations/{id}/messages              (与 KB 节点关联)
   content:[{type:"image", body:media_id}]
```

下载方向:

```
入站消息(content.media_id) ──► as.getMediaUrl(media_id) ──► 拿到签名 URL
                                                            │
                                                            ▼
                                                   as.downloadMedia(url)
                                                            │
                                                            ▼
                                                  本地文件路径 → 交给 Agent
```

## 命令列表

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ⏳ | `as.upload` | `{conversationId, filePath, mediaType?, contentType?}` | `POST /api/v1/media/upload` → `PUT <signed-url>` |
| ⏳ | `as.url` | `{mediaId}` | `GET /api/v1/media/{id}/url` |
| ⏳ | `as.download` | `{mediaId, filename?}` | `as.url` + 字节下载 |

### `as.upload` — 一步式上传

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `conversationId` | string | **必填**,作访问控制 scoping(也接受 kbId 等作 scope 字段) |
| `filePath` | string | **必填**,本地绝对路径 |
| `mediaType` | `image\|video\|audio\|voice\|file\|sticker` | 默认 `file` |
| `contentType` | string | 显式 MIME,默认按 mediaType 推断 |

返回:`{mediaId, mediaType, mimeType, size, fileName}`。

底层两步(对调用方透明):

1. `POST /api/v1/media/upload` 拿到 `{media_id, upload_url, upload_headers}`
2. `PUT <upload_url>` 直传字节(典型是 S3 预签名 URL)

### `as.url` — 拿下载 URL

| 参数 | 类型 |
| --- | --- |
| `mediaId` | string,必填 |

返回:`{url, expiresAt?}`。URL 是临时签发的,有 TTL。

### `as.download` — 完整下载

| 参数 | 类型 |
| --- | --- |
| `mediaId` | string,必填 |
| `filename` | string,可选,落地文件名 |

返回:`{localPath}`(绝对路径,在 `~/zylos/components/coco-workspace/media/`)。

内部 = `as.url` + 字节 GET。Agent 拿到 `localPath` 即可作为 vision/文件读取的输入。

## 典型流程

### Agent 发图给用户(`scripts/send.js` 已自动走这条)

```bash
# 通过 C4 出站:
node /home/cocoai/zylos/.claude/skills/comm-bridge/scripts/c4-send.js \
  coco-workspace '[COCO DM]/<conv-uuid>' '[MEDIA:image]/tmp/chart.png'
```

`scripts/send.js` 内部:

1. 解析 `[MEDIA:image]/tmp/chart.png`
2. `as.uploadMedia('/tmp/chart.png', {conversationId, mediaType:'image'})` → `media_id`
3. `POST /api/v1/conversations/{id}/messages` body `{content:[{type:"image", body: <media_id JSON>}], ...}`

### Agent 看用户发来的图(`comm-bridge.js` 已自动走这条)

WS 推过来一帧 `{content:{media_id:"media_xyz"}, ...}`,comm-bridge 内部:

1. `as.getMediaUrl("media_xyz")` → `{url:"https://s3.../signed", ...}`
2. `as.downloadMedia(url, filename)` → 本地路径 `/home/cocoai/zylos/components/coco-workspace/media/<file>`
3. 把本地路径塞进 C4 出站文本里 `---- image: <localPath>` —— Agent 看见这个 tag 就调用 vision

### Agent 主动调用 CLI

通常**不需要直接调 as.js CLI**,因为 send.js 和 comm-bridge 自动用了。但你想自己手动管理时:

```bash
# 上传(为了拿 media_id 再单独发卡片)
node src/cli/as.js as.upload '{
  "conversationId":"<conv-uuid>",
  "filePath":"/tmp/report.pdf",
  "mediaType":"file"
}'
# -> {mediaId:"<media-uuid>", ...}

# 已知 media_id,拿临时 URL 分享给别人
node src/cli/as.js as.url '{"mediaId":"<media-uuid>"}'
# -> {url:"https://...", expiresAt:"..."}

# 拉到本地分析
node src/cli/as.js as.download '{"mediaId":"<media-uuid>"}'
# -> {localPath:"/home/.../<filename>"}
```

## 选型对照

| 信号 | 走哪里 |
| --- | --- |
| 内容能用 Markdown 表达 | KB Page(`kb.write`),不要传文件 |
| 二进制(图片 / PDF / 数据集) | `as.upload` + 在消息或 KB 里引用 `media_id` |
| 体积大(MB / GB 级) | `as.upload` —— 走预签名 PUT,直传 S3,不进服务端 |
| 临时分享到对话里 | `as.upload` + `comm.send` 引用 |
| 项目交付物长期引用 | `as.upload` + KB 节点登记 `media_id` |

## 注意事项

- Attachment 不可变,"修改"等于新建,旧的留作历史
- `media_id` 是服务端 UUID,客户端不要自己造
- 下载 URL 有 TTL,过期再调 `as.url` 取新的
- `lib/media.js` **已经被移除** —— 历史代码如果还在 import 它,要换成 `import { uploadMedia } from '../cli/as.js'`(或对应路径)

## 环境变量

- `COCO_API_URL` — cws-core 入口(默认 `http://127.0.0.1:8080`)
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀(默认 `/api/v1`)
