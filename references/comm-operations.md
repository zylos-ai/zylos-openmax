# Comm 操作指南

CLI 位置：`src/cli/comm.js`
调用方式：`node src/cli/comm.js <command> '<json>'`

## 何时使用 Comm CLI

被动 IM（人类发消息进来 → Agent 回复）走 C4 bridge 自动路由，**不需要手动调用 Comm CLI**。

Comm CLI 用于 Agent **主动发起**的 IM 操作：

| 场景 | 命令 |
| --- | --- |
| 列出我参与的会话 | `comm.list_conversations` |
| 主动 DM 某个 Agent / 人 | `comm.create_dm` → `comm.send` |
| 在非当前会话里发消息 | `comm.send` |
| 拉历史消息（往前翻 / 同步） | `comm.get_messages` |
| 编辑、撤回、置顶 | `comm.edit_message` / `comm.delete_message` / `comm.pin` |
| 标已读 | `comm.mark_read` |
| 全 IM 搜索 | `comm.search` |

实时事件推送（`message.created` / `typing.started` …）走 WebSocket，不在本 CLI 范围。

## 命令列表

### 会话

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `comm.list_conversations` | 列出参与的会话 | `{type?, q?, cursor?, limit?}` |
| `comm.get_conversation` | 单个会话详情 | `{conversationId, include?}` |
| `comm.create_conversation` | 通用创建（DM/群/B2B） | `{type, name?, memberIds?, agent1Id?, agent2Id?, trigger?, triggerDetail?, viewerMemberIds?}` |
| `comm.create_dm` | DM 快捷（`create_conversation type:"dm"`） | `{participantId}` |

`type` 取值：`all`（查询时默认）/ `dm` / `group` / `b2b`。

### 消息

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `comm.send` | 发消息 | `{conversationId, content, messageType?, attachments?, replyTo?, clientMessageId?}` |
| `comm.get_messages` | 拉历史 | `{conversationId, cursor?, limit?, direction?}` |
| `comm.edit_message` | 编辑 | `{messageId, content}` |
| `comm.delete_message` | 撤回 | `{messageId}` |
| `comm.pin` / `comm.unpin` | 置顶 / 取消 | `{messageId}` |
| `comm.mark_read` | 标已读到某条 | `{conversationId, messageId}` |
| `comm.typing` | "正在输入"指示 | `{conversationId, state?}` |

`content` 可以传字符串（自动归一为 `{text}`），也可以传完整 envelope：

```json
{
  "text": "你看下这版方案 @gavin",
  "format": "markdown",
  "mentions": [{"target_id":"usr-gavin","target_type":"human","display":"gavin"}]
}
```

`clientMessageId` 用于和 WebSocket 回来的 `message.created` 事件去重；不传会自动生成 `cmsg_<uuid>`。同一条逻辑消息重试请用同一个 id。

`messageType` 取值：`text`（默认）/ `image` / `file` / 其他网关约定值。

### 搜索

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `comm.search` | IM 全文搜索 | `{q, type?, conversationId?, senderId?, cursor?, limit?}` |

`type` 取值：`messages` / `files` / `links`。

## 典型流程

### Agent 主动联系一个人

```bash
# 1. 建立 DM 会话（如果已存在则直接返回）
node src/cli/comm.js comm.create_dm '{"participantId":"usr-gavin"}'
# -> {"data":{"id":"cv-xxx", ...}}

# 2. 发消息
node src/cli/comm.js comm.send '{
  "conversationId":"cv-xxx",
  "content":"周报准备好了,你方便的时候看看"
}'
```

### 群里发带附件的消息

```bash
# 1. 先上传附件到 IM（拿 attachment_id）
node src/cli/as.js as.upload_im '{
  "conversationId":"cv-team",
  "filePath":"/tmp/weekly.pdf"
}'
# -> {"data":{"attachment_id":"att-yyy","file_url":"..."}}

# 2. 发消息引用附件
node src/cli/comm.js comm.send '{
  "conversationId":"cv-team",
  "content":"本周周报",
  "attachments":[{"attachment_id":"att-yyy"}]
}'
```

### 同步历史 + 标已读

```bash
# 拉最近 50 条
node src/cli/comm.js comm.get_messages '{"conversationId":"cv-xxx","limit":50}'

# 处理完后把读位推到最新一条
node src/cli/comm.js comm.mark_read '{"conversationId":"cv-xxx","messageId":"msg-zzz"}'
```

## 注意事项

- 网关的 IM 是同一个会话模型,DM / 群 / B2B 都走 `/im/conversations`,只是 `type` 不同
- 发消息有失败重试时,**保留同一个 `clientMessageId`**,服务端按它做幂等
- `comm.edit_message` / `delete_message` 实际可编辑 / 撤回的时限和权限由后端控制,Agent 拿到 4xx 不要重试
- 网关草案里 thread（从一条消息开线程）暂未给独立路径,如果产品上需要,先放在 `replyTo` 上;真正的 thread 端点上线后再迁
- mention / reaction 编码仍在 align 中,以 cws-comm api-design.md 最新版为准

## 环境变量

- `COCO_API_URL` — 网关入口（默认 `http://127.0.0.1:8080`）
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀（默认 `/api/gateway/v1`）
