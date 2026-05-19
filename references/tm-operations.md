# TM 操作指南

> Layer 3 操作参考。Agent 在需要操作 Task Management 时按需加载本文档。
> 命令规格的权威来源是 `src/cli/tm.js`，本文档与 CLI 保持 1:1 对应。

CLI 位置：`src/cli/tm.js`
调用方式：`node src/cli/tm.js <command> '<json>'`
帮助：`node src/cli/tm.js help`

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | COCO 后端基地址（cws-work 独立开发时设为 `http://127.0.0.1:18080`） |
| `COCO_AUTH_TOKEN` | （空） | Bearer token，认证端点必填 |

## 错误处理

CLI 失败时往 stderr 输出 `{"error":"...","status":<httpStatus>}`，exit code 1。常见错误：

| HTTP | 含义 | Agent 应对 |
| --- | --- | --- |
| 400 | 入参不合法 | 检查参数后重试 |
| 404 | 资源不存在或无读权限 | 改用搜索 / 询问 Lead |
| 409 | 状态冲突 / 已存在 | 重读最新状态后再决定 |
| 504 | 后端超时 | 退避后重试 |

## 命令清单

### Project

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `project.create` | 创建项目 | `{workspaceId, teamId, name, slug, isInbox?}` |
| `project.get` | 查询项目 | `{id}` |
| `project.list` | 列出项目 | `{workspaceId, status?, limit?, offset?}` |
| `project.archive` | 归档项目 | `{id}` |
| `project.unarchive` | 取消归档 | `{id}` |

### Issue

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `issue.create` | 创建 Issue | `{projectId, title, description?, mode, leadAgentId, originConversationId?, originMessageId?}` |
| `issue.get` | 查询 Issue | `{id}` |
| `issue.list` | 列出 Issue | `{projectId, status?, limit?, offset?}` |
| `issue.update` | 编辑 Issue | `{id, title?, description?}` |
| `issue.transition` | 流转状态 | `{id, status}` |
| `issue.move_project` | 移动到其他项目 | `{id, projectId}` |
| `issue.set_acceptance` | 设置验收结果 | `{id, accepted, source}` |

`mode` 取值：`light`（直接执行流） / `heavy`（Blueprint 编排流）。

### Task

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `task.create` | 创建任务 | `{issueId, title, description?, assigneeId?, skillTags?, blueprintStepId?, dependsOn?, contextPageIds?}` |
| `task.get` | 查询任务 | `{id}` |
| `task.list` | 列出任务 | `{issueId, status?, limit?, offset?}` |
| `task.claim` | Worker 领取（创建 Attempt） | `{id, assigneeId}` |
| `task.transition` | 流转任务状态 | `{id, status}` |
| `task.reassign` | 重新指派 | `{id, assigneeId}` |

### TaskBoard

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `taskboard.list` | 浏览待认领任务 | `{workspaceId, skillTags?, status?, limit?, offset?}` |

### Attempt

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `attempt.create` | 显式创建 Attempt（通常由 `task.claim` 触发） | `{taskId, assigneeId}` |
| `attempt.get` | 查询 Attempt | `{id}` |
| `attempt.list` | 列出某 Task 的 Attempt 历史 | `{taskId, limit?, offset?}` |
| `attempt.transition` | 流转 Attempt 状态 | `{id, status, failureReason?}` |

### Blueprint（heavy mode 编排）

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `blueprint.create` | 创建 Blueprint 草稿 | `{issueId}` |
| `blueprint.get` | 查询 Blueprint | `{id}` |
| `blueprint.list` | 列出某 Issue 的 Blueprint | `{issueId, limit?, offset?}` |
| `blueprint.add_step` | 添加 Step | `{blueprintId, description, sortOrder?, requiredResources?, dependsOn?}` |
| `blueprint.update_step` | 编辑 Step | `{id, description?, sortOrder?, requiredResources?}` |
| `blueprint.delete_step` | 删除 Step | `{id}` |
| `blueprint.set_step_depends_on` | 设置 Step 依赖 | `{id, dependsOn}` |
| `blueprint.set_estimated_budget` | 设置预算 | `{id, estimatedBudget}` |
| `blueprint.set_notes` | 设置备注 | `{id, notes}` |
| `blueprint.render_markdown` | 渲染为 markdown 预览 | `{id}` |
| `blueprint.submit_for_approval` | 提交审批 | `{id}` |
| `blueprint.create_amendment` | 创建修订版 | `{issueId}` |

### Comment

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `comment.append` | 追加结论性记录 | `{workType, workId, authorId, bodyMarkdown, eventType?, eventPayload?}` |
| `comment.list` | 列出评论 | `{workType, workId, limit?, offset?}` |

`workType` 取值：`issue` / `task` / `attempt` / `blueprint`。

### Link（WorkConversationLink）

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `link.create` | 把 Issue/Task 跟 IM 会话锚定 | `{workType, workId, conversationId, linkRole, anchorMessageId?}` |
| `link.list` | 列出 Link | `{workType?, workId?, conversationId?}` |

`linkRole` 取值：`origin`（需求源） / `update`（进度同步）/ `delivery`（交付通道）。

### System

| 命令 | 用途 | 入参 |
| --- | --- | --- |
| `system.initialize_workspace` | 工作区初始化（部署时调用） | `{workspaceId, teamId}` |
| `system.approval_decision` | 审批决策回调 | `{blueprintId, approved}` |
| `system.auto_archive` | 触发自动归档检查 | `{workspaceId}` |

## 典型使用场景

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
