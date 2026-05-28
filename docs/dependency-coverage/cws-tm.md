# cws-tm 依赖接口覆盖清单(对照 cws-core@contract-v2 转发)

本文档列出 **zylos-coco-workspace** 当前依赖的 TM(Task / Project / Issue / Blueprint / TaskBoard)HTTP 接口,逐项说明:

- 该接口在 **cws-core@contract-v2**(最新已 tag 的 forwarding 契约,与 main HEAD `6e73312` 等价)中是否已经定义**转发**到 cws-work
- 接口干什么(Summary / Description 直接采自 cws-core 的 `huma.Operation` 注册)
- 入参(path + query + body)
- 出参(响应 body,**已包裹 D8 envelope**:单条 `{ data, request_id, server_time }`、列表 `{ data, pagination, request_id, server_time }`)

依赖端来源:仅 `src/cli/tm.js`。`src/lib/client.js` 的 `apiPath(...)` 默认走 `COCO_API_PREFIX = /api/v1`。

服务端来源:

- **cws-core**@`contract-v2` tag:`internal/transport/http/{project,issue,task,blueprint,attempt}.go`
- 与 cws-as / cws-kb 文档不同的是:**TM 整条链路是 cws-core 主动转发(proxy)给 cws-work 的**,不是直连。所以"是否覆盖"看的是 cws-core 这一层是否定义了 forwarding endpoint(以及 connect-rpc 对应调用),而不是 cws-work 是否实现 —— 后者是另一个问题(见文末 F-historical 的 ⏳ 项)。

> 文档生成时间 2026-05-28。**接口描述与参数定义以 cws-core@contract-v2 为准**。cws-core 路由表有变更时需重新生成本文。
>
> 📌 **当前状态**:`src/cli/tm.js` 已经在 `fix/tm-align-with-core-contract-v2` 分支(commit `bdc5a7b`)上对齐 contract-v2。下文表格直接反映**修复后的状态**;原来发现的协议错位归档在 [F-historical](#f-historical) 一节。

---

## 修复进展(2026-05-28)

| Commit | 涵盖范围 | 文件 |
|---|---|---|
| `bdc5a7b` `fix(tm): 把 src/cli/tm.js 对齐 cws-core@contract-v2` | F1 全部 9 个 path 错位 + F2 全部 11 处 body/query 字段错位 + F2 分页参数全量切换 + F3 删 `task.archive` / `task.subtask_create` + 重命名 `blueprint.add_step` → `blueprint.set_steps` | `src/cli/tm.js`(+229 / -136)|
| `7bf54a5` `fix(client): D8 envelope unwrap 保留分页元数据` | F4 D8 envelope unwrap 增强 —— `request()` 现在区分单条 vs 分页响应 | `src/lib/client.js`(+9 / -2)、`src/comm-bridge.js`(+3 / -1)|

剩 9 个 endpoint(`blueprint.update_step` 等 8 个细粒度 blueprint 操作 + `taskboard.list`)依然 ⏳ —— 它们在 cws-work HTTP 已实现,等 cws-core 补 forwarding 即生效,客户端不再需要任何改动。

---

## Coverage Summary

下表按域分组,共 **33 条**依赖(原 35 条减去 2 条已删命令)。"入参 / 出参"列只展示关键字段简写(`*` 标记 required;完整字段表见 [逐项详解](#逐项详解))。

> 状态列含义(post-fix):
> - ✅ — cws-core@contract-v2 有完全对齐的 path + method + body / query;`tm.js` 已对应
> - ⏳ — cws-work HTTP 已实现,cws-core 还没加 forwarding(调用今天会 404);`tm.js` 保留命令并标 ⏳,等 cws-core 即可

### PROJECT(8 条 — 全 ✅)

| # | tm.js 命令 | cws-core@contract-v2 | 状态 | 接口描述(cws-core)| 入参 | 出参 |
|---|---|---|---|---|---|---|
| 1 | `project.list` `GET /projects` | `project.go:100` `list-projects` | ✅ | "Returns a paginated list of projects. Proxied to cws-work Project RPC." | query:`status`(enum:active/archived)、PageParams | `PageListResponse<projectItem>` |
| 2 | `project.create` `POST /projects` | `project.go:150` `create-project` | ✅ | "Creates a new project." | body:`name*`(1..200)、`description?`、`slug*`、`is_default`、`lead_member_id*` | `DataResponse<projectItem>` |
| 3 | `project.get` `GET /projects/{id}` | `project.go:132` `get-project` | ✅ | "Returns detailed information about a specific project." | path:`project_id*`(uuid) | `DataResponse<projectItem>` |
| 4 | `project.update` `PATCH /projects/{id}` | `project.go:177` `update-project` | ✅ | "Updates project metadata." | path:`project_id*`;body:`name?`、`description?`、`lead_member_id?` | `DataResponse<projectItem>` |
| 5 | `project.archive` `POST /projects/{id}/archive` | `project.go:198` `archive-project` | ✅ | "Archives a project. Frontend delete button maps to this." | path:`project_id*` | `DataResponse<projectItem>` |
| 6 | `project.restore` `POST /projects/{id}/restore` | `project.go:216` `restore-project` | ✅ | "Restores an archived project back to active." | path:`project_id*` | `DataResponse<projectItem>` |
| 7 | `project.unarchive`(alias of restore)| 同上 | ✅ | — | — | — |
| 8 | `project.members` `GET /projects/{id}/members` | `project.go:279` `list-project-members` | ✅ | "Returns project members from cws-work." | path:`project_id*`;query:PageParams | `PageListResponse<projectMemberItem>` |

### ISSUE(6 条 — 全 ✅,写路径已从 `/projects/{pid}/issues/{id}/...` 改成 cws-core 的 flat `/issues/{id}/...`)

| # | tm.js 命令 | cws-core@contract-v2 | 状态 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|
| 9 | `issue.list_in_project` `GET /projects/{pid}/issues` | `issue.go:159` `list-project-issues` | ✅ | "Returns issues within a project." | path:`project_id*`;query:`status`、`priority`、PageParams | `PageListResponse<issueItem>` |
| 10 | `issue.get` `GET /issues/{id}` | `issue.go:197` `get-issue` | ✅ | "Returns detailed information about a specific issue." | path:`issue_id*` | `DataResponse<issueItem>` |
| 11 | `issue.create` `POST /projects/{pid}/issues` | `issue.go:215` `create-issue` | ✅ | "Creates an issue within a project." | path:`project_id*`;body:`title*`(1..300)、`description?`、`mode*`(light/heavy)、`priority*`(low/medium/high)、`due_date?`、`lead_agent_id*`、`context_page_ids?`、`input_artifact_ids?`、`origin_conversation_id?`、`origin_message_id?` | `DataResponse<issueItem>` |
| 12 | `issue.update` `PATCH /issues/{id}` | `issue.go:256` `update-issue` | ✅ | "Updates issue metadata." | path:`issue_id*`;body:`title?`、`description?`、`priority?`、`due_date?` | `DataResponse<issueItem>` |
| 13 | `issue.transition` `POST /issues/{id}/transition` | `issue.go:282` `transition-issue` | ✅ | "Transitions an issue to a target status." | path:`issue_id*`;body:`target_status*`、`rejection_reason?` | `DataResponse<issueItem>` |
| 14 | `issue.move_project` `POST /issues/{id}/move` | `issue.go:306` `move-issue-project` | ✅ | "Moves an issue to another project." | path:`issue_id*`;body:`new_project_id*` | `DataResponse<issueItem>` |

### TASK(6 条 — 全 ✅;原 `task.archive` / `task.subtask_create` 已删除)

| # | tm.js 命令 | cws-core@contract-v2 | 状态 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|
| 15 | `task.list` `GET /tasks` | `task.go:102` `list-tasks` | ✅ | "Returns filtered tasks." | query:`project_id?`、`issue_id?`、`status?`、`claimable?`、`agent_skills?`、PageParams | `PageListResponse<taskItem>` |
| 16 | `task.get` `GET /tasks/{id}` | `task.go:173` `get-task` | ✅ | "Returns a task by ID." | path:`task_id*` | `DataResponse<taskItem>` |
| 17 | `task.create` `POST /projects/{pid}/issues/{iid}/tasks` | `task.go:191` `create-task` | ✅ | "Creates a task within an issue." | path:`project_id*` + `issue_id*`;body:`title*`(1..300)、`description?`、`assignee_id?`、`skill_tags?`、`blueprint_step_id?`、`depends_on?`、`context_page_ids?` | `DataResponse<taskItem>` |
| 18 | `task.transition` `POST /tasks/{id}/transition` | `task.go:247` `transition-task` | ✅ | "Transitions a task to a target status." | path:`task_id*`;body:`target_status*`(pending/running/done/failed/cancelled) | `DataResponse<taskItem>` |
| 19 | `task.status`(alias of `task.transition`)| 同上 | ✅ | — | — | — |
| 20 | `task.reassign` `POST /tasks/{id}/reassign` | `task.go:270` `reassign-task` | ✅ | "Reassigns a task to another member." | path:`task_id*`;body:`new_assignee_id*` | `DataResponse<taskItem>` |

### BLUEPRINT(12 条 — 4 ✅ + 8 ⏳)

| # | tm.js 命令 | cws-core@contract-v2 | 状态 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|
| 21 | `blueprint.create` `POST /issues/{iid}/blueprints` | `blueprint.go:82` `create-blueprint` | ✅ | "Creates a blueprint for an issue." | path:`issue_id*`;body:`author_agent_id*`、`steps[]`(每个含 `temp_id`、`description`、可选 `required_resources` 和 `depends_on_temp_ids`)、`estimated_budget?`、`notes?` | `DataResponse<blueprintItem>` |
| 22 | `blueprint.get` `GET /blueprints/{id}` | `blueprint.go:112` `get-blueprint` | ✅ | "Returns a blueprint by ID." | path:`blueprint_id*`;query:`include_steps?`(bool) | `DataResponse<blueprintItem>` |
| 23 | `blueprint.list` `GET /issues/{iid}/blueprints` | `blueprint.go:131` `list-blueprint-versions` | ✅ | "Returns blueprint versions for an issue." | path:`issue_id*`;query:PageParams | `PageListResponse<blueprintItem>` |
| 24 | `blueprint.set_steps` `PUT /blueprints/{id}/steps` | `blueprint.go:154` `set-blueprint-steps` | ✅ | "Replaces all blueprint steps."(全量替换语义,**不是**追加) | path:`blueprint_id*`;body:`steps[]` | `DataResponse<blueprintItem>` |
| 25 | `blueprint.update_step` `PATCH /blueprint-steps/{id}` | **不存在** | ⏳ | cws-work `BlueprintService.UpdateStep` 已实现(`blueprint.go:210`),等 cws-core forwarding | — | — |
| 26 | `blueprint.delete_step` `DELETE /blueprint-steps/{id}` | **不存在** | ⏳ | cws-work `DeleteStep`(`blueprint.go:224`) | — | — |
| 27 | `blueprint.set_step_depends_on` `PUT /blueprint-steps/{id}/depends-on` | **不存在** | ⏳ | cws-work `SetStepDependsOn`(`blueprint.go:237`)| — | — |
| 28 | `blueprint.set_estimated_budget` `PUT /blueprints/{id}/budget` | **不存在** | ⏳ | cws-work `SetEstimatedBudget`(`blueprint.go:251`)| — | — |
| 29 | `blueprint.set_notes` `PUT /blueprints/{id}/notes` | **不存在** | ⏳ | cws-work `SetNotes`(`blueprint.go:265`)| — | — |
| 30 | `blueprint.render_markdown` `GET /blueprints/{id}/markdown` | **不存在** | ⏳ | cws-work `RenderMarkdown`(`blueprint.go:279`)| — | — |
| 31 | `blueprint.submit_for_approval` `POST /blueprints/{id}/submit` | **不存在** | ⏳ | cws-work `SubmitForApproval`(`blueprint.go:295`)| — | — |
| 32 | `blueprint.create_amendment` `POST /blueprints/amend` | **不存在** | ⏳ | cws-work `CreateAmendment`(`blueprint.go:309`)| — | — |

### TASKBOARD(1 条 — ⏳)

| # | tm.js 命令 | cws-core@contract-v2 | 状态 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|
| 33 | `taskboard.list` `GET /task-board` | **不存在** | ⏳ | cws-work `TaskService.ListTaskBoard` 已实现(`task.go:211`),等 cws-core forwarding。临时替代:`GET /tasks?claimable=true&agent_skills=...` | — | — |

---

## 总览统计

| 类别 | 数量 | 占比 |
|---|---|---|
| ✅ path + method + body 全对齐 contract-v2 | **24** | 73% |
| ⏳ cws-work 有但 cws-core 未转发(blueprint 细粒度 + taskboard)| **9** | 27% |
| **合计** | **33**(原 35 减去已删除的 `task.archive` + `task.subtask_create`)| |

按域分:

| 域 | 总数 | ✅ | ⏳ |
|---|---|---|---|
| Project   | 8 | 8 | 0 |
| Issue     | 6 | 6 | 0 |
| Task      | 6 | 6 | 0 |
| Blueprint | 12 | 4 | 8 |
| TaskBoard | 1 | 0 | 1 |

**结论**:Project / Issue / Task 三个域已经完全可用;Blueprint 域 4 个核心操作可用(create / get / list / set_steps),8 个细粒度修改操作(单 step 改/删、budget、notes、markdown、submit、amend)和 TaskBoard 列表都在等 cws-core 补 forwarding。

---

## 逐项详解

下文给出 `cws-core@contract-v2` 中已转发的 24 条接口的入参 / 出参 schema。字段名和类型直接抄自 cws-core 的 `huma.Operation` 与 struct tag。**出参一律带 D8 envelope** —— 单条 `{ data, request_id, server_time }`,列表 `{ data, pagination, request_id, server_time }`,下文不再每条重复。

### Project

#### 1. `GET /api/v1/projects` —— list-projects

"Returns a paginated list of projects. Proxied to cws-work Project RPC."

- query: `status`(enum `active` / `archived`)、PageParams
- 出参 data: `projectItem[]`

#### 2. `POST /api/v1/projects` —— create-project

"Creates a new project. Proxied to cws-work CreateProject RPC."

- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 1..200 |
| `description` | string | | |
| `slug` | string | ✅ | |
| `is_default` | bool | | 是否为该 org 默认 project |
| `lead_member_id` | uuid | ✅ | Lead 成员 UUID(项目成员关系 ID,**不是 user_id**)|

- 出参 data: `projectItem`

#### 3. `GET /api/v1/projects/{project_id}` —— get-project

- path: `project_id*`(uuid)
- 出参 data: `projectItem`

#### 4. `PATCH /api/v1/projects/{project_id}` —— update-project

- path: `project_id*`
- body: `name?`(1..200)、`description?`、`lead_member_id?` —— 全可选
- 出参 data: `projectItem`

#### 5. `POST /api/v1/projects/{project_id}/archive` —— archive-project

- path: `project_id*`
- 出参 data: `projectItem`

#### 6. `POST /api/v1/projects/{project_id}/restore` —— restore-project

- path: `project_id*`
- 出参 data: `projectItem`

#### 7. `GET /api/v1/projects/{project_id}/members` —— list-project-members

- path: `project_id*`;query: PageParams
- 出参 data: `projectMemberItem[]`

---

### Issue

#### 8. `GET /api/v1/projects/{project_id}/issues` —— list-project-issues

- path: `project_id*`
- query: `status`(enum 9 种,见 `issueItem` 状态机)、`priority`(low/medium/high)、PageParams
- 出参 data: `issueItem[]`

#### 9. `GET /api/v1/issues/{issue_id}` —— get-issue

- path: `issue_id*`(uuid)
- 出参 data: `issueItem`

#### 10. `POST /api/v1/projects/{project_id}/issues` —— create-issue

- path: `project_id*`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | ✅ | 1..300 |
| `description` | string | | |
| `mode` | enum | ✅ | `light` / `heavy` |
| `priority` | enum | ✅ | `low` / `medium` / `high` |
| `due_date` | timestamp | | |
| `lead_agent_id` | uuid | ✅ | |
| `context_page_ids` | uuid[] | | |
| `input_artifact_ids` | uuid[] | | |
| `origin_conversation_id` | uuid | | |
| `origin_message_id` | uuid | | |

- 出参 data: `issueItem`

#### 11. `PATCH /api/v1/issues/{issue_id}` —— update-issue

- path: `issue_id*`
- body: `title?`、`description?`、`priority?`、`due_date?` —— 全可选
- 出参 data: `issueItem`

#### 12. `POST /api/v1/issues/{issue_id}/transition` —— transition-issue

- path: `issue_id*`
- body: `target_status*`(enum 9 种)、`rejection_reason?`
- 出参 data: `issueItem`

#### 13. `POST /api/v1/issues/{issue_id}/move` —— move-issue-project

- path: `issue_id*`
- body: `new_project_id*`(uuid)
- 出参 data: `issueItem`

---

### Task

#### 14. `GET /api/v1/tasks` —— list-tasks

- query: `project_id?`、`issue_id?`、`status?`(pending/running/done/failed/cancelled)、`claimable?`(bool)、`agent_skills?`(string[])、PageParams
- 出参 data: `taskItem[]`

#### 15. `GET /api/v1/tasks/{task_id}` —— get-task

- path: `task_id*`
- 出参 data: `taskItem`

#### 16. `POST /api/v1/projects/{project_id}/issues/{issue_id}/tasks` —— create-task

- path: `project_id*` + `issue_id*`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | ✅ | 1..300 |
| `description` | string | | |
| `assignee_id` | uuid | | |
| `skill_tags` | string[] | | |
| `blueprint_step_id` | uuid | | |
| `depends_on` | uuid[] | | task 依赖 |
| `context_page_ids` | uuid[] | | |

- 出参 data: `taskItem`

#### 17. `POST /api/v1/tasks/{task_id}/transition` —— transition-task

- path: `task_id*`
- body: `target_status*`(pending/running/done/failed/cancelled)
- 出参 data: `taskItem`

#### 18. `POST /api/v1/tasks/{task_id}/reassign` —— reassign-task

- path: `task_id*`
- body: `new_assignee_id*`(uuid)
- 出参 data: `taskItem`

---

### Blueprint

#### 19. `POST /api/v1/issues/{issue_id}/blueprints` —— create-blueprint

- path: `issue_id*`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `author_agent_id` | uuid | ✅ | |
| `steps` | stepInput[] | ✅ | 每个 step:`{ temp_id, description, required_resources?, depends_on_temp_ids? }` |
| `estimated_budget` | JSON object | | |
| `notes` | string | | |

- 出参 data: `blueprintItem`

#### 20. `GET /api/v1/blueprints/{blueprint_id}` —— get-blueprint

- path: `blueprint_id*`
- query: `include_steps?`(bool)—— 是否一并返回 steps
- 出参 data: `blueprintItem`

#### 21. `GET /api/v1/issues/{issue_id}/blueprints` —— list-blueprint-versions

- path: `issue_id*`;query: PageParams
- 出参 data: `blueprintItem[]`

#### 22. `PUT /api/v1/blueprints/{blueprint_id}/steps` —— set-blueprint-steps

⚠️ **语义是"全量替换 steps"**,不是追加。要追加一步必须先 GET blueprint(带 `include_steps=true`),本地拼出新数组,再整体 PUT 回去。

- path: `blueprint_id*`
- body: `steps[]`(stepInput[],同 #19)
- 出参 data: `blueprintItem`

---

## 通用类型(节选,均来自 contract-v2)

> 完整字段见 `cws-core/internal/transport/http/{project,issue,task,blueprint}.go` 顶部 struct 定义。

### `projectItem`

`id`(uuid)、`org_id`(uuid)、`name`、`description`、`slug`、`is_default`(bool)、`lead_member_id`(uuid)、`knowledge_base_id?`(uuid)、`status`(enum:active/archived)、`created_at` / `updated_at`(timestamp)、`archived_at?`(timestamp)

### `projectMemberItem`

`id`(uuid)、`project_id`(uuid)、`member_id`(uuid)、`role`(enum:member/lead)、`added_at`(timestamp)

### `issueItem`

`id`、`org_id`、`project_id`、`title`、`description`、`mode`(light/heavy)、`status`(draft / pending_approval / approved / executing / delivered / accepted / rejected / reopened / archived)、`priority`(low/medium/high)、`due_date?`、`assignee_kind`(internal_lead / external_via_group)、`lead_agent_id?`、`current_blueprint_id?`、`blueprint_approval_request_id?`、`origin_conversation_id?`、`origin_message_id?`、`context_page_ids[]`、`input_artifact_ids[]`、`related_issue_ids[]`、`active_approval_request_ids[]`、`acceptance_source?`(im/explicit)、`rejection_reason?`、`created_at` / `updated_at` / `accepted_at?` / `rejected_at?` / `archived_at?`

### `taskItem`

`id`、`org_id`、`project_id`、`issue_id`、`title`、`description`、`status`(pending/running/done/failed/cancelled)、`assignee_id?`、`skill_tags[]`、`blueprint_step_id?`、`depends_on[]`、`current_attempt_number`(int32)、`context_page_ids[]`、`runtime_session_id?`、`created_at` / `updated_at` / `started_at?` / `finished_at?`

### `blueprintItem`

`id`、`issue_id`、`author_agent_id`、`version_number`(int32)、`status`(draft/approved/rejected/superseded)、`estimated_budget?`(JSON object)、`notes`、`content_hash`、`approval_request_id?`、`steps[]`(`blueprintStepItem`)、`created_at` / `updated_at` / `approved_at?` / `superseded_at?`

### `blueprintStepItem`

`id`、`blueprint_id`、`description`、`sort_order`(int32)、`required_resources?`(JSON object)、`depends_on[]`、`created_at` / `updated_at`

### D8 Envelope(出参共享)

所有响应都包了一层 envelope:

- 单条:`{ "data": <item>, "request_id": string, "server_time": timestamp }`
- 列表:`{ "data": [...items], "pagination": { ... }, "request_id": string, "server_time": timestamp }`

`src/lib/client.js` 在 commit `7bf54a5` 之后会自动 strip envelope:`DataResponse` unwrap 到 `data`,`PageListResponse` 保留为 `{ data, pagination }`,所以 tm.js 的调用方不再需要手动 unwrap。

---

## F-historical

下面是初版文档发现的 4 类协议错位,**已在 fix 分支处理完毕**,这一节作为历史档案保留,方便后续 git blame / MR review 时回溯。

### ✅ F1 —— Path 错位(9 个,已修复 in `bdc5a7b`)

| `tm.js` 命令 | 修复前 | 修复后 / cws-core 实际 path |
|---|---|---|
| `issue.get`          | `GET /projects/{pid}/issues/{id}`                | `GET /issues/{issue_id}` |
| `issue.update`       | `PATCH /projects/{pid}/issues/{id}`              | `PATCH /issues/{issue_id}` |
| `issue.transition`   | `POST /projects/{pid}/issues/{id}/transition`    | `POST /issues/{issue_id}/transition` |
| `issue.move_project` | `POST /projects/{pid}/issues/{id}/move`          | `POST /issues/{issue_id}/move` |
| `task.create`        | `POST /tasks`                                    | `POST /projects/{project_id}/issues/{issue_id}/tasks` |
| `task.transition`(及 `task.status`) | `POST /tasks/{id}/status`         | `POST /tasks/{task_id}/transition` |
| `blueprint.create`   | `POST /blueprints`                               | `POST /issues/{issue_id}/blueprints` |
| `blueprint.list`     | `GET /blueprints`(query `issue_id`)            | `GET /issues/{issue_id}/blueprints`(path-scoped)|
| `blueprint.add_step` → `blueprint.set_steps` | `POST /blueprints/{bpid}/steps`(append 一个) | `PUT /blueprints/{blueprint_id}/steps`(全量替换)|

### ✅ F2 —— Body / Query 字段错位(11 处,已修复 in `bdc5a7b`)

| `tm.js` 命令 | 修复前发的字段 | 修复后(对齐 cws-core) |
|---|---|---|
| `project.create`     | `{ name, description, icon, lead_ids, member_ids }` | `{ name*, description?, slug*, is_default, lead_member_id* }` |
| `project.update`     | `{ description, icon, lead_ids, member_ids }`     | `{ name?, description?, lead_member_id? }` |
| `issue.list_in_project` query | `{ status, archived, page_size, page_token }` | `{ status, priority, ...PageParams }`(归档列表传 `status=archived`)|
| `issue.create` body | 漏 `priority` | `priority*`(low/medium/high) |
| `issue.transition` body | `{ status }` | `{ target_status*, rejection_reason? }` |
| `issue.move_project` body | `{ project_id }` | `{ new_project_id* }` |
| `task.list` query | `{ ..., assignee_id, ... }` | `{ ..., claimable?, agent_skills?, ... }`(无 `assignee_id` 过滤)|
| `task.create` body | 多发 `mode` / `priority` / `status` | 不接(task 没有 mode/priority,status 由 transition 走)|
| `task.transition` body | `{ status }` | `{ target_status* }` |
| `task.reassign` body | `{ assignee_id }` | `{ new_assignee_id* }` |
| `blueprint.create` body | `{ issue_id }` | `{ author_agent_id*, steps[]*, estimated_budget?, notes? }` |
| 分页(所有 list)| `{ page_size, page_token }`(cursor 风格)| `{ page, page_size, order_by }`(offset 风格 PageParams)|

### F3 —— cws-core@contract-v2 完全没有的 endpoint

按 cws-work 是否有实现分两类:

**✅ 已从 tm.js 删除(cws-work 也没,无意义再保留)—— 2 个**

| `tm.js` 命令 | 说明 |
|---|---|
| `task.archive` | cws-core / cws-work 都没;等价做法是 `task.transition` 到 `cancelled` |
| `task.subtask_create` | cws-core / cws-work 都没;无 subtask 概念 |

**⏳ 保留并标记(cws-work 已实现,等 cws-core 补 forwarding)—— 9 个**

| `tm.js` 命令 | cws-work 端 | 当前调用结果 |
|---|---|---|
| `blueprint.update_step`          | `PATCH /api/blueprint-steps/{id}`(cws-work `blueprint.go:210`) | 404 from cws-core |
| `blueprint.delete_step`          | `DELETE /api/blueprint-steps/{id}`(`blueprint.go:224`)| 404 |
| `blueprint.set_step_depends_on`  | `PUT /api/blueprint-steps/{id}/depends-on`(`blueprint.go:237`)| 404 |
| `blueprint.set_estimated_budget` | `PUT /api/blueprints/{id}/budget`(`blueprint.go:251`)| 404 |
| `blueprint.set_notes`            | `PUT /api/blueprints/{id}/notes`(`blueprint.go:265`)| 404 |
| `blueprint.render_markdown`      | `GET /api/blueprints/{id}/markdown`(`blueprint.go:279`)| 404 |
| `blueprint.submit_for_approval`  | `POST /api/blueprints/{id}/submit`(`blueprint.go:295`)| 404 |
| `blueprint.create_amendment`     | `POST /api/blueprints/amend`(`blueprint.go:309`)| 404 |
| `taskboard.list`                 | `GET /api/task-board`(cws-work `task.go:211`)| 404;临时替代 `GET /tasks?claimable=...&agent_skills=...` |

> 注意 cws-work HTTP 用 `/api/...` 前缀,**没有 `v1`**;cws-core 转发后会暴露成 `/api/v1/...`。

### ✅ F4 —— D8 envelope unwrap(已修复 in `7bf54a5`)

contract-v2 把所有响应包了一层 envelope。`src/lib/client.js` 的 `request()` helper 现在自动剥离:

- `DataResponse({ data, request_id, server_time })` → unwrap 到 `data`(原 commit `c60c4b0` 就有)
- `PageListResponse({ data, pagination, request_id, server_time })` → 返回 `{ data, pagination }`(新加,保留分页元数据)

`src/comm-bridge.js` 的 `fetchRecentMessages` 兜底链路同步加上 `r?.data`,兼容新形态。

---

## cws-core@contract-v2 暴露但 tm.js 没用的 endpoint(供后续参考)

| Method + Path | 用途 |
|---|---|
| `GET  /api/v1/issues` | 全 org 的 issue 列表(我们只用嵌套版)|
| `POST /api/v1/issues/{issue_id}/acceptance` | 接受 / 拒绝 issue 交付(`set-issue-acceptance`)|
| `POST /api/v1/projects/{project_id}/members` | 加项目成员(`add-project-member`)|
| `DELETE /api/v1/projects/{project_id}/members/{member_id}` | 移除项目成员(`remove-project-member`)|
| `GET  /api/v1/issues/{issue_id}/tasks` | 按 issue 列 task(等价 `list-tasks?issue_id=...`)|
| `POST /api/v1/tasks/{task_id}/claim` | 领取 task,并自动开 attempt(`claim-task`)|
| `POST /api/v1/tasks/{task_id}/attempts` | 直接开 attempt |
| `GET  /api/v1/tasks/{task_id}/attempts` | 列 task 的 attempt 历史 |
| `GET  /api/v1/attempts/{attempt_id}` | 单个 attempt 详情 |
| `POST /api/v1/attempts/{attempt_id}/transition` | attempt 状态流转 |

---

## 重新生成本文

cws-core 增删改路由时:

```bash
cd cws-core
git checkout contract-v2     # 或最新 contract tag
grep -rnE 'Path:\s*"/api/v1' internal/transport/http/{project,issue,task,blueprint,attempt}.go
```

cws-work HTTP 路由(确认 ⏳ 项是否已经在 cws-work 实现):

```bash
cd cws-work
grep -rnE 'Path:\s*"/api' internal/transport/http/{project,issue,task,blueprint,attempt,comment,link,system}.go
```

tm.js 反向贴一遍:

```bash
cd zylos-coco-workspace
grep -nE "apiPath\(" src/cli/tm.js
```
