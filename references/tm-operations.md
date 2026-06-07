# TM 操作指南

> Layer 3 操作参考。Agent 在需要操作 Task Management 时按需加载本文档。
> 命令规格的权威来源是 `src/cli/tm.js`,本文档与 CLI 保持 1:1 对应。
> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`

CLI 位置:`src/cli/tm.js`
调用方式:`node src/cli/tm.js <command> '<json>'`
帮助:`node src/cli/tm.js help`

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core 基地址 |
| `COCO_AUTH_TOKEN` | (空) | Bearer token,认证端点必填 |
| `COCO_API_PREFIX` | `/api/v1` | 路径前缀;非默认场景才需要覆盖 |

## 当前覆盖度速览

全部 31 个命令均已对齐 cws-core@contract-v2，可直接调用。

| 域 | 命令数 | 状态 |
| --- | --- | --- |
| Project | 8 | ✅ 全部可用 |
| Issue | 7 | ✅ 全部可用 |
| Task | 7 | ✅ 全部可用 |
| Blueprint | 5 | ✅ 全部可用 |
| Attempt | 4 | ✅ 全部可用 |

## 错误处理

CLI 失败时往 stderr 输出 `{"error":"...","status":<httpStatus>}`，exit code 1。常见错误：

| HTTP | 含义 | Agent 应对 |
| --- | --- | --- |
| 400 | 入参不合法 | 检查参数后重试 |
| 404 | 资源不存在或无读权限 | 改用搜索 / 询问 Lead |
| 409 | 状态冲突 / 已存在 | 重读最新状态后再决定 |
| 504 | 后端超时 | 退避后重试 |

## 命令清单

### Project (8 条)

| 状态 | 命令 | 入参 | 端点 |
| --- | --- | --- | --- |
| ✅ | `project.list` | `{status?, page?, pageSize?, orderBy?}` | `GET /projects` |
| ✅ | `project.create` | `{name, slug, leadMemberId, description?, isDefault?}` | `POST /projects` |
| ✅ | `project.get` | `{id}` | `GET /projects/{id}` |
| ✅ | `project.update` | `{id, name?, description?, leadMemberId?}` | `PATCH /projects/{id}` |
| ✅ | `project.archive` | `{id}` | `POST /projects/{id}/archive` |
| ✅ | `project.restore` | `{id}` | `POST /projects/{id}/restore` |
| ✅ | `project.unarchive` | `{id}` (alias of restore) | `POST /projects/{id}/restore` |
| ✅ | `project.members` | `{id, page?, pageSize?, orderBy?}` | `GET /projects/{id}/members` |

### Issue (7 条)

写路径使用 flat path `/issues/{id}`，不使用 `/projects/{pid}/issues/{id}`。

| 状态 | 命令 | 入参 | 端点 |
| --- | --- | --- | --- |
| ✅ | `issue.list_in_project` | `{projectId, status?, priority?, page?, pageSize?, orderBy?}` | `GET /projects/{pid}/issues` |
| ✅ | `issue.get` | `{id}` | `GET /issues/{id}` |
| ✅ | `issue.create` | `{projectId, title, mode, priority, leadAgentId, description?, dueDate?, contextPageIds?, inputArtifactIds?, originConversationId?, originMessageId?}` | `POST /projects/{pid}/issues` |
| ✅ | `issue.update` | `{id, title?, description?, priority?, dueDate?}` | `PATCH /issues/{id}` |
| ✅ | `issue.transition` | `{id, targetStatus (or 'status'), rejectionReason?}` | `POST /issues/{id}/transition` |
| ✅ | `issue.move_project` | `{id, newProjectId (or 'targetProjectId')}` | `POST /issues/{id}/move` |
| ✅ | `issue.set_acceptance` | `{id, accepted, source?, rejectionReason?}` | `POST /issues/{id}/acceptance` — `source` 取 `im` / `explicit`(默认 `explicit`),区分隐式 IM 验收和显式 set_acceptance 调用 |

`mode` 取值：`light`（直接执行流）/ `heavy`（Blueprint 编排流）。

### Task (7 条)

`task.create` 使用双重嵌套路径 `/projects/{pid}/issues/{iid}/tasks`；其余使用 flat path `/tasks/{id}`。

| 状态 | 命令 | 入参 | 端点 |
| --- | --- | --- | --- |
| ✅ | `task.list` | `{projectId?, issueId?, status?, claimable?, agentSkills?, page?, pageSize?, orderBy?}` | `GET /tasks` |
| ✅ | `task.get` | `{id}` | `GET /tasks/{id}` |
| ✅ | `task.create` | `{projectId, issueId, title, description?, assigneeId?, skillTags?, blueprintStepId?, dependsOn?, contextPageIds?}` | `POST /projects/{pid}/issues/{iid}/tasks` |
| ✅ | `task.claim` | `{id}` | `POST /tasks/{id}/claim` |
| ✅ | `task.transition` | `{id, targetStatus (or 'status')}` | `POST /tasks/{id}/transition` |
| ✅ | `task.status` | `{id, targetStatus (or 'status')}` (alias of transition) | `POST /tasks/{id}/transition` |
| ✅ | `task.reassign` | `{id, newAssigneeId (or 'assigneeId')}` | `POST /tasks/{id}/reassign` |

`task.claim` 无 body，principal 从 auth header 推断；服务端自动创建 Attempt。

### Blueprint (5 条)

`blueprint.create` 和 `blueprint.list` 使用 issue 嵌套路径；`blueprint.set_steps` 是全量替换语义（PUT），不是追加。

| 状态 | 命令 | 入参 | 端点 |
| --- | --- | --- | --- |
| ✅ | `blueprint.create` | `{issueId, steps[], estimatedBudget?, notes?}` | `POST /issues/{iid}/blueprints` — 服务端从 auth principal 推导 author；CLI 接受 `authorAgentId` 形参但**不发到 body**(向后兼容老调用方) |
| ✅ | `blueprint.get` | `{id, includeSteps?}` | `GET /blueprints/{id}` |
| ✅ | `blueprint.list` | `{issueId, page?, pageSize?, orderBy?}` | `GET /issues/{iid}/blueprints` |
| ✅ | `blueprint.set_steps` | `{blueprintId (or 'id'), steps[]}` | `PUT /blueprints/{id}/steps` |
| ✅ | `blueprint.submit_for_approval` | `{id (or 'blueprintId')}` | `POST /blueprints/{id}/submit-for-approval` — heavy 模式蓝图提审；提交后 issue 走 `draft → pending_approval` |

### Attempt (4 条)

| 状态 | 命令 | 入参 | 端点 |
| --- | --- | --- | --- |
| ✅ | `attempt.create` | `{taskId}` | `POST /tasks/{taskId}/attempts` |
| ✅ | `attempt.get` | `{id}` | `GET /attempts/{id}` |
| ✅ | `attempt.list` | `{taskId, page?, pageSize?, orderBy?}` | `GET /tasks/{taskId}/attempts` |
| ✅ | `attempt.transition` | `{id, targetStatus (or 'status'), failureReason?, blockedOnApprovalRequestIds?}` | `POST /attempts/{id}/transition` |

`attempt.create` 通常不需要直接调用——`task.claim` 会自动创建 Attempt。仅在需要手动开启新一轮尝试时使用。

## 典型使用场景

### 1. Lead 接 light 模式 Issue 且自做

```bash
# 0) 上下文组装：搜 KB 找参考材料，收集 page ID
node src/cli/kb.js kb.search '{"query":"竞品定价","folderId":"tn-projects-growth"}'
# -> 命中 pg-pricing-ref-001, pg-market-overview-002

# 1) 创建 light Issue（auto 进入 executing），带 contextPageIds
node src/cli/tm.js issue.create '{
  "projectId":"proj-1","mode":"light",
  "title":"Notion 竞品定价分析","description":"对比 5 个直接竞品的定价层级",
  "priority":"medium","leadAgentId":"agent-self",
  "contextPageIds":["pg-pricing-ref-001","pg-market-overview-002"],
  "originConversationId":"conv-1","originMessageId":"msg-42"
}'

# 2) 创建 Task 并认领（自做时 contextPageIds 可省略，自己已读过）
node src/cli/tm.js task.create '{
  "projectId":"proj-1","issueId":"iss-1","title":"Implement","assigneeId":"agent-self"
}'
node src/cli/tm.js task.claim '{"id":"task-1"}'

# 3) 工作完成，流转 Attempt → Task → Issue → 交付
node src/cli/tm.js attempt.transition '{"id":"att-1","targetStatus":"done"}'
node src/cli/tm.js task.transition    '{"id":"task-1","targetStatus":"done"}'
node src/cli/tm.js issue.transition   '{"id":"iss-1","targetStatus":"delivered"}'

# 4) 人类验收
node src/cli/tm.js issue.set_acceptance '{"id":"iss-1","accepted":true}'
```

### 2. Lead heavy 模式 Blueprint 编排

```bash
# 1) 创建 heavy Issue
node src/cli/tm.js issue.create '{
  "projectId":"proj-1","mode":"heavy","priority":"high",
  "title":"季度产品规划","leadAgentId":"agent-self"
}'

# 2) 起 Blueprint 草稿（含 Steps，一次提交）
node src/cli/tm.js blueprint.create '{
  "issueId":"iss-2","authorAgentId":"agent-self",
  "steps":[
    {"temp_id":"s1","description":"Step 1: 调研用户痛点"},
    {"temp_id":"s2","description":"Step 2: 写需求文档","depends_on_temp_ids":["s1"]}
  ]
}'

# 3) 需要修改 Steps 时，整体替换
node src/cli/tm.js blueprint.set_steps '{
  "blueprintId":"bp-1",
  "steps":[
    {"temp_id":"s1","description":"Step 1: 调研用户痛点（含问卷）"},
    {"temp_id":"s2","description":"Step 2: 写需求文档","depends_on_temp_ids":["s1"]},
    {"temp_id":"s3","description":"Step 3: 技术可行性评估","depends_on_temp_ids":["s2"]}
  ]
}'

# 4) 审批通过后，按 Step 派 Worker（传 contextPageIds 子集）
node src/cli/tm.js task.create '{
  "projectId":"proj-1","issueId":"iss-2",
  "blueprintStepId":"step-1","title":"用户访谈","assigneeId":"worker-1",
  "contextPageIds":["pg-user-persona-001"]
}'
```

### 3. Worker 认领并执行任务

```bash
# 1) 浏览匹配技能的待认领任务
node src/cli/tm.js task.list '{"claimable":true,"agentSkills":["research"]}'

# 2) 认领
node src/cli/tm.js task.claim '{"id":"task-7"}'

# 3) 读取 Lead 传递的上下文页面
node src/cli/tm.js task.get '{"id":"task-7"}'
# -> context_page_ids: ["pg-user-persona-001"]
node src/cli/kb.js kb.page_content '{"pageId":"pg-user-persona-001"}'

# 4) 查看当前 Attempt 信息
node src/cli/tm.js attempt.list '{"taskId":"task-7"}'

# 5) 完成
node src/cli/tm.js attempt.transition '{"id":"att-3","targetStatus":"done"}'
node src/cli/tm.js task.transition '{"id":"task-7","targetStatus":"done"}'
```

### 4. Worker 遇阻塞 / 失败汇报

```bash
# 标记 Attempt 失败（含原因）
node src/cli/tm.js attempt.transition '{
  "id":"att-3","targetStatus":"failed","failureReason":"missing_credentials"
}'

# 需要审批时，标记 blocked
node src/cli/tm.js attempt.transition '{
  "id":"att-3","targetStatus":"blocked",
  "blockedOnApprovalRequestIds":["apr-1"]
}'
```

## Lead 与 Worker 的操作分布

| 操作 | Lead | Worker |
| --- | --- | --- |
| `issue.create` / `issue.transition` / `issue.set_acceptance` | ✅ | — |
| `issue.update` / `issue.move_project` | ✅ | — |
| `blueprint.*` | ✅ | — |
| `task.create` / `task.reassign` | ✅ | — |
| `task.claim` | — | ✅ |
| `task.transition`（own task → done/failed/cancelled）| 监控 | **✅** |
| `attempt.create` / `attempt.transition`（own attempt → done/failed/cancelled/blocked）| 监控 | **✅** |
| `project.*` / `*.list` / `*.get` | ✅ 读写 | ✅ 只读 |

**Worker 状态流转的明确边界**（避免过保守拒绝合法操作）：

- 自己的 attempt 完成 / 失败 / 被 Lead 通知取消 → Worker **自己**调 `attempt.transition` 到 `done` / `failed` / `cancelled`
- 自己的 task 所有 attempt 在终态后（或被 Lead 通知 cancel）→ Worker **自己**调 `task.transition` 到 `done` / `failed` / `cancelled`
- **不用**等 Lead 来推流转,也**不用**先在 DM 里确认"这是不是 Lead 权限" — 自己的 task / attempt 自己流转是契约的一部分
- Lead 只在**跨 task / 重派 / 接到 Worker 失败汇报后做 task 终态决策**时介入

详细行为参见 [agent-skill-spec.md](../docs/agent-skill-spec.md) 的 Lead/Worker 章节。

## 不要做的事

- **不要**在没有 leadAgentId 的情况下创建 Issue（违反角色模型）
- **不要**在 Worker 角色下调 `issue.transition` / `issue.set_acceptance`（issue 状态机是 Lead 专属）
- **不要**在 Worker 角色下调 `task.create` / `task.reassign`（派活是 Lead 专属）
- **不要**因为"觉得是 Lead 权限"就拒绝流转自己 own 的 task / attempt — 那是 Worker 的责任,Lead 在等你
- **不要**为了"绕开"审批跳过 Blueprint 审批流程（heavy 模式必须走审批）
- **不要**把 IM 消息原文整段复制进评论（用会话锚定就够了）
- **不要**直接调 `attempt.create` 来代替 `task.claim`——`claim` 已内置创建 Attempt 的逻辑

## 后续版本计划

以下功能在 0.5 中不可用（cws-core 尚未转发），计划在后续版本加入：

- Comment（评论追加 / 列表）
- Link（WorkConversationLink 锚定）
- System（工作区初始化 / 审批决策 / 自动归档）
- TaskBoard（专用看板视图，当前可用 `task.list?claimable=true` 替代）
- Blueprint 细粒度操作（单 Step 增删改、预算/备注设置、审批提交、修订版创建）
