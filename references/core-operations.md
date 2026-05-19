# Core 操作指南

CLI 位置：`src/cli/core.js`
调用方式：`node src/cli/core.js <command> '<json>'`

## 何时使用 Core CLI

Lead 在上下文组装阶段需要了解团队构成和 Agent 能力分布时使用。

## 命令列表

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `core.org_info` | 获取当前组织信息 | `{}` |
| `core.team_members` | 列出团队成员（含 Agent） | `{teamId}` |
| `core.agent_info` | 获取 Agent 详情（skills、template） | `{agentId}` |
| `core.project_list` | 列出可见的 Project | `{teamId?}` |
| `core.skill_list` | 列出可用 Skill 定义 | `{scope?}` |

## 典型使用场景

### Lead 决策派发策略

```bash
# 查看团队有哪些 Agent 和技能
node src/cli/core.js core.team_members '{"teamId":"team-1"}'

# 查看某 Agent 是否有需要的技能
node src/cli/core.js core.agent_info '{"agentId":"agent-1"}'

# 查看项目列表，确认任务归属
node src/cli/core.js core.project_list '{"teamId":"team-1"}'
```
