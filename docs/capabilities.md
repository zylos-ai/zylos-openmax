# zylos-coco-workspace 能力清单

> **更新日期**:2026-05-22
> **代码版本**:`feat/v0.1.0-scaffold` @ `1b91e6a`
> **范围**:本文按服务划分,逐项列出 zylos-coco-workspace 当前已经接通的能力、后端暴露但本仓库还没接的能力、以及后端尚未实装的能力。每行带状态标签,方便快速判断"今天能做什么"。

---

## 状态图例

| 标签 | 含义 |
|---|---|
| ✅ | 后端已暴露 + 本仓库已接入,**今天可用** |
| 🛠 | 后端已暴露,本仓库未接入,**可立即补** |
| ⏳ | 后端尚未实装(在 design / api-usage-guide 里写了但 code 没有),**等后端** |
| 🐛 | 本仓库实现存在 bug 或不符合最新 spec,**等修复** |
| 🔀 | 直连服务(不走 cws-core BFF) |
| 📦 | 本仓库自身能力,不依赖后端 |

---

## 架构总览

zylos-coco-workspace 作为 Agent 端的桥接组件,**同时跟 4 个后端服务**通信:

```
                       ┌────────────────────┐
                       │ zylos-coco-workspace │
                       │   (PM2 service)    │
                       └─────────┬──────────┘
                                 │
        ┌────────────────┬───────┼───────┬────────────────┐
        ▼                ▼       ▼       ▼                ▼
    ┌────────┐       ┌────────┐ ┌──────┐ ┌────────┐    ┌────────┐
    │cws-core│       │cws-comm│ │cws-kb│ │cws-as  │    │cws-work│
    │ REST   │       │  WS    │ │ REST │ │ REST   │    │ (经由  │
    │/api/v1 │◄──────┤(直连)  │ │(直连)│ │(直连)  │    │cws-core│
    │/auth/* │       └────────┘ └──────┘ └────────┘    │ 透传)  │
    └────────┘                                          └────────┘
```

**鉴权统一**:所有服务共用一把 `api_key`(存于 `config.agent.api_key`)。当前实现把 api_key 直接当 Bearer 用,**实际上 cws-core spec 要求先换 JWT 再用**(见下文 §鉴权)。

---

## 一、cws-core(身份 / 组织 / 项目 / 任务 / IM)

> Base URL:`config.comm.core_url`(默认 `http://127.0.0.1:8080`)
> OpenAPI:`https://zylos01.jinglever.com/cws-core/openapi.json`
> 当前 cws-core 共暴露 **38 个端点**,本仓库接入 **19 个**。

### 1.1 鉴权 / 认证

| 能力 | cws-core | 本仓库 | 备注 |
|---|---|---|---|
| api_key → JWT 换取(`POST /auth/agent/token`) | ✅ | 🐛 | **本仓库未实装** —— 当前直接用 api_key 做 Bearer,严格部署会被拒 |
| JWT 续期(`POST /auth/refresh`) | ✅ | 🐛 | 同上,需要随 JWT 流程一起做 |
| WS ticket(`POST /auth/ws-ticket`) | ✅ | 🛠 | 我们目前直接 Bearer api_key 升级 WS,没走 ticket |
| 用户登录(`POST /auth/login`) | ✅ | — | Agent 用 api_key,不走 session |
| 注销 / 注册 / 注册 agent(`/auth/logout` / `/register` / `/register/agent`) | ✅ | — | admin 操作,不在 Agent 范围 |

### 1.2 身份 / 我

| 能力 | cws-core | 本仓库 | 命令 / 端点 |
|---|---|---|---|
| 当前用户 + workspace | ✅ | ✅ | `core.me` → `GET /api/v1/me` |
| 修改我 | ✅ | 🛠 | `PATCH /api/v1/me` |
| 修改密码 | ✅ | — | Agent 没 password 概念,不接 |

### 1.3 组织(Organization)

| 能力 | cws-core | 本仓库 | 命令 / 端点 |
|---|---|---|---|
| 列组织 | ✅ | ✅ | `core.org_list` → `GET /api/v1/organizations` |
| 组织详情 | ✅ | ✅ | `core.org_get` → `GET /api/v1/organizations/{id}` |
| 建组织 | ✅ | 🛠 | `POST /api/v1/organizations` |
| 改组织 | ✅ | 🛠 | `PATCH /api/v1/organizations/{id}` |

### 1.4 成员 / 邀请 / 角色

| 能力 | cws-core | 本仓库 | 命令 / 端点 |
|---|---|---|---|
| 列成员 | ✅ | ✅ | `core.member_list` → `GET /api/v1/members` |
| 成员详情 | ✅ | ✅ | `core.member_get` → `GET /api/v1/members/{id}` |
| 改成员 | ✅ | 🛠 | `PATCH /api/v1/members/{id}` |
| 删成员 | ✅ | 🛠 | `DELETE /api/v1/members/{id}` |
| 列邀请 | ✅ | 🛠 | `GET /api/v1/invitations` |
| 建邀请 | ✅ | 🛠 | `POST /api/v1/invitations` |
| 接受邀请 | ✅ | 🛠 | `POST /api/v1/invitations/{id}/accept` |
| 删邀请 | ✅ | 🛠 | `DELETE /api/v1/invitations/{id}` |
| 列角色定义 | ✅ | 🛠 | `GET /api/v1/roles` |
| 列团队 | ⏳ | ⏳ | core 还没暴露 `/teams*` |
| 团队详情 / 团队成员 | ⏳ | ⏳ | 同上 |

### 1.5 Agent 目录

| 能力 | cws-core | 本仓库 | 命令 / 端点 |
|---|---|---|---|
| 列 Agent | ✅ | ✅ | `core.agent_list` → `GET /api/v1/agents` |
| Agent 详情 | ⏳ | ⏳ | `GET /api/v1/agents/{id}` 暂未暴露 |
| Agent skills | ⏳ | ⏳ | `GET /api/v1/agents/{id}/skills` 暂未暴露 |
| Agent metrics | ⏳ | ⏳ | `GET /api/v1/agents/{id}/metrics` 暂未暴露 |

### 1.6 项目(Project)

| 能力 | cws-core | 本仓库 | 命令 / 端点 |
|---|---|---|---|
| 列项目 | ✅ | ✅ | `project.list` / `core.project_list` |
| 项目详情 | ✅ | ✅ | `project.get` |
| 建项目 | ✅ | ✅ | `project.create`(body: `{name, description?, icon?, lead_ids?, member_ids?}`) |
| 改项目 | ✅ | ✅ | `project.update` |
| 归档项目 | ✅ | ✅ | `project.archive` |
| 恢复项目 | ✅ | ✅ | `project.restore` / `project.unarchive` |
| 项目成员 | ✅ | ✅ | `project.members` / `core.project_members` |

### 1.7 Issue(项目下任务单)

| 能力 | cws-core | 本仓库 | 命令 / 端点 |
|---|---|---|---|
| 全局列 Issue | ✅ | ✅ | `issue.list` → `GET /api/v1/issues` |
| 项目内列 Issue | ✅ | ✅ | `issue.list_in_project` → `GET /api/v1/projects/{pid}/issues` |
| Issue 详情(嵌套) | ✅ | ✅ | `issue.get` → `GET /api/v1/projects/{pid}/issues/{iid}` |
| 创建 Issue | ⏳ | ⏳ | core 仅有读,写未暴露 |
| 更新 Issue | ⏳ | ⏳ | 同上 |
| 状态流转 | ⏳ | ⏳ | 同上 |
| 跨项目移动 | ⏳ | ⏳ | 同上 |
| 验收(set_acceptance) | ⏳ | ⏳ | 同上 |

### 1.8 Task(任务,与 Issue 1:N)

| 能力 | cws-core | 本仓库 | 命令 / 端点 |
|---|---|---|---|
| 列 Task | ✅ | ✅ | `task.list` → `GET /api/v1/tasks` |
| Task 详情 | ⏳ | ⏳ | `GET /api/v1/tasks/{id}` 暂未暴露 |
| 建 Task | ⏳ | ⏳ | `POST /api/v1/tasks` |
| 状态流转 | ⏳ | ⏳ | `POST /api/v1/tasks/{id}/status` |
| 软归档 | ⏳ | ⏳ | `POST /api/v1/tasks/{id}/archive` |
| 加子任务 | ⏳ | ⏳ | `POST /api/v1/tasks/{id}/subtasks` |
| Worker 领取 | ⏳ | ⏳ | `POST /api/v1/tasks/{id}/claim` |
| 重新指派 | ⏳ | ⏳ | `POST /api/v1/tasks/{id}/reassign` |

### 1.9 IM(消息 / 会话)

> 注:cws-core 把 IM 的 REST 接口前置在 `/api/v1/conversations/*`,真实媒体走 cws-comm WS。本仓库 `comm.js` 用 cws-core REST,`comm-bridge.js` 用 cws-comm WS。

| 能力 | cws-core | 本仓库 | 命令 / 端点 |
|---|---|---|---|
| 列会话 | ✅ | ✅ | `comm.list_conversations` → `GET /api/v1/conversations` |
| 单会话详情 | ⏳ | ⏳ | `GET /api/v1/conversations/{id}` 未暴露 |
| 建会话(DM/群) | ✅ | ✅ | `comm.create_conversation` / `comm.create_dm` |
| 拉历史消息 | ✅ | ✅ | `comm.get_messages` → `GET /messages?after_seq=&before_seq=&limit=` |
| 发消息 | ✅ | ✅ | `comm.send` / `send.js` → `POST /api/v1/conversations/{id}/messages` |
| 编辑消息 | ⏳ | ⏳ | `PATCH /api/v1/messages/{id}` |
| 撤回消息 | ⏳ | ⏳ | `DELETE /api/v1/messages/{id}` |
| 置顶 / 取消 | ⏳ | ⏳ | `POST/DELETE /messages/{id}/pin` |
| 标已读 | ⏳ | ⏳ | `POST /conversations/{id}/read` |
| 正在输入 | ⏳ | ⏳ | `POST /conversations/{id}/typing` |
| IM 全文搜索 | ⏳ | ⏳ | `GET /api/v1/search` |

---

## 二、cws-comm(WebSocket 实时通道) 🔀

> 直连地址:`config.comm.ws_url`(默认 `ws://127.0.0.1:8080/ws`)
> 鉴权:Authorization Bearer header(per cws-comm api-usage-guide §1+§6)

### 2.1 连接生命周期

| 能力 | cws-comm | 本仓库 | 实现位置 |
|---|---|---|---|
| WS upgrade 时 Bearer + X-Workspace-Id 鉴权 | ✅ | ✅ | `lib/ws.js` |
| 首帧 connect payload + 解析 connect_response | ✅ | ✅ | `lib/connect.js` + `comm-bridge.js` |
| 拿 session_token 持久化 | ✅ | ✅ | `lib/session.js` → `runtime/session.json` |
| JSON ping/pong 心跳(每 30s) | ✅ | ✅ | `lib/ws.js` 自动回应 |
| 帧 watchdog(无帧超时 → 强制重连) | — | ✅ | `lib/ws.js` |
| 指数退避自动重连(cap 30s) | — | ✅ | `lib/ws.js` |
| 4xxx 关闭码语义(4001/4002/4003/4005/4006) | ✅ | ✅ | `lib/ws.js` + `comm-bridge.js` |
| Warm restart(从 session.json 恢复 lastSeq) | — | ✅ | `comm-bridge.js` boot 时 |

### 2.2 入站帧处理

| 帧类型 | cws-comm 推送 | 本仓库处理 | 备注 |
|---|---|---|---|
| `message` | ✅ | ✅ | 解析 → conv 查询 → response_mode 过滤 → 自我消息排除 → 上下文 + 媒体 → 转发 C4 |
| `sync_batch` | ✅ | ✅ | 处理 + 回 `sync_ack` |
| `sync_start` / `sync_complete` | ✅ | ✅ | 状态机维护 |
| `connect_response` | ✅ | ✅ | 解析并持久化 |
| `ping` / `pong` | ✅ | ✅ | 自动 reply |
| `error` | ✅ | ✅ | 日志记录 |
| `typing` | ✅ | 🛠 | 当前忽略,可转发为"用户正在输入"状态 |
| `presence` | ✅ | 🛠 | 同上 |
| `read_state_update` | ✅ | 🛠 | 同上 |
| `read_receipt` | ✅ | 🛠 | 同上 |
| `cross_device_sync` | ✅ | 🛠 | 多设备同步状态 |
| `system` | ✅ | 🛠 | 系统公告类 |

### 2.3 出站帧

| 能力 | 本仓库 | 备注 |
|---|---|---|
| `pong` 自动回复 | ✅ | `lib/ws.js` |
| `sync_ack` 同步确认 | ✅ | `comm-bridge.js` |
| 主动发消息(走 REST 不走 WS) | ✅ | `scripts/send.js` |

---

## 三、cws-kb(知识库) 🔀

> 直连地址:`config.comm.kb_url`(可独立于 core_url)
> X-Org-Id 头作 scope(也内嵌在 URL 路径里)
> cws-kb 当前共 **24 个 REST 端点**,本仓库接入 **24 个(100%)**

### 3.1 KB 集合

| 能力 | cws-kb | 本仓库 | 命令 |
|---|---|---|---|
| 初始化 KB | ✅ | ✅ | `kb.init` → `POST /api/v1/kbs/init` |
| 列 Org 下的 KB | ✅ | ✅ | `kb.list` |
| 归档 KB | ✅ | ✅ | `kb.archive` → `PUT /kbs/archive` |
| 恢复 KB | ✅ | ✅ | `kb.unarchive` → `PUT /kbs/unarchive` |

### 3.2 目录树

| 能力 | cws-kb | 本仓库 | 命令 |
|---|---|---|---|
| 列根节点 | ✅ | ✅ | `kb.tree_roots` |
| 建文件夹 | ✅ | ✅ | `kb.folder_create` → `POST /tree/folders` |
| 节点详情 | ✅ | ✅ | `kb.node_get` |
| 面包屑(祖先链) | ✅ | ✅ | `kb.node_breadcrumb` |
| 子节点列表(分页) | ✅ | ✅ | `kb.node_children` |
| 移动节点(改 parent) | ✅ | ✅ | `kb.node_move` → `PATCH /move` |
| 重命名节点 | ✅ | ✅ | `kb.node_rename` → `PATCH /rename` |
| 删除节点(软删除) | ✅ | ✅ | `kb.node_delete` |

### 3.3 页面 CRUD

| 能力 | cws-kb | 本仓库 | 命令 |
|---|---|---|---|
| 列页面 | ✅ | ✅ | `kb.pages` |
| 页面元信息 | ✅ | ✅ | `kb.page_get` |
| 建页面 | ✅ | ✅ | `kb.page_create` → `POST /pages` |
| 改页面 metadata | ✅ | ✅ | `kb.page_update` → `PATCH /pages/{pid}` |
| 删页面 | ✅ | ✅ | `kb.page_delete` |

### 3.4 内容主体

| 能力 | cws-kb | 本仓库 | 命令 |
|---|---|---|---|
| 读内容(body + front_matter) | ✅ | ✅ | `kb.page_content` → `GET /content` |
| 写内容(独立端点,带乐观并发) | ✅ | ✅ | `kb.page_content_write` → `POST /content`(传 base_revision_id) |

### 3.5 版本管理

| 能力 | cws-kb | 本仓库 | 命令 |
|---|---|---|---|
| 列版本 | ✅ | ✅ | `kb.page_revisions` |
| 单版本详情 | ✅ | ✅ | `kb.page_revision` |
| 版本对比(line diff) | ✅ | ✅ | `kb.page_diff` → `GET /diff?from=&to=` |
| 回滚到历史版本 | ✅ | ✅ | `kb.page_restore` → `POST /restore-version` |

### 3.6 全文搜索 ⭐

| 能力 | cws-kb | 本仓库 | 命令 |
|---|---|---|---|
| 全文搜索(Meilisearch + NATS 索引) | ✅ | ✅ | `kb.search` → `GET /search/pages?query=&folder_id=&author_id=&format=&sync=` |

- 模糊匹配 + typo 容错 + 中文分词
- 响应包含 `highlights` 高亮片段 + `score` 相关性分
- `sync=true`:等 Meilisearch index 完成再返回(Agent 写后立即读保证一致)

### 3.7 ReBAC 关联(权限 + 跨实体绑定)

| 能力 | cws-kb | 本仓库 | 命令 |
|---|---|---|---|
| 列关联 | ✅ | ✅ | `kb.relations_list` |
| 建关联 | ✅ | ✅ | `kb.relations_create` |
| 检查权限 | ✅ | ✅ | `kb.relations_check` |
| 删关联 | ✅ | ✅ | `kb.relations_delete` |

### 3.8 文件挂载

| 能力 | cws-kb | 本仓库 | 命令 |
|---|---|---|---|
| 上传文件到 KB 节点 | (复用 cws-as) | ✅ | `kb.upload` → 委托给 `as.uploadMedia()` |

### 3.9 cws-kb 已设计但尚未实装的能力

| 能力 | cws-kb | 来源 | 等待 |
|---|---|---|---|
| 工作区配置 get/update | ⏳ | api-usage-guide §12 | cws-kb 实装 |
| 导出 MD / PDF | ⏳ | api-usage-guide §9 | cws-kb 实装 |
| 批量原子建页 | ⏳ | api-usage-guide §10 | cws-kb 实装 |
| 审计日志查询 | ⏳ | api-usage-guide §11 | cws-kb 实装 |
| Hocuspocus 协同 WS | ⏳ | api-usage-guide §2/§8 | Web UI 用,Agent 不需要 |

---

## 四、cws-as(文件 / 产物存储) 🔀

> 直连地址:`config.comm.as_url`
> 后端架构:Postgres metadata + S3/MinIO/R2 字节 + Redis URL 缓存
> cws-as 当前共 **10 个 REST 端点**(含 multipart `/upload`),本仓库接入 **9 个**

### 4.1 上传链路(3 步合一)

| 能力 | cws-as | 本仓库 | 命令 |
|---|---|---|---|
| **完整上传**(POST 建 artifact → PUT 直传 S3 → POST finalize) | ✅ | ✅ | `as.upload` / `uploadMedia()` |
| 中止上传(清理临时态) | ✅ | ✅ | `as.abort` |
| Multipart 分片上传(>100MB 文件) | ✅ | 🛠 | `POST /artifacts/{id}/upload` cws-as 内部能用,我们没暴露 |

**秒传特性**:`POST /artifacts` 时携带 SHA-256,服务端命中已有 active artifact → 返回 `instant_upload:true`,客户端跳过 PUT/finalize。

### 4.2 元数据管理

| 能力 | cws-as | 本仓库 | 命令 |
|---|---|---|---|
| 列 artifact(分页 + mime/status/producer 过滤) | ✅ | ✅ | `as.list` |
| 单 artifact 元信息 | ✅ | ✅ | `as.get` |
| 改 metadata(name/description/metadata,字节不可变) | ✅ | ✅ | `as.update` → `PATCH /artifacts/{id}` |
| 软删除(status → deleted) | ✅ | ✅ | `as.delete` → `DELETE /artifacts/{id}` |

### 4.3 下载链路

| 能力 | cws-as | 本仓库 | 命令 |
|---|---|---|---|
| 取预签名下载 URL(mode=download/preview) | ✅ | ✅ | `as.url` → `GET /artifacts/{id}/download` |
| 直接下载到本地 tmp | (拼装) | ✅ | `as.download` = `as.url` + 字节 GET |
| 批量 `as://` URI 解析(带 Redis 缓存) | ✅ | ✅ | `as.resolve` |

### 4.4 cws-as 已设计但尚未实装的能力

| 能力 | cws-as code | 来源 | 等待 |
|---|---|---|---|
| ArtifactSet CRUD(产物集合) | ⏳ | api-design §3.2 | cws-as 实装 |
| Version API(列版本/取指定版本/回滚) | ⏳ | api-design §3.5 | 同上 |
| Search artifact(按 metadata 搜索) | ⏳ | api-design §3.6 | 同上 |
| Lifecycle(归档/恢复软删除/保留策略) | ⏳ | api-design §3.7 | 同上 |
| Virtual Workspace API | ⏳ | api-design §3.8 | 同上 |
| Access Token API(短期访问凭证) | ⏳ | api-design §3.9 | 同上 |
| Preview / 缩略图 | ⏳ | api-design §3.10 | 同上 |
| Admin(存储统计 / GC 触发 / 健康) | ⏳ | api-design §3.11 | 部分 healthz/readyz 有,业务 admin 没 |

---

## 五、cws-work(任务工作流) ⏳

> 当前架构定义:cws-work 通过 cws-core 透传暴露。
> cws-core 已暴露了 Project + Issue 读 + Task 列表;**写工作流尚未透出**

| 子域 | 端点数 | cws-work 实装 | cws-core 透传 | 本仓库 | 备注 |
|---|---|---|---|---|---|
| Project | 7 | ✅(`cws-work/internal/transport/http/project.go`) | ✅ | ✅ | 唯一全通的子域 |
| Issue 读 | 3 | ✅ | ✅ | ✅ | 嵌套形 `/projects/{pid}/issues/{iid}` |
| Issue 写 | 5 | ✅ | ⏳ | ⏳ | issue.create / update / transition / move / acceptance |
| Task 读列表 | 1 | ✅ | ✅ | ✅ | |
| Task 详情 + 写 | 7 | ✅ | ⏳ | ⏳ | task.get / create / status / archive / subtasks / claim / reassign |
| Blueprint(heavy 编排) | 14 | ✅ | ⏳ | ⏳ | blueprint.create + steps + budget + notes + submit + amend 等 |
| Attempt(执行历史) | 4 | ✅ | ⏳ | ⏳ | attempt.create / get / list / transition |
| Comment(工作流评论) | 2 | ✅ | ⏳ | ⏳ | comment.append / list |
| Link(IM ↔ Work 锚定) | 2 | ✅ | ⏳ | ⏳ | link.create / list |
| TaskBoard(聚合视图) | 1 | ✅ | ⏳ | ⏳ | taskboard.list |
| System(初始化/审批/自动归档) | 3 | ✅ | ⏳ | ⏳ | system.initialize_workspace / approval_decision / auto_archive |

**整个 Agent loop(派单 → 领单 → 流转 → 评论 → 验收)目前是"卡住"的** —— 这部分是最大的产品缺口,等 cws-core 把 cws-work 的写工作流透出。

---

## 六、zylos-coco-workspace 自身能力 📦

### 6.1 安装 / 升级

| 能力 | 实现位置 |
|---|---|
| 安装时交互提示 workspace_id / org_id / api_key | `hooks/post-install.js` |
| 自动生成 device_id / client_id(UUIDv4) | 同上 |
| api_key / identity_id / org_id / device_id / client_id 全部落 `config.json` | 同上 |
| 升级钩子 | `hooks/post-upgrade.js` |
| PM2 ecosystem | `ecosystem.config.cjs` |

### 6.2 配置 / 凭证

| 能力 | 字段 / 位置 |
|---|---|
| Workspace 维度 scope | `config.workspace_id`(X-Workspace-Id 头) |
| Org 维度 scope(KB / AS) | `config.org_id`(X-Org-Id 头) |
| 多 backend URL 独立配置 | `config.comm.core_url` / `kb_url` / `as_url` / `ws_url` |
| Env 优先级覆盖 | `COCO_API_URL` / `COCO_WS_URL` / `COCO_ORG_ID` 等(api_key **不走 env**,只读 `config.agent.api_key`) |
| Hot reload | `lib/config.js` 监听文件变化 → debounce 重新加载 |

### 6.3 HTTP 客户端 foundation

| 能力 | 实现 |
|---|---|
| cws-core 模块全局 helper(`get/post/patch/put/del`) | `lib/client.js` |
| cws-kb service-bound factory `kbClient(orgId?)` | 同上 |
| cws-as service-bound factory `asClient(orgId?)` | 同上 |
| 直接字节传输 `putBytes()` / `getBytes()`(预签名 URL 用) | 同上 |
| 共享 Bearer api_key 解析链 | 同上 |

### 6.4 C4 双向桥接

| 方向 | 入口 | 流程 |
|---|---|---|
| 入站(用户 → Agent) | WS message frame → `comm-bridge.js` | dedup → conv 查询 → 过滤 → 上下文 + 媒体 → `c4-receive coco-workspace <endpoint> <body>` |
| 出站(Agent → 用户) | `c4-send coco-workspace <endpoint> <message>` → `scripts/send.js` | 解析 endpoint → 文本/markdown/media 分流 → cws-core REST |

### 6.5 Agent 行为框架(`SKILL.md`)

| 能力 | 内容 |
|---|---|
| 角色识别 | 按消息来源自动判断 Lead / Worker |
| Lead 生命周期 | 接收意图 → 澄清 → 上下文组装 → 决策 → 执行 → 交付 → 验收 → 经验沉淀 |
| Worker 生命周期 | 接收任务 → 理解上下文 → 澄清 → 执行 → 汇报 |
| Layer 3 按需加载 | `references/{kb,as,comm,core,tm}-operations.md` 按需读 |

---

## 七、当前总体缺口汇总

按"修复难度 vs 优先级"排序:

### 🐛 我们的 bug,立刻能修

| 缺口 | 工作量 | 收益 |
|---|---|---|
| **JWT 鉴权流程**(api_key → JWT,以后用 JWT 做 Bearer) | 1.5h | 让严格部署的 cws-core 能正常工作 |
| `kb.search` `sync=true` 超时无 fallback | 0.3h | UX |
| WS 长断不告警 owner | 0.5h | 运维可见性 |

### 🛠 后端已暴露,本仓库未接(可立即补)

| 缺口 | 端点数 | 优先级 |
|---|---|---|
| cws-comm 入站帧:`typing` / `presence` / `read_state_update` 等转发 | 6 类 | 低(UX 增益) |
| cws-core admin 写(org/member/invitation) | ~10 | 低(admin 操作 Agent 一般不用) |
| cws-as multipart 分片上传(大文件) | 1 | 中(看场景) |

### ⏳ 等后端实装

| 子域 | 阻塞方 |
|---|---|
| TM 写工作流(issue/task/blueprint/attempt/comment/link/taskboard/system) | cws-core 透传 cws-work |
| cws-core teams / agent 详情 | cws-core |
| cws-core IM 写(edit/delete/pin/read/typing/search) | cws-core |
| cws-kb 协同 / 导出 / 批量 / 审计 / 配置 | cws-kb |
| cws-as version / lifecycle / search / preview / admin | cws-as |

### 🛠 工程性缺口(我们仓库自身)

| 缺口 | 状态 |
|---|---|
| 测试套(`npm test` 配了 `node --test`,但 0 测试文件) | 应加 client / message / endpoint parser 单测 |
| Mock 后端 | 没有,本地 e2e 验证空白 |
| CI(`.gitlab-ci.yml`) | 缺,lint/test gate 没有 |
| 各 CLI `--version` flag | 缺 |
| `docs/DESIGN.md` 过时 | 引用了已废弃的 ws-ticket / `/api/gateway/v1` |

---

## 八、能力对照速查表

| 子域 | 后端实装度 | 本仓库覆盖度 |
|---|---|---|
| **cws-core 身份 / 我** | 100%(7 端点) | 30%(只接 me 读) |
| **cws-core 组织 / 成员 / 邀请 / 角色** | 100%(11 端点) | 30%(读为主) |
| **cws-core 项目** | 100%(7 端点) | 100% |
| **cws-core Issue** | 读 100% / 写 0% | 跟后端持平 |
| **cws-core Task** | 读 50% / 写 0% | 跟后端持平 |
| **cws-core IM** | 读写消息 ✅,会话编辑 ⏳ | 跟后端持平 |
| **cws-core Agent 目录** | 列表 ✅,详情 ⏳ | 跟后端持平 |
| **cws-core Teams** | 0%(未暴露) | — |
| **cws-comm WebSocket** | ~70%(典型帧已暴露;事件类未) | 50%(message/sync ✅,事件类忽略) |
| **cws-kb** | 24 端点完成 + 5 子域 ⏳ | **100% 覆盖已实装端点** |
| **cws-as** | 10 端点完成 + 8 子域 ⏳ | 90%(差 multipart) |
| **cws-work** | ✅ 完整 backend | ⏳ 经 cws-core 透传中,Project + Issue 读已通 |

---

## 九、典型流程能力矩阵

| 场景 | 今天能做吗 | 卡哪 |
|---|---|---|
| 用户发文本消息给 Agent | ✅ | — |
| Agent 回文本 / markdown | ✅ | — |
| Agent 看用户发的图片(vision) | ✅ | — |
| Agent 主动发图 / 发 PDF 给用户 | ✅ | — |
| Agent 主动 DM 一个人 | ✅ | — |
| Agent 群里 @ 回应 | ✅ | — |
| Agent 拉历史消息当上下文 | ✅ | — |
| Agent 列项目 / 列 Agent / 查身份 | ✅ | — |
| Agent 读项目内 Issue 列表 / Issue 详情 | ✅ | — |
| Agent 读 Task 列表 | ✅ | — |
| Agent 全文搜 KB | ✅ | — |
| Agent 写 KB 页(创建/编辑/版本/diff/恢复) | ✅ | — |
| Agent 把交付物(PDF/图)归档到 cws-as | ✅ | — |
| Agent **派发 Task** | ❌ | cws-core 透传 cws-work 写工作流 |
| Agent **领单 / 流转 / 评论** | ❌ | 同上 |
| Agent **跑 Blueprint 编排** | ❌ | 同上 |
| Agent **回应人类验收** | ❌ | issue.set_acceptance ⏳ |
| Agent 标 IM 已读 / 撤回错消息 | ❌ | cws-core IM 写未暴露 |
| Web UI 用户跟 Agent 协同编辑同一篇 KB 页 | ❌ | Hocuspocus 协同 WS ⏳ |
| 上传 > 100MB 文件 | ⚠️ | 单 PUT 模式可能超限,我们没接 multipart |

---

## 参考

- `docs/DESIGN.md` —— 架构总体设计(部分内容过时)
- `docs/cws-core-api-gaps.md` —— 接口对比表
- `SKILL.md` —— Agent 行为生命周期
- `references/{kb,as,comm,core,tm}-operations.md` —— 各子域操作指南
- cws-core OpenAPI:`https://zylos01.jinglever.com/cws-core/openapi.json`(账号 coco / coco2026)
- cws-kb / cws-as / cws-comm / cws-work 仓库:`git.coco.xyz/coco-workspace/`
