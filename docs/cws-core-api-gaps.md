# cws-core 接口对比表

> **更新日期**:2026-05-22
> **代码版本**:`feat/v0.1.0-scaffold` @ `4c979a6`
> **核对版本**:cws-core OpenAPI(`https://zylos01.jinglever.com/cws-core/openapi.json`)
> **范围**:zylos-coco-workspace 用到的端点 vs cws-core / cws-kb / cws-as 实际暴露的端点

## 状态图例

| 图标 | 含义 |
|---|---|
| ✅ | 后端已暴露 + 我们已接入 + 路径/方法/字段一致 |
| ⚠️ | 后端已暴露,我们这边形态不对(需要客户端对齐) |
| 🐛 | 我们这边有 spec drift / bug(需要修) |
| 🛠 | 后端已暴露,我们这边未接(可立即补) |
| ❌ | 后端没有暴露 |
| ⏳ | 后端未实装,接口在 design doc / api-usage-guide 已规划 |
| 🔀 | 直连服务(不走 cws-core BFF) |
| — | 不适用 / 不需要 |

## 架构说明

zylos-coco-workspace 同时连接 **3 个后端**:

| 服务 | base URL 配置 | 客户端方式 | scope 头 | 端点总数 |
|---|---|---|---|---|
| **cws-core** | `comm.core_url` | 模块全局 `get/post/...` | `X-Workspace-Id` | 38 |
| **cws-kb** 🔀 | `comm.kb_url` | `kbClient(orgId)` factory | `X-Org-Id` | 24 |
| **cws-as** 🔀 | `comm.as_url` | `asClient(orgId)` factory | `X-Org-Id` | 9 |

cws-core 的 IM REST + 业务 REST(身份/项目/任务等)都从这一个入口走。WebSocket 直连 cws-comm(`comm.ws_url`)。KB / AS 直连各自服务。

---

## 1. cws-core IM(会话 / 消息) — `comm.js` + `send.js`

| 能力 | 我们用的 | cws-core 现状 | 状态 |
|---|---|---|---|
| 列会话 | `GET /api/v1/conversations` | `GET /api/v1/conversations?page_size=&page_token=` | ✅ |
| 单会话详情 | `GET /api/v1/conversations/{id}` | — | ❌ core 未暴露 |
| 建会话(DM/群) | `POST /api/v1/conversations` body `{type, title?, participant_ids?}` | 同 | ✅ |
| 拉历史消息 | `GET /api/v1/conversations/{id}/messages?after_seq=&before_seq=&limit=` | 同 | ✅ |
| 发消息(comm.send 和 send.js 共用) | `POST /api/v1/conversations/{id}/messages` body `{client_msg_id, content:[{type,body}], reply_to?}` | 同 | ✅ |
| 编辑消息 | `PATCH /api/v1/messages/{id}` | — | ❌ core 未暴露 |
| 撤回消息 | `DELETE /api/v1/messages/{id}` | — | ❌ core 未暴露 |
| 置顶 / 取消 | `POST/DELETE /api/v1/messages/{id}/pin` | — | ❌ core 未暴露 |
| 标已读 | `POST /api/v1/conversations/{id}/read` | — | ❌ core 未暴露 |
| 正在输入 | `POST /api/v1/conversations/{id}/typing` | — | ❌ core 未暴露 |
| IM 全文搜索 | `GET /api/v1/search` | — | ❌ core 未暴露 |

**说明**:
- 之前文档里"⚠️ 路径多 `/im/` 段"和"⚠️ body 带 conversation_id" 的问题在 commit `20a2da6` 已经修了,现在 ✅
- `content` body 严格按 cws-core 的 `MessageContent[]` shape:`[{type:"text"|"markdown"|"image", body:<string>}]`
- 媒体消息走 `as.uploadMedia()` 先拿 `media_id`,再以 `{type:"image", body:"<media_id>"}` 形态挂消息

---

## 2. cws-kb 知识库 — 🔀 直连(`kb.js`,24/24 全接)

cws-core 没有 KB 端点 —— 我们走 `comm.kb_url` 直连 cws-kb。24 个端点 100% 接入。

| 能力 | 我们用的命令 | cws-kb 真实端点 | 状态 |
|---|---|---|---|
| 初始化 KB | `kb.init` | `POST /api/v1/kbs/init` | 🔀 ✅ |
| 列 Org 下 KB | `kb.list` | `GET /api/v1/orgs/{orgId}/kbs?status=` | 🔀 ✅ |
| 归档 / 取消归档 | `kb.archive` / `kb.unarchive` | `PUT .../kbs/{archive,unarchive}` | 🔀 ✅ |
| 目录根 | `kb.tree_roots` | `GET .../tree/roots` | 🔀 ✅ |
| 建文件夹 | `kb.folder_create` | `POST .../tree/folders` | 🔀 ✅ |
| 节点详情 | `kb.node_get` | `GET .../tree/nodes/{nid}` | 🔀 ✅ |
| 面包屑 | `kb.node_breadcrumb` | `GET .../tree/nodes/{nid}/breadcrumb` | 🔀 ✅ |
| 子节点 | `kb.node_children` | `GET .../tree/nodes/{pid}/children` | 🔀 ✅ |
| 移动节点 | `kb.node_move` | `PATCH .../tree/nodes/{nid}/move` | 🔀 ✅ |
| 重命名节点 | `kb.node_rename` | `PATCH .../tree/nodes/{nid}/rename` | 🔀 ✅ |
| 删节点 | `kb.node_delete` | `DELETE .../tree/nodes/{nid}` | 🔀 ✅ |
| 列页面 | `kb.pages` | `GET .../pages` | 🔀 ✅ |
| 页面元信息 | `kb.page_get` | `GET .../pages/{pid}` | 🔀 ✅ |
| 建页面 | `kb.page_create` | `POST .../pages` | 🔀 ✅ |
| 改页面 metadata | `kb.page_update` | `PATCH .../pages/{pid}` | 🔀 ✅ |
| 删页面 | `kb.page_delete` | `DELETE .../pages/{pid}` | 🔀 ✅ |
| 读内容 | `kb.page_content` | `GET .../pages/{pid}/content` | 🔀 ✅ |
| 写内容 | `kb.page_content_write` | `POST .../pages/{pid}/content` | 🔀 ✅ |
| 版本列表 | `kb.page_revisions` | `GET .../pages/{pid}/revisions` | 🔀 ✅ |
| 单版本 | `kb.page_revision` | `GET .../pages/{pid}/revisions/{rid}` | 🔀 ✅ |
| 版本对比 | `kb.page_diff` | `GET .../pages/{pid}/diff?from_revision_id=&to_revision_id=` | 🔀 ✅ |
| 版本恢复 | `kb.page_restore` | `POST .../pages/{pid}/restore-version` | 🔀 ✅ |
| **全文搜索** ⭐ | `kb.search` | `GET .../search/pages?query=&folder_id=&author_id=&format=&sync=` | 🔀 ✅ |
| 列关联 | `kb.relations_list` | `GET .../relations` | 🔀 ✅ |
| 建关联 | `kb.relations_create` | `POST .../relations` | 🔀 ✅ |
| 检查关联 | `kb.relations_check` | `GET .../relations/check` | 🔀 ✅ |
| 删关联 | `kb.relations_delete` | `DELETE .../relations?...` | 🔀 ✅ |
| 文件挂载 | `kb.upload` | 委托给 `as.uploadMedia()` | 🔀 ✅ |

**全文搜索专项**:Meilisearch + NATS 事件驱动索引,中文分词,带 `highlights` / `score`,`sync=true` 给 Agent 写后立即读用。

**cws-kb 已设计但未实装的能力**(我们也没接):

| 能力 | 来源 | 等待 |
|---|---|---|
| 工作区配置 get/update | api-usage-guide §12 | cws-kb 实装 |
| 导出 MD/PDF | api-usage-guide §9 | cws-kb 实装 |
| 批量原子建页 | api-usage-guide §10 | cws-kb 实装 |
| 审计日志查询 | api-usage-guide §11 | cws-kb 实装 |
| Hocuspocus 协同 WS | api-usage-guide §2 / §8 | Web UI 用,Agent 不需要 |

---

## 3. cws-as 文件存储 — 🔀 直连(`as.js`,9/10 接入)

cws-core 没有 AS 端点 —— 我们直连 cws-as。9 个 REST 端点接入了 8 个 + 1 个 multipart chunk(单 PUT 模式用不到)。

| 能力 | 我们用的命令 | cws-as 真实端点 | 状态 |
|---|---|---|---|
| **上传(3 步合一)** | `as.upload` | `POST /artifacts` → `PUT <upload_url>` → `POST /artifacts/{id}/finalize` | 🔀 ✅ |
| 列 artifact | `as.list` | `GET /api/v1/artifacts` | 🔀 ✅ |
| 单个详情 | `as.get` | `GET /api/v1/artifacts/{id}` | 🔀 ✅ |
| 改 metadata | `as.update` | `PATCH /api/v1/artifacts/{id}` | 🔀 ✅ |
| 软删除 | `as.delete` | `DELETE /api/v1/artifacts/{id}` | 🔀 ✅ |
| 下载 URL | `as.url` | `GET /api/v1/artifacts/{id}/download?mode=` | 🔀 ✅ |
| 全量下载 | `as.download` | `as.url` + 字节 GET | 🔀 ✅ |
| 取消上传 | `as.abort` | `POST /api/v1/artifacts/{id}/abort` | 🔀 ✅ |
| 批量解析 URI | `as.resolve` | `POST /api/v1/artifacts/resolve` | 🔀 ✅ |
| Multipart chunk presign | (未用) | `POST /api/v1/artifacts/{id}/upload` | 🛠 大文件场景才用 |

**秒传**:`POST /artifacts` 时携带 SHA-256,服务端命中已有 active artifact 返回 `instant_upload:true`,客户端跳过 PUT + finalize。`uploadMedia()` 内部已处理。

**cws-as 已设计但未实装的能力**:

| 能力 | 来源 |
|---|---|
| ArtifactSet CRUD | api-design §3.2 |
| Version API(版本/回滚) | api-design §3.5 |
| Search artifact(按 metadata) | api-design §3.6 |
| Lifecycle(归档/恢复/保留策略) | api-design §3.7 |
| Virtual Workspace API | api-design §3.8 |
| Access Token API | api-design §3.9 |
| Preview / 缩略图 | api-design §3.10 |
| Admin(存储统计 / GC) | api-design §3.11 |

---

## 4. cws-core 身份 / 目录(`core.js`)

| 能力 | 我们用的命令 | cws-core 现状 | 状态 |
|---|---|---|---|
| 当前用户 + workspace | `core.me` | `GET /api/v1/me` | ✅ |
| 修改我 | (未用) | `PATCH /api/v1/me` | 🛠 |
| 修改密码 | (未用) | `POST /api/v1/me/password` | 🛠 Agent 不需要 |
| 列成员(orgId/kind/status/search/cursor/limit) | `core.member_list` | `GET /api/v1/members` | ✅ |
| 成员详情 | `core.member_get` | `GET /api/v1/members/{id}` | ✅ |
| 改成员 | (未用) | `PATCH /api/v1/members/{id}` | 🛠 admin |
| 删成员 | (未用) | `DELETE /api/v1/members/{id}` | 🛠 admin |
| 项目成员 | `core.project_members` | `GET /api/v1/projects/{id}/members` | ✅ |
| 列 Agent(pageSize/pageToken) | `core.agent_list` | `GET /api/v1/agents` | ✅ |
| Agent 详情 | `core.agent_get` | `GET /api/v1/agents/{id}` | ❌ core 未暴露 |
| Agent skills | `core.agent_skills` | `GET /api/v1/agents/{id}/skills` | ❌ core 未暴露 |
| Agent metrics | `core.agent_metrics` | `GET /api/v1/agents/{id}/metrics` | ❌ core 未暴露 |
| 列项目 | `core.project_list` | `GET /api/v1/projects` | ✅(也由 `project.list` 提供) |
| 列组织 | `core.org_list` | `GET /api/v1/organizations` | ✅ |
| 组织详情 | `core.org_get` | `GET /api/v1/organizations/{id}` | ✅ |
| 列团队 | `core.team_list` | — | ❌ core 未暴露 |
| 团队详情 | `core.team_get` | — | ❌ |
| 团队成员 | `core.team_members` | — | ❌ |

---

## 5. cws-core TM —— Project(`tm.js`)

| 能力 | 我们用的命令 | cws-core 现状 | 状态 |
|---|---|---|---|
| 列项目(status/pageSize/pageToken) | `project.list` | `GET /api/v1/projects` | ✅ |
| 建项目(name/description/icon/lead_ids/member_ids) | `project.create` | `POST /api/v1/projects` | ✅ |
| 项目详情 | `project.get` | `GET /api/v1/projects/{id}` | ✅ |
| 改项目 | `project.update` | `PATCH /api/v1/projects/{id}` | ✅ |
| 归档 | `project.archive` | `POST /api/v1/projects/{id}/archive` | ✅ |
| 恢复 | `project.restore` / `project.unarchive`(别名) | `POST /api/v1/projects/{id}/restore` | ✅ |
| 项目成员 | `project.members` | `GET /api/v1/projects/{id}/members` | ✅ |

---

## 6. cws-core TM —— Issue

cws-core 当前只暴露读路径(嵌套在 project 下),写路径全部 ⏳ 等 cws-work 透传。

| 能力 | 我们用的命令 | cws-core 现状 | 状态 |
|---|---|---|---|
| 全局列 Issue | `issue.list` | `GET /api/v1/issues?status=&assignee_id=&page_size=&page_token=` | ✅ |
| 项目内列 Issue | `issue.list_in_project` | `GET /api/v1/projects/{pid}/issues?status=&archived=&page_size=&page_token=` | ✅ |
| Issue 详情(嵌套) | `issue.get` | `GET /api/v1/projects/{pid}/issues/{iid}` | ✅ |
| 建 Issue | `issue.create` | — | ⏳ |
| 改 Issue | `issue.update` | — | ⏳ |
| 状态流转 | `issue.transition` | — | ⏳ |
| 跨项目移动 | `issue.move_project` | — | ⏳ |
| 验收(set_acceptance) | `issue.set_acceptance` | — | ⏳ |

---

## 7. cws-core TM —— Task

| 能力 | 我们用的命令 | cws-core 现状 | 状态 |
|---|---|---|---|
| 列 Task(project_id/issue_id/status/assignee_id/page_size/page_token) | `task.list` | `GET /api/v1/tasks` | ✅ |
| Task 详情 | `task.get` | — | ⏳ |
| 建 Task | `task.create` | — | ⏳ |
| 状态流转(`POST /tasks/{id}/status`) | `task.transition` / `task.status` | — | ⏳ |
| 软归档 | `task.archive` | — | ⏳ |
| 加子任务 | `task.subtask_create` | — | ⏳ |
| Worker 领取 | `task.claim` | — | ⏳ |
| 重新指派 | `task.reassign` | — | ⏳ |

---

## 8. cws-core TM —— 其他工作流子域(全 ⏳)

我们 CLI 里有这些命令的占位实现(`tm.js` 用 `apiPath()` 拼路径),但 cws-core 当前都没暴露 —— 等 cws-core 透传 cws-work。

| 子域 | 命令数 | 状态 |
|---|---|---|
| Blueprint(create/get/list/add_step/update_step/delete_step/set_step_depends_on/set_estimated_budget/set_notes/render_markdown/submit_for_approval/create_amendment) | 14 | ⏳ 全部 |
| Attempt(create/get/list/transition) | 4 | ⏳ 全部 |
| Comment(append/list) | 2 | ⏳ 全部 |
| Link(WorkConversationLink:create/list) | 2 | ⏳ 全部 |
| TaskBoard(list) | 1 | ⏳ |
| System(initialize_workspace/approval_decision/auto_archive) | 3 | ⏳ 全部 |

**整个 Agent 写工作流(派单 → 领单 → 流转 → 评论 → 验收)目前 blocked**,这是 v0.1.0 最大的产品缺口。

---

## 9. Auth / 凭证管理(🐛 已知 bug)

| 能力 | 我们用的 | cws-core 现状 | 状态 |
|---|---|---|---|
| **api_key → JWT 换取** | (未实装) | `POST /auth/agent/token` body `{org_id?}` | 🐛 我们直接拿 api_key 当 Bearer 用,严格部署会被拒(spec 明确写 "api_key only for initial token exchange") |
| **JWT 续期** | (未实装) | `POST /auth/refresh` body `{refresh_token, org_id?}` | 🐛 需要实装 |
| WS ticket | (未用,走 §6 直 Bearer) | `POST /auth/ws-ticket` | 🛠 部署若强制走 ticket 模式需要接 |
| 用户登录 | (未用) | `POST /auth/login` | — Agent 用 api_key |
| 注销 / 注册 / 注册 agent | (未用) | `POST /auth/logout` `/register` `/register/agent` | — Agent 用 api_key |

**bug 影响**:目前所有 `/api/v1/*` 请求带的是 `Authorization: Bearer cwsk_xxx`。cws-core OpenAPI 中 `agentApiKey` schema 写明 "**used only for initial token exchange**",其他端点用 `bearerAuth` (JWT)。需要修复才能跟严格部署的 cws-core 真打通。

---

## 10. cws-core 暴露但我们未用(列举)

按"将来或许要 / 不需要"分类:

| 端点 | 用途 | 我们是否需要 |
|---|---|---|
| `POST PATCH /api/v1/organizations` | 建/改组织 | 🛠 admin 操作,需要时再加 |
| `PATCH DELETE /api/v1/members/{id}` | 改/删成员 | 🛠 admin 操作 |
| `PATCH /api/v1/me` | 改自己 | 🛠 Agent 偶尔改自己 display name |
| `POST /api/v1/me/password` | 改密码 | — Agent 没 password |
| `GET POST DELETE /api/v1/invitations` 整套(4 个) | 邀请人入组织 | 🛠 admin 操作 |
| `GET /api/v1/roles` | 列角色定义 | 🛠 PD/admin 视角才需要 |
| `POST /api/v1/invitations/{id}/accept` | 接受邀请 | 🛠 |

---

## 11. 汇总统计

### 接口覆盖度

| 服务 | 后端端点 | 我们已接 | 覆盖率 |
|---|---|---|---|
| cws-core 业务读 | 19 | 12 | 63% |
| cws-core 业务写 | 13 | 6 | 46%(都是 ✅) |
| cws-core auth | 7 | 0 | 0% 🐛 |
| **cws-core 总计** | **38** | **18** | **47%** |
| cws-kb 🔀 | 24 | 24 | **100%** ✅ |
| cws-as 🔀 | 9 | 8 | 89%(差 multipart) |
| **三服务合计** | **71** | **50** | **70%** |

### 待修缺口分布

| 类别 | 数量 |
|---|---|
| 🐛 我们 bug(JWT 流程) | 1 大项 |
| ❌ cws-core 未暴露(Agent detail / Teams / IM 编辑撤回搜索 / TM 写工作流 / Blueprint / Attempt / Comment / Link / TaskBoard / System) | ~50 个端点 |
| 🛠 已有但我们没接(admin 操作 / multipart) | ~12 个 |
| ⏳ cws-kb / cws-as 已设计未实装(协同 / 导出 / batch / lifecycle / preview 等) | ~15 个 |

### 阻塞 Agent 关键能力的缺口

| 关键能力 | 阻塞方 |
|---|---|
| Agent 写工作流(派单/领单/流转/评论/验收) | **cws-core 透传 cws-work** |
| Agent 团队视角(列团队成员决定派给谁) | cws-core 未暴露 `/teams*` |
| Agent 看 skill 决策(判断 Worker 能否胜任) | cws-core 未暴露 `/agents/{id}/skills` |
| 严格部署下任何调用 | **我们的 JWT 流程**(🐛) |
| 大文件附件(>100MB) | cws-as multipart 我们没接 |

---

## 12. 参考

- `docs/capabilities.md` —— 完整能力清单(按服务划分,中文,带状态标)
- `docs/DESIGN.md` —— 架构总体设计(部分内容过时,待重写)
- `references/{kb,as,comm,core,tm}-operations.md` —— 各子域 Agent 操作指南
- cws-core OpenAPI:`https://zylos01.jinglever.com/cws-core/openapi.json`(账号 coco / coco2026)
- cws-kb / cws-as / cws-comm / cws-work 源码:`git.coco.xyz/coco-workspace/`
