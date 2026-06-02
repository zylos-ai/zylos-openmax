# zylos-coco-workspace 认证与连接流程

| 属性 | 值 |
|------|-----|
| 版本 | v1.0 |
| 日期 | 2026-05-22 |
| 状态 | 正式 |

---

## 概览

Agent 与 COCO Workspace 的交互分为三个阶段：

```
阶段一：首次注册（一次性）
  └─ POST /auth/register/agent → api_key

阶段二：启动认证（每次 PM2 启动 / 重连）
  ├─ POST /auth/agent/token  (api_key → JWT)
  ├─ POST /auth/ws-ticket    (JWT → one-time ticket)
  └─ WS ws://host/ws?ticket=<ticket>

阶段三：运行时消息处理（持续）
  ├─ 入站：WS frame → comm-bridge → C4 → Agent → CLI
  └─ 出站：Agent → C4 → send.js → IPC HTTP → WS（REST 降级）
```

---

## 阶段一：Agent 注册（一次性）

触发时机：`zylos add coco-workspace` 执行 `hooks/post-install.js`，且 `config.agent.api_key` 未设置。

```
POST /auth/register/agent        ← 用一次性 ticket 认证
Body: {
  username:     "zylos-agent-xxx",   // 全局唯一，3-39 字符，小写字母数字连字符
  display_name: "Zylos Agent",
  ticket:       "<one-time ticket>"  // 非交互安装从 COCO_AGENT_TICKET 读
}

Response: {
  identity_id: "<uuid>",    // agent 的身份 UUID
  api_key:     "cwsk_xxx"   // 仅此一次明文返回
}
```

> **注意**：`api_key` 只在注册时返回一次，必须立即保存。之后只能重新注册。

注册完成后 post-install 写入 `config.json`(单一存储位置,无 `.env` 落地):
- `agent.identity_id` / `agent.api_key`
- `orgs.<slug>.org_id` / `self.member_id`(由 `COCO_ORG_ID` / `COCO_SELF_MEMBER_ID` 注入)

**存储位置**

| 值 | 存储位置 |
|----|---------|
| `api_key` | `~/zylos/components/coco-workspace/config.json` → `agent.api_key` |
| `identity_id` | `~/zylos/components/coco-workspace/config.json` → `agent.identity_id` |
| `org_id` | `~/zylos/components/coco-workspace/config.json` → `orgs.<slug>.org_id` |
| `member_id`(per-org) | `~/zylos/components/coco-workspace/config.json` → `orgs.<slug>.self.member_id` |

---

## 阶段二：启动认证与 WebSocket 连接

每次 `comm-bridge.js` 启动或 WebSocket 重连时执行。

### Step 1：api_key 换 JWT

```
POST /auth/agent/token
Authorization: Bearer <api_key>     ← cwsk_xxx 前缀
Body: { org_id: "<uuid>" }          ← 获得 org-scoped JWT

Response: {
  access_token:             "eyJ...",   // JWT，5-15 分钟 TTL
  access_token_expires_at:  "2026-...", // 绝对 UTC 时间
  refresh_token:            "...",      // 不透明，用于续期
  refresh_token_expires_at: "2026-..."  // 通常 7 天
}
```

Token 缓存在内存 + 写入 `runtime/token.json`（供 CLI 子进程读取，避免每次重新 exchange）。

### Step 2：JWT 换 WS Ticket

```
POST /auth/ws-ticket
Authorization: Bearer <access_token>  ← JWT
Body: { org_id: "<uuid>" }

Response: {
  ticket:     "wst_xxx",           // 一次性，30 秒 TTL
  expires_at: "2026-..."
}
```

> Ticket 每次建立 WebSocket 连接前现取，不缓存（30s TTL 太短）。

### Step 3：建立 WebSocket 连接

```
GET ws://<host>/ws?ticket=<ticket>
Upgrade: websocket
Connection: Upgrade
X-Workspace-Id: <workspace_id>
X-Device-Id:    <device_id>
(无 Authorization 头——ticket 在 URL 中即为认证凭证)
```

### Step 4：发送 ConnectRequest 帧

连接建立后的第一个文本帧：

```json
{
  "type": "connect",
  "payload": {
    "token":       "<access_token>",
    "client_id":   "<config.client_id>",
    "platform":    "server",
    "last_seq":    42,
    "app_version": "0.1.0",
    "device_id":   "<config.device_id>"
  }
}
```

### Step 5：接收 ConnectResponse

```json
{
  "type": "connect_response",
  "payload": {
    "session_token": "sess_...",    // 保存到 runtime/session.json（诊断用）
    "server_time":   1716163200000,
    "max_seq":       85,
    "user_id":       "agent_xxx",
    "resume_result": {
      "success":          true,
      "missed_messages":  []        // last_seq < max_seq 时补消息
    }
  }
}
```

若 `last_seq < max_seq`，服务端随后推送 `sync_start → sync_batch → sync_complete`，
comm-bridge 依次处理补发消息，发送 `sync_ack`，进入实时推送模式。

---

## Token 刷新

`access_token` 有效期约 5-15 分钟。Token 管理器（`src/lib/token.js`）在过期前 60 秒自动续期：

```
access_token 剩余 < 60s
  │
  ▼
POST /auth/refresh
Authorization: Bearer <access_token>
Body: { refresh_token: "...", org_id: "<uuid>" }
  │
  ▼
新的 { access_token, refresh_token }
  ├─ 写入内存缓存
  └─ 写入 runtime/token.json

若 refresh 失败（token family 已撤销）→ 重新走 Step 1 exchange
```

---

## 阶段三：入站消息处理

```
cws-comm WebSocket 推送 message 帧
  │
  ▼
comm-bridge.js onFrame()
  ├─ 去重（dedupe by message.id，5 分钟 TTL）
  ├─ fetchConversation(id)          ← GET /api/v1/conversations/{id}
  ├─ shouldHandleMessage()
  │   ├─ 自身发的消息 → 丢弃
  │   ├─ responseMode=silent → 丢弃
  │   ├─ responseMode=proactive → 全部处理
  │   └─ responseMode=at_only → DM 全处理 / group 仅 @mention
  ├─ 有 media_id → getMediaUrl() → downloadMedia() → 本地路径
  ├─ 拼消息上下文（fetchRecentMessages，群聊用）
  │
  ▼
c4-receive coco-workspace <endpoint> <body>
  │
  ▼
C4 bridge → Claude Agent
  │
  ├─ 加载 SKILL.md (L1+L2 始终在上下文)
  ├─ 按需加载 references/*.md (L3)
  │
  └─ 调用 CLI:
       node src/cli/tm.js  issue.create '{...}'
       node src/cli/kb.js  kb.search    '{...}'
       node src/cli/as.js  as.upload    '{...}'
       node src/cli/comm.js comm.send   '{...}'
```

所有 CLI 通过 `src/lib/client.js` 发 REST，`client.js` 自动从 `token.js` 取有效 JWT Bearer。

---

## 阶段三：出站消息

```
Agent 通过 C4 回复
  │
  ▼
c4-send coco-workspace "[COCO DM]/<convId>" "<message>"
  │
  ▼
scripts/send.js
  ├─ 解析 endpoint → conversationId / threadId / replyTo
  │
  ├─ 纯文本 / Markdown
  │   ├─ [主路径] 读取 runtime/bridge.json → 验证 pid 存活
  │   │    └─ POST 127.0.0.1:<port>/send
  │   │         { conversationId, text, threadId?, replyTo? }
  │   │              │
  │   │              ▼
  │   │         comm-bridge IPC server
  │   │           ├─ 长消息拆分（≤3000 chars，按段落/换行/硬截断）
  │   │           └─ buildWsSendFrame() → WS → cws-comm
  │   │
  │   └─ [降级] bridge 离线 / WS 断开（IPC 返回 503）
  │         └─ POST /api/v1/conversations/{id}/messages
  │                { client_msg_id, content:[{type,body}], reply_to? }
  │
  └─ [MEDIA:image|file]/path（始终走 REST）
      ├─ as.uploadMedia(localPath) → { mediaId }
      └─ POST /api/v1/conversations/{id}/messages
             { content:[{type:"image", body:<mediaId>}] }
```

---

## 错误处理与重连

| WS 关闭码 | 含义 | 处理 |
|-----------|------|------|
| `1000/1001` | 正常关闭 | 指数退避重连（1s→2s→…→30s） |
| `4001` | 心跳超时 | 同上 |
| `4002` | 认证失败 | **终止**，检查 `config.agent.api_key` |
| `4003` | Session 过期 | 清除 token 内存缓存 + session，重新 exchange → ticket → 重连 |
| `4004` | 限流 | 退避（初始 5s）后重连 |
| `4005` | 工作区暂停 | **终止** |
| `4006` | 重复连接 | **终止** |

---

## 关键文件索引

| 文件 | 职责 |
|------|------|
| `hooks/post-install.js` | 首次注册（`/auth/register/agent`）+ 配置引导 |
| `src/lib/token.js` | JWT 生命周期管理（exchange / refresh / ws-ticket / 磁盘持久化） |
| `src/lib/ws.js` | WebSocket 连接管理（重连、心跳、urlProvider 钩子） |
| `src/lib/connect.js` | ConnectRequest / ConnectResponse 帧构建与解析 |
| `src/lib/client.js` | 统一 HTTP 客户端（自动注入 JWT Bearer） |
| `src/comm-bridge.js` | PM2 服务入口；兼作 IPC HTTP server（`POST /send`，监听随机端口） |
| `src/lib/session.js` | WS runtime 状态持久化（last_seq、session_token） |
| `runtime/token.json` | JWT 磁盘缓存（CLI 子进程跨进程复用） |
| `runtime/bridge.json` | IPC bridge 端口 + pid，send.js 用于定位 comm-bridge 服务 |
