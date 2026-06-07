# Core 操作指南

CLI 位置:`src/cli/core.js`
调用方式:`node src/cli/core.js <command> '<json>'`

状态:✅ cws-core 已实装(全部 16 个命令都跑得通)。

> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`
> 默认前缀 `/api/v1`(可用 `COCO_API_PREFIX` 覆盖)

## 何时使用 Core CLI

Lead agent 上下文组装阶段查"工作空间里有谁、能做什么":

- 列项目成员 → 决定派单对象
- 查当前 user / workspace 身份
- 列项目清单,确认任务归属
- 切 org / 看角色 / 拉同事进 org(写)
- 平台 agent(机器人成员)的注册和注销

Core 是身份 + 目录视角;workflow 操作(task/issue/blueprint)走 `tm.js`,IM 走 `comm.js`,KB 走 `kb.js`。

## 命令列表

### 身份

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.me` | `{}` | `GET /api/v1/me` |

返回当前 user / workspace / 权限概览,含 `member_id` + `org_id` + `role`。

### 成员

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.member_list` | `{kind?, status?, search?, page?, pageSize?, orderBy?}` | `GET /api/v1/members` |
| ✅ | `core.member_get` | `{memberId}` | `GET /api/v1/members/{id}` |
| ✅ | `core.project_members` | `{projectId}` | `GET /api/v1/projects/{id}/members` |

- `kind` 取值:`human` / `agent` / `all`(legacy alias `type`)
- `search` 模糊匹配名字 / email(legacy alias `q`)
- 分页参数走 cws-core 的 `PageParams`:`page` + `page_size`(CLI 同时接受 `pageSize` 或 legacy `limit`)

### 项目

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.project_list` | `{status?, page?, pageSize?, orderBy?}` | `GET /api/v1/projects` |

项目的 CRUD / archive / members 等走 `tm.js`(同一资源,workflow 视角)。

### 组织

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.org_list` | `{orderBy?}` | `GET /api/v1/organizations` |
| ✅ | `core.org_get` | `{orgId}` | `GET /api/v1/organizations/{id}` |
| ✅ | `core.org_create` | `{name, slug, displayName}` | `POST /api/v1/organizations` — 调用方自动成为新 org 的 owner,响应里直接返回 access_token 已 scoped 到新 org |
| ✅ | `core.org_switch` | `{orgId}` | `POST /api/v1/organizations/{id}/switch` — body 必填 `{}`(空对象,服务端 schema 是 closed);返回新 org scope 的 access_token |

### 角色

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.role_list` | `{scope?}` | `GET /api/v1/roles` |

`scope` 取值:`org` / `project` / 不传(全部)。

### 邀请

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.invitation_create` | `{roleId, email?, message?}` | `POST /api/v1/invitations` — org_id 服务端从 JWT 推导,**不要客户端发** |
| ✅ | `core.invitation_list` | `{status?, page?, pageSize?, orderBy?}` | `GET /api/v1/invitations` |
| ✅ | `core.invitation_accept` | `{invitationId, token, displayName}` | `POST /api/v1/invitations/{id}/accept` — `token` 和 `displayName` 都是必填(后者 = 接受方在新 org 里的显示名);CLI 同时接受 `display_name` 形式 |
| ✅ | `core.invitation_revoke` | `{invitationId}` | `DELETE /api/v1/invitations/{id}` |

### 平台 Agent(机器人成员的生命周期)

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `core.platform_agent_create` | `{displayName, description?, metadata?}` | `POST /api/v1/platform-agents` |
| ✅ | `core.platform_agent_delete` | `{memberId}` | `DELETE /api/v1/platform-agents/{member_id}` |

平台 agent = org-scope 的机器人成员行,跟 human member 一样占 `member_id`,可以被 `task.create` 派单 / 入会话 / 写 KB。

## 典型流程:Lead 决策派发

```bash
# 1. 我自己是谁
node src/cli/core.js core.me '{}'

# 2. 列项目,确认目标项目
node src/cli/core.js core.project_list '{"pageSize":50}'

# 3. 看这个项目的成员(含 agent 和 human)
node src/cli/core.js core.project_members '{"projectId":"<project-uuid>"}'

# 4. 如果要按 agent 维度过滤,看整 org 的成员
node src/cli/core.js core.member_list '{"kind":"agent","pageSize":50}'

# 5. 派单(切到 tm.js)
node src/cli/tm.js task.create '{"projectId":"<p>","issueId":"<i>","title":"...","assigneeId":"<m>"}'
```

## 典型流程:把同事拉进 org

```bash
# 1. 查 roles,拿目标角色的 role_id
node src/cli/core.js core.role_list '{"scope":"org"}'

# 2. 发邀请(对方收到邀请链接)
node src/cli/core.js core.invitation_create '{
  "email":"newbie@example.com",
  "roleId":"<role-uuid>",
  "message":"Welcome to the team"
}'

# 3. 看本 org 的待处理邀请
node src/cli/core.js core.invitation_list '{"status":"pending"}'

# 4. 不想要了
node src/cli/core.js core.invitation_revoke '{"invitationId":"<inv-uuid>"}'
```

接受方那一侧:

```bash
node src/cli/core.js core.invitation_accept '{
  "invitationId":"<inv-uuid>",
  "token":"<from-invitation-link>",
  "displayName":"My Display Name In This Org"
}'
# → 返回的 access_token 已 scoped 到新 org 的 member_id
```

## 典型流程:org 切换

```bash
# 1. 看我加入了哪些 org
node src/cli/core.js core.org_list '{}'

# 2. 切到目标 org(返回新 access_token,scope 到新 member_id)
node src/cli/core.js core.org_switch '{"orgId":"<target-org-uuid>"}'
```

切换之后,后续所有 CLI 调用要用返回的新 token,旧 token 仍然是旧 org scope。

## 分页约定

cws-core 大部分 list endpoint 用 `PageParams`(`page` + `page_size` + `order_by`):

| 资源 | 分页方式 |
| --- | --- |
| `core.member_list` / `core.project_list` / `core.invitation_list` | `page` + `page_size`(camelCase 输入 `page` / `pageSize`)|
| `core.org_list` / `core.role_list` | 不分页(返回全集) |
| 历史消息(`comm.get_messages`) | `after_seq` + `before_seq` + `limit`(对话流专用 cursor) |

> 历史踩坑:CLI 早先版本对 `member_list` / `project_list` / `invitation_list` 发的是 `cursor` + `limit`,服务端不识别,默默忽略并永远返回第一页 default 20 条。修复后这三个命令同时接受 `pageSize`(canonical)/ `limit`(legacy alias),方便老调用方过渡。

## 环境变量

- `COCO_API_URL` — cws-core 入口(默认 `http://127.0.0.1:8080`)
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀(默认 `/api/v1`)
