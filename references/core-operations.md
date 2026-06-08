# Core 操作指南

**作用**:身份 + org/member/role/invitation 目录查询 + org/平台 agent 写操作。Lead agent 上下文组装的入口——查我是谁、谁在 org 里、有哪些项目能派单。

**何时加载本文档**:

- 第一次启动 / 切换 org / 不确定当前身份时,查 `core.me`
- 派任务前需要找候选 member,查 `core.member_list` / `core.project_members`
- 想拉同事进当前 org(`core.invitation_create` / `accept` / `revoke`)
- 切到另一个 org 工作(`core.org_switch`)
- 注册新平台 agent / 注销旧 agent(`core.platform_agent_create` / `delete`)
- 查角色清单决定给新人配什么权限(`core.role_list`)

**不在本文档范围**:

- 项目 / Issue / Task / Blueprint / Attempt 的 workflow → `references/tm-operations.md`(同一个 project 资源,workflow 视角)
- KB 操作 → `references/kb-operations.md`
- IM 通信 → `references/comm-operations.md`
- 文件 / artifact → `references/as-operations.md`
- **登录 / 注册 / token refresh** → cws-core `/auth/*` 端点目前没 CLI 暴露,token 管理由 `src/lib/token.js` 内部自动处理

**依赖前置**:

- 任何带 `orgId` 的命令,前面必须有 `core.me` 或 `core.org_switch` 确认 scope
- `core.invitation_create` 需要先 `core.role_list` 拿到 `role_id`
- `core.invitation_accept` 需要从邀请链接里拿到 `token`,自己造不出来
- 完整参数依赖树见 [`SKILL.md` 效率捷径 > 参数解析](../SKILL.md)

---

> Layer 3 操作参考。本文档与 `src/cli/core.js` dispatch 表保持 1:1 对应。
> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`

CLI 位置:`src/cli/core.js`
调用方式:`node src/cli/core.js <command> '<json>'`

状态:✅ cws-core 已实装(全部 17 个命令都能跑通)。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF 基地址 |
| `COCO_AUTH_TOKEN` | (空) | Bearer token |
| `COCO_API_PREFIX` | `/api/v1` | 路径前缀 |

## 命令清单

### 身份

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `core.me` | 当前 user / agent 的 identity + member + org + role 概览 | `{}` | `GET /api/v1/me` |
| ✅ | `core.self_rename` | 改自己的 display_name（cws-core 身份 + 本地各 org `self.name` 同步） | `{name}` | `PATCH /api/v1/me` |

返回字段含 `member_id` / `org_id` / `role`,后续所有命令都依赖这几个 ID。

`core.self_rename` 说明:
- 走自助端点 `PATCH /api/v1/me`(改的是 identity 级 display_name,对该 identity 加入的所有 org 生效)。**不要**用 admin 才能调的 `PATCH /api/v1/members/{id}`——普通 agent 是 `org-member`,调那个会 403。
- 成功后把新名字写回本地 config 每个 enabled org 的 `self.name`,保持运行时与 cws-core 一致。
- 输出只含新名字 + 同步到的 org slug,不打印任何 token / api_key。
- 示例:`node src/cli/core.js core.self_rename '{"name":"新名字"}'`

### 成员

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `core.member_list` | 列当前 org 的所有成员(可按 kind / status / 名字过滤) | `{kind?, status?, search?, page?, pageSize?, orderBy?}` | `GET /api/v1/members` |
| ✅ | `core.member_get` | 取单个成员详情(含 online_status / role 等) | `{memberId}` | `GET /api/v1/members/{id}` |
| ✅ | `core.project_members` | 列某个项目的成员(派任务前找候选) | `{projectId}` | `GET /api/v1/projects/{id}/members` |

- `kind` 取值:`human` / `agent` / `all`(legacy alias `type`)
- `search` 模糊匹配名字 / email(legacy alias `q`)
- 分页参数走 cws-core 的 `PageParams`:`page` + `page_size`(CLI 同时接受 `pageSize` 或 legacy `limit`)

### 项目

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `core.project_list` | 列当前 org 的项目目录(分页) | `{status?, page?, pageSize?, orderBy?}` | `GET /api/v1/projects` |

项目的 CRUD / archive / members 等写操作走 `tm.js`(同一资源,workflow 视角)。

### 组织

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `core.org_list` | 列我加入的所有 org | `{orderBy?}` | `GET /api/v1/organizations` |
| ✅ | `core.org_get` | 取单个 org 详情 | `{orgId}` | `GET /api/v1/organizations/{id}` |
| ✅ | `core.org_create` | 创建新 org,调用方自动成为 owner;响应里附带新 org scope 的 access_token | `{name, slug, displayName}` | `POST /api/v1/organizations` |
| ✅ | `core.org_switch` | 切到指定 org;返回的新 access_token scope 到目标 org 的 member_id | `{orgId}` | `POST /api/v1/organizations/{id}/switch` — body 必填 `{}`(空对象),schema closed |

### 角色

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `core.role_list` | 列可用角色(发邀请前拿 role_id 用) | `{scope?}` | `GET /api/v1/roles` |

`scope` 取值:`org` / `project` / 不传(全部)。

### 邀请

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `core.invitation_create` | 发邀请到指定 email,带可选 message;org_id 服务端从 JWT 推导 | `{roleId, email?, message?}` | `POST /api/v1/invitations` |
| ✅ | `core.invitation_list` | 列本 org 的邀请(可按 status 过滤 pending/accepted/revoked/expired) | `{status?, page?, pageSize?, orderBy?}` | `GET /api/v1/invitations` |
| ✅ | `core.invitation_accept` | 接受邀请加入新 org,响应里附带新 org scope 的 access_token | `{invitationId, token, displayName}` | `POST /api/v1/invitations/{id}/accept` — `token` 和 `displayName` 都必填(后者 = 接受方在新 org 里的显示名);CLI 同时接受 `display_name` 形式 |
| ✅ | `core.invitation_revoke` | 撤销待处理的邀请 | `{invitationId}` | `DELETE /api/v1/invitations/{id}` |

### 平台 Agent(机器人成员的生命周期)

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `core.platform_agent_create` | 在当前 org 注册一个 agent member(机器人),返回 member_id | `{displayName, description?, metadata?}` | `POST /api/v1/platform-agents` |
| ✅ | `core.platform_agent_delete` | 注销 agent member(同 DELETE /members,标 departed) | `{memberId}` | `DELETE /api/v1/platform-agents/{member_id}` |

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

> 历史踩坑:CLI 早先对 `member_list` / `project_list` / `invitation_list` 发的是 `cursor` + `limit`,服务端不识别,默默忽略并永远返回第一页 default 20 条。修复后三个命令同时接受 `pageSize`(canonical)/ `limit`(legacy alias)。

## 与 SKILL.md 的关系

本文档是 [`SKILL.md`](../SKILL.md) 的 Layer 3 子 skill,只负责 Core CLI 的**命令机制**。下面这些行为面内容**在 SKILL.md 里**,本文档不重复:

| 想看 | 去 SKILL.md 的哪节 |
|---|---|
| 何时该自动锚定身份 / 何时该问人类 | [效率捷径 > 上下文锚定](../SKILL.md) |
| `core.me` / `core.member_list` 在依赖树里的位置 | [效率捷径 > 参数解析](../SKILL.md) |
| 何时持久化 `agentId` / `orgId` 到记忆 | [记忆触发点](../SKILL.md) |
| 通用错误防护 | [行为护栏 > 常见错误](../SKILL.md) |

## Core 专属注意事项

- `org_id` 在所有命令里都不由客户端传——服务端从 JWT 里推导。CLI 不接受 `orgId` 字段(除了 `org_get` 这种显式查别的 org 的命令)。要换 org scope 走 `core.org_switch`。
- `invitation_create` 的 `org_id` 同理,即使 doc 里没写也不要尝试塞进 body,塞了会被 schema 拒。
- `org_create` 和 `org_switch` 的响应里都会附带一个新的 `access_token`,后续调用必须用这个新 token,旧 token 还是旧 scope。
- 注销 agent 走 `platform_agent_delete` 跟 `DELETE /members/{id}` 效果一样,但 platform_agent_delete 含针对机器人成员的额外清理(token 吊销等)。
- `core.role_list` 现在不分页;role 一般 4-8 条,数量超过 100 的可能性极低,所以没在 cws-core 加 PageParams。
