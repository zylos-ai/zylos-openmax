# 消息上下文锚定设计 

| 属性  | 值                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 作者  | Daniel                                                                                                                                                                                                                            |
| 版本  | v0.2                                                                                                                                                                                                                              |
| 日期  | 2026-05-27                                                                                                                                                                                                                        |
| 状态  | 草案                                                                                                                                                                                                                                |
| 关联  | [Agent Skill Spec](agent-skill-spec.md)、[通信域](../../cws-docs/domain/communication/communication.md)、[工作三层](../../cws-docs/domain/workspace/work-hierarchy.md)、[投递链路](../../../cws-docs/pre-deploy/human-message-to-agent-path.md) |

## 1. 问题

Agent 只有一个 session，所有 Conversation 的消息汇入同一个入口。当 Agent 同时处理多个 Issue（Lead）或 Task（Worker）时，需要解决两个问题：

1. **上下文锚定**：这条消息属于哪个工作上下文（Issue/Task）？
2. **参数推断**：调用 TM/KB/AS 接口时，projectId、issueId、conversationId 等参数从哪来？

Conversation 和 Issue/Task 之间是 **M:N 关系**——一个 Conversation 可以讨论多个 Issue，同一个 Issue 可以在多个 Conversation 中被提及。消息信封不携带 Issue/Task 等工作域语义信息。

## 2. 场景推演

### 场景 1：单 Issue（大多数情况）

```
[DM] 人类: 帮我调研竞品定价
     Agent: (创建 Issue A, projectId=inbox) 收到，开始处理
[DM] 人类: 怎么样了？
     → 只有一个活跃 Issue → 无歧义
[DM] 人类: 加上市场份额分析
     → 追加指令，仍属于 Issue A
```

### 场景 2：多 Issue 同一会话

```
[DM] 人类: 帮我调研竞品定价
     Agent: (创建 Issue A)
[DM] 人类: 另外帮我写个周报
     Agent: (创建 Issue B)
[DM] 人类: 怎么样了？
     → A 还是 B？
[DM] 人类: 定价那个加上市场份额
     → 历史上下文可推断是 A
[DM] 人类: 好的可以
     → 如果 A 和 B 都 DELIVERED，哪个被 accepted？
```

### 场景 3：同一 Issue 跨会话

```
[DM]   人类: 帮我调研竞品定价        → Agent 创建 Issue A
[群聊] 人类: @Agent 定价分析进展同步下  → Agent 需从"定价分析"关联到 Issue A
```

### 场景 4：Lead→Worker

```
[DM Lead→Worker]
  Lead: 帮我访谈 5 位用户，Task-7，详见 KB /projects/x/brief.md
  → Worker 从消息中知道 taskId、KB 路径

[群聊]
  Lead: @WorkerAgent 那个访谈做得怎么样了
  → Worker 需从历史上下文推断是哪个 Task
```

### 场景 5：非工作消息

```
[DM] 人类: 我们团队有几个人？     → 组织查询，不属于任何 Issue
[DM] 人类: onboarding 项目进度？  → Project 查询，不是 Issue
```

### 场景 6：话题切换

```
[DM] 人类: 定价分析加个竞品 D    ← Issue A
[DM] 人类: 对了周报今天能交吗    ← 切换到 Issue B
[DM] 人类: 格式按上次的来        ← 紧接上文 → Issue B
```

## 3. API 参数推断

Agent 调用平台接口时需要各种 ID 和上下文参数。这些参数不从消息信封获得，而是从 Agent 自身历史行为和对话上下文中推断。

### 3.1 参数来源分类

| 来源           | 含义                  | 示例                                                   |
| ------------ | ------------------- | ---------------------------------------------------- |
| **Agent 身份** | 始终已知，环境变量注入         | agentId（`core.me`）、orgId（`COCO_ORG_ID`）              |
| **自身行为产生**   | Agent 之前的 API 调用返回值 | 创建 Issue 返回 issueId；创建 Task 返回 taskId                |
| **对话上下文推断**  | 从历史对话中提取            | 人类提到的项目名 → projectId；人类描述的需求 → title                 |
| **平台查询**     | 调用读接口获取             | `project.list` 获取可用项目；`core.agent_list` 获取可派发的 Agent |
| **默认值 / 约定** | 预设的 fallback        | 未指定项目 → Inbox；mode 未指定 → light                       |
| **主动询问**     | 无法推断时问人类            | "你想放到哪个项目？"                                          |

### 3.2 TM 关键操作的参数推断

#### issue.create

| 参数 | 必填 | 推断方式 |
|---|---|---|
| projectId | 是 | 人类提到项目名 → `project.list` 匹配；未提到 → Inbox 项目；不确定 → 问 |
| title | 是 | 从人类意图中提取 |
| description | 否 | 从澄清对话中积累 |
| mode | 是 | Agent 决策（light/heavy），基于编排决策框架 |
| leadAgentId | 是 | 始终 = self（创建者就是 Lead） |
| originConversationId | 否 | 当前消息的 conversationId（comm-bridge endpoint 中携带） |

**推断链示例**：

```
人类: "帮我调研竞品定价"
  → title = "竞品定价调研"（从意图提取）
  → projectId = ?（人类没说项目）
  → Agent 有两个选择:
    a) 默认放 Inbox，交付时问要不要挪到正式项目
    b) 问人类"放到哪个项目？这些是当前项目列表: ..."
  → mode = light（单步骤、可自做）
  → leadAgentId = self
```

#### issue.transition

| 参数 | 必填 | 推断方式 |
|---|---|---|
| projectId | 是 | Agent 创建 Issue 时已知（对话历史中有） |
| id | 是 | Agent 创建 Issue 时已知（API 返回值） |
| status | 是 | Agent 根据生命周期决定 |

#### task.create

| 参数 | 必填 | 推断方式 |
|---|---|---|
| issueId | 否 | 当前正在处理的 Issue（从上下文锚定结果获得） |
| projectId | 否 | 从 Issue 继承 |
| title | 是 | Agent 决定（从 Blueprint Step 或自行拆分） |
| assigneeId | 否 | 自做 = self；派发 = `core.agent_list` + skillTags 匹配 → 选择 Agent |
| skillTags | 否 | Agent 判断任务所需技能 |

**assigneeId 推断链**：

```
Agent 决定派发 → 需要找合适的 Worker
  → core.agent_list 获取 Team 成员
  → 匹配 skillTags（如 "research"）
  → 如果有多个候选 → Agent 选择（或问 Lead 人类）
  → 如果无候选 → 回退为自做或告知人类
```

#### task.transition

| 参数 | 必填 | 推断方式 |
|---|---|---|
| id | 是 | Worker: 从派发消息或 claim 时已知；Lead: 从 task.list 获取 |
| status | 是 | Worker 根据执行结果决定（done/failed） |

### 3.3 KB 关键操作的参数推断

| 操作 | 关键参数 | 推断方式 |
|---|---|---|
| kb.search | query | 从当前任务需求中提取搜索词 |
| kb.page_create | parentId, title | 遵循 KB 命名空间约定：`/projects/{slug}/...`；slug 从 Project 获取 |
| kb.page_content_write | pageId, content | pageId 来自 page_create 返回值或 search 结果 |
| kb.page_get / page_content | pageId | 从搜索结果、Lead 指定路径、或 Task.contextPageIds 获取 |

**KB 路径推断链**：

```
Agent 需要写经验沉淀
  → 约定路径: /agents/{slug}/lessons/
  → slug = Agent 自身名称（从 core.me 获取）
  → parentId = kb.tree_roots → 找 /agents → kb.node_children → 找 {slug} → lessons
  → 如果路径不存在 → kb.folder_create 逐级创建
```

### 3.4 Comm 关键操作的参数推断

| 操作 | 关键参数 | 推断方式 |
|---|---|---|
| comm.send | conversationId, content | conversationId 从当前消息的 endpoint 提取；content 由 Agent 生成 |
| comm.get_messages | conversationId | 同上 |
| comm.create_dm | memberIds | 从 core.member_list / core.agent_list 获取目标 member_id |

### 3.5 参数推断的关键依赖

```
core.me → agentId, orgId（身份基础，所有操作的前置）
  │
  ├→ project.list → projectId（Issue 归属）
  │
  ├→ core.agent_list → assigneeId（Task 派发）
  │
  ├→ issue.create → issueId（后续所有 Issue 操作）
  │     │
  │     └→ task.create → taskId（后续所有 Task 操作）
  │
  └→ kb.tree_roots → KB 目录结构 → pageId（读写知识）
```

Agent 的第一个 API 调用应该是 `core.me`（获取身份），然后按需查询 `project.list` 和 `kb.tree_roots` 建立工作上下文。

## 4. 上下文锚定策略

> 前提假设：消息正文到达 Agent（P0 已修复）。
> 消息信封不携带 Issue/Task 语义信息。锚定完全依赖 Agent 的对话历史理解能力。

zylos 的 Agent runtime（Claude Code）在单 session 内天然具备多任务上下文追踪能力——LLM 通过对话历史理解"之前在聊什么"。我们不构建额外的状态追踪机制，而是依赖两个策略：

### 4.1 历史上下文推断

Agent 基于对话历史自行推断当前消息属于哪个工作上下文。这是 LLM 的自然能力，不需要显式的状态机或焦点追踪。

Agent 在推断时可利用的线索：

| 线索 | 示例 |
|---|---|
| 对话近因 | 上一轮聊的是 Issue A → 本轮大概率还是 A |
| 语义关联 | "加上市场份额" 与 Issue A（竞品定价）相关 |
| 发送者身份 | Lead-Alpha 发消息 → 大概率关于 Lead-Alpha 派发的 Task |
| 话题切换信号 | "对了"、"另外" → 可能切换到其他 Issue |
| 唯一活跃上下文 | 只有一个 Issue 在进行中 → 默认归属 |

**Skill 不规定推断算法，只规定行为约束**：

- Agent 在操作前必须明确自己在操作哪个 Issue/Task
- 操作代价越高，锚定置信度要求越高

### 4.2 主动询问

当 Agent 无法从历史上下文中确定消息属于哪个工作上下文时，主动询问人类。

**询问阈值与操作代价挂钩**：

| 操作代价 | 策略 | 示例 |
|---|---|---|
| 高（验收、状态流转） | 不确定就问 | "好的可以"→ "你是说竞品定价分析可以了，还是周报？" |
| 中（追加指令） | 中等置信度可先执行，错了可纠正 | "加上市场份额"→ 大概率是定价分析，直接做 |
| 低（查询、闲聊） | 不需要锚定 | "团队有几个人？"→ 直接查 |

**询问格式**：提供选项，减少人类输入成本。

```
你说的是哪个任务？
1. 竞品定价分析（进行中）
2. 周报（已交付，等待确认）
```

## 5. Agent 出站消息设计

Agent 发出的消息会成为对话历史的一部分，影响后续消息的推断。如果 Agent 在关键节点的消息中附带 Issue 标识，后续对话中 LLM 更容易推断上下文。

建议 Agent 在以下节点附带轻量标识：

| 节点 | 消息格式 |
|---|---|
| 开始执行 | "收到，我开始处理 **竞品定价分析** 了" |
| 交付 | "**竞品定价分析** 完成了，产出在 KB /projects/.../report.md" |
| 验收确认 | "好的，我把 **竞品定价分析** 标记为完成了" |
| Worker 汇报 | "**Task-7 用户访谈** 完成了，摘要: ..." |

这不是强制格式，是 Skill 指导 Agent 养成的习惯——让对话历史中有足够的锚点供后续推断。

## 6. Session 切换的影响

zylos 通过切换新 session 解决上下文膨胀，切换后对话历史清零。

Agent 在新 session 中需要重建工作上下文：

| 信息 | 恢复方式 |
|---|---|
| 活跃 Issue/Task 列表 | `task.list`（查自己 assignee 的 Task）+ `issue.list_in_project`（查自己 Lead 的 Issue）|
| Issue/Task 元信息 | 同上，API 返回值包含 title/status |
| 历史对话上下文 | 丢失；Agent 只能从 TM 状态中推断"我之前在做什么" |

**前置依赖**：TM 读接口可用（当前 cws-core 网关 501）。在网关可用之前，session 切换后 Agent 无法恢复工作上下文。

## 7. 对 Skill 设计的影响

### Layer 1（Base Prompt）

不需要显式的角色检测状态机或焦点追踪机制。改为：
- Agent 在收到消息后，基于对话历史判断消息属于哪个工作上下文
- 无法判断时主动询问
- 高代价操作（验收、状态流转）要求更高置信度

### Layer 2（Agent Skill）

- Lead 流程中：操作前确认当前 Issue 上下文，不确定就问
- Worker 流程中：Task 上下文通常清晰（来自派发消息），多 Task 时从发送者推断
- Agent 出站消息附带 Issue/Task 标识（§5）
- API 参数推断遵循 §3 的推断链

### 新 session 恢复

- Agent 在新 session 启动时通过 TM 读接口恢复活跃工作列表
- 如果 TM 不可用，Agent 应告知人类"我刚切换了 session，请告诉我当前在做什么"

## 8. 待决事项

### 投递链路（前置）

- [ ] **P0：消息正文到达 Agent** — NATS 事件或 WS frame 携带 content，或 comm-bridge REST 补拉
- [ ] **P1：sender_display_name** — Agent 询问时需要可读名称
- [ ] **P2：sender_type 透传** — Agent 需区分 human/agent 消息

### 设计决策

- [ ] Agent 出站消息标识格式是否标准化（§5）
- [ ] session 切换后的恢复流程是否写入 Skill
- [ ] projectId 默认 Inbox 的策略是否足够，还是应该更积极地引导人类选择项目
