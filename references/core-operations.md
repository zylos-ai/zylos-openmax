# Core 操作指南

CLI 位置：`src/cli/core.js`
调用方式：`node src/cli/core.js <command> '<json>'`

## 何时使用 Core CLI

Lead agent 在上下文组装阶段需要了解"工作空间里有谁、能干什么"时使用：

- 列出团队成员，挑合适的 Agent 派发任务
- 查 Agent 的 skill 列表，确认是否具备处理能力
- 列项目清单，确认任务归属哪个 project
- 查当前 workspace / user 身份

Core 是只读视角；写操作（建/改/删项目、调度任务）走 `tm.js`，发消息走 `comm.js`。

## 命令列表

### 身份

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `core.me` | 当前 user / workspace / permission 概览 | `{}` |

### 成员

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `core.member_list` | 通讯录（人 + Agent 统一视图） | `{type?, q?, teamId?, status?, cursor?, limit?}` |
| `core.member_get` | 单个成员详情 | `{memberId}` |

`type` 取值：`all`（默认）/ `human` / `agent`。

### 团队

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `core.team_list` | 列出团队 | `{cursor?, limit?}` |
| `core.team_get` | 团队详情 | `{teamId, include?}` |
| `core.team_members` | 团队成员列表（`member_list {teamId}` 的语义快捷） | `{teamId, type?, cursor?, limit?}` |

`include` 用于一次拉取附加结构，例如 `"members,activity"`（草案，需后端支持）。

### Agent

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `core.agent_list` | Agent 清单 | `{cursor?, limit?}` |
| `core.agent_get` | Agent 详情（含 template、状态） | `{agentId}` |
| `core.agent_skills` | Agent 的 skill 配置 | `{agentId}` |
| `core.agent_metrics` | Agent 运行指标 | `{agentId}` |

### 项目

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `core.project_list` | 项目目录（元信息视角） | `{tab?, view?, mode?, status?, cursor?, limit?}` |

项目内的任务工作流（Issue / Task / Blueprint 等）请使用 `tm.js`。

## 典型流程：Lead 决策派发

```bash
# 1. 看团队成员
node src/cli/core.js core.team_members '{"teamId":"team-growth"}'

# 2. 挑一个 Agent，看其 skill 是否够用
node src/cli/core.js core.agent_skills '{"agentId":"agt-analyst"}'

# 3. 确认目标项目存在
node src/cli/core.js core.project_list '{"tab":"mine"}'

# 4. 派发任务（切换到 tm.js）
node src/cli/tm.js task.create '{"issueId":"is-x","title":"...","assigneeId":"agt-analyst"}'
```

## 注意事项

- `members` 把人和 Agent 统一成同一种实体，`type` 字段区分
- 项目网格 / 列表的视觉模式（`view` / `mode`）是前端筛选 hint，后端会按 hint 返回最相关字段，但响应里仍是完整 Project
- 全局 skill 注册表（按 skill 反查谁会）网关暂未提供（pending #待确认问题），目前只能按 Agent 维度查
- 写型操作（成员邀请、Agent 配置变更等）属于 admin / 编辑面，不在本 CLI 范围

## 环境变量

- `COCO_API_URL` — 网关入口（默认 `http://127.0.0.1:8080`）
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀（默认 `/api/gateway/v1`）
