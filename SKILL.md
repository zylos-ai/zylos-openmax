---
name: coco-agent
version: 1.0.3
description: >-
  COCO Workspace Agent Skill (Guided Autonomy)。效率捷径 + 状态机 +
  行为护栏 + 记忆触发点。首次行为决策时加载。
  Config at ~/zylos/components/coco-workspace/config.json.
  Service: pm2 zylos-coco-workspace.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-coco-workspace
    entry: src/comm-bridge.js
  data_dir: ~/zylos/components/coco-workspace
  hooks:
    post-install: hooks/post-install.js
    post-upgrade: hooks/post-upgrade.js
    configure:    hooks/configure.js
  preserve:
    - config.json
    - logs/
    - runtime/

upgrade:
  repo: gitlab:coco-workspace/zylos-coco-workspace
  branch: main

config:
  required:
    - name: COCO_BFF_URL
      description: cws-core HTTP base URL (e.g. http://cws-core:8080)
  optional:
    - name: COCO_WS_URL
      description: cws-comm WebSocket URL (derived from BFF if omitted)
    - name: COCO_ORG_ID
      description: COCO org UUID this agent should serve (single — matches proto CoCoWorkspaceChannelAuth; multi-org operators re-run prepare per org)
    - name: COCO_IDENTITY_ID
      description: BYO agent identity_id (skip auto-register; requires COCO_API_KEY + COCO_MEMBER_ID too)
    - name: COCO_API_KEY
      description: BYO agent api_key (cwsk_xxx)
      sensitive: true
    - name: COCO_MEMBER_ID
      description: BYO agent's member_id in COCO_ORG_ID (proto self.member_id)
    - name: COCO_ORG_NAME
      description: Display-only org name (proto org_name)
    - name: COCO_OWNER_MEMBER_ID
      description: Human owner's member_id (proto owner.member_id; pre-binds dmPolicy=owner)
    - name: COCO_OWNER_NAME
      description: Display-only owner name (proto owner.name)
    - name: COCO_SELF_NAME
      description: Agent's display name in COCO_ORG_ID (proto self.name)
    - name: COCO_CF_ACCESS_CLIENT_ID
      description: Cloudflare Access service-token client id (for Access-protected envs like cws-int); written to config.cf_access. Omit for direct/unprotected cws-core.
    - name: COCO_CF_ACCESS_CLIENT_SECRET
      description: Cloudflare Access service-token client secret; written to config.cf_access. Never hardcoded in source.
      sensitive: true

dependencies:
  - comm-bridge
---

# Agent Skill

> 设计规范源：`cws-work/docs/skill-design/agent-skill-spec.md`
> 范式：Guided Autonomy — 不规定流程步骤，只提供捷径、护栏和触发点。

## 角色模型

角色由运行时指派关系决定，不是 Agent 固有属性：

| 指派关系 | 角色 |
|---|---|
| `Issue.leadAgentId = self` | Lead（编排者）|
| `Task.assigneeId = self` | Worker（执行者）|
| 两者同时 | Lead 自做 |

同一 Agent 可同时在 Issue A 中当 Lead、Issue B 中当 Worker。

**角色边界按 Issue/Task 范围生效，不是 session 级**：

| 能力 | Lead | Worker |
|---|---|---|
| 与人类直接通信 | 是 | 否（通过 Lead 转达）|
| Issue 操作（创建/流转/关闭）| 是 | 否 |
| Task 创建/派发 | 是 | 否 |
| Task 领取（claim 自己的 task）| 仅监控 | 是 |
| Task 状态流转（own task → done/failed/cancelled）| 仅监控 | **是** |
| Task 重派（reassign 到别的 agent）| 是 | 否 |
| Attempt 状态流转（own attempt → done/failed/cancelled/blocked）| 仅监控 | **是** |
| Blueprint 操作 | 是 | 否 |
| KB 写入 | 经验沉淀 | 任务产出（Lead 指定位置）|

Worker 的"不创建 Issue""不与人类通信"仅在该 Worker 角色上下文中生效。同一 Agent 在 Lead 角色中正常行使 Lead 权限。

**Worker 状态流转的明确边界**（避免保守过头拒绝合法操作）：

- 自己 attempt 走完、失败、被 Lead 通知取消 → Worker **自己**调 `attempt.transition` 到 done/failed/cancelled
- 自己 task 所有 attempt 在终态后（或被 Lead 通知 cancel）→ Worker **自己**调 `task.transition` 到 done/failed/cancelled
- 不需要等 Lead 来推流转，也不需要先确认"这是不是 Lead 权限"
- Lead 只在跨 task / 重派 / 接收 Worker 失败汇报后做 task 终态决策时介入

Worker **不该**做的:`issue.transition`（issue 状态机是 Lead 专属）、`issue.set_acceptance`、`task.reassign`、`task.create`。

## 任务分类与执行流程

**触发（每条消息都要做）**：凡是通过 coco-workspace 组件收到的用户消息，先判断它**是不是一个"任务"（工作目标）**，而不是简单问答 / 闲聊。

- **不是任务**（简单问答、闲聊、查询）→ 直接回答，不走下面的流程。
- **是任务** → **自行判断它是简单任务还是复杂任务**，然后**严格按对应流程**与用户交互推进，不要跳步。
- 选择 agent 时，依据各 agent 的**描述**判断其职责是否匹配再指派；**不确定该让哪个 bot 执行时，把候选列给用户、让用户选择**（不要自己随便指派）。
- 任何环节不确定（任务归类、选哪个项目/知识库、指派哪个 agent、是否需要审批等）→ **先咨询用户**，不要擅自决定。

判断简单/复杂的经验：单一产出、一个 agent 就能独立做完（如一份研究/分析报告）→ 简单任务；需要拆成多个有依赖关系的子任务、多个 agent 协作、或需要编排执行计划 → 复杂任务。拿不准就问用户。

### 简单任务流程（单 Agent 独立完成，例：研究报告）
1. **接收用户意图**：解析消息，识别为简单研究/分析类需求
2. **选择项目**：让用户选择归属项目（可用默认 Inbox 项目，但要由用户确认 / 选择，不要默默替他定）
3. **选择知识库**：让用户选择产出沉淀到哪个知识库（可用默认 KB，同样由用户确认 / 选择）
4. **指派单一 Agent**：按 agent 描述匹配职责后指派；**不确定该让哪个 bot 执行时，把候选 agent 列给用户、由用户选择**（无匹配专长或用户未指定 → COCO Agent 自己做）
5. **Agent 执行**：该 Agent 独立完成全部工作 → 产出结果
6. **产物归档 & 知识沉淀**：产出 → ArtifactStore；报告沉淀到所选知识库（`/projects/.../research/`）
7. **验收 & 状态收敛**：Task → pending_acceptance → 用户验收 → 关闭

### 复杂任务流程（Lead Agent 编排 + 多 Agent 协作，例：开发任务）
1. **接收用户意图**：Lead Agent 解析消息，识别为工作目标（非简单问答）
2. **检查归属 Project**：查 DB 搜索关联 Project → 找到则问用户是否关联 / 未找到则让用户选已有项目或创建新项目 → 用户确认后关联或创建 Project + KB 空间（`/projects/{project-name}/`）
3. **创建 Task + 生成 Blueprint**：Lead Agent 拆解目标 → 生成 Blueprint（执行计划），定义所有 Step 及依赖关系（KB：`/jobs/{id}/blueprints/v1.md`）
4. **Blueprint 审批**：用户确认 → ApprovalRequest(kind: blueprint) → approved；冻结快照写入 KB
5. **实例化 Sub-task**：Blueprint.Step → Task，设置 `dependsOn` 依赖，按技能匹配把 `assigneeId` 分配给合适的 Agent
6. **并行/串行执行**：无依赖子任务并行启动，有依赖的等前置完成后自动触发；Sub-task → Attempt → Agent 执行
7. **产物归档 & 知识沉淀**：Agent 产出 → ArtifactStore；关键文档（报告、方案）沉淀到 KB（`/projects/.../research/`、`/projects/.../deliverables/`）
8. **验收 & 状态收敛**：子任务完成 → Task pending_acceptance → 用户验收 → 关闭 → 看板同步

> 说明：以上两条流程对应 coco-workspace 原型「对话」里的两个演示场景（▶ 复杂开发任务 / ▶ 简单研究报告），是产品定义的标准交互路径。

## 效率捷径

### 上下文锚定

收到消息时，按优先级确定属于哪个工作上下文：

1. **对话历史推断**（零调用）— 上一轮聊的是什么、语义关联、话题切换信号
2. **记忆中的活跃工作列表**（零调用）— 持久化的 Issue/Task 状态
3. **本地目录语义匹配**（零调用）— 从缓存的 Project/Issue name+description 匹配
4. **主动询问人类** — 提供选项让人类选择，不要开放式提问

操作代价越高，锚定置信度要求越高：

- 高（验收、状态流转）→ 不确定就问
- 中（追加指令）→ 中等置信度可先执行，错了可纠正
- 低（查询、闲聊）→ 不需要锚定

### 参数解析

API 调用需要的 ID，按优先级获取：

1. **人类消息上下文** → 人类给出的 projectId、orgId 等，直接使用，不要重复创建
2. **自身行为产物** → 本 session 内 API 返回值（创建 Issue 返回的 issueId 等）
3. **记忆** → 上次已知的 projectId、issueId 等
4. **本地目录** → 从缓存的 Project/Issue name+description 语义匹配
5. **API 查询** → `project.list`、`core.member_list({kind:"agent"})` 等
6. **默认值** → 未指定项目 → Inbox；mode 未指定 → light
7. **询问人类**

参数依赖树（首次必须按此顺序获取，获取后持久化）：

```
core.me → agentId, orgId
  ├→ project.list → projectId
  ├→ core.member_list({kind:"agent"}) → assigneeId（派发 Task 时）
  ├→ issue.create → issueId → task.create → taskId
  └→ kb.tree_roots → KB 目录结构 → pageId
```

### 本地目录

首次需要解析 Project 或 Issue 时，一次性拉取全量：

- `project.list` → 所有项目的 name + description + id
- `issue.list_in_project` → 各项目活跃 Issue 的 name + description + id

缓存到记忆。后续解析从本地目录语义匹配，不再调 API。

- **增量更新**：自己创建 Issue/Project 时追加到本地目录
- **全量刷新**：匹配不上时，或日常维护时

### 上下文传递（contextPageIds）

Lead 组装上下文时读过的 KB 页面，通过 `contextPageIds` 结构化传递给 Issue/Task，Worker 直接按 ID 读取，不需要重新搜索。

**Lead 写入**：

- 上下文组装阶段搜索/阅读 KB 页面时，收集相关 page ID
- `issue.create` 时传入全部相关 page ID
- `task.create` 时筛选该 Task 实际需要的子集传入
- 人类消息中提到的文档、搜索命中的参考材料、项目 overview 等都是候选

**Worker 消费**：

- `task.get` 返回 `context_page_ids` 数组
- 对每个 ID 调 `kb.page_content` 读取内容，作为执行上下文
- 这些是 Lead 精选的参考材料，优先级高于自行搜索

**粒度**：Issue 级放全量参考，Task 级放该 Task 需要的子集。宁可多传不要少传。

## 状态机

### Issue 状态

```
Light 模式: (create) → EXECUTING → DELIVERED → ACCEPTED → ARCHIVED
                                  ↘ REJECTED → REOPENED → EXECUTING（循环）

Heavy 模式: (create) → DRAFT → PENDING_APPROVAL → APPROVED → EXECUTING → ...（同上）
```

| 状态 | 含义 | Lead 可做 |
|---|---|---|
| DRAFT | Heavy 模式刚创建 | 编辑描述、编排 Blueprint、提交审批 |
| PENDING_APPROVAL | 等待审批 | 等待 |
| APPROVED | 审批通过 | → EXECUTING |
| EXECUTING | 执行中 | 创建 Task、监控、交付 |
| DELIVERED | 已交付 | 等待人类反馈 |
| ACCEPTED | 人类验收通过 | 经验沉淀 → ARCHIVED |
| REJECTED | 人类拒收 | → REOPENED（不可直接→EXECUTING）|
| REOPENED | 重新打开 | → EXECUTING |
| ARCHIVED | 终态 | — |

### Task 状态

| 状态 | 含义 | 触发 |
|---|---|---|
| PENDING | 已创建未领取 | CreateTask 无 assigneeId |
| RUNNING | 执行中 | claim / CreateTask 带 assigneeId（自动 claim）|
| DONE | 完成（终态）| Worker |
| FAILED | 失败（终态）| Worker |
| CANCELLED | 取消（终态）| Lead |

### Attempt 状态

| 状态 | 含义 | 后续 |
|---|---|---|
| RUNNING | 执行中 | claim 自动创建 |
| DONE | 完成（终态）| Task → DONE |
| FAILED | 失败（终态，附 failureReason）| Lead 决定是否重试 |
| BLOCKED | 等待审批（终态）| 审批通过 → 新 Attempt 续作 |
| CANCELLED | 取消（终态）| — |

BLOCKED ≠ FAILED：BLOCKED 是主动 suspend 等待审批，审批通过后系统自动新建 Attempt 续作。

### 完成流转顺序

从内到外，逐层流转，禁止跳层：

```
attempt.transition → done
task.transition → done
issue.transition → delivered
```

Task 完成前，其下所有 Attempt 必须在终态。Issue 交付前，其下所有 Task 必须在终态。

## 行为护栏

### 任务生命周期护栏（强制）

以下是每个任务从开工到收尾的**硬性动作**，不是可选建议——靠自觉容易被省略，必须每次执行：

1. **先安排再动手（每次处理都必须先创建 Task）**：每一次处理工作目标，**都必须先在 TM 里建好对应的 Task**（Issue → Task，需要时认领/指派）再开始执行——**没有「小事顺手做、不建 Task」的例外**（纯问答/闲聊除外）。安排即「把要做的事登记成 Task」，让进度可见、可流转、可验收；不要绕过 TM 直接埋头做。
2. **项目/知识库选择必经**：执行「产出 deliverable 的用户任务」（研究 / 分析 / 开发等）前，**必须**让用户确认归属项目 + 产出 KB，不可默默用默认 Inbox/默认 KB。唯一可跳过：用户已明确指定、纯查询/闲聊、或「内部 bug/问题登记」。
3. **状态流转即通知**：issue/task 每次状态变更（executing→delivered、task→done、pending_acceptance 等）的**当下**就通知用户，不要事后补、更不要不说。
4. **完成即通知**：每个任务执行完**必须**主动通知用户结果，不能默默做完、让结论埋进消息流。
5. **按优先级续做**：处理完一个任务后，**主动**按优先级接续处理下一个待办任务，而不是停下干等下一条指令（除非必须等用户输入/验收才能继续）。

> 区分两类动作：「用户任务执行（出 deliverable）」走完整流程（含项目/KB 选择 + 验收 + 通知）；「内部 bug/问题登记」可默认 Inbox、轻量记录，但完成后仍要通知。

### 常见错误

| 错误 | 正确做法 |
|---|---|
| 使用 Claude Code 内置 TaskCreate/TaskUpdate | 所有任务操作走 TM CLI，禁止用平台内置的 task 工具 |
| 跳过 TM 流程直接执行任务 | 每个需求必须先 Issue → Task → Attempt 推进 |
| Worker 调 issue.transition | Issue 状态只由 Lead 流转 |
| 创建 Issue 没有 leadAgentId | Issue 必须有 Lead |
| REJECTED 直接回 EXECUTING | 必须走 REJECTED → REOPENED → EXECUTING |
| Heavy 模式跳过 Blueprint 审批 | 必须 submit_for_approval |
| Worker 自行创建新 Attempt 重试 | 汇报失败，等 Lead 决定 |
| CreateTask 不带 projectId | 必须传 issueId 或 projectId |
| 对 ⏳ 命令反复重试 | 404/501 → 降级到对话流 |
| 人类提供了 Project ID 仍自创 Project | 直接使用人类给出的 ID，不要 project.create 重复创建 |
| 用 curl/fetch 直接调 TM/KB/AS API | 所有服务操作必须走 CLI，禁止直接 HTTP 调用 |
| Task done 但 Attempt 仍在 running | 先 attempt.transition → done，再 task.transition → done |
| 工作做完但 Issue 没有 deliver | 所有 Task done 后必须 issue.transition → delivered |
| 人类拒收后直接修改产出 | 先 issue.transition → reopened → executing，再新建 Task 重做 |
| 描述里写"参考 /projects/X/..."但不传 contextPageIds | 搜到 page 后将 ID 传入 contextPageIds，Worker 直接读取 |

### API 降级

CLI 命令返回 404 或 501（cws-core 网关暂未接通）时：

1. 在 IM 中告知相关方当前操作暂不支持
2. 用对话流完成等价动作（人类口头确认代替 API 调用）
3. 在 IM 消息中保留 Issue/Task ID，便于系统就绪后补录
4. 不反复重试，不阻塞
5. 可用的读操作（project.list 等）仍正常调用

### Lead-Worker 契约

**Lead 对 Worker**：完成时通过 IM 汇报且流转 TM 状态；遇阻主动请求澄清；产出位置符合 Lead 指定。

**Worker 对 Lead**：派发时提供清晰描述；有参考材料时通过 `contextPageIds` 传递，不要只在描述里写路径；澄清请求及时响应；不在执行中途无预警取消 Task。

### 跨 agent 沟通模式（Lead ↔ Worker）

Lead 派任务给另一个 agent 之后，**绝大多数协调都通过 bot-to-bot DM 完成**（不是给人类发 IM）。完整流程：

1. **找 worker 的 member_id**：
   `core.member_list({kind:"agent", search:"<worker 显示名>"})` 拿 `member_id`。
   常用 worker 的 member_id 应该已经在记忆里，记忆里有就别再查。

2. **拿/建会话**：
   `comm.create_dm({participantId: <worker-member-id>})` 返回 `conversationId`。
   - 这条幂等：会话已存在直接返回原 id，没有就建一个新的
   - 同一对 LEAD-WORKER 的 conversationId 应该持久化到记忆，下次直接复用，避免每次重新 create_dm

3. **发协调消息**：
   `comm.send({conversationId, content: "..."})` —— 用 markdown 表达任务细节、退回选项、上下文引用。
   消息内容要**显式**：把命令 ID、退回触发词、判断标准都写清楚（参考 smoke-6 NL 的写法）。

4. **等 worker 回复**：
   不要轮询 `comm.get_messages`。Worker 的回复通过 WS 推到 comm-bridge，会作为新消息出现在你的输入流里。

**何时跳过 bot DM 用 TM action 而非聊**：

- 派任务用 `task.create({assigneeId})` 直接挂在 worker 名下（不是 DM 通知）
- 重派用 `task.reassign({newAssigneeId})`（不是发"接回去吧"那种 NL）
- 状态流转 worker 自己走 attempt/task transition，不需要发 DM 通知 Lead

但**澄清需求、上下文同步、判断分歧**这些"对话"性质的事情，**必须**走 bot DM。

## 记忆触发点

以下时机，持久化关键信息确保 session 切换后可恢复。不指定存储位置，Agent 根据运行时的记忆系统自行决定。

| 时机 | 持久化内容 |
|---|---|
| 首次 `core.me` | agentId、orgId |
| 首次 `project.list` | 项目目录（name + description + id）|
| 创建 Issue | issueId、projectId、title、status |
| 领取 Task | taskId、issueId、title、status |
| 状态流转 | 更新对应 Issue/Task 的 status |
| 拉取 Issue 列表 | 更新本地 Issue 目录 |
| Issue accepted | 评估是否沉淀经验 |

**经验沉淀判断**（任一满足则沉淀，全不满足则跳过）：

- 执行中遇到意外障碍或踩坑
- 人类拒收过一次或多次
- 发现了可复用的模式

沉淀位置遵循 KB 命名空间约定：项目决策 → `/projects/{slug}/decisions/`，调研 → `/projects/{slug}/research/`，Agent 经验 → `/agents/{slug}/lessons/`。

## 访问控制（DM / 群消息）

每个 org 在 `config.json` 的 `orgs.<slug>` 下有**独立**的访问策略，DM 与群消息策略**互不影响**。所有名单值都是 cws-core 的 **`member_id`**（不是显示名）。

```jsonc
// config.json → orgs.<slug>
{
  "owner": { "member_id": "", "name": "" },   // 绑定的人类 owner，member_id 为空 = 未绑定
  "access": {
    "dmPolicy":    "owner",          // "open" | "allowlist" | "owner"
    "dmAllowFrom": [],               // member_id 列表，dmPolicy=allowlist 时生效
    "groupPolicy": "allowlist",      // "open" | "allowlist" | "disabled"
    "groups": {                      // 按 conversation_id 配置，groupPolicy=allowlist 时生效
      "<conversationId>": {
        "mode": "mention",           // "mention"（仅被 @ 时响应）| "smart"（收全部消息自行判断）
        "allowFrom": ["*"]           // ['*'] 或 [] = 群内所有人；否则限定 member_id
      }
    }
  }
}
```

**私聊（dmPolicy）：**
1. 是 owner？→ 永远放行
2. `open`？→ 任何 org 成员都能 DM
3. `owner`？→ 仅绑定的 owner（首次 DM 自动绑定到 `owner.member_id`）
4. `allowlist`？→ 仅 `access.dmAllowFrom` 里的 member_id 放行，其余丢弃

**群消息（groupPolicy）：**
1. `disabled`？→ 所有群消息丢弃
2. `open`？→ 任意群里被 @ 即响应
3. `allowlist`？→ 仅 `access.groups` 里配置的群；未配置的群只有 owner 被 @ 能过，其余静默丢弃
4. 群内 `allowFrom` 非空且非 `['*']`？→ 仅名单内 member_id 放行（owner 豁免）
5. `mode: 'smart'`？→ 收群里全部消息、无需被 @；`mode: 'mention'`（默认）→ 仅处理 @ 机器人的消息

**要点：**
- `dmPolicy` 与 `groupPolicy` 完全独立，改一个不影响另一个
- owner 仅豁免 allowlist / 群名单检查；`groupPolicy: disabled` 连 owner 的群消息也拦
- 名单用 `member_id`，不是显示名；安装期 `COCO_OWNER_MEMBER_ID` 会预绑定 owner 并隐含 `dmPolicy=owner`
- 策略按 org 维度配置（每个 org 有独立的 `access` 块）

## 操作指南索引（Layer 3，按需加载）

**本文件（SKILL.md）是 Layer 1+2**，负责行为护栏 + 角色边界 + 状态机 + 通用错误防护——**任何 CLI 操作之前都要符合这些规则**。`references/*-operations.md` 是 Layer 3，只补"具体命令怎么调"的机制层细节，**不复述**这里的行为面规则。

**加载策略**：本表只给摘要；不确定该开哪份就先扫"负责什么"那一列，再去对应文件查命令清单。

| 模块 | 负责什么 | 典型触发场景 | 文件 |
|---|---|---|---|
| **TM** | Project / Issue / Task / Attempt 四层工作流 + Blueprint 编排骨架 | 收到新需求、派单、attempt→task→issue 状态流转、heavy 蓝图审批 | `references/tm-operations.md` |
| **KB** | KB 实例 + 目录树 + page 内容/版本/trash 三态 + 跨 page 搜索 + 文件附件 | 写笔记沉淀经验、整理目录、搜参考资料、归档文件 | `references/kb-operations.md` |
| **AS** | 文件上传（IM/KB 双模）+ 下载 URL 解析 + 本地下载 | 发会话附件、归档文件到 KB、下载远端 artifact 做 vision/分析 | `references/as-operations.md` |
| **Comm** | Agent **主动发起**的 IM：会话/消息/未读/WS 同步/KB page 搜索 | 主动 DM 同事、拉群、定向搜 page、WS 重连补漏 | `references/comm-operations.md` |
| **Core** | 身份 + 成员/项目/角色/邀请目录查询 + org 切换 + 平台 agent 生命周期 | `core.me` 确认身份、找派单候选、发邀请、切 org | `references/core-operations.md` |

每份 Layer 3 doc 顶部都有自己的 `作用` / `何时加载本文档` / `不在本文档范围` / `依赖前置` 四段摘要，加载到内存后先扫这段确认是不是要的，再往下看命令清单。
