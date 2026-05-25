# Core 操作指南

CLI 位置:`src/cli/core.js`
调用方式:`node src/cli/core.js <command> '<json>'`

状态:✅ cws-core 已有 · ⏳ 暂未暴露(调用会 404)

> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`
> 默认前缀 `/api/v1`(可用 `COCO_API_PREFIX` 覆盖)

## 何时使用 Core CLI

Lead agent 在上下文组装阶段查"工作空间里有谁、能干什么":

- 列团队成员 / 项目成员 → 决定派单对象
- 看 Agent 是谁,有哪些能力(等 ⏳ 解锁)
- 列项目清单,确认任务归属
- 查当前 user / workspace 身份

Core 是只读视角;写操作走 `tm.js`(任务调度) / `comm.js`(发消息)。

## 命令列表

### 身份

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.me` | `{}` | `GET /api/v1/me` |

返回当前 user + workspace + 权限概览。

### 成员

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.member_list` | `{orgId?, kind?, status?, search?, cursor?, limit?}` | `GET /api/v1/members` |
| ✅ | `core.member_get` | `{memberId}` | `GET /api/v1/members/{id}` |
| ✅ | `core.project_members` | `{projectId}` | `GET /api/v1/projects/{id}/members` |

`kind` 取值:`human` / `agent` / `all`(legacy alias:`type`)。
`search` 取值:模糊匹配名字 / email(legacy alias:`q`)。

### 团队

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ⏳ | `core.team_list` | `{cursor?, limit?}` | `GET /api/v1/teams` |
| ⏳ | `core.team_get` | `{teamId, include?}` | `GET /api/v1/teams/{id}` |
| ⏳ | `core.team_members` | `{teamId}` | `GET /api/v1/teams/{id}/members` |

整个 teams 域 cws-core 尚未暴露。临时变通:用 `core.project_members` 走项目维度找人。

### Agent

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.agent_list` | `{pageSize?, pageToken?}` | `GET /api/v1/agents` |
| ⏳ | `core.agent_get` | `{agentId}` | `GET /api/v1/agents/{id}` |
| ⏳ | `core.agent_skills` | `{agentId}` | `GET /api/v1/agents/{id}/skills` |
| ⏳ | `core.agent_metrics` | `{agentId}` | `GET /api/v1/agents/{id}/metrics` |

### 项目

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.project_list` | `{status?, pageSize?, pageToken?}` | `GET /api/v1/projects` |

项目的 CRUD / archive / members 等走 `tm.js`(同一资源,workflow 视角)。

### 组织

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.org_list` | `{}` | `GET /api/v1/organizations` |
| ✅ | `core.org_get` | `{orgId}` | `GET /api/v1/organizations/{id}` |

## 典型流程:Lead 决策派发(✅ 当前能跑的版本)

```bash
# 1. 我自己是谁
node src/cli/core.js core.me '{}'

# 2. 列项目,确认目标项目
node src/cli/core.js core.project_list '{}'

# 3. 看这个项目的成员(含 agent 和 human)
node src/cli/core.js core.project_members '{"projectId":"<project-uuid>"}'

# 4. 列所有 agent 取个详细清单(若需要按能力筛)
node src/cli/core.js core.agent_list '{"pageSize":50}'

# 5. 派单(切到 tm.js,⏳ task.create 待 core 暴露)
node src/cli/tm.js task.create '{"projectId":"<p>","title":"...","assigneeId":"<m>"}'
```

`teams` 上线后,步骤 3 可以从 `project_members` 切到 `team_members` 看更宽的范围。

## 分页约定

cws-core 不统一,逐端点看 OpenAPI:

| 资源 | 参数 |
| --- | --- |
| conversations / projects / issues / tasks / agents | `page_size` + `page_token` |
| members | `cursor` + `limit` |
| messages | `after_seq` + `before_seq` + `limit` |

本 CLI 接受 camelCase 输入(`pageSize`/`pageToken`/`cursor`/`limit`),内部转 snake 走线。

## 环境变量

- `COCO_API_URL` — cws-core 入口(默认 `http://127.0.0.1:8080`)
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀(默认 `/api/v1`)
