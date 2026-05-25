# TM 操作指南

> Layer 3 操作参考。Agent 在需要操作 Task Management 时按需加载本文档。
> 命令规格的权威来源是 `src/cli/tm.js`,本文档与 CLI 保持 1:1 对应。
> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`

CLI 位置:`src/cli/tm.js`
调用方式:`node src/cli/tm.js <command> '<json>'`
帮助:`node src/cli/tm.js help`

状态:✅ cws-core 已有 · ⏳ 暂未暴露(调用会 404)

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core 基地址 |
| `COCO_AUTH_TOKEN` | (空) | Bearer token,认证端点必填 |
| `COCO_API_PREFIX` | `/api/v1` | 路径前缀;非默认场景才需要覆盖 |

## 当前覆盖度速览

| 域 | ✅ 可用 | ⏳ 暂缺 |
| --- | --- | --- |
| Project | list / create / get / update / archive / restore / members | — |
| Issue | list / list_in_project / get(嵌套) | create / update / transition / move / acceptance |
| Task | list | get / create / transition / archive / subtask / claim / reassign |
| Blueprint / Attempt / Comment / Link / System / TaskBoard | — | 整族 ⏳ |

`task.*` 写、`issue.*` 写、`blueprint.*`、`attempt.*` 等是 Agent loop 的核心,目前**只能读、不能写**。Agent 在 ⏳ 命令上得到 404 时应**回退到对话流**(让人类辅助)而不是反复重试。

## 错误处理

CLI 失败时往 stderr 输出 `{"error":"...","status":<httpStatus>}`，exit code 1。常见错误：

| HTTP | 含义 | Agent 应对 |
| --- | --- | --- |
| 400 | 入参不合法 | 检查参数后重试 |
| 404 | 资源不存在或无读权限 | 改用搜索 / 询问 Lead |
| 409 | 状态冲突 / 已存在 | 重读最新状态后再决定 |
| 504 | 后端超时 | 退避后重试 |

## 命令清单

### Project ✅ 全套可用

| 状态 | 命令 | 入参 | 端点 |
| --- | --- | --- | --- |
| ✅ | `project.list` | `{status?, pageSize?, pageToken?}` | `GET /projects` |
| ✅ | `project.create` | `{name, description?, icon?, leadIds?, memberIds?}` | `POST /projects` |
| ✅ | `project.get` | `{id}` | `GET /projects/{id}` |
| ✅ | `project.update` | `{id, description?, icon?, leadIds?, memberIds?}` | `PATCH /projects/{id}` |
| ✅ | `project.archive` | `{id}` | `POST /projects/{id}/archive` |
| ✅ | `project.restore` / `project.unarchive` | `{id}` | `POST /projects/{id}/restore` |
| ✅ | `project.members` | `{id}` | `GET /projects/{id}/members` |

`create` body 严格按 `CreateProjectRequestBody`(`additionalProperties:false`):只有 `{name, description?, icon?, lead_ids?, member_ids?}`。不要传 `workspace_id` / `team_id` / `slug` / `is_inbox` —— 会被拒。

### Issue (读 ✅ · 写 ⏳)

| 状态 | 命令 | 入参 | 端点 |
| --- | --- | --- | --- |
| ✅ | `issue.list` | `{status?, assigneeId?, pageSize?, pageToken?}` | `GET /issues`(全局) |
| ✅ | `issue.list_in_project` | `{projectId, status?, archived?, pageSize?, pageToken?}` | `GET /projects/{pid}/issues` |
| ✅ | `issue.get` | `{projectId, id}` | `GET /projects/{pid}/issues/{iid}`(嵌套) |
| ⏳ | `issue.create` | `{projectId, title, description?, mode, leadAgentId, originConversationId?, originMessageId?}` | `POST /projects/{pid}/issues` |
| ⏳ | `issue.update` | `{projectId, id, title?, description?}` | `PATCH /projects/{pid}/issues/{iid}` |
| ⏳ | `issue.transition` | `{projectId, id, status}` | `POST /projects/{pid}/issues/{iid}/transition` |
| ⏳ | `issue.move_project` | `{projectId, id, targetProjectId}` | `POST /projects/{pid}/issues/{iid}/move` |
| ⏳ | `issue.set_acceptance` | `{projectId, id, accepted, source}` | `POST /projects/{pid}/issues/{iid}/acceptance` |

注意 `issue.get` / 写操作都需要 `projectId`(嵌套路径),不能像旧版那样只传 issue id。

`mode` 取值:`light`(直接执行流) / `heavy`(Blueprint 编排流)。

### Task (列表 ✅ · 其他 ⏳)

| 状态 | 命令 | 入参 | 端点 |
| --- | --- | --- | --- |
| ✅ | `task.list` | `{projectId?, issueId?, status?, assigneeId?, pageSize?, pageToken?}` | `GET /tasks` |
| ⏳ | `task.get` | `{id}` | `GET /tasks/{id}` |
| ⏳ | `task.create` | `{issueId?, projectId?, title, description?, assigneeId?, skillTags?, blueprintStepId?, dependsOn?, contextPageIds?, mode?, priority?, status?}` | `POST /tasks` |
| ⏳ | `task.transition` / `task.status` | `{id, status}` | `POST /tasks/{id}/status` |
| ⏳ | `task.archive` | `{id}` | `POST /tasks/{id}/archive` |
| ⏳ | `task.subtask_create` | `{id, title, assigneeId?, status?}` | `POST /tasks/{id}/subtasks` |
| ⏳ | `task.claim` | `{id, assigneeId}` | `POST /tasks/{id}/claim` |
| ⏳ | `task.reassign` | `{id, assigneeId}` | `POST /tasks/{id}/reassign` |

### TaskBoard

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| ⏳ | `taskboard.list` | 浏览待认领任务 | `{workspaceId, skillTags?, status?, pageSize?, pageToken?}` |

### Attempt(整族 ⏳)

| 状态 | 命令 | 用途 | 入参 |
| --- | --- | --- | --- |
| ⏳ | `attempt.create` | 显式创建 Attempt(通常由 `task.claim` 触发) | `{taskId, assigneeId}` |
| ⏳ | `attempt.get` | 查询 Attempt | `{id}` |
| ⏳ | `attempt.list` | 列出某 Task 的 Attempt 历史 | `{taskId, pageSize?, pageToken?}` |
| ⏳ | `attempt.transition` | 流转 Attempt 状态 | `{id, status, failureReason?}` |

### Blueprint(整族 ⏳ · heavy mode 编排)

| 状态 | 命令 | 用途 | 入参 |
| --- | --- | --- | --- |
| ⏳ | `blueprint.create` | 创建 Blueprint 草稿 | `{issueId}` |
| ⏳ | `blueprint.get` | 查询 Blueprint | `{id}` |
| ⏳ | `blueprint.list` | 列出某 Issue 的 Blueprint | `{issueId, pageSize?, pageToken?}` |
| ⏳ | `blueprint.add_step` | 添加 Step | `{blueprintId, description, sortOrder?, requiredResources?, dependsOn?}` |
| ⏳ | `blueprint.update_step` | 编辑 Step | `{id, description?, sortOrder?, requiredResources?}` |
| ⏳ | `blueprint.delete_step` | 删除 Step | `{id}` |
| ⏳ | `blueprint.set_step_depends_on` | 设置 Step 依赖 | `{id, dependsOn}` |
| ⏳ | `blueprint.set_estimated_budget` | 设置预算 | `{id, estimatedBudget}` |
| ⏳ | `blueprint.set_notes` | 设置备注 | `{id, notes}` |
| ⏳ | `blueprint.render_markdown` | 渲染为 markdown 预览 | `{id}` |
| ⏳ | `blueprint.submit_for_approval` | 提交审批 | `{id}` |
| ⏳ | `blueprint.create_amendment` | 创建修订版 | `{issueId}` |

### Comment(整族 ⏳)

| 状态 | 命令 | 用途 | 入参 |
| --- | --- | --- | --- |
| ⏳ | `comment.append` | 追加结论性记录 | `{workType, workId, authorId, bodyMarkdown, eventType?, eventPayload?}` |
| ⏳ | `comment.list` | 列出评论 | `{workType, workId, pageSize?, pageToken?}` |

`workType` 取值:`issue` / `task` / `attempt` / `blueprint`。

### Link(整族 ⏳ · WorkConversationLink)

| 状态 | 命令 | 用途 | 入参 |
| --- | --- | --- | --- |
| ⏳ | `link.create` | 把 Issue/Task 跟 IM 会话锚定 | `{workType, workId, conversationId, linkRole, anchorMessageId?}` |
| ⏳ | `link.list` | 列出 Link | `{workType?, workId?, conversationId?}` |

`linkRole` 取值:`origin`(需求源) / `update`(进度同步)/ `delivery`(交付通道)。

### System(整族 ⏳)

| 状态 | 命令 | 用途 | 入参 |
| --- | --- | --- | --- |
| ⏳ | `system.initialize_workspace` | 工作区初始化(部署时调用) | `{workspaceId, teamId}` |
| ⏳ | `system.approval_decision` | 审批决策回调 | `{blueprintId, approved}` |
| ⏳ | `system.auto_archive` | 触发自动归档检查 | `{workspaceId}` |

## 典型使用场景

> 下面流程示例**部分步骤**会触达 ⏳ 命令(标出来了);⏳ 步骤等 core 暴露后即可跑通,目前会 404。

### 1. Lead 接 light 模式 Issue 且自做

```bash
# 1) 创建 light Issue（auto 进入 executing）
node src/cli/tm.js issue.create '{
  "projectId":"proj-1","mode":"light",
  "title":"Notion 竞品定价分析","description":"对比 5 个直接竞品的定价层级",
  "leadAgentId":"agent-self","originConversationId":"conv-1","originMessageId":"msg-42"
}'

# 2) 创建 Task 并自做
node src/cli/tm.js task.create '{
  "issueId":"iss-1","title":"Implement","assigneeId":"agent-self"
}'
node src/cli/tm.js task.claim '{"id":"task-1","assigneeId":"agent-self"}'

# 3) 工作完成，流转 Attempt → Task → Issue → 交付
node src/cli/tm.js attempt.transition '{"id":"att-1","status":"done"}'
node src/cli/tm.js task.transition    '{"id":"task-1","status":"done"}'
node src/cli/tm.js issue.transition   '{"id":"iss-1","status":"delivered"}'

# 4) 人类验收
node src/cli/tm.js issue.set_acceptance '{"id":"iss-1","accepted":true,"source":"im"}'
```

### 2. Lead heavy 模式 Blueprint 编排

```bash
# 1) 创建 heavy Issue
node src/cli/tm.js issue.create '{
  "projectId":"proj-1","mode":"heavy",
  "title":"季度产品规划","leadAgentId":"agent-self"
}'

# 2) 起 Blueprint 草稿 + Steps
node src/cli/tm.js blueprint.create '{"issueId":"iss-2"}'
node src/cli/tm.js blueprint.add_step '{
  "blueprintId":"bp-1","description":"Step 1: 调研用户痛点","sortOrder":1
}'
node src/cli/tm.js blueprint.add_step '{
  "blueprintId":"bp-1","description":"Step 2: 写需求文档","sortOrder":2,"dependsOn":["step-1"]
}'

# 3) 提交审批
node src/cli/tm.js blueprint.submit_for_approval '{"id":"bp-1"}'

# 4) 审批通过后，按 Step 派 Worker
node src/cli/tm.js task.create '{
  "issueId":"iss-2","blueprintStepId":"step-1","title":"用户访谈","assigneeId":"worker-1"
}'
```

### 3. Worker 从 TaskBoard 认领并执行

```bash
# 1) 浏览匹配技能的待认领任务
node src/cli/tm.js taskboard.list '{"workspaceId":"ws-1","skillTags":["research"]}'

# 2) 领取
node src/cli/tm.js task.claim '{"id":"task-7","assigneeId":"agent-self"}'

# 3) 执行过程中追加进度评论
node src/cli/tm.js comment.append '{
  "workType":"task","workId":"task-7","authorId":"agent-self",
  "bodyMarkdown":"已完成访谈 3/5，待安排剩余两位。"
}'

# 4) 完成
node src/cli/tm.js attempt.transition '{"id":"att-3","status":"done"}'
node src/cli/tm.js task.transition '{"id":"task-7","status":"done"}'
```

### 4. Worker 遇阻塞 / 失败汇报

```bash
node src/cli/tm.js comment.append '{
  "workType":"task","workId":"task-7","authorId":"agent-self",
  "bodyMarkdown":"无法访问竞品 B 的定价页（403），请求 Lead 提供凭证或替代来源。"
}'
node src/cli/tm.js attempt.transition '{
  "id":"att-3","status":"failed","failureReason":"missing_credentials"
}'
```

## Lead 与 Worker 的操作分布

| 操作 | Lead | Worker |
| --- | --- | --- |
| `issue.create` / `issue.transition` / `issue.set_acceptance` | ✅ | — |
| `blueprint.*` | ✅ | — |
| `task.create` / `task.reassign` | ✅ | — |
| `task.claim` / `task.transition` | — | ✅ |
| `attempt.transition` | — | ✅ |
| `comment.append` | 经验沉淀 / 决策记录 | 进度 / 阻塞 / 完成汇报 |
| `link.create` | 创建会话锚定 | — |

详细行为参见 [agent-skill-spec.md](../docs/agent-skill-spec.md) 的 Lead/Worker 章节。

## 不要做的事

- **不要**在没有 leadAgentId 的情况下创建 Issue（违反角色模型）
- **不要**在 Worker 角色下直接调 `issue.transition`（应该由 Lead 监控并流转）
- **不要**为了"绕开"审批跳过 `blueprint.submit_for_approval`（heavy 模式必须走审批）
- **不要**把 IM 消息原文整段复制进 `comment.append`（用 link.create 锚定就够了）
