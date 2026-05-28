# cws-tm 依赖接口覆盖清单(对照 cws-core@contract-v2 转发)

本文档列出 **zylos-coco-workspace** 当前依赖的 TM(Task / Project / Issue / Blueprint / TaskBoard)HTTP 接口,逐项说明:

- 该接口在 **cws-core@contract-v2**(最新已 tag 的 forwarding 契约)中是否已经定义**转发**到 cws-work
- 接口干什么(Summary / Description 直接采自 cws-core 的 `huma.Operation` 注册)
- 入参(path + query + body)
- 出参(响应 body,**已包裹 D8 envelope**:`{ data, request_id, server_time }` 或 `PageListResponse{ data, pagination, request_id, server_time }`)

依赖端来源:仅 `src/cli/tm.js`。`src/lib/client.js` 的 `apiPath(...)` 默认走 `COCO_API_PREFIX = /api/v1`。

服务端来源:

- **cws-core**@`contract-v2` tag:`internal/transport/http/{project,issue,task,blueprint,attempt}.go`
- 与 cws-as / cws-kb 文档不同的是:**TM 整条链路是 cws-core 主动转发(proxy)给 cws-work 的**,不是直连。所以这里"是否覆盖"看的是 cws-core 这一层是否定义了 forwarding endpoint(以及 connect-rpc 对应调用),而不是 cws-work 是否实现 —— 后者已经是另一个问题。

> 文档生成时间 2026-05-28。**接口描述与参数定义以 cws-core@contract-v2 为准**。cws-core 路由表有变更时需重新生成本文。
>
> ⚠️ **重要提示**:写文档过程中发现 `tm.js` 中有 **大量路径 / 方法 / 字段名与 contract-v2 不一致** 的问题,集中放在文末 [发现的协议错位](#发现的协议错位) 一节。**对接 contract-v2 前请先看那一节**,不要直接照搬当前 `tm.js` 的入参。

---

## Coverage Summary

下表 8 列,覆盖所有 35 条依赖。"入参 / 出参"列仅展示关键字段简写(`*` 标记 required;完整字段表见每个接口的"逐项详解"小节)。

> 状态列含义:
> - ✅ — cws-core@contract-v2 有完全对得上的 path+method;body/query 可能仍有字段错位(详见 F1 表)
> - ⚠️ — cws-core 有概念等价的 endpoint,但 path / method / body 与我们 tm.js 不一致
> - ❌ — cws-core@contract-v2 完全没有对应 endpoint(call 会 404)

### PROJECT(8 条 — 全部 ✅ path 命中,部分 body 字段错位)

| # | tm.js 命令 (Method+Path) | cws-core@contract-v2 | 状态 | 接口描述(cws-core) | 入参(cws-core 要求) | 出参 |
|---|---|---|---|---|---|---|
| 1 | `project.list` `GET /projects` | `project.go:100` `list-projects` | ✅ | "Returns a paginated list of projects. Proxied to cws-work Project RPC." | query:`status`(enum:active/archived)、PageParams | `PageListResponse<projectItem>` |
| 2 | `project.create` `POST /projects` | `project.go:150` `create-project` | ✅ path / ⚠️ body | "Creates a new project. Proxied to cws-work CreateProject RPC." | body:`name*`(1..200)、`description?`、`slug*`、`is_default`、`lead_member_id*` | `DataResponse<projectItem>` |
| 3 | `project.get` `GET /projects/{id}` | `project.go:132` `get-project` | ✅ | "Returns detailed information about a specific project." | path:`project_id*`(uuid) | `DataResponse<projectItem>` |
| 4 | `project.update` `PATCH /projects/{id}` | `project.go:177` `update-project` | ✅ path / ⚠️ body | "Updates project metadata. Requires cws-work UpdateProject RPC (D13)." | path:`project_id*`;body:`name?`(1..200)、`description?`、`lead_member_id?` | `DataResponse<projectItem>` |
| 5 | `project.archive` `POST /projects/{id}/archive` | `project.go:198` `archive-project` | ✅ | "Archives a project. Frontend delete button maps to this; no hard delete." | path:`project_id*` | `DataResponse<projectItem>` |
| 6 | `project.restore` `POST /projects/{id}/restore` | `project.go:216` `restore-project` | ✅ | "Restores an archived project back to active." | path:`project_id*` | `DataResponse<projectItem>` |
| 7 | `project.unarchive`(alias of restore) | 同上 | ✅ | — | — | — |
| 8 | `project.members` `GET /projects/{id}/members` | `project.go:279` `list-project-members` | ✅ | "Returns project members from cws-work." | path:`project_id*`;query:PageParams | `PageListResponse<projectMemberItem>` |

### ISSUE(6 条 — 1/6 ✅,4/6 path 错位,1/6 body 部分错位)

| # | tm.js 命令 (Method+Path) | cws-core@contract-v2 | 状态 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|
| 9 | `issue.list_in_project` `GET /projects/{pid}/issues` | `issue.go:159` `list-project-issues` | ✅ path / ⚠️ query | "Returns issues within a project." | path:`project_id*`;query:`status`、`priority`、PageParams(**无 `archived` 过滤**,归档要走 status="archived") | `PageListResponse<issueItem>` |
| 10 | `issue.get` `GET /projects/{pid}/issues/{id}` | `issue.go:197` `get-issue` —— 但 path 是 `GET /issues/{issue_id}` | ⚠️ **path 不对** | "Returns detailed information about a specific issue." | path:`issue_id*`(**没有 project 前缀**) | `DataResponse<issueItem>` |
| 11 | `issue.create` `POST /projects/{pid}/issues` | `issue.go:215` `create-issue` | ✅ path / ⚠️ body | "Creates an issue within a project." | path:`project_id*`;body:`title*`(1..300)、`description?`、`mode*`(light/heavy)、`priority*`(low/medium/high)、`due_date?`、`lead_agent_id*`、`context_page_ids?`、`input_artifact_ids?`、`origin_conversation_id?`、`origin_message_id?` | `DataResponse<issueItem>` |
| 12 | `issue.update` `PATCH /projects/{pid}/issues/{id}` | `issue.go:256` `update-issue` —— 但 path 是 `PATCH /issues/{issue_id}` | ⚠️ **path 不对** | "Updates issue metadata." | path:`issue_id*`;body:`title?`、`description?`、`priority?`、`due_date?` | `DataResponse<issueItem>` |
| 13 | `issue.transition` `POST /projects/{pid}/issues/{id}/transition` | `issue.go:282` `transition-issue` —— 但 path 是 `POST /issues/{issue_id}/transition` | ⚠️ **path + body 都不对** | "Transitions an issue to a target status." | path:`issue_id*`;body:`target_status*`(**字段名 `target_status` 不是 `status`**)、`rejection_reason?` | `DataResponse<issueItem>` |
| 14 | `issue.move_project` `POST /projects/{pid}/issues/{id}/move` | `issue.go:306` `move-issue-project` —— 但 path 是 `POST /issues/{issue_id}/move` | ⚠️ **path + body 都不对** | "Moves an issue to another project." | path:`issue_id*`;body:`new_project_id*`(**字段名是 `new_project_id` 不是 `project_id`**) | `DataResponse<issueItem>` |

### TASK(8 条 — 2/8 ✅,4/8 path/body 错位,2/8 缺失)

| # | tm.js 命令 (Method+Path) | cws-core@contract-v2 | 状态 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|
| 15 | `task.list` `GET /tasks` | `task.go:102` `list-tasks` | ✅ path / ⚠️ query | "Returns filtered tasks." | query:`project_id?`、`issue_id?`、`status?`、`claimable?`、`agent_skills?`(**无 `assignee_id` 过滤**)、PageParams | `PageListResponse<taskItem>` |
| 16 | `task.get` `GET /tasks/{id}` | `task.go:173` `get-task` | ✅ | "Returns a task by ID." | path:`task_id*` | `DataResponse<taskItem>` |
| 17 | `task.create` `POST /tasks` | `task.go:191` `create-task` —— 但 path 是 `POST /projects/{project_id}/issues/{issue_id}/tasks` | ⚠️ **path + body 都不对** | "Creates a task within an issue." | path:`project_id*` + `issue_id*`;body:`title*`(1..300)、`description?`、`assignee_id?`、`skill_tags?`、`blueprint_step_id?`、`depends_on?`、`context_page_ids?`(**不接 `mode/priority/status`**) | `DataResponse<taskItem>` |
| 18 | `task.transition` `POST /tasks/{id}/status` | `task.go:247` `transition-task` —— 但 path 是 `POST /tasks/{task_id}/transition` | ⚠️ **path(/status → /transition) + body(`status` → `target_status`)都不对** | "Transitions a task to a target status." | path:`task_id*`;body:`target_status*`(pending/running/done/failed/cancelled) | `DataResponse<taskItem>` |
| 19 | `task.status`(alias) | 同 #18 | ⚠️ | — | — | — |
| 20 | `task.archive` `POST /tasks/{id}/archive` | **不存在** | ❌ | cws-core 没有 task archive 概念,只有 transition 到 cancelled | — | — |
| 21 | `task.subtask_create` `POST /tasks/{id}/subtasks` | **不存在** | ❌ | cws-core 没有 subtask 概念 | — | — |
| 22 | `task.reassign` `POST /tasks/{id}/reassign` | `task.go:270` `reassign-task` | ✅ path / ⚠️ body | "Reassigns a task to another member." | path:`task_id*`;body:`new_assignee_id*`(**字段名是 `new_assignee_id` 不是 `assignee_id`**) | `DataResponse<taskItem>` |

### BLUEPRINT(12 条 — 1/12 ✅,3/12 path/method/body 错位,8/12 缺失)

| # | tm.js 命令 (Method+Path) | cws-core@contract-v2 | 状态 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|
| 23 | `blueprint.create` `POST /blueprints` | `blueprint.go:82` `create-blueprint` —— 但 path 是 `POST /issues/{issue_id}/blueprints`,且 body 是 `{ author_agent_id*, steps[], estimated_budget?, notes? }`(批量带 steps 创建) | ⚠️ **path + body 完全不同** | "Creates a blueprint for an issue." | path:`issue_id*`;body:`author_agent_id*`、`steps[]`(每个含 `temp_id`、`description`、可选 `required_resources` 和 `depends_on_temp_ids`)、`estimated_budget?`、`notes?` | `DataResponse<blueprintItem>` |
| 24 | `blueprint.get` `GET /blueprints/{id}` | `blueprint.go:112` `get-blueprint` | ✅ path / 多一个可选 query | "Returns a blueprint by ID." | path:`blueprint_id*`;query:`include_steps?`(bool) | `DataResponse<blueprintItem>` |
| 25 | `blueprint.list` `GET /blueprints` | `blueprint.go:131` `list-blueprint-versions` —— 但 path 是 `GET /issues/{issue_id}/blueprints`(按 issue 嵌套) | ⚠️ **path 不对** | "Returns blueprint versions for an issue." | path:`issue_id*`;query:PageParams | `PageListResponse<blueprintItem>` |
| 26 | `blueprint.add_step` `POST /blueprints/{bpid}/steps` | `blueprint.go:154` `set-blueprint-steps` —— **方法是 `PUT`,语义是"全量替换 steps"** | ⚠️ **method + 语义都不同** | "Replaces all blueprint steps." | path:`blueprint_id*`;body:`steps[]`(每个含 `temp_id`、`description`、可选 `required_resources` 和 `depends_on_temp_ids`) | `DataResponse<blueprintItem>` |
| 27 | `blueprint.update_step` `PATCH /blueprint-steps/{id}` | **不存在** | ❌ | cws-core 没有"单独改一个 step"的 endpoint,只有批量 replace | — | — |
| 28 | `blueprint.delete_step` `DELETE /blueprint-steps/{id}` | **不存在** | ❌ | 同上,通过 PUT /steps 重新提交不含该 step 的列表 | — | — |
| 29 | `blueprint.set_step_depends_on` `PUT /blueprint-steps/{id}/depends-on` | **不存在** | ❌ | depends-on 是 step input 的子字段,只能批量 replace | — | — |
| 30 | `blueprint.set_estimated_budget` `PUT /blueprints/{id}/budget` | **不存在** | ❌ | estimated_budget 只能在 create 时一并传 | — | — |
| 31 | `blueprint.set_notes` `PUT /blueprints/{id}/notes` | **不存在** | ❌ | notes 只能在 create 时一并传 | — | — |
| 32 | `blueprint.render_markdown` `GET /blueprints/{id}/markdown` | **不存在** | ❌ | 渲染 markdown 不是 cws-core 的职责 | — | — |
| 33 | `blueprint.submit_for_approval` `POST /blueprints/{id}/submit` | **不存在** | ❌ | 没有 submit-for-approval 流程 | — | — |
| 34 | `blueprint.create_amendment` `POST /blueprints/amend` | **不存在** | ❌ | 没有 amendment 概念 | — | — |

### TASKBOARD(1 条 — 缺失)

| # | tm.js 命令 (Method+Path) | cws-core@contract-v2 | 状态 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|
| 35 | `taskboard.list` `GET /task-board` | **不存在** | ❌ | cws-core 没有 task-board 概念。能筛 claimable / agent_skills 的 task 列表用 `GET /tasks` 替代 | — | — |

---

## 总览统计

| 类别 | 数量 | 占比 |
|---|---|---|
| ✅ path + method 命中 | **14** | 40% |
| ⚠️ 部分错位(path / method / body / query 至少有一项不一致) | **10** | 29% |
| ❌ cws-core 完全没有 | **11** | 31% |
| **合计** | **35**(实际去重 34,task.transition 与 task.status 是同一 endpoint) | |

按域分:

| 域 | 总数 | ✅ | ⚠️ | ❌ |
|---|---|---|---|---|
| Project | 8 | 8 | 0 | 0 |
| Issue | 6 | 1 | 5 | 0 |
| Task | 8 | 2 | 4 | 2 |
| Blueprint | 12 | 1 | 3 | 8 |
| TaskBoard | 1 | 0 | 0 | 1 |

**结论**:Project 几乎完全可用(只剩 body 字段名要调);Issue/Task 的写路径需要把 path 重写到 cws-core 的形态(把 `/projects/{pid}/issues/{id}/...` 改成 `/issues/{id}/...`,task 同理把 `/tasks` 改到 `/projects/{pid}/issues/{iid}/tasks`);Blueprint 在 contract-v2 是**全新最小化设计**(只有 create / get / list / set-steps 四个 endpoint),tm.js 里大部分 blueprint 命令需要砍掉或在 cws-work 那侧补。

---

## 逐项详解(仅 ✅ 命中的 14 条)

下文每节中,"入参 / 出参"的字段名和类型直接抄自 cws-core@contract-v2 的 `huma.Operation` 与 struct tag。**出参一律带 D8 envelope** —— 单条返回 `{ data, request_id, server_time }`,列表返回 `{ data, pagination, request_id, server_time }`,下文不再每条重复。

### Project

#### 1. `GET /api/v1/projects` —— list-projects

"Returns a paginated list of projects. Proxied to cws-work Project RPC. Response wrapped in standard envelope (D8)."

- query: `status`(enum `active` / `archived`)、`PageParams`(分页参数,共享字段)
- 出参 data: `projectItem[]`

#### 2. `POST /api/v1/projects` —— create-project

"Creates a new project. Proxied to cws-work CreateProject RPC."

- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 1..200 |
| `description` | string | | |
| `slug` | string | ✅ | Project slug |
| `is_default` | bool | | 是否为该 org 的默认 project |
| `lead_member_id` | uuid | ✅ | Lead 成员 UUID(项目成员关系 ID,**不是 user_id**) |

- 出参 data: `projectItem`

#### 3. `GET /api/v1/projects/{project_id}` —— get-project

- path: `project_id*`(uuid)
- 出参 data: `projectItem`

#### 4. `PATCH /api/v1/projects/{project_id}` —— update-project

"Updates project metadata. Requires cws-work UpdateProject RPC (D13)."

- path: `project_id*`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | *string | | 1..200 |
| `description` | *string | | |
| `lead_member_id` | *uuid | | |

- 出参 data: `projectItem`

#### 5. `POST /api/v1/projects/{project_id}/archive` —— archive-project

"Archives a project. Frontend delete button maps to this; no hard delete."

- path: `project_id*`
- 出参 data: `projectItem`

#### 6. `POST /api/v1/projects/{project_id}/restore` —— restore-project

"Restores an archived project back to active."

- path: `project_id*`
- 出参 data: `projectItem`

#### 7. `GET /api/v1/projects/{project_id}/members` —— list-project-members

"Returns project members from cws-work."

- path: `project_id*`;query: `PageParams`
- 出参 data: `projectMemberItem[]`

---

### Issue

#### 8. `GET /api/v1/projects/{project_id}/issues` —— list-project-issues

"Returns issues within a project."

- path: `project_id*`
- query:

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | enum | `draft` / `pending_approval` / `approved` / `executing` / `delivered` / `accepted` / `rejected` / `reopened` / `archived` |
| `priority` | enum | `low` / `medium` / `high` |
| `PageParams` | | 分页 |

- 出参 data: `issueItem[]`

#### 9. `POST /api/v1/projects/{project_id}/issues` —— create-issue

"Creates an issue within a project."

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

---

### Task

#### 10. `GET /api/v1/tasks` —— list-tasks

"Returns filtered tasks."

- query:

| 字段 | 类型 | 说明 |
|---|---|---|
| `project_id` | uuid | 过滤 project |
| `issue_id` | uuid | 过滤 issue |
| `status` | enum | `pending` / `running` / `done` / `failed` / `cancelled` |
| `claimable` | bool | 只返回可领取的 task |
| `agent_skills` | string[] | 按 agent 技能过滤 |
| `PageParams` | | 分页 |

- 出参 data: `taskItem[]`

#### 11. `GET /api/v1/tasks/{task_id}` —— get-task

- path: `task_id*`
- 出参 data: `taskItem`

---

### Blueprint

#### 12. `GET /api/v1/blueprints/{blueprint_id}` —— get-blueprint

"Returns a blueprint by ID."

- path: `blueprint_id*`
- query: `include_steps`(bool) —— 是否一并返回 steps

- 出参 data: `blueprintItem`

---

## 通用类型(节选,均来自 contract-v2)

> 完整字段见 `cws-core/internal/transport/http/{project,issue,task,blueprint}.go` 顶部 struct 定义。这里只列每个类型的字段名 + 类型,描述见源码。

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

---

## 发现的协议错位

写文档时把 `src/cli/tm.js` 的每一个调用都和 cws-core@contract-v2 的 huma 注册比对了一遍,**有大量不一致**。按"影响半径"从高到低排:

### 🔴 F1 —— Path 错位(整条路径都打不到 cws-core 的 endpoint)

下面这些命令的 path **完全 404**,因为 cws-core 用的是另一种 URL shape。修法:把 path 重写到右列的形态。

| `tm.js` 命令 | 我们发的 path | cws-core 实际 path |
|---|---|---|
| `issue.get`          | `GET /projects/{pid}/issues/{id}`        | `GET /issues/{issue_id}` |
| `issue.update`       | `PATCH /projects/{pid}/issues/{id}`      | `PATCH /issues/{issue_id}` |
| `issue.transition`   | `POST /projects/{pid}/issues/{id}/transition` | `POST /issues/{issue_id}/transition` |
| `issue.move_project` | `POST /projects/{pid}/issues/{id}/move` | `POST /issues/{issue_id}/move` |
| `task.create`        | `POST /tasks`                            | `POST /projects/{project_id}/issues/{issue_id}/tasks` |
| `task.transition`(及 `task.status`) | `POST /tasks/{id}/status`         | `POST /tasks/{task_id}/transition` |
| `blueprint.create`   | `POST /blueprints`                       | `POST /issues/{issue_id}/blueprints` |
| `blueprint.list`     | `GET /blueprints`(query `issue_id`)    | `GET /issues/{issue_id}/blueprints`(path-scoped) |
| `blueprint.add_step` | `POST /blueprints/{bpid}/steps`(add 一个) | `PUT /blueprints/{blueprint_id}/steps`(replace **全部**) |

> ⚠️ 最后一项 `blueprint.add_step` 不只是 path,**method 也错了**(POST → PUT),而且 cws-core 这个 endpoint 的**语义是"全量替换 steps"**,不是"追加一个"。要"追加一步"必须先 GET blueprint(带 `include_steps=true`)、本地拼出新数组、再整体 PUT 回去。

### 🟡 F2 —— Body / Query 字段错位

| `tm.js` 命令 | 我们发的字段 | cws-core 接受的字段 |
|---|---|---|
| `project.create`     | `{ name, description, icon, lead_ids, member_ids }`(都数组形态) | `{ name*, description?, slug*, is_default, lead_member_id* }` —— icon 不存在,lead_ids/member_ids 改成 `lead_member_id`,新增必填 `slug` |
| `project.update`     | `{ description, icon, lead_ids, member_ids }`                   | `{ name?, description?, lead_member_id? }` —— icon/lead_ids/member_ids 全无 |
| `issue.list_in_project` | query `{ status, archived, page_size, page_token }`          | query `{ status, priority, ...PageParams }` —— **无 `archived` 过滤**,要归档列表传 `status=archived` |
| `issue.create`(body) | 我们漏发 `priority`                                              | `priority*` 是 required(low/medium/high)|
| `issue.transition`(body) | `{ status }`                                                | `{ target_status*, rejection_reason? }` —— **字段名错** |
| `issue.move_project`(body) | `{ project_id }`                                          | `{ new_project_id* }` —— **字段名错** |
| `task.list`(query)   | `{ project_id, issue_id, status, assignee_id, page_size, page_token }` | `{ project_id?, issue_id?, status?, claimable?, agent_skills?, ...PageParams }` —— **无 `assignee_id` 过滤** |
| `task.create`(body)  | 多发了 `mode`、`priority`、`status`                              | cws-core 不接这三个(task 没有 mode/priority,status 由 transition 走) |
| `task.transition`(body) | `{ status }`                                                 | `{ target_status* }` —— **字段名错** |
| `task.reassign`(body) | `{ assignee_id }`                                              | `{ new_assignee_id* }` —— **字段名错** |
| `blueprint.create`(body) | `{ issue_id }`                                              | `{ author_agent_id*, steps[]*, estimated_budget?, notes? }` —— 完全不一样,要在 create 时一并把 steps 提交 |

### 🔴 F3 —— cws-core@contract-v2 完全没有的 endpoint(call 会 404)

短期内只能把这些命令在 tm.js 里 disable / 删掉(或在 cws-core 那侧加 forwarding):

| `tm.js` 命令 | 说明 |
|---|---|
| `task.archive`                   | cws-core 没有 task archive,等价做法是 `transition` 到 `cancelled` |
| `task.subtask_create`            | cws-core 没有 subtask 概念 |
| `blueprint.update_step`          | 单 step 改不了,只能 `PUT /blueprints/{id}/steps` 全量替换 |
| `blueprint.delete_step`          | 同上,通过全量 PUT 提交一个不含该 step 的列表 |
| `blueprint.set_step_depends_on`  | depends-on 是 stepInput 的子字段,只能批量 replace |
| `blueprint.set_estimated_budget` | `estimated_budget` 只能在 create 时一并传 |
| `blueprint.set_notes`            | `notes` 只能在 create 时一并传 |
| `blueprint.render_markdown`      | 渲染逻辑不在 cws-core |
| `blueprint.submit_for_approval`  | 没有 submit-for-approval endpoint(audit 流程在 cws-work 但 cws-core 没暴露) |
| `blueprint.create_amendment`     | 没有 amendment 概念 |
| `taskboard.list`                 | cws-core 没有 task-board endpoint。能筛 `claimable=true` / `agent_skills=[...]` 的 task 列表用 `GET /tasks` 替代(`list-tasks` 已经支持这俩 query) |

### F4 —— 出参形态变了:加了 D8 envelope

所有 ✅ 命中的接口,响应都被包了一层 `{ data, request_id, server_time }` 或 `{ data, pagination, ... }`。我们的 `tm.js` 直接把 fetch 后的 JSON `console.log`,**调用方拿到的就不是 raw item,而是带 envelope 的 wrapper**。后续如果对 tm.js 做适配:或者(a) 在 tm.js / client.js 里统一 unwrap `body.data`(类似已经为其他 service 做过的 D8 unwrap),或者(b) 让 caller 自己拿 `result.data`。

---

## cws-core@contract-v2 暴露但 tm.js 没用的 endpoint(供后续参考)

| Method + Path | 用途 |
|---|---|
| `GET  /api/v1/issues` | 全 org 的 issue 列表(我们只用嵌套版) |
| `POST /api/v1/issues/{issue_id}/acceptance` | 接受 / 拒绝 issue 交付(`set-issue-acceptance`) |
| `POST /api/v1/projects/{project_id}/members` | 加项目成员(`add-project-member`) |
| `DELETE /api/v1/projects/{project_id}/members/{member_id}` | 移除项目成员(`remove-project-member`) |
| `GET  /api/v1/issues/{issue_id}/tasks` | 按 issue 列 task(等价 `list-tasks?issue_id=...`) |
| `POST /api/v1/tasks/{task_id}/claim` | 领取 task,并自动开 attempt(`claim-task`) |
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

要把 `tm.js` 反过来贴一遍:

```bash
cd zylos-coco-workspace
grep -nE "apiPath\(" src/cli/tm.js
```
