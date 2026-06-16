# TM 操作指南

**作用**:管理 Task Management 服务的工作流——`Project → Issue → Task → Attempt` 四层资源,加 Blueprint(heavy 模式的编排骨架)。所有命令通过 cws-core BFF 落到 cws-work。

**何时加载本文档**:

- 收到人类的"新需求 / 帮我做这个"时,加载查 `issue.create` 入参,决定 `light`(单 Agent/无 Blueprint)还是 `heavy`(Blueprint 编排流),再由 Lead 判断是否需要审批
- 需要派 task 给别人或自己接活时,查 `task.create` / `task.claim` → `task.start`(接活两步:claim 分配、start 开工)
- 需要提前停掉一个还没结论的 issue 时,查 `issue.terminate`(终止 + 善后)
- 工作做完准备收尾时,查 `attempt.transition` → `task.transition` → `issue.deliver` → `accept_delivered` / `reject_delivered` 的顺序
- Lead 编排 heavy issue 的步骤时,查整套 `blueprint.*`
- Worker 失败 / 阻塞要汇报时,查 `attempt.transition` 的 `failed` / `blocked` 选项

**不在本文档范围**:

- 知识库操作(KB page / folder / file)→ `references/kb-operations.md`
- 文件 / artifact 上传 → `references/as-operations.md`
- IM 消息 / 对话管理 → `references/comm-operations.md`
- 成员 / 角色 / 组织目录查询 → `references/core-operations.md`

**依赖前置**:

- 调用前先 `core.me` 确认当前 `member_id` 跟意图中的身份匹配
- 创建 issue 前通常先 `project.list` 拿目标 projectId
- 给 task 配 `contextPageIds` 时,KB page id 先用 `kb.search` 拉到
- Worker 调 `task.list?claimable=true` 找活之前,确保自己的 `skillTags` 已经登记到 member 资料

> 完整的参数依赖树(`core.me → project.list → issue.create → task.create → ...`)见 [`SKILL.md` 效率捷径 > 参数解析](../SKILL.md)。本文档不重复,只补 TM 命令级细节。

---

> Layer 3 操作参考。本文档与 `src/cli/tm.js` dispatch 表保持 1:1 对应。
> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`

CLI 位置:`src/cli/tm.js`
调用方式:`node src/cli/tm.js <command> '<json>'`
帮助:`node src/cli/tm.js help`

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF 基地址 |
| `COCO_AUTH_TOKEN` | (空) | Bearer token,认证端点必填 |
| `COCO_API_PREFIX` | `/api/v1` | 路径前缀;非默认场景才需要覆盖 |

## 当前覆盖度速览

全部 43 个命令均已对齐 cws-core BFF,可直接调用。

| 域 | 命令数 | 状态 |
| --- | --- | --- |
| Project | 8 | ✅ 全部可用 |
| Issue | 15 | ✅ 全部可用 |
| Task | 8 | ✅ 全部可用 |
| Blueprint | 5 | ✅ 全部可用 |
| Attempt | 4 | ✅ 全部可用 |
| Event Binding | 3 | ✅ 全部可用 |

## 错误处理

CLI 失败时往 stderr 输出 `{"error":"...","status":<httpStatus>}`,exit code 1。常见错误:

| HTTP | 含义 | Agent 应对 |
| --- | --- | --- |
| 400 | 入参不合法 | 检查参数后重试 |
| 404 | 资源不存在或无读权限 | 改用搜索 / 询问 Lead |
| 409 | 状态冲突 / 已存在 | 重读最新状态后再决定 |
| 504 | 后端超时 | 退避后重试 |

## 命令清单

### Project (8 条)

| 状态 | 命令 | 说明 | 入参 | 端点 |
| --- | --- | --- | --- | --- |
| ✅ | `project.list` | 列项目目录(分页) | `{status?, page?, pageSize?, orderBy?}` | `GET /projects` |
| ✅ | `project.create` | 新建项目,需指定 leadMemberId | `{name, slug, leadMemberId, description?, descriptionFormat?, isDefault?}` | `POST /projects` |
| ✅ | `project.get` | 取单个项目详情 | `{id}` | `GET /projects/{id}` |
| ✅ | `project.update` | 改项目名 / 描述 / lead | `{id, name?, description?, descriptionFormat?, leadMemberId?}` | `PATCH /projects/{id}` |
| ✅ | `project.archive` | 归档项目(前端"删除"映射到这条,不做硬删) | `{id}` | `POST /projects/{id}/archive` |
| ✅ | `project.restore` | 把归档项目恢复 active | `{id}` | `POST /projects/{id}/restore` |
| ✅ | `project.unarchive` | `restore` 别名,行为完全一致 | `{id}` | `POST /projects/{id}/restore` |
| ✅ | `project.members` | 列项目成员(从 cws-work 拉) | `{id, page?, pageSize?, orderBy?}` | `GET /projects/{id}/members` |

### Issue (15 条)

写路径使用 flat path `/issues/{id}`,不使用 `/projects/{pid}/issues/{id}`。每个状态变更是一个带不变量校验和副作用的语义化动作;通用 `POST /issues/{id}/transition` 已被删除,`issue.transition` 仅作旧脚本兼容 shim。

| 状态 | 命令 | 说明 | 入参 | 端点 |
| --- | --- | --- | --- | --- |
| ✅ | `issue.list_in_project` | 列项目内的 issue(可按状态 / 优先级过滤) | `{projectId, status?, priority?, page?, pageSize?, orderBy?}` | `GET /projects/{pid}/issues` |
| ✅ | `issue.get` | 取单个 issue 详情 | `{id}` | `GET /issues/{id}` |
| ✅ | `issue.create` | 起 issue;`mode=light` 表示无 Blueprint,`mode=heavy` 表示 Blueprint 编排;`disposition=backlog` 可先记录不执行 | `{projectId, title, mode, priority, leadAgentId, description?, descriptionFormat?, disposition?, dueDate?, contextPageIds?, inputArtifactIds?, originConversationId?, originMessageId?}` | `POST /projects/{pid}/issues` |
| ✅ | `issue.update` | 改 issue 元数据(不动状态) | `{id, title?, description?, descriptionFormat?, priority?, dueDate?}` | `PATCH /issues/{id}` |
| ✅ | `issue.activate` | backlog → pending_start;按 source 决定是否唤醒 Lead | `{id, source?}` | `POST /issues/{id}/activate` |
| ✅ | `issue.start_execution` | Lead 判断无需审批/已具备条件后直接开工(pending_start/draft → executing) | `{id}` | `POST /issues/{id}/start-execution` |
| ✅ | `issue.deliver` | executing → delivered | `{id}` | `POST /issues/{id}/deliver` |
| ✅ | `issue.reopen` | rejected → pending_start,进入返工接手 | `{id}` | `POST /issues/{id}/reopen` |
| ✅ | `issue.archive` | 归档 issue(**仅终态 accepted / terminated 可归档**;级联归档其 Task) | `{id}` | `POST /issues/{id}/archive` |
| ✅ | `issue.accept_delivered` | delivered → accepted | `{id, source?}` | `POST /issues/{id}/accept-delivered` — `source` 取 `im` / `explicit`(默认 `explicit`) |
| ✅ | `issue.reject_delivered` | delivered → rejected | `{id, source?, rejectionReason?}` | `POST /issues/{id}/reject-delivered` |
| ✅ | `issue.transition` | 旧脚本兼容 shim;新调用优先用上面的语义命令 | `{id, targetStatus (or 'status'), rejectionReason?}` | 映射到语义端点 |
| ✅ | `issue.move_project` | 把 issue 整体迁到另一个项目 | `{id, newProjectId (or 'targetProjectId')}` | `POST /issues/{id}/move` |
| ✅ | `issue.set_acceptance` | 兼容 wrapper;新调用优先用 `accept_delivered` / `reject_delivered` | `{id, accepted, source?, rejectionReason?}` | `POST /issues/{id}/acceptance` — `source` 取 `im` / `explicit`(默认 `explicit`) |
| ✅ | `issue.terminate` | 提前终止未结论 issue → terminated;服务端级联取消非终态 Task + 发 `issue.terminated` 事件给 Lead 善后(不回滚已发生副作用) | `{id, reason?, source?}` | `POST /issues/{id}/terminate` — `source` 默认 `lead_chat` |

`mode` 取值:`light`(单 Agent/无 Blueprint)/ `heavy`(Blueprint 编排流)。是否需要审批不是 mode 的副作用,由 Lead/策略按风险、预算、权限等因素显式选择。`disposition` 取值:`start`(默认) / `backlog`。

### Task (8 条)

`task.create` 使用双重嵌套路径 `/projects/{pid}/issues/{iid}/tasks`;其余使用 flat path `/tasks/{id}`。

| 状态 | 命令 | 说明 | 入参 | 端点 |
| --- | --- | --- | --- | --- |
| ✅ | `task.list` | 列任务(可过滤 claimable + skillTags 找待领取的活) | `{projectId?, issueId?, status?, claimable?, agentSkills?, page?, pageSize?, orderBy?}` | `GET /tasks` |
| ✅ | `task.get` | 取单个 task 详情(返回里有 `context_page_ids`,Worker 接活后逐个 kb.page_content 读) | `{id}` | `GET /tasks/{id}` |
| ✅ | `task.create` | 派 task;带 `assigneeId` 直接进 assigned(已分配,待 start),不带则 pending 等人 claim | `{projectId, issueId, title, description?, descriptionFormat?, assigneeId?, skillTags?, blueprintStepId?, dependsOn?, contextPageIds?}` | `POST /projects/{pid}/issues/{iid}/tasks` |
| ✅ | `task.claim` | 自己接 task,**只分配**(pending → assigned);不再自动建 attempt,接完要 `task.start` | `{id}` | `POST /tasks/{id}/claim` |
| ✅ | `task.start` | 开工(assigned → running)并开 attempt;依赖闸(dependsOn 全 done)在此校验 | `{id}` | `POST /tasks/{id}/start` |
| ✅ | `task.transition` | 推 task 终态(done / failed / cancelled);所有 attempt 必须先到终态 | `{id, targetStatus (or 'status')}` | `POST /tasks/{id}/transition` |
| ✅ | `task.status` | `task.transition` 别名 | `{id, targetStatus (or 'status')}` | `POST /tasks/{id}/transition` |
| ✅ | `task.reassign` | 把已 claim 的 task 重派给别的 member(Lead 专属) | `{id, newAssigneeId (or 'assigneeId')}` | `POST /tasks/{id}/reassign` |

`task.claim` / `task.start` 均无 body,principal 从 auth header 推断。v0.7 起 claim 与 start 分离:**claim 只把 task 分给自己(assigned),start 才真正开工并建 Attempt**。Worker 接活的标准两步是 `task.claim` → `task.start`。

### Blueprint (5 条)

`blueprint.create` 和 `blueprint.list` 使用 issue 嵌套路径;`blueprint.set_steps` 是全量替换语义(PUT),不是追加。

| 状态 | 命令 | 说明 | 入参 | 端点 |
| --- | --- | --- | --- | --- |
| ✅ | `blueprint.create` | 起 blueprint 草稿,steps 一次性给齐(后续可 set_steps 改) | `{issueId, steps[], estimatedBudget?, notes?}` | `POST /issues/{iid}/blueprints` — 服务端从 auth principal 推导 author;CLI 接受 `authorAgentId` 形参但**不发到 body**(向后兼容老调用方) |
| ✅ | `blueprint.get` | 取 blueprint(含/不含 steps) | `{id, includeSteps?}` | `GET /blueprints/{id}` |
| ✅ | `blueprint.list` | 列 issue 下的 blueprint 版本(看修订历史) | `{issueId, page?, pageSize?, orderBy?}` | `GET /issues/{iid}/blueprints` |
| ✅ | `blueprint.set_steps` | 整批替换 steps(全量,不是 append) | `{blueprintId (or 'id'), steps[]}` | `PUT /blueprints/{id}/steps` |
| ✅ | `blueprint.submit_for_approval` | heavy 模式提审蓝图;提交后 issue 走 `draft → pending_approval` 等审批 | `{id (or 'blueprintId')}` | `POST /blueprints/{id}/submit-for-approval` |

### Attempt (4 条)

| 状态 | 命令 | 说明 | 入参 | 端点 |
| --- | --- | --- | --- | --- |
| ✅ | `attempt.create` | 手动开新一轮(几乎用不到,`task.claim` 已经自带建 attempt) | `{taskId}` | `POST /tasks/{taskId}/attempts` |
| ✅ | `attempt.get` | 取 attempt 详情(看 status / startedAt / failureReason) | `{id}` | `GET /attempts/{id}` |
| ✅ | `attempt.list` | 列 task 的所有 attempt(看历次重试 / 失败原因) | `{taskId, page?, pageSize?, orderBy?}` | `GET /tasks/{taskId}/attempts` |
| ✅ | `attempt.transition` | 推 attempt 状态(done / failed / blocked / cancelled);Worker 用这条标记自己的执行结果 | `{id, targetStatus (or 'status'), failureReason?, blockedOnApprovalRequestIds?}` | `POST /attempts/{id}/transition` |

`attempt.create` 通常不需要直接调用——`task.claim` 会自动创建 Attempt。仅在需要手动开启新一轮尝试时使用。

### Event Binding (3 条)

定时任务 = `EventBinding(sourceKind=timer)`：到点由平台创建 Issue 并派给 lead（你），你只是"接到一份新 Issue"，不感知自己被 cron 调起。

| 状态 | 命令 | 说明 | 入参 | 端点 |
| --- | --- | --- | --- | --- |
| ✅ | `event-binding.create` | 创建定时任务（create-by-agent 主路径） | `{cronExpr, leadMemberId, ownerMemberId, projectId, title, description?, mode?}` | `POST /event-bindings` |
| ✅ | `event-binding.list` | 列本 org 的定时任务 | `{}` | `GET /event-bindings` |
| ✅ | `event-binding.get` | 取定时任务详情（看 nextTriggerAt） | `{id}` | `GET /event-bindings/{id}` |

create-by-agent 护栏（cws-work 强制，违反直接报错）：

- `leadMemberId` 必须 = **你自己的 member id**（agent 只能把自己设为 lead）
- `ownerMemberId` 必须 = **对话中那个人类的 member id**，且不能是你自己（owner 是治理责任人=人类）
- `cronExpr` 5 段（分 时 日 月 周）；`mode` 缺省 `light`

## 典型使用场景

### 1. Lead 接 light 模式 Issue 且自做

```bash
# 0) 上下文组装:搜 KB 找参考材料,收集 page ID
node src/cli/kb.js kb.search '{"query":"竞品定价","folderId":"tn-projects-growth"}'
# -> 命中 pg-pricing-ref-001, pg-market-overview-002

# 1) 创建 light Issue(进入 pending_start),带 contextPageIds
node src/cli/tm.js issue.create '{
  "projectId":"proj-1","mode":"light",
  "title":"Notion 竞品定价分析","description":"对比 5 个直接竞品的定价层级",
  "priority":"medium","leadAgentId":"agent-self",
  "contextPageIds":["pg-pricing-ref-001","pg-market-overview-002"],
  "originConversationId":"conv-1","originMessageId":"msg-42"
}'

# 1.5) Lead 接手后判断无需审批,启动执行
node src/cli/tm.js issue.start_execution '{"id":"iss-1"}'

# 2) 创建 Task 并认领(自做时 contextPageIds 可省略,自己已读过)
node src/cli/tm.js task.create '{
  "projectId":"proj-1","issueId":"iss-1","title":"Implement","assigneeId":"agent-self"
}'
node src/cli/tm.js task.claim '{"id":"task-1"}'

# 3) 工作完成,流转 Attempt → Task → Issue → 交付
node src/cli/tm.js attempt.transition '{"id":"att-1","targetStatus":"done"}'
node src/cli/tm.js task.transition    '{"id":"task-1","targetStatus":"done"}'
node src/cli/tm.js issue.deliver      '{"id":"iss-1"}'

# 4) 人类验收
node src/cli/tm.js issue.accept_delivered '{"id":"iss-1","source":"im"}'
```

### 2. Lead heavy 模式 Blueprint 编排

```bash
# 1) 创建 heavy Issue
node src/cli/tm.js issue.create '{
  "projectId":"proj-1","mode":"heavy","priority":"high",
  "title":"季度产品规划","leadAgentId":"agent-self"
}'

# 2) 起 Blueprint 草稿(含 Steps,一次提交)
node src/cli/tm.js blueprint.create '{
  "issueId":"iss-2",
  "steps":[
    {"temp_id":"s1","description":"Step 1: 调研用户痛点"},
    {"temp_id":"s2","description":"Step 2: 写需求文档","depends_on_temp_ids":["s1"]}
  ]
}'

# 3) 需要修改 Steps 时,整体替换
node src/cli/tm.js blueprint.set_steps '{
  "blueprintId":"bp-1",
  "steps":[
    {"temp_id":"s1","description":"Step 1: 调研用户痛点(含问卷)"},
    {"temp_id":"s2","description":"Step 2: 写需求文档","depends_on_temp_ids":["s1"]},
    {"temp_id":"s3","description":"Step 3: 技术可行性评估","depends_on_temp_ids":["s2"]}
  ]
}'

# 4) Lead 判断需要审批时,提审 Blueprint;无需审批时直接 start_execution
node src/cli/tm.js blueprint.submit_for_approval '{"id":"bp-1"}'
# node src/cli/tm.js issue.start_execution '{"id":"iss-2"}'

# 5) 审批通过或 start_execution 后,按 Step 派 Worker(传 contextPageIds 子集)
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
# 标记 Attempt 失败(含原因)
node src/cli/tm.js attempt.transition '{
  "id":"att-3","targetStatus":"failed","failureReason":"missing_credentials"
}'

# 需要审批时,标记 blocked
node src/cli/tm.js attempt.transition '{
  "id":"att-3","targetStatus":"blocked",
  "blockedOnApprovalRequestIds":["apr-1"]
}'
```

### 5. create-by-agent:帮人类创建定时任务

人类在 DM 里说"帮我建一个定时任务"时，你（被选定的 lead agent）负责把它问清楚再建——你最清楚到点跑这个任务需要什么上下文。

```bash
# 0) 交互式问清楚（不要凭空猜，缺上下文是定时任务最大的坑）：
#    - 多久跑一次 → 转成 5 段 cron（说清时区假设）
#    - 归属哪个 project
#    - 到点要做什么 → title / description，尽量把上下文问全
#    - 轻/重模式（默认 light）
# 1) 复述确认后创建：leadMemberId=自己，ownerMemberId=对话的人类
node src/cli/tm.js event-binding.create '{
  "cronExpr":"0 9 * * 1",
  "leadMemberId":"<你自己的 member id>",
  "ownerMemberId":"<对话人类的 member id>",
  "projectId":"prj-1",
  "title":"每周清理过期工件",
  "description":"清理 7 天前的临时工件，输出清理报告",
  "mode":"light"
}'
# 2) 回报结果（binding id + nextTriggerAt）
```

要点：

- **owner=人类、lead=自己**是硬约束，填错直接被拒（见上方护栏）
- **上下文不足不在创建期拦**：如果人类坚持信息不全也要建，照建；将来到点跑发现缺东西，把"缺 XX"作为产出投递回该会话，人类再改 binding
- 这是 v0.7 的主路径（agent 直接调 API）；后续版本会改成"返回可交互卡片、人类点按钮以人类身份创建"

## 与 SKILL.md 的关系

本文档是 [`SKILL.md`](../SKILL.md) 的 Layer 3 子 skill,只负责 TM CLI 的**命令机制**(入参 / 端点 / 顺序 / 典型流程)。下面这些行为面内容**在 SKILL.md 里**,本文档不重复:

| 想看 | 去 SKILL.md 的哪节 |
|---|---|
| Lead 与 Worker 的能力边界对照表 | [角色模型](../SKILL.md) |
| Worker 自己流转 task / attempt 的契约 | [角色模型 > Worker 状态流转的明确边界](../SKILL.md) |
| Issue / Task / Attempt 状态机完整图 | [状态机](../SKILL.md) |
| 通用的"常见错误"清单(15 条) | [行为护栏 > 常见错误](../SKILL.md) |
| 参数依赖树 / 上下文锚定 / contextPageIds | [效率捷径](../SKILL.md) |
| 记忆持久化的时机 | [记忆触发点](../SKILL.md) |

也就是说:**SKILL.md 讲行为,本文档讲机制**,两份配套使用。

## TM 专属注意事项

下面几条是 SKILL.md "常见错误"没单独覆盖的 TM 命令级细节:

- **不要**把 IM 消息原文整段复制进 task description / 评论 —— 通过会话锚定 + `contextPageIds` 引用就够了
- **不要**直接调 `attempt.create` 来代替 `task.claim` —— `claim` 已内置建 attempt,手动 create 会撞冲突
- **不要**忘记 `task.reassign` 后老 attempt 已自动 cancelled —— 新 assignee 走的是新 attempt,旧 attempt 不要再操作
- **description 必须使用 Markdown 格式**：Project / Issue / Task 的 description 字段均支持 Markdown。CLI 默认传 `description_format: "markdown"`,前端按此渲染富文本。写 description 时使用标题(`##`)、列表(`-`)、加粗(`**`)、代码块(`` ``` ``)、链接(`[text](url)`)等标准 Markdown 语法。示例：
  ```json
  {"title":"用户增长分析","description":"## 目标\n\n分析 Q2 用户增长趋势。\n\n## 产出\n\n- 增长漏斗分析报告\n- 关键指标 dashboard\n- 改进建议清单"}
  ```

## 后续版本计划

以下功能在 0.5 中不可用(cws-core 尚未转发),计划在后续版本加入:

- Comment(评论追加 / 列表)
- Link(WorkConversationLink 锚定)
- System(工作区初始化 / 审批决策 / 自动归档)
- TaskBoard(专用看板视图,当前可用 `task.list?claimable=true` 替代)
- Blueprint 细粒度操作(单 Step 增删改、预算/备注设置、修订版创建)
