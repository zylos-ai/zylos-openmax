# Skill 设计：Guided Autonomy

> 设计规范源：`docs/skill-design/agent-skill-spec.md`
> 记忆系统参考：zylos-core 记忆架构（identity.md / state.md / references.md）
> 备选方案：`docs/skill-design/design-v2.md`（Procedural Skill）

## 范式：Guided Autonomy（引导式自治）

Skill 不教 Agent "怎么做"，只给它三样东西：

- **效率捷径** — 参数解析链、本地目录缓存、上下文锚定优先级，省掉试探和冗余 API 调用
- **行为护栏** — 状态机约束、角色边界、常见错误，防止越界
- **记忆触发点** — 什么时候该持久化什么信息（意图式，不指定存储位置），保持跨 session 连贯

流程编排（意图理解→澄清→上下文收集→决策→执行→交付→验收→沉淀）交给 LLM 自行判断。

## 设计原则

### 1. LLM 足够聪明

即使没有 Skill，LLM 大概率也能跑通任务编排闭环。Skill 的三重作用是：

- 减少 token 用量 — 告诉 Agent 参数怎么拿，省掉试探循环
- 提高效率 — 告诉 Agent 先查缓存再调 API，缩短关键路径
- 减少打扰人类 — 告诉 Agent 什么时候该自己判断、什么时候该问

### 2. 利用本地记忆

zylos 的记忆系统（state.md / references.md）提供跨 session 持久化。Skill 只描述持久化意图（"创建 Issue 后记下 ID 和状态"），不指定存储位置（不写 "写入 state.md 的第 X 行"）。这样 Skill 在不同运行时上都能工作。

### 3. 本地目录兜底

Agent 维护一份 Project/Issue/Task 本地目录（name + description + id）。当需要从人类消息中推断 projectId/issueId/taskId 时，先在本地目录做语义匹配（LLM 天然擅长），而不是调 API 搜索。一次批量拉取，长期本地消费。

上下文锚定优先级链：

1. **对话历史推断**（零调用）— 上一轮聊的是什么、语义关联、话题切换信号
2. **记忆中的活跃工作列表**（零调用）— 持久化的 Issue/Task 状态
3. **本地目录语义匹配**（零调用）— 从缓存的 Project/Issue/Task name+description 匹配
4. **主动询问人类** — 提供选项让人类选择，不要开放式提问

本地目录的拉取策略：

- **首次拉取**：session 启动时（或首次需要时），一次性调 `project.list` + 各项目的 `issue.list_in_project` + 活跃 Issue 的 `task.list`，拿到 name/description/id，缓存到记忆
- **增量更新**：Agent 自己创建 Issue/Task 时，立即追加到本地目录
- **全量刷新**：人类提到一个匹配不上的名称时触发刷新；或日常维护时（频率可以很低，比如每天一次）
- **操作代价与置信度挂钩**：验收/状态流转等高代价操作，锚定不确定就问人类；追加指令等中代价操作，中等置信度可先执行、错了可纠正

## 与备选方案（Procedural）的差异

Guided Autonomy 认为 LLM 已经会编排，Skill 只需要提供捷径和护栏；Procedural 认为 LLM 需要明确的步骤指引才能可靠工作。

| 维度 | Guided Autonomy（本方案）| Procedural（备选）|
|---|---|---|
| 流程指导 | 无显式步骤，LLM 自行编排 | Step 3→4→5→...→11 程序性步骤 |
| 密度 | ~200 行 | ~390 行 |
| 决策框架 | 只保留 Light/Heavy 模式差异 | 6 维度表 + 2×2 矩阵 + 4 策略 |
| 消息格式 | 不规定格式，LLM 自行决定 | 汇报模板、澄清格式 |
| 上下文追踪 | 对话历史 + 记忆 + 本地目录语义匹配 | 显式 mapping 结构（leadIssues/workerTasks）|
| 参数获取 | 显式优先级链 + 本地目录兜底 | 隐含在流程步骤中 |
| 记忆整合 | 意图式触发点 | 未涉及 |

两者共享：状态机（完整保留）、角色边界（完整保留）、`references/*.md`（操作指南）。

## 文件

| 文件 | 说明 |
|---|---|
| `SKILL.md` | 单文件 Agent Skill（~200 行）|
| `references/*.md` | 操作指南（各服务团队维护，所有版本共享）|
