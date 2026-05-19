# TM 操作指南

CLI 位置：`src/cli/tm.js`
调用方式：`node src/cli/tm.js <command> '<json>'`

## 命令列表

### Issue 操作

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `issue.create` | 创建 Issue | `{projectId, title, description, leadAgentId, mode?}` |
| `issue.get` | 获取 Issue 详情 | `{id}` |
| `issue.list` | 列出 Issue | `{projectId?, status?, keyword?, limit?}` |
| `issue.transition` | 流转 Issue 状态 | `{id, status}` |

### Task 操作

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `task.create` | 创建 Task | `{issueId, title?, description, assigneeId?, skillTags?}` |
| `task.get` | 获取 Task 详情 | `{id}` |
| `task.claim` | 领取 Task（创建 Attempt） | `{id}` |
| `task.transition` | 流转 Task 状态 | `{id, status}` |
| `task.list` | 列出 Task | `{issueId?, assigneeId?, status?}` |

### Attempt 操作

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `attempt.transition` | 流转 Attempt 状态 | `{id, status, failureReason?}` |

### Blueprint 操作

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `blueprint.create` | 创建 Blueprint 草稿 | `{issueId, title?, description?}` |
| `blueprint.add_step` | 添加 Step | `{blueprintId, title, description, skillTags?, dependsOn?}` |
| `blueprint.submit` | 提交审批 | `{blueprintId}` |

### Comment 操作

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `comment.create` | 创建 Comment | `{workType, workId, content}` |

## 典型使用场景

### Lead 创建 Issue 并自做

```bash
node src/cli/tm.js issue.create '{"projectId":"proj-1","title":"竞品分析","leadAgentId":"self"}'
node src/cli/tm.js task.create '{"issueId":"issue-1","description":"分析 Notion 定价","assigneeId":"self"}'
node src/cli/tm.js task.claim '{"id":"task-1"}'
# ... 执行工作 ...
node src/cli/tm.js attempt.transition '{"id":"att-1","status":"done"}'
node src/cli/tm.js task.transition '{"id":"task-1","status":"done"}'
node src/cli/tm.js issue.transition '{"id":"issue-1","status":"delivered"}'
```

### Worker 领取并完成 Task

```bash
node src/cli/tm.js task.claim '{"id":"task-1"}'
# ... 执行工作 ...
node src/cli/tm.js attempt.transition '{"id":"att-1","status":"done"}'
node src/cli/tm.js task.transition '{"id":"task-1","status":"done"}'
```
