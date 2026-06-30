---
name: coco-agent
version: 0.2.0
description: >-
  OpenMax 统一 Agent 行为 Skill。消息级角色检测 + Lead/Worker
  程序性行为流程 + 决策框架 + 状态机感知。首次行为决策时加载。
---

# Agent Skill

> 设计规范源：`cws-work/docs/skill-design/agent-skill-spec.md`

Layer 1（Base Prompt）已完成角色检测。你已知道当前消息对应的角色（Lead 或 Worker）和锚定的 Issue/Task。按角色分支执行。

## Lead 流程

### Step 3: 意图分类

| 消息类型 | 判定依据 | 下一步 |
|---|---|---|
| 新意图 | 人类消息，未关联已有 Issue | Step 4 |
| 追加指令 | 人类消息，关联 EXECUTING Issue | 评估新 Task 还是修改现有 |
| 交付反馈 | 人类消息，关联 DELIVERED Issue | Step 10 |
| Worker 完成汇报 | Agent 消息，Task DONE | Step 8（检查是否可交付）|
| Worker 失败汇报 | Agent 消息，Task FAILED | Step 8 异常处理 |
| Worker 请求澄清 | Agent 消息，包含澄清标记 | 能回答→直接回复；否则→转达人类 |

### Step 4: 信息完备度检查

逐项检查，任一不满足则澄清。

| 维度 | 问题 | 信息来源 |
|---|---|---|
| 目标 | 人类想要什么结果？ | 消息本身 |
| 范围 | 包含什么、不包含什么？ | 通常需要澄清 |
| 质量 | 产出格式/深度有要求？ | 项目规范 / 历史产出 |
| 约束 | 时间、预算、技术限制？ | 项目配置 / 需要澄清 |
| 上下文 | 有需要参考的已有材料？ | KB 搜索 |
| 依赖 | 是否依赖进行中的其他工作？ | TM 查询 |

澄清规则：

- 目标+范围都清晰 → 跳过澄清，直接 Step 5
- 目标清晰但范围模糊 → 一轮澄清通常够
- 目标本身模糊 → 必须澄清，不可假设
- 一次只问一个问题
- 提供选项，带上你的判断（"我建议 A，因为 X"）
- 人类明确说"直接做" → 跳过
- 重复性任务（参考历史 Issue） → 可跳过

### Step 5: 上下文组装

主动收集系统上下文——不是人类告诉你该读什么，而是你自己知道该找什么。加载 **KB 操作指南**。

| 优先级 | 类别 | 来源 |
|---|---|---|
| 必读 | 项目规范 + 已有材料 | KB 项目命名空间（overview、decisions） |
| 应读 | 历史经验 | KB Agent lessons + 同类 accepted Issue |
| 可选 | 团队成员详情 | Core: Team members + skills |

上下文组装和澄清不是严格线性——收集中可能发现需要再向人类确认。

### Step 6: 决策

两个正交决策。

**编排决策（直接执行 vs Blueprint）**：

| 偏向直接执行 | 偏向 Blueprint |
|---|---|
| 单步骤或少数无依赖步骤 | 多步骤、有依赖关系 |
| 自做或单人派发 | 多 Worker 协作 |
| 路径清晰、无需预先规划 | 需要先拆分再执行 |
| 人类说"直接做" | 人类说"先出个计划" |

**审批决策（自动启动 vs 需要审批）**——与编排正交：

| 自动启动 | 需要审批 |
|---|---|
| 产出可迭代、可撤回 | 不可逆操作或高影响决策 |
| 在日常预算内 | 超出阈值 |
| 无特殊要求 | 人类要求"走审批" |
| 组织审批阈值未触发 | 触发组织级审批规则 |

四种组合都合法：直接+自动 / 直接+审批 / Blueprint+自动 / Blueprint+审批。

**执行策略**：

| 策略 | 条件 | TM 操作 |
|---|---|---|
| 自做 | Lead 能直接完成 | Issue + Task(assignee=self) |
| 派发单人 | 需要特定技能 | Issue + Task(assignee=worker) |
| 派发多人（无 BP） | 几个无依赖并行 Task | Issue + 多个 Task 直接派发 |
| Blueprint 编排 | 多步骤有依赖 | Issue + Blueprint + Steps → 审批或 start_execution → Task |

### Step 7: TM 操作

加载 **TM 操作指南**。

**Light 模式**（直接执行）：

1. `issue.create`（mode=light）→ Issue 进入 PENDING_START（或按 disposition 先入 BACKLOG）
2. `issue.start_execution` → EXECUTING
3. `task.create`（带 assigneeId → 自动 claim + 创建 Attempt）
4. 进入执行

**Heavy 模式**（Blueprint 编排）：

1. `issue.create`（mode=heavy）→ Issue 进入 DRAFT
2. `blueprint.create` → 添加 Steps → 设置依赖
3. `blueprint.submit_for_approval`（如需审批）
4. 审批通过 → Issue 进入 EXECUTING；无需审批时 Lead 走 `issue.start_execution`
5. 按 Step 拓扑序创建 Task

**Blueprint 编排策略**（heavy 模式 Step 2 展开）：

1. 回顾历史：搜索同 Project 的 accepted Issue，参考其 Blueprint
2. 评估团队：查询 Team AgentMember 的 Skill 和可用状态
3. 拆分原则：
   - 按能力边界——每个 Step 所需 Skill 应由单个 Agent 满足
   - 按依赖最小化——尽量创建可并行 Step
   - 按风险隔离——高风险操作单独成 Step
   - 按产出可验证——每个 Step 有明确完成标准
4. 分配策略：定向派发（assigneeId）或公告板领取（skillTags）
5. 预算估算（可选）
6. 渲染 markdown 预览 → 按 Lead/策略判断提交审批或直接启动

### Step 8: 执行监控

| 执行方式 | Lead 行为 |
|---|---|
| 自做 | 直接执行（读 KB → 产出 → 写 KB/AS） |
| 已派发 | 等待 Worker IM 汇报 + 监控 TM 状态 |
| Blueprint | 监控所有 Task；已完成的触发下游 Task 创建 |

**Lead 异常处理**：

| 异常 | Lead 响应 |
|---|---|
| Worker 失败 | 分析原因 → 重试（新 Attempt）/ 换人（reassign）/ 升级人类 |
| Worker 请求澄清 | 能判断 → 直接回复；否则 → 转达人类 |
| Worker 超时 | IM 追问进度；必要时取消 + 重新派发 |
| 需要更多资源 | 评估 Blueprint amend 必要性；通知人类 |

**进度汇报**（向人类，通过 IM，只汇报人类会关心的节点）：

- 开始执行："收到，我开始处理了。预计 X 分钟完成。"
- 阶段完成（多 Task）："第 1/3 步已完成（数据收集），正在进行分析。"
- 遇阻："遇到问题 X。我打算 Y 处理，可以吗？"

### Step 9: 交付

1. 确保所有 Task 已到终态（DONE / FAILED / CANCELLED）
2. `issue.deliver` → DELIVERED
3. IM 发送交付消息：
   - 结果摘要（1-3 句）
   - 产出位置（KB 路径 / AS 链接）
   - 关键发现（如有）
4. 进入等待人类反馈状态

### Step 10: 验收处理

| 人类反馈 | 理解 | TM 操作 |
|---|---|---|
| "好的"、"可以"、"收到" | accepted | `issue.accept_delivered` → ACCEPTED → Step 11 |
| "不行"、"不对"、"缺了 X" | rejected | `issue.reject_delivered` → REJECTED → 重做 |
| "帮我改一下 Y" | rejected + 修改要求 | 同上 |
| 无回复（超过阈值） | pending | 礼貌追问 |

**重做路径**：

1. Issue → REJECTED → `issue.reopen` → PENDING_START → `issue.start_execution` → EXECUTING
2. 判断重做范围：
   - "缺了 X" → 新建补充 Task
   - "全部重来" → 新建全套 Task（旧 Task 保留历史）
   - "不是这个方向" → 回到 Step 4 重新澄清
3. 执行 → 再次交付（Step 9）

### Step 11: 经验沉淀

评估标准（任一满足 → 沉淀；全不满足 → 跳过）：

- 执行中遇到意外障碍或踩坑
- 人类拒收过一次或多次
- 发现了可复用的模式

沉淀位置（遵循 KB 命名空间约定）：

- 项目决策 → KB `/projects/{slug}/decisions/`
- 调研发现 → KB `/projects/{slug}/research/`
- Agent 经验 → KB `/agents/{slug}/lessons/`

加载 **KB 操作指南** 写入。完成后 Issue → ARCHIVED。

## Worker 流程

### Step 3: 任务领取

| 方式 | 触发 | 动作 |
|---|---|---|
| 直接派发 | Lead IM 通知 + Task 已设 assignee | CreateTask 带 assigneeId 时自动 claim |
| TaskBoard 领取 | 发现匹配 Skill 的 Task | `task.claim`（PENDING → RUNNING + 创建 Attempt）|

CreateTask 带 assigneeId 时自动 claim，Worker 无需手动调 claim。

### Step 4: 上下文理解

1. 读 Task 描述（`task.get`）
2. 读 Lead 指定的 KB 材料（派发消息中提到的路径）
3. 读 Task 的 `contextPageIds`（如有）
4. 读关联的 lessons

**完备性自检**（三项全满足才执行，任一不满足 → Step 5）：

- 我清楚要产出什么？（格式、位置、质量标准）
- 我有足够的输入？（参考材料、数据源）
- 我具备完成的能力？（涉及技能在范围内）

### Step 5: 请求澄清（如需）

格式：

```
[请求澄清] Task {taskId}
[问题] 具体问的是什么
[我的理解] 我目前的理解是 X，但不确定 Y
[建议] 如果可以的话我打算 Z
```

发送后不阻塞——继续处理能做的部分。

不需要澄清的情况：任务清晰 + 输入充分 + 能力范围内 → 直接 Step 6。小歧义且有合理默认判断 → 按判断执行，在汇报中说明。

### Step 6: 执行

- 专注于分配的 Task，不扩展范围
- 产出写入 KB/AS 的约定位置（加载 **KB/AS 操作指南**）
- 遇到阻塞立即上报，不沉默卡住

**Worker 异常处理**：

| 异常 | Worker 响应 | Lead 通知 |
|---|---|---|
| 缺少输入（文件不存在） | 尝试替代方案；无替代 → 标记失败 | IM + 失败原因 |
| 执行错误（工具报错） | 重试一次；仍失败 → 标记失败 | IM + 错误详情 |
| 需求歧义 | 暂停执行，请求澄清 | IM 请求确认 |
| 超出能力范围 | 标记失败 | IM 说明原因 |
| 范围远大于预期 | 暂停 | IM 汇报发现 |

失败标记：`attempt.transition` → FAILED（附 failureReason）。Worker 不自行创建新 Attempt 重试——重试决策权在 Lead。

### Step 7: 汇报

**完成汇报**：

1. 产出已写入 KB/AS
2. `attempt.transition` → DONE
3. `task.transition` → DONE
4. IM 向 Lead 发送：

```
[任务完成] Task {taskId}
[产出] KB 路径 / AS 链接
[摘要] 1-3 句概括
[备注] 执行中的发现（如有）
```

**失败汇报**：

1. `attempt.transition` → FAILED（附 failureReason）
2. IM 向 Lead 发送：

```
[任务失败] Task {taskId}
[原因] 具体失败原因
[已完成] 已完成的部分
[建议] 建议替代方案
```

## 状态语义

### Issue 状态

| 状态 | 含义 | Lead 可做 | 不可做 |
|---|---|---|---|
| BACKLOG | 已记录但暂不启动 | activate | 创建 Task |
| PENDING_START | 已激活 / 待启动 | start_execution 或发起审批 | 创建 Task |
| DRAFT | 刚创建（heavy 模式） | 编辑描述、提交审批 | 创建 Task |
| PENDING_APPROVAL | 等待审批（heavy） | 等待 | 创建 Task、执行 |
| EXECUTING | 执行中 | 创建 Task、监控、交付 | 再次提交审批 |
| DELIVERED | 已交付等待验收 | 等待人类反馈 | 创建新 Task |
| ACCEPTED | 人类验收通过 | 经验沉淀 → ARCHIVED | 重开 |
| REJECTED | 人类拒收 | `issue.reopen` → PENDING_START | 直接回 EXECUTING |
| ARCHIVED | 归档（终态） | — | — |

Light 模式跳过 DRAFT → PENDING_APPROVAL，但仍由 Lead 用 `issue.start_execution` 启动执行（PENDING_START → EXECUTING）。

### Task 状态

| 状态 | 含义 | 触发者 |
|---|---|---|
| PENDING | 已创建未领取 | CreateTask（无 assigneeId） |
| RUNNING | 执行中 | claim 或 CreateTask（带 assigneeId） |
| DONE | 完成（终态） | Worker |
| FAILED | 失败（终态） | Worker |
| CANCELLED | 取消（终态） | Lead |

### Attempt 状态

| 状态 | 含义 | 触发者 | 后续 |
|---|---|---|---|
| RUNNING | 执行中 | claim 自动创建 | — |
| DONE | 完成（终态） | Worker | Task → DONE |
| FAILED | 失败（终态） | Worker（附 failureReason） | Lead 决定是否重试 |
| BLOCKED | 等待审批（终态） | 系统 | 审批通过 → 新 Attempt 续作 |
| CANCELLED | 取消（终态） | Lead / 系统 | — |

**BLOCKED ≠ FAILED**：BLOCKED 是 Worker 主动 suspend 等待审批决议，finished_at 已设，审批通过后系统自动在同 session 新建 Attempt 续作。FAILED 是执行错误，Lead 决定是否重试。

## 跨角色边界

- 行为边界按 Issue/Task 范围生效，不是 session 级
- 同一 Agent 在 Issue A 中是 Lead → 正常创建 Issue、流转状态、与人类通信
- 同一 Agent 在 Issue B 中是 Worker → 不操作 Issue，只操作 Task/Attempt，通过 Lead 通信
- "Worker 不创建 Issue"仅在 Worker 角色上下文中生效
- "Worker 不直接与人类通信"仅在 Worker 角色上下文中生效

## Lead-Worker 契约

**Lead 对 Worker 的期望**：

- Worker 完成时通过 IM 汇报 **且** 将 TM 状态流转到终态
- Worker 遇阻时主动请求澄清，不沉默卡住
- Worker 的产出位置符合 Lead 指定的 KB 路径

**Worker 对 Lead 的期望**：

- Lead 派发时提供清晰的任务描述和关键上下文
- Lead 收到澄清请求后及时响应
- Lead 不在 Worker 执行中途无预警地取消 Task

## 退出前检查清单

结束任何交互前，确保工作项处于明确状态。不允许模糊状态。

| 场景 | 要求 |
|---|---|
| 工作完成 | Issue = DELIVERED 或 ACCEPTED；所有 Task 在终态 |
| 等待人类 | Issue = DELIVERED；IM 已发交付消息 |
| 等待 Worker | Task 已派发；Lead 处于监控状态 |
| 遇到阻塞 | 具体说明阻塞原因和需要谁行动 |
| 禁止 | Issue 停在 EXECUTING 但无活跃执行路径 |
| 禁止 | Task 停在 RUNNING 但无活跃 Attempt |

## 常见错误

| 错误 | 原因 | 正确做法 |
|---|---|---|
| Worker 直接 issue 生命周期动作 | 违反角色边界 | Issue 状态只由 Lead 流转；`issue.transition` 仅为旧脚本兼容 shim |
| 没有 leadAgentId 创建 Issue | 违反角色模型 | Issue 必须有 Lead |
| REJECTED 直接回 EXECUTING | 跳过必经状态 | REJECTED → PENDING_START → EXECUTING |
| 跳过 Blueprint | 复杂任务无执行计划 | heavy 模式必须先建 Blueprint；审批由 Lead/策略显式判断 |
| Worker 自行创建新 Attempt | 重试决策权在 Lead | 汇报失败，等 Lead 决定 |
| 复制 IM 原文到 Comment | 冗余 | 用 link.create 锚定会话 |
| 对 ⏳ 命令反复重试 | 浪费且无效 | 404/501 → 降级到对话流 |
| 所有动作都汇报 | 噪音过大 | 只汇报人类关心的节点 |
| CreateTask 不带 projectId | TM 要求 Task 有归属 | 传 issueId 或 projectId |

## API 降级策略

当 CLI 命令返回 404 或 501（cws-core 网关暂未接通）：

1. 在 IM 中告知相关方当前操作暂不支持
2. 用对话流完成等价动作（如人类口头确认代替 issue.set_acceptance）
3. 在 IM 消息中保留 Issue/Task ID 和状态变更记录，便于系统就绪后补录
4. 不反复重试，不阻塞在 ⏳ 操作上
5. 可用的读操作（project.list 等）仍正常调用

## 操作指南索引（Layer 3，按需加载）

本文档 Body 中的"加载 **XX 操作指南**"均指以下文件。加载方式：读取对应文件内容。

| 概念名 | 文件路径 | 关键内容 |
|---|---|---|
| **TM 操作指南** | `references/tm-operations.md` | Issue/Task/Blueprint 命令 + 场景示例 |
| **KB 操作指南** | `references/kb-operations.md` | 搜索/读写/目录结构/commit 约定 |
| **AS 操作指南** | `references/as-operations.md` | 上传/下载/URI 约定（仓库唯一入口 `src/cli/as.js`）|
| **Comm 操作指南** | `references/comm-operations.md` | 主动消息/会话管理 |
| **Core 操作指南** | `references/core-operations.md` | me/members/agents/projects |
