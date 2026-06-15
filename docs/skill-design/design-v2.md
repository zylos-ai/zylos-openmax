# Skill 设计（备选）：Procedural Skill

> 设计规范源：`docs/skill-design/agent-skill-spec.md`
> 默认方案：`docs/skill-design/design.md`（Guided Autonomy）

## 范式：Procedural Skill（程序性技能）

Skill 完整定义 Agent 在每个阶段做什么、怎么判断、下一步去哪：

- **程序性流程** — Lead Step 3→11、Worker Step 3→7，每个 Step 有明确的判断条件和分支
- **决策框架** — 6 维度信息完备度检查 + 编排/审批 2×2 矩阵 + 4 种执行策略
- **格式规范** — 澄清消息格式、汇报模板、进度话术

Agent 在任意时刻能定位到"我在 Step 几"，按 Step 指引行动。

## 设计原则

### 1. 程序性优先

借鉴 Paperclip 的 heartbeat 流程设计。每个 Step 有：判断条件（什么时候进入）、行为规范（做什么）、出口条件（什么时候离开，去哪个 Step）。

### 2. 忠实于状态机

所有状态流转与 cws-work 实际实现对齐（proto enum + domain 层逻辑）。

### 3. CLI 同步

操作指南（`references/*.md`）命令清单与 `src/cli/*.js` 保持 1:1 对应。

## 与默认方案（Guided Autonomy）的差异

Procedural 认为 LLM 需要明确的步骤指引才能可靠工作；Guided Autonomy 认为 LLM 已经会编排，Skill 只需要提供捷径和护栏。

| 维度 | Procedural（本方案）| Guided Autonomy（默认）|
|---|---|---|
| 流程指导 | Step 3→4→5→...→11 程序性步骤 | 无显式步骤，LLM 自行编排 |
| 密度 | ~390 行 | ~200 行 |
| 决策框架 | 6 维度表 + 2×2 矩阵 + 4 策略 | 只保留 Light/Heavy 模式差异 |
| 消息格式 | 汇报模板、澄清格式 | 不规定格式，LLM 自行决定 |
| 上下文追踪 | 显式 mapping 结构（leadIssues/workerTasks）| 对话历史 + 记忆 + 本地目录语义匹配 |
| 参数获取 | 隐含在流程步骤中 | 显式优先级链 + 本地目录兜底 |
| 记忆整合 | 未涉及 | 意图式触发点 |
| 异常处理 | Lead 4 类 + Worker 5 类，逐类降级 | 仅保留常见错误表 + API 降级策略 |

两者共享：状态机（完整保留）、角色边界（完整保留）、`references/*.md`（操作指南）。

## 当前 API 可用性

cws-work 侧所有域（Project/Issue/Task/Attempt/Blueprint/Comment/Link/System）已全部实现。瓶颈在 cws-core 网关层——所有 stub 均返回 501 Not Implemented。

SKILL.md 描述的是目标行为流程，references 标注实际可用性，降级策略覆盖不可用场景。

## 文件

| 文件 | 说明 |
|---|---|
| `SKILL.md` | 程序性 Agent Skill（~390 行）|
| `references/*.md` | 操作指南（各服务团队维护，所有版本共享）|
