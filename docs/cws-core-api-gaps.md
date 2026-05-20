# cws-core 接口对比表

> **日期**:2026-05-20
> **核对版本**:cws-core OpenAPI(`https://zylos01.jinglever.com/cws-core/openapi.json`)
> **范围**:zylos-coco-workspace 用到的端点 vs cws-core 已暴露的端点

图例:
- ✅ core 已有,签名一致
- ⚠️ core 已有,但路径/字段位置不一致(需要客户端或服务端对齐)
- ❌ core 完全没有

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

## 2. KB(知识库)

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 列 KB | `GET /knowledge-bases` | — | ❌ |
| 建 KB | `POST /knowledge-bases` | — | ❌ |
| KB 详情 | `GET /knowledge-bases/{id}` | — | ❌ |
| 归档 KB | `POST /knowledge-bases/{id}/archive` | — | ❌ |
| 恢复 KB | `POST /knowledge-bases/{id}/restore` | — | ❌ |
| 目录树 | `GET /knowledge-bases/{id}/tree` | — | ❌ |
| 节点列表 | `GET /knowledge-bases/{id}/nodes` | — | ❌ |
| 建节点 | `POST /knowledge-bases/{id}/nodes` | — | ❌ |
| 节点详情 | `GET /knowledge-bases/{id}/nodes/{nid}` | — | ❌ |
| 改节点 | `PATCH /knowledge-bases/{id}/nodes/{nid}` | — | ❌ |
| 删节点 | `DELETE /knowledge-bases/{id}/nodes/{nid}` | — | ❌ |
| 读 Page | `GET /knowledge-bases/{id}/pages/{pid}` | — | ❌ |
| 写 Page | `PUT /knowledge-bases/{id}/pages/{pid}` | — | ❌ |
| 上传文件到 KB | `POST /knowledge-bases/{id}/files` | — | ❌ |

---

## 3. AS(独立 ArtifactStore 域)

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| (IM 附件 presign) | `POST /im/uploads/presign` | — | ❌(同 IM 域) |
| (IM 附件 complete) | `POST /im/uploads/{id}/complete` | — | ❌(同 IM 域) |
| 媒体上传(单步) | `POST /api/v1/media/upload` | — | ❌ |
| 媒体下载 URL | `GET /api/v1/media/{id}/url` | — | ❌ |

AS 端点全部跟 KB / IM 域共用,不重复计。

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

