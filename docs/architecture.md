# zylos-coco-workspace 设计文档

| 属性 | 值 |
| --- | --- |
| 作者 | Daniel |
| 版本 | v0.2 |
| 日期 | 2026-05-18 |
| 状态 | 草案 |
| 仓库 | https://git.coco.xyz/coco-workspace/zylos-coco-workspace |
| 关联 | [zylos-lark DESIGN.md](../zylos-lark/DESIGN.md)（参考）、[Agent Skill 设计规范](../cws-work/docs/skill-design/agent-skill-spec.md)、[KB/AS 操作 Reference](../cws-work/docs/skill-design/kb-as-operations-reference.md)、[通信域模型](../coco-workspace/docs/modeling/domain/communication/communication.md) |

## 1. 定位

### 1.1 是什么

zylos-coco-workspace 是 zylos 平台的 **workspace 对接插件**，使 zylos agent 成为 COCO Workspace 的原生成员。

两个核心能力：

| 能力 | 说明 | 类比 |
| --- | --- | --- |
| 原生通信 | 通过 COCO 通信协议（cws-comm）收发消息，与人类和其他 Agent 实时通信 | zylos-lark 对接飞书，zylos-coco-workspace 对接 COCO 原生 IM |
| 服务对接 | 提供 TM、KB、AS、Comm、Core 等全部服务的 CLI 工具，以及 Agent 行为技能层 | 统一插件，包含所有 workspace 服务操作 |

### 1.2 与其他插件的关系

```
                    zylos agent
                        │
        ┌───────────────┼───────────────┐
        │               │               │
   zylos-lark      zylos-coco-workspace    zylos-core
   (飞书通信)       (原生通信+全部     (Agent 运行时)
                    服务 CLI+技能层)
        │               │
   Lark API        cws-comm / TM / KB / AS / Core API
```

- **zylos-lark / zylos-telegram**：外部 IM 桥接——把外部平台消息转成 C4 bridge 格式
- **zylos-coco-workspace**：原生 IM 桥接 + 全部 workspace 服务 CLI + 统一行为技能层
- **zylos-tm**：开发阶段独立迭代的 TM CLI，成熟后合入 zylos-coco-workspace 的 `cli/tm.js`

### 1.3 为什么是一个统一插件

Agent 收到人类消息后的行为是一个连续流程，贯穿 KB、TM、AS、Comm 所有服务：

```
接收意图 → kb.search 搜知识 → issue.create 建任务 → kb.write 写产出 → comm.send 交付
```

这个流程需要一个统一的行为 Skill（SKILL.md）来串联。如果把各服务 CLI 拆成独立插件，Agent 看到的是碎片化的工具说明，没有人告诉它整个 Lead/Worker 生命周期怎么串起来。

因此 zylos-coco-workspace 是一个大插件，各服务团队向同一个仓库贡献自己负责的 CLI 模块和操作指南。

### 1.4 不做什么

- 不做外部 IM 桥接（那是 zylos-lark / zylos-telegram 的职责）
- 不做 Agent 运行时管理（那是 zylos-core 的职责）
- 不实现具体业务逻辑——只提供工具和行为指导，Agent 的决策在运行时发生

## 2. 架构

### 2.1 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        zylos-coco-workspace                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────────────────────────────────┐                  │
│  │         通信模块 (PM2 Service)              │                  │
│  │                                            │                  │
│  │  comm-bridge.js (WebSocket Client)         │                  │
│  │    ├─ 连接 cws-comm WebSocket              │                  │
│  │    ├─ 接收消息事件 → c4-receive              │                  │
│  │    └─ 维护连接 / 重连 / 心跳                  │                  │
│  │                                            │                  │
│  │  send.js (C4 标准发送接口)                   │                  │
│  │    └─ C4 回调 → cws-comm HTTP API           │                  │
│  └────────────────────────────────────────────┘                  │
│                                                                  │
│  ┌────────────────────────────────────────────┐                  │
│  │         服务 CLI 模块 (无状态)               │                  │
│  │                                            │                  │
│  │  cli/tm.js   — TM 操作 (Issue/Task/...)    │                  │
│  │  cli/kb.js   — KB 搜索 / 读写 / 列目录      │                  │
│  │  cli/as.js   — AS 上传 / 引用 / 查询        │                  │
│  │  cli/comm.js — 主动通信操作                  │                  │
│  │  cli/core.js — 组织 / 团队 / Agent 查询     │                  │
│  └────────────────────────────────────────────┘                  │
│                                                                  │
│  ┌────────────────────────────────────────────┐                  │
│  │         技能层 (渐进式加载)                   │                  │
│  │                                            │                  │
│  │  SKILL.md (L1+L2)                          │                  │
│  │    角色识别 + Lead/Worker 生命周期            │                  │
│  │    + Layer 3 索引                           │                  │
│  │                                            │                  │
│  │  references/tm-operations.md  (L3, 按需加载)    │                  │
│  │  references/kb-operations.md  (L3, 按需加载)    │                  │
│  │  references/as-operations.md  (L3, 按需加载)    │                  │
│  │  references/comm-operations.md(L3, 按需加载)    │                  │
│  │  references/core-operations.md(L3, 按需加载)    │                  │
│  └────────────────────────────────────────────┘                  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 模块职责

| 模块 | 类型 | 职责 |
| --- | --- | --- |
| comm-bridge.js | PM2 常驻服务 | WebSocket 长连接，实时收发 COCO 消息，桥接到 C4 bridge |
| cli/tm.js | 无状态 CLI | 封装 TM API：Issue/Task/Blueprint/Comment 操作 |
| cli/kb.js | 无状态 CLI | 封装 KB API：搜索、读写 Page、列目录、查历史 |
| cli/as.js | 无状态 CLI | 封装 AS API：上传 Artifact、获取 URI、查元数据 |
| cli/comm.js | 无状态 CLI | 封装 Comm API：主动发消息、建会话、更新已读、创线程 |
| cli/core.js | 无状态 CLI | 封装 Core API：查组织信息、团队成员、Agent 详情、项目列表 |
| SKILL.md | L1+L2 技能 | 始终加载：角色识别 + Lead/Worker 完整生命周期 + L3 索引 |
| references/*.md | L3 操作指南 | 按需加载：各服务 CLI 的命令列表、参数格式、使用场景 |

### 2.3 团队协作模型

每个服务团队的交付物是一对文件：

| 团队 | CLI 代码 | 操作指南 |
| --- | --- | --- |
| TM 团队（我们） | `src/cli/tm.js` | `references/tm-operations.md` |
| KB 团队 | `src/cli/kb.js` | `references/kb-operations.md` |
| AS 团队 | `src/cli/as.js` | `references/as-operations.md` |
| Comm 团队 | `src/cli/comm.js` | `references/comm-operations.md` |
| Core 团队 | `src/cli/core.js` | `references/core-operations.md` |

通信模块（comm-bridge.js）、SKILL.md（L1+L2 行为层）、共享基础设施（lib/）由我们维护。

### 2.4 渐进式加载

```
Agent 启动
    │
    ▼
SKILL.md 始终加载 (Layer 1+2)
  ├─ 角色识别规则
  ├─ Lead 完整生命周期
  ├─ Worker 完整生命周期
  └─ Layer 3 操作指南索引
    │
    ▼ (按需，在具体 phase 需要时)
references/kb-operations.md    ← 上下文组装时
references/tm-operations.md    ← 创建 Issue/Task 时
references/as-operations.md    ← 上传产出时
references/comm-operations.md  ← 主动创建会话时
references/core-operations.md  ← 查询团队能力时
```

SKILL.md 写的是"Phase 3 上下文组装时，搜索 KB 获取项目知识"，但不写 `kb.search` 的参数细节。Agent 到了那一步按索引加载 `references/kb-operations.md`，拿到具体命令格式再执行。

## 3. 通信模块

通信模块功能上对标 zylos-lark 的通信能力，但对接的是 COCO 原生通信协议而非外部 IM。

### 3.1 与 zylos-lark 的对比

| 维度 | zylos-lark | zylos-coco-workspace |
| --- | --- | --- |
| 传输协议 | Webhook (HTTP POST) / WSClient | WebSocket 长连接 |
| 消息来源 | Lark 事件推送 | cws-comm 实时事件流 |
| 身份 | Lark Bot (App ID + Secret) | COCO AgentMember (Participant) |
| 消息格式 | Lark 消息结构 → 解析为文本 | COCO Message (JSONB) → 解析为文本 |
| 会话模型 | Lark p2p / group → endpoint 格式 | COCO Conversation (dm/group/thread) → endpoint 格式 |
| 发送接口 | send.js → Lark API | send.js → cws-comm API |
| 访问控制 | dmPolicy / groupPolicy / per-group config | 同 lark：dmPolicy / groupPolicy / per-group config（per-org，多 org 各自独立） |
| 入口文件 | index.js（单一职责） | comm-bridge.js（通信模块是多个模块之一） |

### 3.2 入站消息流（Workspace → Agent）

**多 org**：每个在 `config.orgs.*.enabled=true` 的 org 启动一条独立的 WebSocket
连接。下方流程对每条连接独立执行。

```
cws-comm WebSocket 连接（per-org）
    │
    ├─ 事件: message:new
    │   ├─ 解析 conversationId, senderId, content, seq
    │   ├─ 查询 Conversation 类型 (dm/group/thread)
    │   ├─ 本地 access policy 过滤（与 lark 同款，per-org）：
    │   │   ├─ self-echo：sender == orgs[slug].self.member_id → skip
    │   │   ├─ DM：
    │   │   │   ├─ dmPolicy=open      → accept
    │   │   │   ├─ dmPolicy=allowlist → 查 dmAllowFrom
    │   │   │   └─ dmPolicy=owner     → owner.member_id 为空则自动绑定首发 sender；
    │   │   │                          否则只接 owner.member_id
    │   │   └─ Group/Thread：
    │   │       ├─ groupPolicy=disabled → drop
    │   │       ├─ groupPolicy=allowlist → 查 groups[convId]
    │   │       ├─ mode=mention → 要求 @本 agent
    │   │       ├─ mode=smart   → 收全部
    │   │       └─ allowFrom: ['*']/[] 全员；否则按 member_id 列表过滤
    │   ├─ 构建消息上下文 (recent messages)
    │   └─ 调用 c4-receive → C4 bridge → Agent
    │
    ├─ 事件: thread:created
    │   └─ 如果 Agent 是主会话参与者 → 自动加入 thread
    │
    └─ 事件: sync:request (断线重连)
        └─ 用 lastSeq 拉取缺失消息，逐条处理
```

### 3.3 出站消息流（Agent → Workspace）

```
Agent 通过 C4 bridge 回复
    │
    ▼
c4-send coco-workspace <endpoint> <message>
    │
    ▼
send.js 解析 endpoint
    │
    ├─ endpoint 格式: [COCO <type>]/<conversationId>|thread:<threadConvId>|reply:<msgId>
    │
    ├─ 纯文本 → POST /api/conversations/{id}/messages (type=text)
    ├─ Markdown → POST /api/conversations/{id}/messages (type=text, markdown=true)
    ├─ [MEDIA:image]/path → 上传至 AS → 发送 image 类型消息
    ├─ [MEDIA:file]/path → 上传至 AS → 发送 file 类型消息
    └─ 线程回复 → 发送到 threadConversationId
```

### 3.4 Endpoint 格式

延续 zylos-lark 的 endpoint 编码风格，适配 COCO 会话模型：

```
[COCO DM]/<conversationId>
[COCO GROUP]/<conversationId>|reply:<messageId>
[COCO THREAD]/<conversationId>|thread:<threadConvId>|parent:<parentMsgId>
```

| 字段 | 含义 |
| --- | --- |
| `conversationId` | COCO Conversation UUID |
| `reply` | 引用回复的目标消息 ID |
| `thread` | 线程子会话 ID |
| `parent` | 线程中直接父消息 ID |

### 3.5 消息格式

入站消息（发送给 C4 bridge）遵循 zylos-lark 建立的格式约定：

```
# DM
[COCO DM] 张三 said: 帮我分析一下上周的竞品报告

# 群组 @mention
[COCO GROUP] 张三 said: [Group context - recent messages:]
[李四]: 新功能方案定了吗？
[王五]: 还在评审

[Current message:] @Agent 你来看看可行性

# 线程
[COCO THREAD] 张三 said: [Thread context:]
[root] 李四: 我们需要做竞品分析
[张三]: 分析哪几个维度？

[Current message:] 主要看定价和功能对比

# 带附件
[COCO DM] 张三 said: 帮我看看这个文件 ---- file: /tmp/workspace-media/doc-xxx.pdf
```

### 3.6 WebSocket 连接管理

| 机制 | 实现 |
| --- | --- |
| 认证 | 连接时携带 Agent 的 Bearer token |
| 心跳 | 定期 ping/pong，检测连接活性 |
| 断线重连 | 指数退避重连（1s → 2s → 4s → ... → 30s 上限） |
| 消息补全 | 重连后用 `sync:request` + lastSeq 拉取缺失消息 |
| 去重 | 基于 messageId 的 TTL 缓存，防止重复处理 |

### 3.7 已读与状态

通信模块自动维护 Agent 的在线状态和已读游标：

- Agent 处理完消息后，自动更新 ReadCursor（`lastReadSeq`）
- 出站消息前设置 typing 状态，发送完毕后清除
- 在线/离线状态跟随 WebSocket 连接状态

## 4. 服务 CLI 模块

所有 CLI 遵循 zylos-tm 建立的模式：无状态、JSON 输入输出、退出码表示成功/失败。

```bash
node src/cli/<service>.js <command> '<json-params>'
```

CLI 命令列表和使用场景详见各 Layer 3 操作指南（`references/*-operations.md`），此处不重复。

### 4.1 CLI 通用设计

所有 CLI 共享 `src/lib/client.js`（HTTP client + 认证）：

- 使用 Node.js 20+ 原生 `fetch`，零外部依赖
- `COCO_API_URL` 环境变量指定后端基地址
- `COCO_AUTH_TOKEN` 环境变量提供 Bearer token

**输出格式**

```bash
# 成功: JSON 输出到 stdout, exit code 0
{"pageId": "pg-xxx", "path": "/projects/growth/research/pricing.md"}

# 失败: JSON 错误输出到 stderr, exit code 1
{"error": "page not found", "code": "NOT_FOUND"}
```

**权限错误处理**

| 错误码 | 含义 | Agent 应对 |
| --- | --- | --- |
| `NOT_FOUND` | 资源不存在或无读权限 | 换搜索策略或请求 Lead 提供路径 |
| `PERMISSION_DENIED` | 有读权限但无写权限 | 向 Lead 汇报，请求权限或换写入位置 |
| `CONFLICT` | 写入冲突（KB 并发编辑） | 重新读取后重试 |

## 5. 目录结构

### 5.1 代码目录

```
zylos-coco-workspace/
├── SKILL.md                      # L1+L2: 角色识别 + Lead/Worker 生命周期 + L3 索引
├── DESIGN.md                     # 本设计文档
├── CLAUDE.md                     # 开发约定
├── package.json
├── ecosystem.config.cjs          # PM2 配置（通信模块）
│
├── references/                       # Layer 3: 按需加载的操作指南
│   ├── tm-operations.md          #   TM 团队提供
│   ├── kb-operations.md          #   KB 团队提供
│   ├── as-operations.md          #   AS 团队提供
│   ├── comm-operations.md        #   通信操作指南
│   └── core-operations.md        #   Core 团队提供
│
├── src/
│   ├── comm-bridge.js            # 通信模块入口（WebSocket → C4 bridge）
│   ├── cli/
│   │   ├── tm.js                 #   TM 团队提供
│   │   ├── kb.js                 #   KB 团队提供
│   │   ├── as.js                 #   AS 团队提供
│   │   ├── comm.js               #   通信操作 CLI
│   │   └── core.js               #   Core 团队提供
│   └── lib/
│       ├── client.js             # HTTP client（共享，native fetch + 认证）
│       ├── config.js             # 配置加载 + 热重载
│       ├── ws.js                 # WebSocket 连接管理
│       ├── message.js            # 消息解析与格式化
│       └── media.js              # 媒体文件处理
│
├── scripts/
│   └── send.js                   # C4 标准发送接口
│
└── hooks/
    ├── post-install.js           # 安装后配置
    └── post-upgrade.js           # 升级后迁移
```

### 5.2 运行时数据目录

```
~/zylos/components/coco-workspace/
├── config.json                   # 运行时配置
├── media/                        # 媒体文件临时存储
└── logs/                         # PM2 日志
```

## 6. 配置

### 6.1 config.json

```json
{
  "enabled": true,

  "comm": {
    "ws_url": "ws://127.0.0.1:8080/ws",
    "reconnect_max_delay": 30000,
    "heartbeat_interval": 30000
  },

  "agent": {
    "id": "",
    "participant_id": ""
  },

  "message": {
    "context_messages": 10,
    "dedup_ttl": 300000
  }
}
```

### 6.2 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | COCO 后端 API 基地址 |
| `COCO_AUTH_TOKEN` | — | Agent 认证 token（必须） |
| `COCO_WS_URL` | `ws://127.0.0.1:8080/ws` | WebSocket 端点（可从 config.json 覆盖） |

## 7. 生命周期管理

### 7.1 SKILL.md 注册

```yaml
---
name: coco-workspace
version: 0.1.0
type: communication
service:
  name: zylos-coco-workspace
  entry: src/comm-bridge.js
data_dir: ~/zylos/components/coco-workspace
---
```

### 7.2 安装

```bash
zylos add coco-workspace
# 1. 克隆到 ~/zylos/.claude/skills/coco-workspace/
# 2. npm install
# 3. post-install hook: 创建数据目录、生成默认 config.json
# 4. 注册 PM2 服务
# 5. 启动通信模块
```

### 7.3 升级

```bash
zylos upgrade coco-workspace
# 1. git pull
# 2. npm install
# 3. post-upgrade hook: config.json 字段迁移（如有）
# 4. PM2 reload（graceful restart）
```

## 8. 待细化

| 项目 | 说明 | 依赖 |
| --- | --- | --- |
| WebSocket 消息协议细节 | cws-comm 的 WebSocket 事件格式和认证握手流程 | cws-comm 服务开发进度 |
| Agent token 获取流程 | Agent 在 Workspace 中的认证方式和 token 刷新 | 鉴权模型落地 |
| 离线消息处理 | Agent 重启后如何补全离线期间的消息 | cws-comm 的 sync 协议 |
| 与 zylos-lark 的共存 | Agent 同时连接外部 IM 和原生 IM 时的消息路由和去重 | C4 bridge 的 channel 隔离机制 |
| zylos-tm 合入时机 | 开发阶段 zylos-tm 独立迭代，成熟后代码搬入 cli/tm.js | TM CLI 稳定度 |
