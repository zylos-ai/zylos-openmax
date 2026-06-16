---
name: coco-workspace
version: 1.0.31
description: >-
  COCO Workspace 任务代理 (Guided Autonomy)。凡通过 coco-workspace 收到的用户消息，
  处理任务前必须先加载并遵守本 skill：先判断是任务还是问话/闲聊；是任务则必须走完整流程——
  确认归属项目 + 知识库 → 登记 Issue→Task（谁执行谁建）→ 执行 → 发起人验收通过才算完成/归档，
  不要跳过流程直接开干。含效率捷径 / 状态机 / 行为护栏 / 记忆触发点。
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

Worker **不该**做的:任何 issue 生命周期动作（如 `issue.deliver` / `issue.reopen` / `issue.accept_delivered` / `issue.reject_delivered`；`issue.transition` 仅旧脚本兼容）、`task.reassign`、替别人派单式的 `task.create`。
**例外（谁执行谁建）**：被指派执行某 Issue 时，执行 bot 可在该 Issue 下**为自己的工作** `task.create` 并认领——这是「登记自己要做的任务」，不是替别人派单，不算越权。Lead 派发时只建 Issue、不替执行 bot 建 Task。

## 服务调用铁律（TM / KB / AS / Comm / Core 一律走 CLI）

**所有 Workspace 服务操作——Issue / Task / Attempt / Blueprint、知识库(KB)、文件(AS)、主动 IM(Comm)、成员/项目/组织查询(Core)——必须通过 coco-workspace 的 CLI 调用：`src/cli/{tm,kb,as,comm,core}.js`。严禁手搓 BFF REST（curl / fetch / 直接拼 HTTP 路径）。**

- **不确定命令/参数时**：先跑 `node src/cli/<svc>.js`（无参看命令清单），或查 `references/<svc>-operations.md`——**不要凭 REST 惯例猜路径**（确切端点/字段以 CLI 与 ops 文档为准）。
- 这是**硬性约束、不是建议**：绕过 CLI 直连 BFF = 破窗。

## 任务分类与执行流程

**触发（每条消息都要做）**：凡是通过 coco-workspace 组件收到的用户消息，先判断它**是不是一个"任务"（工作目标）**，而不是简单问答 / 闲聊。

- **不是任务**（简单问答、闲聊、查询）→ 直接回答，不走下面的流程。
- **是任务** → 下面两件事**必须立刻做、不得省略，且不因任务"简单"而豁免**：
  1. **先登记 Issue→Task**：动手前先在 TM 建好 Issue→Task（需要时认领/指派）。这是整套流程被触发的前提——**跳过登记 ＝ 流程根本没启动**，是最常见的破窗。
  2. **强制确认项目 + 知识库**：让用户确认/选择归属项目与产出知识库**之后**再执行，**禁止默默用默认 Inbox/默认 KB 直接开干**。
  做完这两步，再**自行判断简单 / 复杂任务**，**严格按对应流程**推进，不要跳步。
- 选择执行的 bot 时，**不要自己直接拍板指派**：依据各 agent 的**描述**给出推荐（附推荐理由），但**最终必须由发起人确认 / 选择**执行的 bot 再指派；无合适专长时可推荐 COCO 自己做，但同样要经发起人确认。
- 任何环节不确定（任务归类、选哪个项目/知识库、指派哪个 agent、是否需要审批等）→ **先咨询用户**，不要擅自决定。

判断简单/复杂的经验：单一产出、一个 agent 就能独立做完（如一份研究/分析报告）→ 简单任务；需要拆成多个有依赖关系的子任务、多个 agent 协作、或需要编排执行计划 → 复杂任务。拿不准就问用户。**注意：简单任务只是"执行/编排简单"，并不豁免登记 Task 和确认项目/KB——研究 / 分析报告这类最容易被误当成"顺手做"的，恰恰必须走全流程。**

> **复杂任务 = heavy 模式 + Blueprint（强制，不可绕过）。** 一旦判定为复杂任务（多步骤 / 多 agent 协作 / 子任务间有依赖 / 需要编排执行计划），就**必须**用 **heavy 模式**起 Issue，并**先生成 Blueprint（执行计划）**，再由 Lead/策略判断是否需要审批：需要审批 → `blueprint.submit_for_approval`，审批通过后执行；无需审批 → Lead 走 `issue.start_execution` 直接开工。**严禁**用 light 模式把复杂任务直接拆成一堆 Task 就开干、跳过 Blueprint——那等于无计划施工，是复杂任务流程被架空的头号方式。light 模式只允许用于"单产出、单 agent"的简单任务。拿不准是简单还是复杂 → 问用户；只要沾到"多步骤/多 agent/有依赖" → 一律按复杂任务走 Blueprint。

### 简单任务流程（单 Agent 独立完成，例：研究报告）
1. **接收用户意图**：解析消息，识别为简单研究/分析类需求
2. **选择项目（必问，禁止默默决定，且必须在执行前）**：**先问用户**归属哪个项目再继续；可建议默认 Inbox，但必须经用户确认 / 选择，**绝不能跳过此步直接开干**
3. **选择知识库（必问，禁止默默决定，且必须在执行前）**：**先问用户**产出沉淀到哪个知识库；可建议默认 KB，但同样必须经用户确认 / 选择
4. **确认执行 Agent（必问，bot 不自行决定）**：按 agent 描述**给出推荐 + 理由**，把候选列给发起人，**由发起人确认 / 选择**执行的 bot；无匹配专长时可推荐 COCO 自己做，但仍需发起人确认
5. **登记 Issue→Task（谁执行谁建 Task）**：Lead 在**已确认的项目**下创建 **Issue**（light）。**Task 由执行者创建**——自己执行 → 自己 `task.create` 并认领；**派给别的 bot → 先开放 DM 权限（见跨 agent 沟通模式），再由那个 bot 自己在该 Issue 下 `task.create` 认领**，Lead 不替它建。严格顺序：确认项目/KB + 执行者 → 建 Issue →（执行者）建 Task → 执行，不先开干再补
6. **Agent 执行**：该 Agent 独立完成全部工作 → 产出结果
7. **产物归档 & 知识沉淀**：产出 → ArtifactStore；报告沉淀到所选知识库（`/projects/.../research/`）
8. **交付 & 人类验收闭环**：Task 全部 done → `issue.deliver` 到 **delivered**，并**主动通知发起该任务的人类（任务发起人）请其验收**（不是 bot 自己、不是 owner、不是随便哪个用户）；**bot 不自行验收 / 归档**。**发起人验收通过**（IM 说「验收通过」或看板点验收）→ bot 调 `issue.accept_delivered({source:"im"})` → **accepted**，必要时再 `issue.archive` 并沉淀经验；发起人**退回** → `issue.reject_delivered({source:"im", rejectionReason})` → rejected → `issue.reopen` → pending_start，再由 Lead `issue.start_execution` 重做。交付到验收之间，issue 停在 **delivered（待验收）**，别当已完成丢着不管

### 复杂任务流程（Lead Agent 编排 + 多 Agent 协作，例：开发任务）
1. **接收用户意图**：Lead Agent 解析消息，识别为工作目标（非简单问答）
2. **确认项目 + 知识库（必问，编排/执行前）**：查 DB 搜索关联 Project → 找到则问用户是否关联 / 未找到则让用户选已有项目或创建新项目；**同时与用户确认产出沉淀的知识库**。用户确认**项目 + KB 之后**才关联 / 创建 Project + KB 空间（`/projects/{project-name}/`）并进入后续编排——**先确认项目/KB → 再执行，简单 / 复杂任务一致**，不要先开干再补
3. **生成 Blueprint（强制，复杂任务的必经步骤）**：Lead Agent 拆解目标 → **必须**先生成 Blueprint（执行计划），定义所有 Step 及依赖关系（KB：`/jobs/{id}/blueprints/v1.md`）。**复杂任务一定要有 Blueprint——不允许跳过蓝图、直接拆 Task 开干。** 此步在实例化任何 Sub-task 之前完成
4. **Blueprint 审批 / 启动决策**：Lead/策略按风险、预算、权限等判断是否需要审批。需要审批 → 用户确认 → ApprovalRequest(kind: blueprint) → approved；冻结快照写入 KB；审批通过后执行。无需审批 → Lead 走 `issue.start_execution` 启动执行。审批是显式决策，不是 heavy mode 的自动副作用；但 Blueprint 本身是复杂任务从"规划"进入"施工"的硬门禁，不可省略
5. **实例化 Sub-task（Blueprint 通过后一次性建全部 Step）**：Blueprint 审批通过后，**必须一次性把全部 Step 实例化成 Task**——**严禁边做边补 / 做一个建一个**（那会让看板只看到零散的当前步骤，丢掉问题全景）。建 Task 时按 Blueprint 依赖关系设好 `dependsOn`，并**按"是否有未满足依赖"区分是否带 assignee**：
   - **无依赖、可立即开跑的 Step → 创建时带 `assigneeId`**（指定执行 bot）→ 自动分配给该 bot（**assigned，已分配但未开工**）；该执行 bot 随即 `task.start` 才进「进行中」真开跑
   - **有依赖的 Step → 创建时不带 `assigneeId`** → 停在「待办」(pending)；其指定执行 bot 记在 **Blueprint step（规划层）**，**先不写进 `task.assigneeId`**，等真被认领时才落到 task 上
   - 各 Step 的执行 bot 仍**按技能匹配给出推荐、由发起人确认 / 选择**，不自行拍板
6. **依赖驱动的 bot 自认领推进（状态=真实执行，看板全程可见全景）**：**「进行中」必须对应"真有 bot 在执行"**——后端不会、也不应擅自把待办改成进行中（否则状态是假的）。推进由 **bot 驱动**：
   - 无依赖 Step 已在「进行中」；有依赖 Step 在「待办」等待
   - **前置 bot 干完**（attempt→done、task→done）后，**通知下游 bot**（bot-DM，需双向 DM 权限，见跨 agent 沟通模式）「你的前置好了，去接 task X」→ **下游 bot 自己 `task.claim`**（分配给自己，assigned）→ 再 **`task.start`**（**依赖闸在这一步**：校验 `dependsOn`，前置都 done 才放行）→ 进「进行中」→ 执行。**v0.7 起 claim 与 start 分离：claim 只把活分给自己，start 才开工建 attempt、才查依赖**
   - 这样看板从一开工就是完整全景：谁在跑 / 谁在「待办」等 / 卡了什么前置，且 **RUNNING 永远对应真在执行的 bot，不存在空转的「进行中」**
   - **关键看板语义：待办列 = 已规划、已建 Task 但尚未被认领（被依赖挂起）的 Step，不是「还没拆出来的步骤」。** Sub-task → Attempt → Agent 执行
7. **产物归档 & 知识沉淀**：Agent 产出 → ArtifactStore；关键文档（报告、方案）沉淀到 KB（`/projects/.../research/`、`/projects/.../deliverables/`）
8. **交付 & 人类验收闭环**：所有子任务 done → `issue.deliver` 到 **delivered** → **主动请发起任务的人类（任务发起人）验收**（bot 不自行验收；Worker 经 Lead 转达给发起人）→ 发起人验收通过 → `issue.accept_delivered({source:"im"})` → **accepted**，必要时 `issue.archive` 归档 + 看板同步；退回 → `issue.reject_delivered({source:"im", rejectionReason})` → rejected → `issue.reopen` → pending_start → `issue.start_execution` 重做

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
Light 模式: (create) → PENDING_START → EXECUTING → DELIVERED → ACCEPTED → ARCHIVED
                                                  ↘ REJECTED → PENDING_START → EXECUTING（循环）

Heavy 模式: (create) → DRAFT → (PENDING_APPROVAL → 审批通过 或直接 start_execution) → EXECUTING → ...（同上）

可选: disposition=backlog 时 (create) → BACKLOG ──activate──→ PENDING_START → ...（同上）

任意未结论态 ──terminate──→ TERMINATED ──archive──→ ARCHIVED   （提前终止）
```

| 状态 | 含义 | Lead 可做 |
|---|---|---|
| BACKLOG | 已记录但暂不启动 | activate |
| PENDING_START | 已激活 / 待 Lead 接手启动 | start_execution 或走审批 |
| DRAFT | Heavy 模式刚创建 | 编辑描述、编排 Blueprint、提交审批 |
| PENDING_APPROVAL | 等待审批 | 等待 |
| EXECUTING | 执行中 | 创建 Task、监控、交付 |
| DELIVERED | 已交付 | 等待人类反馈 |
| ACCEPTED | 人类验收通过（终态）| 经验沉淀 → ARCHIVED |
| REJECTED | 人类拒收 | issue.reopen → PENDING_START（不可直接→EXECUTING）|
| TERMINATED | 提前终止（终态）| `issue.terminate` 推到此；善后后 → ARCHIVED |
| ARCHIVED | 封存（终态）| **仅 ACCEPTED / TERMINATED 可归档** |

**归档只接受终态**（ACCEPTED 或 TERMINATED）：还在跑或被拒（rejected）的 Issue 不能直接归档，必须先验收通过或 `issue.terminate`。提前终止见行为护栏「提前终止善后」。

### Task 状态

| 状态 | 含义 | 触发 |
|---|---|---|
| PENDING | 已创建未领取 | CreateTask 无 assigneeId |
| ASSIGNED | 已分配未开工 | `task.claim` / CreateTask 带 assigneeId（**只分配，不开工、不建 attempt**）|
| RUNNING | 执行中 | `task.start`（assigned → running，开 attempt，查 dependsOn）|
| DONE | 完成（终态）| Worker |
| FAILED | 失败（终态）| Worker |
| CANCELLED | 取消（终态）| Lead；Issue 被提前终止时其下非终态 Task 也级联 cancelled |

接活两步：`task.claim`（分到自己，assigned）→ `task.start`（开工，running）。**依赖闸在 start，不在 claim。**

### Attempt 状态

| 状态 | 含义 | 后续 |
|---|---|---|
| RUNNING | 执行中 | `task.start` 时创建 |
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
issue.deliver → delivered
```

Task 完成前，其下所有 Attempt 必须在终态。Issue 交付前，其下所有 Task 必须在终态。

## 行为护栏

### 任务生命周期护栏（强制）

以下是每个任务从开工到收尾的**硬性动作**，不是可选建议——靠自觉容易被省略，必须每次执行：

1. **先安排再动手（每次处理都必须先创建 Task）**：每一次处理工作目标，**都必须先在 TM 里建好对应的 Task**（Issue → Task，需要时认领/指派）再开始执行——**没有「小事顺手做、不建 Task」的例外**（纯问答/闲聊除外）。安排即「把要做的事登记成 Task」，让进度可见、可流转、可验收；不要绕过 TM 直接埋头做。**这是「任务流程未被触发」的头号根因：收到任务直接开干、跳过 Issue→Task 登记——务必先登记再动手。**
2. **项目/知识库选择必经（简单任务同样适用）**：执行任何「产出 deliverable 的用户任务」（研究 / 分析 / 开发等，**无论简单还是复杂**）前，**必须**让用户确认归属项目 + 产出 KB，不可默默用默认 Inbox/默认 KB。**不要因为任务"简单 / 一个 agent 就能做完"而跳过——简单研究 / 分析报告同样必须先问项目和 KB。** 唯一可跳过：用户已明确指定、纯查询/闲聊、或「内部 bug/问题登记」。**同理，执行任务的 bot 也必须经发起人确认**（可基于 agent 描述给推荐 + 理由），**不可自行拍板指派**。
3. **状态流转即通知**：issue/task 每次状态变更（pending_start→executing、executing→delivered、task→done、delivered→accepted/archived 等）的**当下**就通知用户，不要事后补、更不要不说。
4. **完成即通知**：每个任务执行完**必须**主动通知用户结果，不能默默做完、让结论埋进消息流。
5. **按优先级续做**：处理完一个任务后，**主动**按优先级接续处理下一个待办任务，而不是停下干等下一条指令（除非必须等用户输入/验收才能继续）。
6. **人类验收闭环（交付后不自行收尾）**：出 deliverable 的任务，bot 交付（`issue.deliver`→delivered）后**必须主动请发起该任务的人类验收，且不得自行验收 / 自行归档**。验收人＝**任务发起人**（按 issue 来源会话 / `originConversationId` 识别），**不是 bot 自己、不是 owner、也不是随便哪个用户**；Worker 没有直接与人沟通权时，经 Lead 转达给发起人。先后顺序：完成内层流转（attempt→done、task→done）→ `issue.deliver` → 请发起人验收。**发起人验收通过**才由 bot 调 `issue.accept_delivered({source:"im"})` 收敛到 **accepted**，必要时再 `issue.archive` 归档；**退回**则 `issue.reject_delivered({source:"im", rejectionReason})` → `issue.reopen` → pending_start → `issue.start_execution` 重做。交付到验收之间停在 **delivered（待验收）**，别堆在「已完成」不管。**区分**：worker 把自己的 attempt/task 流转到 done 只代表「执行动作做完」；**Issue 真正进入「完成」(accepted) 和归档(archived)，都必须人类验收通过**——bot 绝不自行把任务推进到 accepted/archived。「任务做完 ≠ 结束，发起人验收通过才算完成、才能归档」。
7. **跨 agent 派发：双向 DM 权限确认（强制）+ 谁执行谁建 Task**：把任务交给别的 bot 前，**两个方向的 DM 权限都必须确认开通，缺一不可**：
   - **方向①（worker→你）**：把该 bot 的 member_id 加进**自己的** `dmAllowFrom`（`config.json` → `orgs.<slug>.access`，必要时 `dmPolicy=allowlist`）——否则它的完成回报 DM 被你的 comm-bridge 拦掉、你永远收不到（跨 agent 通知链头号断点）。
   - **方向②（你→worker）**：确认该 bot 的 `dmPolicy` 允许你给它发 DM——否则你的派发消息它收不到。
   - **两个方向都通了再派**；任一方向没开通，先解决或反馈给人类，**不要盲派**。
   (b) Lead 只建 **Issue** + 给目标，**Task 由被指派的 bot 自己 `task.create` 并认领**（谁执行谁建，Lead 不替它建）；(c) 收到它的完成回报后，Lead 才调 `issue.deliver` 并转交发起人验收。
8. **复杂任务必须先有 Blueprint（强制）**：判定为复杂任务（多步骤 / 多 agent / 子任务有依赖 / 需编排）的，**必须** heavy 模式 → 先生成 Blueprint → Lead/策略决定审批或直接启动 → 再实例化 Task 执行。需要审批时走 `blueprint.submit_for_approval` 并等通过；无需审批时走 `issue.start_execution`。**禁止**把复杂任务用 light 模式直接拆成多个 Task 绕过蓝图。顺序硬性：确认项目/KB → 起 heavy Issue → 建 Blueprint → 审批或启动决策 → 按 Step 建 Task → 执行。Blueprint 是复杂任务的施工图，无蓝图就开干 ＝ 复杂任务流程被架空。
9. **Blueprint 启动后一次性实例化全部 Step（强制）+ 依赖步骤不带 assignee、bot 自认领推进**：审批通过或 `issue.start_execution` 后**一次性把全部 Step 建成 Task 并设 `dependsOn`**，**禁止边做边补**。**有依赖的 Step 创建时不带 `assigneeId` → 停「待办」**；前置完成后由**完成的 bot 通知下游 bot、下游自己 `task.claim`（分配）→ `task.start`（依赖闸在此校验）**进「进行中」——**不是后端自动改状态**（RUNNING 必须 = 真有 bot 在跑，杜绝空转的「进行中」）。只实例化当前一步、其余不进看板 ＝ piecemeal，违背设计预期。（详见复杂任务流程 step 5/6。）

10. **提前终止善后（收到 `issue.terminated` 事件，Lead 专属）**：当一个未结论 Issue 被 `issue.terminate` 主动停下，系统已**机械收尾**（级联取消其下非终态 Task、叫停在跑 Attempt），并给 Lead 发 `issue.terminated` 事件。Lead 收到后按以下 SOP 善后，**不要闷头处理**：
    - **不复活**：terminated 是终态，**不得**把该 Issue / Task 重新拉起或续作；善后只能是**向前补偿**（发撤回说明、清理外部记录等），不是撤销终止。
    - **三桶分诊，产出善后清单**：① 在途/预留（系统已撤，Lead 只核对，无需动作）；② 已实现的内部产物（Artifact / KB 页 / comment）——**默认保留**，仅明显是临时草稿且无外部引用才清理；③ 外部不可逆动作（经 Connection 发生过的外部写）——逐项列出，标注是否建议补偿。
    - **与人类共同决定（硬性）**：默认把善后清单带回 **origin conversation** 和人类一起拍；**凡有外部不可逆影响的补偿动作，一律先经人类确认再执行，Lead 不得自授**。仅当**纯内部、无外部影响、产物明显可保留**时才可自行收尾，事后报一句结论。
    - **closure**：善后落定后在 origin conversation 给人类收尾消息（终止已确认 + 留了什么 / 撤了什么 / 人类拍了什么）。

> 区分两类动作：「用户任务执行（出 deliverable）」走完整流程（含项目/KB 选择 + 验收 + 通知）；「内部 bug/问题登记」可默认 Inbox、轻量记录，但完成后仍要通知。

### 常见错误

| 错误 | 正确做法 |
|---|---|
| 使用 Claude Code 内置 TaskCreate/TaskUpdate | 所有任务操作走 TM CLI，禁止用平台内置的 task 工具 |
| 跳过 TM 流程直接执行任务 | 每个需求必须先 Issue → Task → Attempt 推进 |
| Worker 调 issue 生命周期动作 | Issue 状态只由 Lead 流转；`issue.transition` 仅旧脚本兼容 shim，新流程用 `issue.deliver` / `issue.reopen` / `issue.accept_delivered` / `issue.reject_delivered` 等语义命令 |
| 创建 Issue 没有 leadAgentId | Issue 必须有 Lead |
| REJECTED 直接回 EXECUTING | 必须走 `issue.reopen` 到 pending_start，再由 Lead `issue.start_execution` |
| Heavy 模式跳过 Blueprint | 复杂任务必须先建 Blueprint；是否审批由 Lead/策略显式判断 |
| 复杂任务绕过 Blueprint 直接拆 Task 开干（用 light / 无蓝图就实例化）| 复杂（多步/多 agent/有依赖）任务必须 heavy 模式 + 先建 Blueprint，再由 Lead/策略选择审批或直接启动，才能按 Step 实例化 Task |
| Blueprint 通过后只建当前一步 Task、边做边补（piecemeal） | 一次性把全部 Step 建成 Task + 设 dependsOn；无依赖的带 assignee 进进行中、有依赖的不带 assignee 停待办，前置完成后下游 bot 自认领推进，看板呈现完整全景 |
| 给有依赖的 Step 建 Task 时直接带 assigneeId | 有依赖的 Step 不带 assigneeId（否则后端创建即认领、顶成「进行中」，看板看不到待办）；指定执行人记在 Blueprint，前置完成后下游 bot 自己 claim |
| 期待后端"前置 done 自动把待办变进行中" | 后端不自动改状态；由前置 bot 通知下游、下游 task.claim（分配）→ task.start（校验依赖）才进进行中——RUNNING 必须对应真在执行的 bot |
| claim 完就以为开工了 / 等 attempt | v0.7 claim 只分配（assigned）；必须再 `task.start` 才进 running、才建 attempt、才查依赖 |
| 想把已 terminated 的 Issue/Task 重新拉起 | terminated 是终态，不复活；善后只做向前补偿，且外部不可逆动作先经人类确认 |
| 直接归档未结论的 Issue | 只有 accepted / terminated 可归档；先验收通过或 `issue.terminate` 拿到终态 |
| Worker 自行创建新 Attempt 重试 | 汇报失败，等 Lead 决定 |
| CreateTask 不带 projectId | 必须传 issueId 或 projectId |
| 对 ⏳ 命令反复重试 | 404/501 → 降级到对话流 |
| 人类提供了 Project ID 仍自创 Project | 直接使用人类给出的 ID，不要 project.create 重复创建 |
| 用 curl/fetch 直接调 TM/KB/AS API / 手搓 BFF REST 路径 | 一律走 CLI `src/cli/{tm,kb,as,comm,core}.js`，禁止直接 HTTP（见顶部「服务调用铁律」）；不确定先 `node src/cli/<svc>.js` 看命令或查 ops 文档，别猜路径 |
| Task done 但 Attempt 仍在 running | 先 attempt.transition → done，再 task.transition → done |
| 工作做完但 Issue 没有 deliver | 所有 Task done 后必须 `issue.deliver` |
| 交付后 bot 自行验收 / 自行归档 | delivered 后必须**等发起人验收通过**，再由 bot 调 `issue.accept_delivered({source:"im"})` |
| 找 owner / 随便哪个用户验收 | 验收人＝**发起该任务的人类**（按 issue 来源会话识别），不是 owner、不是 bot 自己 |
| 交付后把任务堆在「已完成」不管 | delivered=待验收，主动请发起人验收；任务做完≠结束，发起人验收通过才归档 |
| 先开干再补登记 Issue/Task | 先确认项目/KB → 再登记 Issue→Task → 再执行，顺序不能颠倒 |
| 自行决定派哪个 bot 执行 | 按 agent 描述给推荐 + 理由，由发起人确认/选择执行 bot，不自行拍板 |
| 派任务给 bot 但没把它加进 dmAllowFrom | 派发前先把 worker member_id 加进自己的 dmAllowFrom（必要时 dmPolicy=allowlist），否则它的完成回报 DM 被拦、收不到 |
| Lead 替 worker 建 Task 再派给它 | Lead 只建 Issue + 给目标 + 开权限；Task 由执行的 bot 自己 task.create 并认领（谁执行谁建）|
| worker 把 task 流转到 done 就当任务完成/归档 | task done 只是「执行动作做完」；进入 accepted/「完成」与 archived 必须人类验收通过 |
| 人类拒收后直接修改产出 | 先 `issue.reject_delivered` → `issue.reopen` → pending_start → `issue.start_execution`，再新建 Task 重做 |
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
   `core.member_list({kind:"agent", search:"<worker 显示名>"})` 拿 `member_id`。常用 worker 的 member_id 应该已经在记忆里，记忆里有就别再查。

2. **双向开放 DM 权限（关键！否则收不到回报）**：
   - **把 worker 的 member_id 加进自己的 `dmAllowFrom`**（`config.json` → `orgs.<slug>.access`，必要时把 `dmPolicy` 设为 `allowlist`）。否则 `dmPolicy=owner/allowlist` 会把 worker 的回报 DM **直接丢弃**，Lead 永远收不到「已完成」——这正是跨 agent 通知链最常断的地方。**派一个 worker 就加一个**。
   - **确认 worker 那边也对自己开放**（worker 的 `dmPolicy` 允许 Lead 发 DM）。派发 DM 若迟迟没被处理，多半是对方没放行——反馈给人类，别干等。

3. **拿/建会话**：
   `comm.create_dm({participantId})` 返回 `conversationId`（幂等；持久化到记忆复用）。

4. **发目标 + 让 worker 自建 Task（谁执行谁建）**：
   `comm.send({conversationId, content})` 用 markdown 写清**目标、所属 Issue ID、KB 产出位置、退回触发词、判断标准**。**Task 由被指派的 worker 自己在该 Issue 下 `task.create` 并认领执行**——Lead 只建 Issue + 给目标 + 开权限，**不替 worker 建 Task / 不预先 `task.create({assigneeId})`**。

5. **等 worker 回报并转交验收**：
   不要轮询 `comm.get_messages`。worker 完成后通过 bot DM 回报；**该回报只有在第 2 步开放权限后才会进 Lead 的输入流**。收到回报 → Lead 调 `issue.deliver` → **转交发起人（人类）验收**（见护栏规则 6，验收通过才 accepted/archived）。

**用 TM action 而非聊**：重派用 `task.reassign({newAssigneeId})`；状态流转 worker 自己走 attempt/task transition。但**澄清需求、上下文同步、判断分歧**这些"对话"性质的事，**必须**走 bot DM。

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

## 前端链接（Frontend URL Patterns）

分享 Workspace 资源链接时，**必须**加上 `/cws` 前缀（`server.frontend_base_path` 配置值，默认 `/cws`）。直接拼 BFF 路径会 404。

| 资源 | URL 模板 |
|---|---|
| KB 页面 | `{bff_url}/cws/knowledge?kb={kb_id}&node={node_id}` |
| KB 列表 | `{bff_url}/cws/knowledge?kb={kb_id}` |
| Issue 详情 | `{bff_url}/cws/issue/{issue_id}` |
| 项目看板 | `{bff_url}/cws/project/{project_id}` |

可用 CLI 一步生成：`node src/cli/core.js core.frontend_url '{"path":"/knowledge?kb=xxx&node=yyy"}'`，输出完整 URL。

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
