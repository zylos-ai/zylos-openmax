# comm ↔ core 接口对齐文档

> 基准版本：cws-comm `bfb6db2`，cws-core `35ca93b`
>
> 架构约定：**所有 REST 调用走 cws-core（BFF），cws-comm 不直接暴露给客户端。**
> cws-core 负责代理/聚合 cws-comm 的接口，并补充身份信息（org_id、member_id 注入）。

---

## 一、cws-core 目前的 comm 代理状态

cws-core 当前只有 **4 个** comm 相关接口（全部是 501 stub，未实现）：

| Method | Path | OperationID | 状态 |
|--------|------|-------------|------|
| GET | /api/v1/conversations | list-conversations | ⚠️ STUB |
| POST | /api/v1/conversations | create-conversation | ⚠️ STUB |
| GET | /api/v1/conversations/{conversation_id}/messages | list-messages | ⚠️ STUB |
| POST | /api/v1/conversations/{conversation_id}/messages | send-message | ⚠️ STUB |

其余 **70 个** cws-comm 接口在 cws-core 中**完全没有对应入口**。

---

## 二、cws-comm 全量接口 & core 暴露状态

### Conversations（15 个）

| Method | Path | OperationID | core 状态 | 备注 |
|--------|------|-------------|-----------|------|
| POST | /api/v1/conversations | create-conversation | ⚠️ STUB + ❌ 参数不对齐 | 见下方详细说明 |
| GET | /api/v1/conversations | list-conversations | ⚠️ STUB + ❌ 参数不对齐 | 见下方详细说明 |
| GET | /api/v1/conversations/list | list-conversations-for-user | ❌ 未暴露 | 含 is_pinned/is_muted/unread_count，更适合客户端 list |
| GET | /api/v1/conversations/{conv_id} | get-conversation | ❌ 未暴露 | |
| PATCH | /api/v1/conversations/{conv_id} | update-conversation | ❌ 未暴露 | |
| POST | /api/v1/conversations/{conv_id}/archive | archive-conversation | ❌ 未暴露 | |
| POST | /api/v1/conversations/dm | get-or-create-dm | ❌ 未暴露 | |
| POST | /api/v1/conversations/{conv_id}/members | add-member | ❌ 未暴露 | |
| DELETE | /api/v1/conversations/{conv_id}/members/{user_id} | remove-member | ❌ 未暴露 | |
| PATCH | /api/v1/conversations/{conv_id}/members/{user_id}/role | update-member-role | ❌ 未暴露 | |
| GET | /api/v1/conversations/{conv_id}/members | list-members | ❌ 未暴露 | |
| POST | /api/v1/conversations/{conv_id}/pin | pin-conversation | ❌ 未暴露 | |
| DELETE | /api/v1/conversations/{conv_id}/pin | unpin-conversation | ❌ 未暴露 | |
| POST | /api/v1/conversations/{conv_id}/mute | mute-conversation | ❌ 未暴露 | |
| DELETE | /api/v1/conversations/{conv_id}/mute | unmute-conversation | ❌ 未暴露 | |

### Messages（6 个）

| Method | Path | OperationID | core 状态 |
|--------|------|-------------|-----------|
| POST | /api/v1/conversations/{conv_id}/messages | send-message | ⚠️ STUB + ❌ 参数不对齐 |
| GET | /api/v1/conversations/{conv_id}/messages | list-messages | ⚠️ STUB + ❌ 参数不对齐 |
| GET | /api/v1/messages/{message_id} | get-message | ❌ 未暴露 |
| PUT | /api/v1/messages/{message_id} | edit-message | ❌ 未暴露 |
| DELETE | /api/v1/messages/{message_id} | recall-message | ❌ 未暴露 |
| GET | /api/v1/messages/{message_id}/edits | list-message-edits | ❌ 未暴露 |

### Notifications（4 个）— ❌ 全部未暴露

| Method | Path | OperationID |
|--------|------|-------------|
| GET | /api/v1/notifications | list-notifications |
| POST | /api/v1/notifications/{id}/read | mark-notification-read |
| POST | /api/v1/notifications/read-all | mark-all-notifications-read |
| GET | /api/v1/notifications/unread-count | get-notification-unread-count |

### Read Receipts（2 个）— ❌ 全部未暴露

| Method | Path | OperationID |
|--------|------|-------------|
| POST | /api/v1/conversations/{conv_id}/read | mark-read |
| GET | /api/v1/conversations/{conv_id}/unread | get-unread-count |

### Pinned Messages（3 个）— ❌ 全部未暴露

| Method | Path | OperationID |
|--------|------|-------------|
| POST | /api/v1/conversations/{conversation_id}/pinned-messages | pin-message |
| DELETE | /api/v1/conversations/{conversation_id}/pinned-messages/{message_id} | unpin-message |
| GET | /api/v1/conversations/{conversation_id}/pinned-messages | list-pinned-messages |

### Search（1 个）— ❌ 未暴露

| Method | Path | OperationID |
|--------|------|-------------|
| POST | /api/v1/messages/search | search-messages |

### Typing（1 个）— ❌ 未暴露

| Method | Path | OperationID |
|--------|------|-------------|
| POST | /api/v1/conversations/{conv_id}/typing | send-typing |

### Media（7 个）— ❌ 全部未暴露

| Method | Path | OperationID |
|--------|------|-------------|
| POST | /api/media/upload | media-upload |
| GET | /api/media/{media_id} | media-get |
| GET | /api/media/{media_id}/url | media-download-url |
| GET | /api/media/{media_id}/thumbnail | media-thumbnail-url |
| DELETE | /api/media/{media_id} | media-delete |
| PUT | /api/media/{media_id}/content-hash | media-update-content-hash |
| PUT | /api/media/{media_id}/scan-status | media-update-scan-status |

### Groups（7 个）— ❌ 全部未暴露

| Method | Path | OperationID |
|--------|------|-------------|
| POST | /api/v1/groups | create-group |
| GET | /api/v1/groups/{group_id} | get-group |
| PATCH | /api/v1/groups/{group_id} | update-group |
| POST | /api/v1/groups/{group_id}/members | add-group-member |
| DELETE | /api/v1/groups/{group_id}/members/{user_id} | remove-group-member |
| PATCH | /api/v1/groups/{group_id}/members/{user_id} | update-group-member |
| GET | /api/v1/groups/{group_id}/members | list-group-members |

### Channels（8 个）— ❌ 全部未暴露

| Method | Path |
|--------|------|
| POST | /api/v1/channels |
| GET | /api/v1/channels |
| GET | /api/v1/channels/{channel_id} |
| POST | /api/v1/channels/{channel_id}/subscribe |
| DELETE | /api/v1/channels/{channel_id}/subscribe |
| POST | /api/v1/channels/{channel_id}/members |
| PATCH | /api/v1/channels/{channel_id}/members/{user_id}/role |
| GET | /api/v1/channels/{channel_id}/members |

### Announcements（3 个）— ❌ 全部未暴露

### Agent Config（3 个）— ❌ 全部未暴露

### Agent Gateway（6 个）— ❌ 全部未暴露

### B2B DM（4 个）— ❌ 全部未暴露

### Bridges（9 个）— ❌ 全部未暴露

### Conversation Artifacts（1 个）— ❌ 未暴露

### Onboarding（1 个）— ❌ 未暴露（内部运维接口，不应暴露）

### Webhooks（2 个）— ❌ 未暴露（Lark/Slack inbound，不走 core）

---

## 三、已有 stub 的 4 个接口参数不对齐详情

### 3.1 GET /api/v1/conversations — list-conversations

**请求参数不对齐：**

| 参数 | cws-comm | cws-core stub | 说明 |
|------|---------|---------------|------|
| 分页游标 | `cursor` (string) | `page_token` (string) | 名称不同，需统一 |
| 分页大小 | `limit` (1-100) | `page_size` | 名称不同，需统一 |
| 类型过滤 | `type` (string) | 无 | core stub 缺失 |
| 归档过滤 | `include_archived` (bool) | 无 | core stub 缺失 |

**响应不对齐：**

cws-comm 有两个 list 接口：
- `GET /api/v1/conversations`：返回 `conversationBody`（无 is_pinned/is_muted/unread_count）
- `GET /api/v1/conversations/list`：返回 `conversationListItemBody`（含 is_pinned、is_muted、unread_count、last_read_seq）

cws-core stub 返回 `conversationSummary`（设计中包含 participants[]、last_message、unread_count、pinned、muted），这是 BFF 聚合视图——比 cws-comm 单接口返回的字段更丰富。

| 字段 | cws-comm conversationBody | cws-core stub conversationSummary | 说明 |
|------|--------------------------|-----------------------------------|------|
| id | string | UUID format | 类型标注不同（实际都是 UUID string） |
| name | `name` | `title` | **字段名不同，需统一** |
| participants | 无（单独 list-members） | `participants[]` 含 member_id/kind/display_name | core BFF 需聚合 |
| last_message | `last_message_id`+`last_message_at` | `last_message` 对象含 id/sender_id/preview/created_at | core BFF 需聚合 |
| unread_count | 无（单独 unread 接口） | `unread_count` | core BFF 需聚合 |
| pinned | `is_pinned`（在 listItemBody） | `pinned` | 字段名不同 |
| muted | `is_muted`（在 listItemBody） | `muted` | 字段名不同 |
| metadata | `metadata` (map) | 无 | core stub 缺失 |
| max_members/member_count | 有 | 无 | core stub 缺失 |

**结论**：cws-core BFF 的 list-conversations 需要聚合 cws-comm 的多个接口（conversations/list + read-receipts + members）。字段名 `name` vs `title` 需要在 core BFF 层做映射。

---

### 3.2 POST /api/v1/conversations — create-conversation

**请求不对齐：**

| 字段 | cws-comm | cws-core stub | 说明 |
|------|---------|---------------|------|
| 会话名称 | `name` | `title` | **字段名不同，需统一** |
| 初始成员 | 无（create 后单独 add-member） | `participant_ids` ([]UUID) | core BFF 需在创建后批量调用 add-member |
| 类型枚举 | dm\|group\|thread\|broadcast\|bridge | dm\|group | core stub 枚举范围不完整 |
| max_members | 有 | 无 | core stub 缺失 |
| metadata | 有 | 无 | core stub 缺失 |

**响应不对齐：**

| 字段 | cws-comm | cws-core stub | 说明 |
|------|---------|---------------|------|
| 返回内容 | 完整 conversationBody | 仅 { id, type, created_at } | cws-core 按 minimal 设计，合理 |

**结论**：`name` vs `title` 字段名在 BFF 层做映射；`participant_ids` 需要 BFF 在创建后逐个调 add-member；core stub 的类型枚举需扩充。

---

### 3.3 GET /api/v1/conversations/{conversation_id}/messages — list-messages

**请求参数：基本对齐**（after_seq、before_seq、limit 三个参数名一致）

**响应不对齐：**

| 字段 | cws-comm messageBody | cws-core stub messageItem | 说明 |
|------|---------------------|---------------------------|------|
| id | `id` (int64) | `id` (UUID format) | **类型不同：cws-comm 用 int64** |
| sender | `sender_id` (string) | `sender_id` (UUID format) | 标注不同（实际都是 UUID string） |
| 消息内容 | `content` (string) + `type` (enum) | `content` ([]{ type, body }) | **模型完全不同** |
| 回复引用 | `parent_id` (int64) + `parent` (object) | `reply_to` (UUID) | **字段名和类型均不同** |
| 时间戳 | `timestamp` (int64 unix ms) + `created_at` | `created_at` (time.Time) | 两套时间字段 |
| content_version | 有 | 无 | |
| fallback_text | 有 | 无 | |
| mentions | 有 | 无 | |
| edited_at | 有 | 无 | |
| deleted_at | 有 | 无 | |
| metadata | 有 | 无 | |
| delivery_status | 无 | 有 | core stub 新增字段 |

**结论**：响应模型差异巨大。核心问题：
1. message id 是 int64（cws-comm）vs UUID（cws-core stub 设计）——cws-comm 实际用 int64，core stub 的 UUID 标注错误
2. content 模型需要 BFF 做转换（string → array）
3. parent_id (int64) → reply_to 需要 BFF 解析

---

### 3.4 POST /api/v1/conversations/{conversation_id}/messages — send-message

**请求不对齐：**

| 字段 | cws-comm | cws-core stub | 说明 |
|------|---------|---------------|------|
| 消息类型 | `type` (required enum: text\|image\|...) + `content_type` (required enum) | `content` ([]{ type, body }) | **模型完全不同** |
| 内容 | `content` (string) + `content_body` (map) | `content[].body` (string) | 结构差异 |
| 回复 | `parent_id` (int64) | `reply_to` (UUID) | **字段名和类型不同** |
| media_ids | 有 | 无 | core stub 缺失 |
| ttl | 有 | 无 | core stub 缺失 |
| metadata | 有 | 无 | core stub 缺失 |

**响应不对齐：**

| 字段 | cws-comm | cws-core stub | 说明 |
|------|---------|---------------|------|
| id | int64 | UUID (messageItem) | 类型不同 |
| 返回内容 | { id, seq, timestamp, conversation_id, mentions?, parent? } | 完整 messageItem | cws-comm 更精简 |

**结论**：请求模型需要 BFF 做转换。建议 core BFF 定义自己的统一 content 模型，内部映射到 cws-comm 的 type+content_type+content_body 格式。

---

## 四、当前客户端处理建议

在 cws-core BFF 代理完整实现之前，zylos-coco-workspace 的处理策略：

| 接口分类 | 当前处理 | 长期目标 |
|---------|---------|---------|
| conv/message 4个核心接口 | 直连 cws-comm（绕过 core 501） | 等 core BFF 实现后切换 |
| 其余 70 个接口 | 直连 cws-comm | 等 core BFF 逐步暴露后迁移 |
| WS 连接 | 直连 cws-comm（`?token=<jwt>`） | 等 cws-comm 支持 ticket 后改回 |

**直连时的 URL 映射：**
- REST base URL = `COCO_COMM_URL`（直接指向 cws-comm，如 `http://127.0.0.1:8082`）
- 认证：`Authorization: Bearer <access_token>`（JWT，不是 api_key）
- WS URL = `COCO_WS_URL?token=<access_token>`（注意：comm 读 `?token=` 不是 `?ticket=`）

---

## 五、需要 cws-core / cws-comm 修复的问题汇总

| 优先级 | 问题 | 涉及服务 | 建议处理 |
|--------|------|---------|---------|
| P0 | WS 认证：cws-comm 读 `?token=<jwt>`，cws-core 发 `?ticket=<ticket>` | cws-comm | cws-comm 支持消费 ticket（ConsumeWSTicket），或 cws-core 明确 `?token=` 为规范 |
| P0 | 字段名：`name` vs `title` | core stub | core BFF 实现时统一为 `name`（comm 的命名） |
| P0 | message id 类型：int64 vs UUID format | core stub | core stub 去掉 UUID format 标注，改为 int64 string |
| P1 | content 模型不统一 | core stub | BFF 层做格式转换，对外暴露统一模型 |
| P1 | parent_id(int64) vs reply_to(UUID) | core stub | BFF 统一为 `parent_id` (string/int64) |
| P1 | 分页参数：cursor/limit vs page_token/page_size | core stub | 统一为 cursor/limit（与 comm 对齐） |
| P2 | core stub 缺 type/include_archived/metadata/media_ids 等字段 | core stub | BFF 实现时补齐 |
| P2 | 70 个 comm 接口在 core 无代理 | cws-core | 按优先级逐步在 core 开放代理 |
