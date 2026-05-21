# cws-core 接口对比表

> **日期**:2026-05-21
> **核对版本**:cws-core OpenAPI(`https://zylos01.jinglever.com/cws-core/openapi.json`)
> **范围**:zylos-coco-workspace 用到的端点 vs cws-core 已暴露的端点

图例:
- ✅ core 已有,签名一致
- ⚠️ core 已有,但路径/字段位置不一致(需要客户端或服务端对齐)
- ❌ core 完全没有
- 🔀 KB / AS 直连(不走 cws-core,在 cws-kb / cws-as 本身实装)

## 架构说明(2026-05-21 更新)

cws-core 不是所有 REST 的入口。下面三个 backend 各管一摊:

| 服务 | base URL 配置项 | 我们调用方式 | 状态 |
|---|---|---|---|
| **cws-core** | `comm.core_url` | `client.js → get/post/...`(模块全局) | 38 个端点 |
| **cws-kb** | `comm.kb_url` | `client.js → kbClient(orgId)` factory | 21 个端点 ✅ |
| **cws-as** | `comm.as_url` | `client.js → asClient(orgId)` factory | 7 个端点 ✅ |

通过共用 Bearer api_key 鉴权;cws-core 走 `X-Workspace-Id` 头,cws-kb / cws-as 走 `X-Org-Id` 头。后者也要 `config.org_id`(post-install 时配)。

---

## 1. IM(会话 / 消息 / 媒体)

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 列会话 | `GET /im/conversations` | `GET /api/v1/conversations` | ⚠️ 路径多 `/im/` 段 |
| 建会话(DM/群) | `POST /im/conversations` | `POST /api/v1/conversations` | ⚠️ 路径多 `/im/` 段 |
| 拉历史消息 | `GET /im/conversations/{id}/messages` | `GET /api/v1/conversations/{id}/messages` | ⚠️ 路径多 `/im/` 段 |
| 发消息 | `POST /api/v1/messages`(send.js) | `POST /api/v1/conversations/{id}/messages` | ⚠️ shape 不一致:body 带 `conversation_id` vs URL path |
| 发消息(comm.js) | `POST /im/conversations/{id}/messages` | `POST /api/v1/conversations/{id}/messages` | ⚠️ 路径多 `/im/` 段 |


---

## 2. KB(知识库)— 🔀 直连 cws-kb

cws-core 没有 KB 端点。我们直连 cws-kb(`comm.kb_url`,`X-Org-Id` 头 scope)。21 个端点对应关系:

| 操作 | 我们用的(`kb.js` 命令) | cws-kb 真实端点 | 状态 |
|---|---|---|---|
| 初始化 KB | `kb.init` | `POST /api/v1/kbs/init` | 🔀 ✅ |
| 列 KB | `kb.list` | `GET /api/v1/orgs/{orgId}/kbs` | 🔀 ✅ |
| 归档 / 恢复 | `kb.archive` / `kb.unarchive` | `POST /api/v1/orgs/{orgId}/kbs/{archive,unarchive}` | 🔀 ✅ |
| 目录根 | `kb.tree_roots` | `GET /tree/roots` | 🔀 ✅ |
| 文件夹列表 | `kb.tree_folders` | `GET /tree/folders` | 🔀 ✅ |
| 节点详情 | `kb.node_get` | `GET /tree/nodes/{nodeId}` | 🔀 ✅ |
| 面包屑 | `kb.node_breadcrumb` | `GET /tree/nodes/{nodeId}/breadcrumb` | 🔀 ✅ |
| 子节点 | `kb.node_children` | `GET /tree/nodes/{parentId}/children` | 🔀 ✅ |
| 移动 / 重命名 | `kb.node_move` / `kb.node_rename` | `POST /tree/nodes/{nodeId}/{move,rename}` | 🔀 ✅ |
| 列页面 | `kb.pages` | `GET /pages` | 🔀 ✅ |
| 页详情 / 内容 | `kb.page_get` / `kb.page_content` | `GET /pages/{pid}[/content]` | 🔀 ✅ |
| 版本列表 / 详情 | `kb.page_revisions` / `kb.page_revision` | `GET /pages/{pid}/revisions[/{rid}]` | 🔀 ✅ |
| 版本对比 | `kb.page_diff` | `POST /pages/{pid}/diff` | 🔀 ✅ |
| 版本恢复 | `kb.page_restore` | `POST /pages/{pid}/restore-version` | 🔀 ✅ |
| **全文搜索** ⭐ | `kb.search` | `GET /search/pages?query=&folder_id=&author_id=&format=&sync=&...` | 🔀 ✅(Meilisearch+NATS) |
| 关联管理 | `kb.relations_*` | `GET POST /relations` + `GET /relations/check` | 🔀 ✅ |
| 创建页面 | `kb.page_create` | `POST /pages`(api-usage-guide §3) | ⏳ cws-kb code 未实装 |
| 更新页面 | `kb.page_update` | `PUT /pages/{pid}` | ⏳ cws-kb code 未实装 |
| 删除页面 | `kb.page_delete` | `DELETE /pages/{pid}` | ⏳ cws-kb code 未实装 |
| 文件上传 | `kb.upload` | 委托给 `as.uploadMedia()` | 🔀 ✅ |

---

## 3. AS(ArtifactStore)— 🔀 直连 cws-as

cws-core 没有 AS 端点。我们直连 cws-as(`comm.as_url`,`X-Org-Id` 头)。7 个端点全部对接:

| 操作 | 我们用的(`as.js` 命令) | cws-as 真实端点 | 状态 |
|---|---|---|---|
| **上传(3-step)** | `as.upload` | `POST /artifacts` → `PUT <upload_url>` → `POST /artifacts/{id}/finalize` | 🔀 ✅ |
| 列 artifact | `as.list` | `GET /api/v1/artifacts` | 🔀 ✅ |
| 单个详情 | `as.get` | `GET /api/v1/artifacts/{id}` | 🔀 ✅ |
| 下载 URL | `as.url` | `GET /api/v1/artifacts/{id}/download?mode=download\|preview` | 🔀 ✅ |
| 全量下载 | `as.download` | `as.url` + 字节 GET | 🔀 ✅ |
| 取消上传 | `as.abort` | `POST /api/v1/artifacts/{id}/abort` | 🔀 ✅ |
| 批量解析 URI | `as.resolve` | `POST /api/v1/artifacts/resolve` | 🔀 ✅(Redis 缓存) |

**秒传(`instant_upload`)**:`POST /artifacts` 返回时若服务端按 SHA-256 命中已存在 artifact,返回 `instant_upload:true`,客户端跳过 PUT + finalize。`uploadMedia()` 内部已处理。

**大文件**:cws-as 支持 multipart 模式(`upload_mode:"multipart"`,文件 > 100MB),我们 CLI 目前只走单步 PUT —— 大文件场景标 TODO。

---

## 4. Core 目录(身份 / 成员 / 团队 / Agent / 项目)

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 当前用户 + workspace | `GET /me` | `GET /api/v1/me` | ✅ |
| 列成员 | `GET /members` | `GET /api/v1/members` | ✅ |
| 成员详情 | `GET /members/{id}` | `GET /api/v1/members/{id}` | ✅ |
| 列 Agent | `GET /agents` | `GET /api/v1/agents` | ✅ |
| 列项目 | `GET /projects` | `GET /api/v1/projects` | ✅ |

---

## 5. TM —— Project

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 列项目 | `GET /projects` | `GET /api/v1/projects` | ✅ |
| 建项目 | `POST /projects` | `POST /api/v1/projects` | ✅ |
| 项目详情 | `GET /projects/{id}` | `GET /api/v1/projects/{id}` | ✅ |
| 改项目 | `PATCH /projects/{id}` | `PATCH /api/v1/projects/{id}` | ✅ |
| 归档项目 | `POST /projects/{id}/archive` | `POST /api/v1/projects/{id}/archive` | ✅ |
| 恢复项目 | `POST /projects/{id}/restore` | `POST /api/v1/projects/{id}/restore` | ✅ |
| 项目成员 | (未用) | `GET /api/v1/projects/{id}/members` | ✅ core 有,我们没用 |

---

## 6. TM —— Issue

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 列 Issue(全局) | `GET /api/issues?project_id=` | `GET /api/v1/issues` | ⚠️ 路径不一致(我们用 cws-work 直连风格) |
| 列 Issue(嵌套) | (未用) | `GET /api/v1/projects/{pid}/issues` | ✅ core 有 |
| Issue 详情(嵌套) | `GET /api/issues/{id}` | `GET /api/v1/projects/{pid}/issues/{iid}` | ⚠️ 我们用扁平 ID,core 是嵌套 |
| 建 Issue | `POST /api/issues` | — | ❌ |
| 改 Issue | `PATCH /api/issues/{id}` | — | ❌ |

---

## 7. TM —— Task

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 列 Task | `GET /tasks` | `GET /api/v1/tasks` | ✅ |
| Task 详情 | `GET /tasks/{id}` | — | ❌ |
| 建 Task | `POST /tasks` | — | ❌ |

---

## 8. Auth / Org / 邀请 / 角色

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| WS ticket(已废) | (前期用过,现已切 Bearer 直连) | `POST /auth/ws-ticket` | core 有 |
| login / logout / register / refresh / agent token | (未用,Agent 用 api_key) | `POST /auth/{login,logout,register,register/agent,refresh,agent/token}` | core 有 |
| Org / 邀请 / 角色 / 密码 | (未用) | `GET POST /api/v1/organizations(/{id})`, `GET POST DELETE /api/v1/invitations(...)`, `GET /api/v1/roles`, `POST /api/v1/me/password` | core 有 |

---

