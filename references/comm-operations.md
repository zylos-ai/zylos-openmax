# Comm 操作指南

**作用**:Agent 主动发起的 IM 操作——建会话、发消息、拉历史、查未读、WS 重连补漏、page 搜索。所有命令通过 cws-core BFF 落到 cws-comm。

**何时加载本文档**:

- 想主动 DM / 拉群跟某个人或一群人沟通(`comm.create_dm` / `comm.create_group` → `comm.send`)
- 需要往某个已知 conversationId 里发消息(`comm.send`)
- 拉历史消息上下文(`comm.get_messages` / `comm.get_message`)
- 查会话未读数或 WS 重连后补漏(`comm.unread` / `comm.sync`)
- 在 KB 里关键词搜索 page(`comm.search`,v5 唯一的搜索入口)

**不在本文档范围**:

- **被动接消息**(人类发进来 → Agent 回复)走 C4 bridge 自动路由,不需要手动调 CLI
- 消息附件 / 媒体上传 → `references/as-operations.md`(`as.upload` 带 conversationId)
- 任务管理 / 状态机 → `references/tm-operations.md`
- KB page 内容读写 → `references/kb-operations.md`
- 成员 / 角色目录查询 → `references/core-operations.md`

**依赖前置**:

- 调用前先 `core.me` 拿当前 `member_id`,DM / Group 创建时它就是隐含的"我"
- DM 之前先 `core.member_list` 找到对方的 member_id
- 引用消息附件前先 `as.upload` 拿到 `media_id`
- 完整参数依赖树见 [`SKILL.md` 效率捷径 > 参数解析](../SKILL.md)

---

> Layer 3 操作参考。本文档与 `src/cli/comm.js` dispatch 表保持 1:1 对应。
> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`

CLI 位置:`src/cli/comm.js`
调用方式:`node src/cli/comm.js <command> '<json>'`

实时事件推送(`message.created` 等)走 WebSocket,由 `src/comm-bridge.js` 处理,不在本 CLI 范围。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF 基地址 |
| `COCO_AUTH_TOKEN` | (空) | Bearer token |
| `COCO_API_PREFIX` | `/api/v1` | 路径前缀 |

## 命令清单

### 会话

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `comm.list_conversations` | 列我参与的所有会话(分页) | `{pageSize?, pageToken?}` | `GET /api/v1/conversations` |
| ✅ | `comm.create_dm` | 跟单人开 DM(已存在直接返回,幂等) | `{participantId}` | `POST /api/v1/conversations/dm` |
| ✅ | `comm.create_group` | 拉群,自己 + participantIds 组成成员表 | `{title, participantIds[]}` | `POST /api/v1/conversations/groups` |
| ✅ | `comm.get_conversation` | 取单个会话详情 | `{conversationId}` | `GET /api/v1/conversations/{id}` |

`participantIds` 必须是 UUID 数组。DM 用一个 `participantId`(无 `title`),group 用多个 + `title`。

### 消息

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `comm.send` | 发消息;`content` 支持字符串 / markdown / 数组结构 | `{conversationId, content, replyTo?, clientMsgId?}` | `POST /api/v1/conversations/{id}/messages` |
| ✅ | `comm.get_messages` | 拉历史消息列表(基于 seq 的范围) | `{conversationId, afterSeq?, beforeSeq?, limit?}` | `GET /api/v1/conversations/{id}/messages` |
| ✅ | `comm.get_message` | 取单条消息详情(展开 content) | `{conversationId, messageId}` | `GET /api/v1/conversations/{id}/messages/{message_id}` |

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

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `comm.unread` | 查会话的未读消息计数 | `{conversationId}` | `GET /api/v1/conversations/{id}/unread` |

### 同步

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `comm.sync` | WS 断线重连后,按 `sinceSeq` 拉漏掉的事件 | `{sinceSeq, deviceId, limit?}` | `POST /api/v1/sync` |

### 搜索

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `comm.search` | KB page 全文搜索(v5 唯一搜索入口;名字带 comm 是历史包袱)| `{query, kbId?, limit?, offset?, sort?}` | `GET /api/v1/search/pages` |

## 典型流程

### Agent 主动联系一个人

```bash
# 1. 建立 DM 会话(已存在直接返回)
node src/cli/comm.js comm.create_dm '{"participantId":"<member-uuid>"}'
# -> {data:{id:"<conversation-uuid>", type:"dm", ...}}

# 2. 发消息
node src/cli/comm.js comm.send '{
  "conversationId":"<conversation-uuid>",
  "content":"周报准备好了,你方便的时候看看"
}'
```

### 群里发带附件的消息

```bash
# 1. 先上传附件(IM 模式,带 conversationId),拿 media_id
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
# 用最后已知 seq + device_id 拉漏掉的事件
node src/cli/comm.js comm.sync '{
  "sinceSeq":12345,
  "deviceId":"<device-id>",
  "limit":100
}'

# 看某个会话还有多少未读
node src/cli/comm.js comm.unread '{"conversationId":"<conv-uuid>"}'
```

## 与 SKILL.md 的关系

本文档是 [`SKILL.md`](../SKILL.md) 的 Layer 3 子 skill,只负责 Comm CLI 的**命令机制**。下面这些行为面内容**在 SKILL.md 里**,本文档不重复:

| 想看 | 去 SKILL.md 的哪节 |
|---|---|
| 何时该主动通信 vs 走 C4 bridge 被动响应 | [角色模型](../SKILL.md)(Lead 能与人类通信 / Worker 不行) |
| 参数依赖树 / 上下文锚定 | [效率捷径](../SKILL.md) |
| 通用错误防护(比如不该绕过 CLI 直接 curl) | [行为护栏 > 常见错误](../SKILL.md) |

## Comm 专属注意事项

- DM 走 `/conversations/dm`、Group 走 `/conversations/groups`,**不是**同一个 POST 通用入口
- 发消息失败重试时,**保留同一个 `clientMsgId`**,服务端按它做 5 分钟幂等
- cws-core 的 `SendMessageRequestBody` 是 `additionalProperties:false` —— 不要传 schema 外的字段(会被拒)
- 实际响应包在 `{data:{...}, ...}` 里;本 CLI 不解包,调用方按需取 `.data`
- `comm.search` 名字带 `comm` 但实际是 KB page search(`/api/v1/search/pages`),v5 没有独立的全消息搜索

## DM 权限管理 CLI

管理 DM 访问策略和白名单,修改后运行中的服务热加载生效(无需重启)。

| 命令 | 说明 | 参数 |
|---|---|---|
| `comm.dm_policy` | 查看或设置 DM 策略 | `{org?, policy?}` policy: open/allowlist/owner |
| `comm.dm_list` | 列出当前策略和白名单 | `{org?}` |
| `comm.dm_allow` | 添加成员到 DM 白名单 | `{memberId\|memberIds, org?}` |
| `comm.dm_revoke` | 从 DM 白名单移除成员 | `{memberId\|memberIds, org?}` |

- `org` 可选 — 单组织部署自动解析,多组织需指定 slug 或 org_id
- 修改直接写入 `config.json`,运行中的 comm-bridge 通过 `watchConfig` 热加载 `access.*` 字段
- `dmPolicy=owner` 模式下白名单不生效(仅 owner 可 DM);切到 `allowlist` 后白名单才有意义

示例:
```bash
# 查看当前策略
node src/cli/comm.js comm.dm_list '{}'

# 开放给指定成员
node src/cli/comm.js comm.dm_allow '{"memberId":"019ea63f-b7ff-..."}'

# 批量添加
node src/cli/comm.js comm.dm_allow '{"memberIds":["id1","id2"]}'

# 撤销
node src/cli/comm.js comm.dm_revoke '{"memberId":"019ea63f-b7ff-..."}'

# 切换策略
node src/cli/comm.js comm.dm_policy '{"policy":"allowlist"}'
```
