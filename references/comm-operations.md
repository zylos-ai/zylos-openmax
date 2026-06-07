# Comm 操作指南

CLI 位置:`src/cli/comm.js`
调用方式:`node src/cli/comm.js <command> '<json>'`

状态图例:✅ cws-core 已有 · ⏳ 暂未暴露(调用会 404)

> 全部命令默认走 `apiPath()`,默认前缀 `/api/v1`(可用 `COCO_API_PREFIX` 覆盖)。
> 真实路径由 cws-core OpenAPI 决定:`https://zylos01.jinglever.com/cws-core/openapi.json`

## 何时使用 Comm CLI

被动 IM(人类发消息进来 → Agent 回复)走 C4 bridge 自动路由,**不需要手动调用**。

Comm CLI 用于 Agent **主动发起**的 IM:

| 场景 | 命令 |
| --- | --- |
| 列出我参与的会话 | `comm.list_conversations` |
| 主动 DM 某个用户 | `comm.create_dm` → `comm.send` |
| 拉群聊一群人 | `comm.create_group` → `comm.send` |
| 在非当前会话里发消息 | `comm.send` |
| 拉历史消息 | `comm.get_messages` / `comm.get_message` |
| 看会话未读计数 | `comm.unread` |
| WS 重连后拉漏掉的事件 | `comm.sync` |
| KB page 搜索 | `comm.search`(v5 唯一搜索入口) |

实时事件推送(`message.created` 等)走 WebSocket,不在本 CLI 范围。

## 命令列表

### 会话

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `comm.list_conversations` | `{pageSize?, pageToken?}` | `GET /api/v1/conversations` |
| ✅ | `comm.create_dm` | `{participantId}` | `POST /api/v1/conversations/dm` |
| ✅ | `comm.create_group` | `{title, participantIds[]}` | `POST /api/v1/conversations/groups` |
| ✅ | `comm.get_conversation` | `{conversationId}` | `GET /api/v1/conversations/{id}` |

`participantIds` 必须是 UUID 数组。DM 用一个 `participantId`(无 `title`),group 用多个 + `title`。

### 消息

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `comm.send` | `{conversationId, content, replyTo?, clientMsgId?}` | `POST /api/v1/conversations/{id}/messages` |
| ✅ | `comm.get_messages` | `{conversationId, afterSeq?, beforeSeq?, limit?}` | `GET /api/v1/conversations/{id}/messages` |
| ✅ | `comm.get_message` | `{conversationId, messageId}` | `GET /api/v1/conversations/{id}/messages/{message_id}` |

`content` 接受四种输入,CLI 自动归一为 cws-core 的 `MessageContent[]`:

```text
"hello"                              → [{type:"text",     body:"hello"}]
"# header\n..."                      → [{type:"markdown", body:"# header\n..."}]   (启发式)
{text:"hi", markdown:true}           → [{type:"markdown", body:"hi"}]
{type:"image", body:"<media_id>"}    → [{type:"image",    body:"<media_id>"}]
[{type:"text", body:"..."}, ...]     → 原样透传(已经是数组形式)
```

`clientMsgId` 用于服务端 5 分钟幂等去重,不传会自动生成 `cmsg_<uuid>`。同一条逻辑消息重试请用同一个 id。

### 已读 / 未读

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `comm.unread` | `{conversationId}` | `GET /api/v1/conversations/{id}/unread` |

### 同步

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `comm.sync` | `{sinceSeq, deviceId, limit?}` | `POST /api/v1/sync` — WS 重连后拉漏掉的事件 |

### 搜索

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `comm.search` | `{query, kbId?, limit?, offset?, sort?}` | `GET /api/v1/search/pages` — v5 唯一的搜索入口,实际是 KB page search(放在 comm CLI 里是历史原因) |

## 典型流程

### Agent 主动联系一个人(✅ 当前能跑)

```bash
# 1. 建立 DM 会话(若已存在直接返回)
node src/cli/comm.js comm.create_dm '{"participantId":"<member-uuid>"}'
# -> {data:{id:"<conversation-uuid>", type:"dm", ...}}

# 2. 发消息
node src/cli/comm.js comm.send '{
  "conversationId":"<conversation-uuid>",
  "content":"周报准备好了,你方便的时候看看"
}'
```

### 群里发带附件的消息(⚠️ 附件依赖 ⏳ 的 media endpoint)

```bash
# 1. 先上传附件,拿 media_id
node src/cli/as.js as.upload '{
  "conversationId":"<conv-uuid>",
  "filePath":"/tmp/weekly.pdf",
  "mediaType":"file"
}'
# -> {mediaId:"<media-uuid>", ...}

# 2. 发消息引用 media_id
node src/cli/comm.js comm.send '{
  "conversationId":"<conv-uuid>",
  "content":[{"type":"text","body":"本周周报"},
             {"type":"file","body":"<media-uuid>"}]
}'
```

### WS 重连后补漏

```bash
# 用最后已知 seq + device_id 拉漏掉的事件(✅)
node src/cli/comm.js comm.sync '{
  "sinceSeq":12345,
  "deviceId":"<device-id>",
  "limit":100
}'

# 看某个会话还有多少未读(✅)
node src/cli/comm.js comm.unread '{"conversationId":"<conv-uuid>"}'
```

## 注意事项

- DM 走 `/conversations/dm`、Group 走 `/conversations/groups`,**不是**同一个 POST 通用入口
- 发消息失败重试时,**保留同一个 `clientMsgId`**,服务端按它做 5 分钟幂等
- cws-core 的 `SendMessageRequestBody` 是 `additionalProperties:false` —— 不要传 schema 外的字段(会被拒)
- 实际响应包在 `{data:{...}, ...}` 里;本 CLI 不解包,调用方按需取 `.data`
- `comm.search` 名字带 `comm` 但实际是 KB page search(`/api/v1/search/pages`),v5 没有独立的全消息搜索

## 环境变量

- `COCO_API_URL` — cws-core 入口(默认 `http://127.0.0.1:8080`)
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀(默认 `/api/v1`)
