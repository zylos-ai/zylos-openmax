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
| 单会话详情 | `GET /im/conversations/{id}` | — | ❌ |
| 建会话(DM/群) | `POST /im/conversations` | `POST /api/v1/conversations` | ⚠️ 路径多 `/im/` 段 |
| 拉历史消息 | `GET /im/conversations/{id}/messages` | `GET /api/v1/conversations/{id}/messages` | ⚠️ 路径多 `/im/` 段 |
| 发消息 | `POST /api/v1/messages`(send.js) | `POST /api/v1/conversations/{id}/messages` | ⚠️ shape 不一致:body 带 `conversation_id` vs URL path |
| 发消息(comm.js) | `POST /im/conversations/{id}/messages` | `POST /api/v1/conversations/{id}/messages` | ⚠️ 路径多 `/im/` 段 |
| 编辑消息 | `PATCH /im/messages/{id}` | — | ❌ |
| 撤回消息 | `DELETE /im/messages/{id}` | — | ❌ |
| 置顶消息 | `POST /im/messages/{id}/pin` | — | ❌ |
| 取消置顶 | `DELETE /im/messages/{id}/pin` | — | ❌ |
| 标已读 | `POST /im/conversations/{id}/read` | — | ❌ |
| 正在输入 | `POST /im/conversations/{id}/typing` | — | ❌ |
| IM 全文搜索 | `GET /im/search` | — | ❌ |
| 媒体上传(单步) | `POST /api/v1/media/upload` | — | ❌ |
| 媒体下载 URL | `GET /api/v1/media/{id}/url` | — | ❌ |
| 媒体上传 presign | `POST /im/uploads/presign` | — | ❌ |
| 媒体上传 complete | `POST /im/uploads/{id}/complete` | — | ❌ |

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
| (KB 文件上传) | `POST /knowledge-bases/{id}/files` | — | ❌(同 KB 域) |
| (IM 附件 presign) | `POST /im/uploads/presign` | — | ❌(同 IM 域) |
| (IM 附件 complete) | `POST /im/uploads/{id}/complete` | — | ❌(同 IM 域) |

AS 端点全部跟 KB / IM 域共用,不重复计。

---

## 4. Core 目录(身份 / 成员 / 团队 / Agent / 项目)

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 当前用户 + workspace | `GET /me` | `GET /api/v1/me` | ✅ |
| 列成员 | `GET /members` | `GET /api/v1/members` | ✅ |
| 成员详情 | `GET /members/{id}` | `GET /api/v1/members/{id}` | ✅ |
| 列团队 | `GET /teams` | — | ❌ |
| 团队详情 | `GET /teams/{id}` | — | ❌ |
| 团队成员 | `GET /teams/{id}/members` 或 `members?team_id=` | — | ❌ |
| 列 Agent | `GET /agents` | `GET /api/v1/agents` | ✅ |
| Agent 详情 | `GET /agents/{id}` | — | ❌ |
| Agent skills | `GET /agents/{id}/skills` | — | ❌ |
| Agent metrics | `GET /agents/{id}/metrics` | — | ❌ |
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
| Issue 状态流转 | `POST /api/issues/{id}/transition` | — | ❌ |
| Issue 跨项目移动 | `POST /api/issues/{id}/move` | — | ❌ |
| Issue 验收 | `POST /api/issues/{id}/acceptance` | — | ❌ |

---

## 7. TM —— Task

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 列 Task | `GET /tasks` | `GET /api/v1/tasks` | ✅ |
| Task 详情 | `GET /tasks/{id}` | — | ❌ |
| 建 Task | `POST /tasks` | — | ❌ |
| Task 状态流转 | `POST /tasks/{id}/status` | — | ❌ |
| Task 归档 | `POST /tasks/{id}/archive` | — | ❌ |
| 加子任务 | `POST /tasks/{id}/subtasks` | — | ❌ |
| Task 领取 | `POST /api/tasks/{id}/claim` | — | ❌ |
| Task 转派 | `POST /api/tasks/{id}/reassign` | — | ❌ |

---

## 8. TM —— Blueprint / Attempt / Comment / Link / System / TaskBoard

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| 建 Blueprint | `POST /api/blueprints` | — | ❌ |
| 列 Blueprint | `GET /api/blueprints?issue_id=` | — | ❌ |
| Blueprint 详情 | `GET /api/blueprints/{id}` | — | ❌ |
| 加 Blueprint step | `POST /api/blueprints/{bid}/steps` | — | ❌ |
| 改 Blueprint step | `PATCH /api/blueprint-steps/{id}` | — | ❌ |
| 删 Blueprint step | `DELETE /api/blueprint-steps/{id}` | — | ❌ |
| 设 step 依赖 | `PUT /api/blueprint-steps/{id}/depends-on` | — | ❌ |
| 设 Blueprint 预算 | `PUT /api/blueprints/{id}/budget` | — | ❌ |
| 设 Blueprint 备注 | `PUT /api/blueprints/{id}/notes` | — | ❌ |
| Blueprint Markdown 渲染 | `GET /api/blueprints/{id}/markdown` | — | ❌ |
| Blueprint 提交审批 | `POST /api/blueprints/{id}/submit` | — | ❌ |
| 建 Blueprint 修订 | `POST /api/blueprints/amend` | — | ❌ |
| 建 Attempt | `POST /api/attempts` | — | ❌ |
| Attempt 详情 / 列表 | `GET /api/attempts(/{id})` | — | ❌ |
| Attempt 状态流转 | `POST /api/attempts/{id}/transition` | — | ❌ |
| 加评论 | `POST /api/comments` | — | ❌ |
| 列评论 | `GET /api/comments?work_type=&work_id=` | — | ❌ |
| 加 work-conversation link | `POST /api/links` | — | ❌ |
| 列 link | `GET /api/links` | — | ❌ |
| 工作台聚合 | `GET /api/task-board` | — | ❌ |
| 初始化 workspace | `POST /api/system/initialize-workspace` | — | ❌ |
| 审批决定 | `POST /api/system/approval-decision` | — | ❌ |
| 自动归档 | `POST /api/system/auto-archive` | — | ❌ |

---

## 9. Auth / Org / 邀请 / 角色

| 操作 | 我们用的 | cws-core 现状 | 对比 |
|---|---|---|---|
| WS ticket(已废) | (前期用过,现已切 Bearer 直连) | `POST /auth/ws-ticket` | core 有 |
| login / logout / register / refresh / agent token | (未用,Agent 用 api_key) | `POST /auth/{login,logout,register,register/agent,refresh,agent/token}` | core 有 |
| Org / 邀请 / 角色 / 密码 | (未用) | `GET POST /api/v1/organizations(/{id})`, `GET POST DELETE /api/v1/invitations(...)`, `GET /api/v1/roles`, `POST /api/v1/me/password` | core 有 |

---

## 10. 汇总

| 域 | 我们用的端点数 | core 完全有(✅) | 路径/形状错位(⚠️) | core 缺(❌) |
|---|---:|---:|---:|---:|
| IM(含 media) | 17 | 0 | 5 | 12 |
| KB | 14 | 0 | 0 | 14 |
| AS | (共用 KB/IM) | — | — | — |
| Core 目录 | 11 | 5 | 0 | 6 |
| TM Project | 6 | 6 | 0 | 0 |
| TM Issue | 8 | 0 | 2 | 6 |
| TM Task | 8 | 1 | 0 | 7 |
| TM Blueprint/Attempt/Comment/Link/System/TaskBoard | 23 | 0 | 0 | 23 |
| **合计** | **87** | **12** | **7** | **68** |

> 说明:同一逻辑端点在多 CLI 里出现会重复计;"我们用的"按代码里 unique path 统计。`apiPath()` 当前默认前缀是 `/api/gateway/v1`,以上"我们用的"列省略了这个前缀。
