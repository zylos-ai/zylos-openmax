# cws-core API 缺口报告

> **作者**:zylos
> **日期**:2026-05-20
> **针对版本**:cws-core OpenAPI(`https://zylos01.jinglever.com/cws-core/openapi.json`,2026-05-20 抓取)
> **目的**:把 zylos-coco-workspace 当前用到的接口跟 cws-core 实际暴露的接口做对照,列出 core 需要补的端点 + 我们这边需要修的错配。

## 0. 数据

- **cws-core 现有端点**:38(含 7 个 `/auth/*` + 31 个 `/api/v1/*`)
- **zylos-coco-workspace 使用端点**:**50+**(含 5 个 CLI + comm-bridge + send.js + media.js)
- **正确对接的**:`/me`、`/members(/{id})`、`/agents`(列表)、`/projects` 全套 + `/projects/{id}/members`、`/projects/{id}/issues(/{iid})`、`/issues`(列表)、`/tasks`(列表)、`/conversations`、`/conversations/{id}/messages`、`/organizations(/{id})`、`/auth/ws-ticket`(已废)
- **本仓库 50+ 端点中,40+ 个 core 没暴露或路径/形状不对**

---

## 1. 必须本仓库自己修的"错配"(不是 core 的锅)

这些是 zylos-coco-workspace 在写 scaffold 时基于 **cws-fe-api-gateway 草案** 假设的接口形态,跟 cws-core 真实 OpenAPI 不一致。core 不需要为此改动,**我们这边改就行**。

### 1.1 路径前缀错配 — `/api/gateway/v1` ≠ `/api/v1`

| 我们写的(scaffold 默认) | core 真实 |
|---|---|
| `/api/gateway/v1/*` | `/api/v1/*` |

- 出处:`src/lib/client.js → apiPath()` 默认前缀 `'/api/gateway/v1'`
- 影响:5 个 CLI(`kb.js`、`as.js`、`core.js`、`comm.js`、`tm.js` gateway 侧路径)上线全部 404
- 修复:`apiPath()` 默认改为 `'/api/v1'`;保留 `COCO_API_PREFIX` env 覆盖给调试用
- 工作量:1 行代码

### 1.2 IM 路径多了 `/im/` 段

| 我们写的 | core 真实 |
|---|---|
| `/im/conversations` | `/api/v1/conversations` |
| `/im/conversations/{id}/messages` | `/api/v1/conversations/{id}/messages` |
| `/im/messages/{id}` | (core 没有) |

- 出处:`src/cli/comm.js` 大量端点带 `/im/` 前缀
- 修复:去掉 `/im/` 段
- 工作量:`comm.js` 重写一次

### 1.3 发消息 shape 错配 — body 带 conversation_id vs URL 路径

| 字段位置 | 我们写的 | core 真实 |
|---|---|---|
| 路径 | `POST /api/v1/messages` | `POST /api/v1/conversations/{conversation_id}/messages` |
| `conversation_id` | body | URL path 参数 |

- 出处:`scripts/send.js → POST /api/v1/messages`
- 影响:**Agent 回信完全失败** —— send.js 是 C4 出站唯一通道,本错配直接断回信路径
- 修复:`POST` URL 改成 `/api/v1/conversations/${conversationId}/messages`,body 去掉 `conversation_id`
- 工作量:`send.js` 改 3 行

### 1.4 `as.upload_im` 跟 `lib/media.js` 实现重复

scaffold 期写了两套上传实现,目标都是"给消息挂图片/文件",但:

| 实现 | 走哪个接口 | core 真实 |
|---|---|---|
| `src/lib/media.js → uploadMedia()`(被 send.js 调用) | `POST /api/v1/media/upload` 单步 | ❌ 不存在 |
| `src/cli/as.js → as.upload_im` | `POST /api/gateway/v1/im/uploads/presign + complete` 两步 | ❌ 不存在 |

- 修复:留单步 `lib/media.js`,`as.js` 的 `as.upload_im / presign / complete` 改成委托给 `media.js`(或直接删除,scaffold 没人在用)
- 工作量:`as.js` 删 60 行

---

## 2. cws-core 真缺的端点(按域)

下面这些是 core OpenAPI 里**完全没暴露**的,而 zylos-coco-workspace 需要才能工作。core 团队需要新增。

### 2.1 IM 域 — 缺 11 个写操作 + 整个 media 子域

core 现有 IM 只是"只读+发送":列会话、单会话(❌ 缺!)、列消息、发消息。下面这些是 Agent 实际场景必须的:

| 操作 | 端点 | 优先级 | 用例 |
|---|---|---|---|
| 单会话详情 | `GET /api/v1/conversations/{id}` | **P0** | comm-bridge 收到 WS message 后要查 conversation type(dm/group)决定是否过滤 @mention |
| 编辑消息 | `PATCH /api/v1/messages/{id}` | P1 | Agent 发完字符串后想改错别字 |
| 撤回消息 | `DELETE /api/v1/messages/{id}` | P1 | Agent 发错了回收 |
| 置顶 / 取消 | `POST / DELETE /api/v1/messages/{id}/pin` | P2 | 在群里把通知钉住 |
| 标已读 | `POST /api/v1/conversations/{id}/read` | **P0** | 防止 Agent 离线重连后把已处理消息当新消息再处理一遍 |
| 正在输入 | `POST /api/v1/conversations/{id}/typing` | P2 | UX 反馈,Agent 思考中先发"输入中" |
| IM 搜索 | `GET /api/v1/search` | P1 | Agent 接到"上周谁提过 X"类查询 |
| 媒体上传(单步) | `POST /api/v1/media/upload` | **P0** | Agent **发图、发 PDF、发任何附件**(见 §3) |
| 媒体下载 URL | `GET /api/v1/media/{id}/url` | **P0** | Agent **看用户发的图、读用户发的 PDF**(见 §3) |
| 上传 presign(可选) | `POST /api/v1/uploads/presign` | P2 | 批量 / 大文件场景,目前可用单步代替 |
| 上传 complete(可选) | `POST /api/v1/uploads/{id}/complete` | P2 | 同上 |

### 2.2 KB 域 — **整个域缺失**

core OpenAPI 里**一个 `/knowledge-bases*` 都没有**。Lead agent 上下文组装、Worker 写交付物全部依赖 KB。

| 操作 | 端点 | 优先级 |
|---|---|---|
| 列 KB | `GET /api/v1/knowledge-bases` | P1 |
| 建 KB | `POST /api/v1/knowledge-bases` | P2 |
| KB 详情 | `GET /api/v1/knowledge-bases/{id}` | P1 |
| 归档 / 恢复 KB | `POST /api/v1/knowledge-bases/{id}/{archive,restore}` | P2 |
| 目录树 | `GET /api/v1/knowledge-bases/{id}/tree` | **P0** |
| 节点列表 | `GET /api/v1/knowledge-bases/{id}/nodes` | **P0** |
| 建节点 | `POST /api/v1/knowledge-bases/{id}/nodes` | P1 |
| 节点详情 | `GET /api/v1/knowledge-bases/{id}/nodes/{nid}` | **P0** |
| 改 / 删节点 | `PATCH DELETE /api/v1/knowledge-bases/{id}/nodes/{nid}` | P1 |
| 读 Page | `GET /api/v1/knowledge-bases/{id}/pages/{pid}` | **P0** |
| 写 Page | `PUT /api/v1/knowledge-bases/{id}/pages/{pid}` | **P0** |
| 上传文件到 KB | `POST /api/v1/knowledge-bases/{id}/files` | P1 |

**P0 子集(6 个)是 Agent 读写记忆/产出的最小集**。

### 2.3 AS 域 — 跟 IM media 重叠,见 §2.1

`as.get` / `as.url` / `as.list`(按 issue/project 查 artifact)是早期设计里有,但实际从 KB 文件 + IM 附件两个入口就够覆盖,**这块可以不补**,等真有需求再说。

### 2.4 Core 目录域 — Teams 整缺,Agent 详情缺

| 操作 | 端点 | 优先级 | 用例 |
|---|---|---|---|
| 列团队 | `GET /api/v1/teams` | P1 | Lead 派单时需要 |
| 团队详情 | `GET /api/v1/teams/{id}` | P1 | 看团队成员、负责的 project |
| 团队成员 | `GET /api/v1/members?team_id={id}` 或 `GET /api/v1/teams/{id}/members` | **P0** | 派单核心数据 |
| Agent 详情 | `GET /api/v1/agents/{id}` | **P0** | 看 Agent 能力,决定是否合适 |
| Agent skills | `GET /api/v1/agents/{id}/skills` | **P0** | 按 skill 匹配任务 |
| Agent metrics | `GET /api/v1/agents/{id}/metrics` | P2 | 性能 dashboard |

### 2.5 TM 域 — 写操作大面积缺

core 现状:`/api/v1/projects` 全套 ✓,`/api/v1/issues` 只读 list,`/api/v1/tasks` 只读 list,`/api/v1/projects/{pid}/issues(/{iid})` 嵌套读。**所有写、所有 workflow 抽象层缺失**。

| 子域 | 端点 | 优先级 |
|---|---|---|
| Task 单体读 | `GET /api/v1/tasks/{id}` | **P0** |
| Task 写 | `POST /api/v1/tasks` | **P0** |
| Task 状态流转 | `POST /api/v1/tasks/{id}/status` | **P0** |
| Task 归档 | `POST /api/v1/tasks/{id}/archive` | P1 |
| Task 子任务 | `POST /api/v1/tasks/{id}/subtasks` | P2 |
| Task 领取 | `POST /api/v1/tasks/{id}/claim` | **P0** |
| Task 转派 | `POST /api/v1/tasks/{id}/reassign` | P1 |
| Issue 创建 | `POST /api/v1/issues` 或 `POST /api/v1/projects/{pid}/issues` | **P0** |
| Issue 更新 | `PATCH /api/v1/issues/{id}` | **P0** |
| Issue 状态流转 | `POST /api/v1/issues/{id}/transition` | **P0** |
| Issue 跨项目移动 | `POST /api/v1/issues/{id}/move` | P2 |
| Issue 验收 | `POST /api/v1/issues/{id}/acceptance` | P1 |
| Blueprint 全套(14 个) | `/api/v1/blueprints/*` + `/api/v1/blueprint-steps/*` | P1 |
| Attempt 全套(3 个) | `/api/v1/attempts/*` | P1 |
| Comment | `GET POST /api/v1/comments` | **P0** |
| Link(work ↔ conversation) | `GET POST /api/v1/links` | P1 |
| System | `POST /api/v1/system/{initialize-workspace, approval-decision, auto-archive}` | P2 |
| TaskBoard | `GET /api/v1/task-board` | P1 |

**TM 整个写工作流(Issue / Task / Blueprint / Attempt / Comment)是核心 agent loop 的依赖**,缺了 Agent 就只能"看"不能"干"。

---

## 3. 媒体上传/下载流单独说明

媒体是消息附件最关键的两个端点(见 §2.1 P0 标记):

### 出站(Agent 发图/PDF 给用户)

```
POST /api/v1/media/upload
  Body: {file_name, mime_type, file_size, conversation_id, media_type}
  Resp: {media_id, upload_url, upload_headers, expires_at}

PUT  <upload_url>            ← 直传 S3,字节不经服务端
  Body: <raw bytes>

POST /api/v1/conversations/{id}/messages
  Body: {type:"image", content:{media_id, filename, mime_type, size}}
```

### 入站(用户发图/PDF 给 Agent)

```
(WS 推消息) {content:{media_id:"media_xyz"}, ...}

GET /api/v1/media/{media_id}/url
  Resp: {url:"https://s3.../signed?...", expires_at}

GET <url>                    ← 拿字节,落到本地 temp 文件
  Resp: <raw bytes>
```

**缺了这两个,Agent 退化成纯文本 bot**:用户发图问"这是什么"答不出,Agent 生成图表也发不出。

### 关于两步式 `presign + complete`

cws-fe-api-gateway 草案里有 `/uploads/presign + complete` 两步式,适合**批量并行 / 大文件 / 断点续传**。我们 scaffold 期把它写进了 `as.js` 但实际从未触达。**单步 `/media/upload` 已经覆盖 95% 场景**,两步式作为 P2,真有大文件场景再加。

---

## 4. 给 core 团队的请求清单(按优先级)

### P0 —— v0.1.0 上线最小集(没这些 Agent 跑不起来)

共 **15 个端点**:

```
IM:
  GET    /api/v1/conversations/{id}
  POST   /api/v1/conversations/{id}/read
  POST   /api/v1/media/upload
  GET    /api/v1/media/{id}/url

KB:
  GET    /api/v1/knowledge-bases/{id}/tree
  GET    /api/v1/knowledge-bases/{id}/nodes
  GET    /api/v1/knowledge-bases/{id}/nodes/{nid}
  GET    /api/v1/knowledge-bases/{id}/pages/{pid}
  PUT    /api/v1/knowledge-bases/{id}/pages/{pid}

Core 目录:
  GET    /api/v1/teams/{id}/members(或 members?team_id=)
  GET    /api/v1/agents/{id}
  GET    /api/v1/agents/{id}/skills

TM:
  GET    /api/v1/tasks/{id}
  POST   /api/v1/tasks
  POST   /api/v1/tasks/{id}/status
  POST   /api/v1/tasks/{id}/claim
  POST   /api/v1/issues
  PATCH  /api/v1/issues/{id}
  POST   /api/v1/issues/{id}/transition
  GET POST /api/v1/comments
```

### P1 —— 演示阶段补齐(没这些 Agent 能跑但效果弱)

约 **20 个**:Teams 列表/详情、KB 写操作、IM 编辑撤回搜索、Issue 验收、Task 转派归档、Blueprint 全套、Attempt 全套、Link、TaskBoard。

### P2 —— 完整功能(可以最后做)

约 **10 个**:typing 指示、message pin、Agent metrics、Issue move、System 端点、上传两步式 presign/complete。

**合计:core 至少需要补 P0 + P1 + P2 共 ~45 个端点**(扣掉已经能用嵌套形式拿到的 issue 读)才完整 cover 当前 v0.1.0 scaffold 全部代码路径。

---

## 5. 本仓库待修(不依赖 core 进度)

| 项 | 文件 | 工作量 |
|---|---|---|
| `apiPath()` 默认前缀改 `/api/v1` | `src/lib/client.js` | 1 行 |
| `send.js` 消息发送 shape 对齐 | `scripts/send.js` | 3 行 |
| `comm.js` 去掉 `/im/` 前缀 | `src/cli/comm.js` | 重写路径表 |
| `as.upload_im` 委托给 `media.js` 或删除 | `src/cli/as.js` | 删 60 行 |
| 各 CLI `--help` 标记 "pending core 暴露"的命令 | 5 个 CLI 文件 | 5×几行注释 |

修完后:**v0.1.0 scaffold 在 core 当前 38 个端点下可以做到"能跑的子集"**:`me / member 列表 / agent 列表 / project 全套(读写归档) / issue/task 列表 / 会话 + 消息基本读写`。其余命令 4xx,但 CLI 不崩。

---

## 6. 参考

- cws-core OpenAPI:`https://zylos01.jinglever.com/cws-core/openapi.json`(auth: coco/coco2026)
- cws-comm api-usage-guide:`~/zylos/workspace/cws-comm/docs/design/api-usage-guide.md`
- cws-comm api-design:`~/zylos/workspace/cws-comm/docs/design/api-design.md`
- cws-fe-api-gateway 草案:`https://zylos303.coco.site/docs/cws-fe-api-gateway-doc.html`(已过时,以 OpenAPI 为准)
- 本仓库 SKILL / DESIGN:`SKILL.md`、`docs/DESIGN.md`
