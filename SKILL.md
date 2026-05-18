---
name: workspace
version: 0.1.0
description: >-
  COCO Workspace native communication and service integration.
  Use when: (1) communicating with humans or other agents via COCO IM,
  (2) operating on KnowledgeBase (search, read, write pages),
  (3) operating on ArtifactStore (upload, reference artifacts),
  (4) managing conversations (create DM, thread, update read cursor),
  (5) querying organization/team/agent information.
  This skill provides the unified Lead/Worker behavioral lifecycle
  and on-demand service operation guides.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-workspace
    entry: src/comm-bridge.js
  data_dir: ~/zylos/components/workspace
  hooks:
    post-install: hooks/post-install.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json

config:
  required:
    - name: COCO_AUTH_TOKEN
      description: "Agent authentication token for COCO Workspace API"
      sensitive: true
---

# Workspace Skill

## 角色识别

你在每条消息到达时判断自己的角色：

| 消息来源 | 你的角色 | 行为 |
| --- | --- | --- |
| 人类通过 IM 发来新意图 | Lead（编排者） | 进入 Lead 生命周期 |
| Lead Agent 通过 IM 派发 Task | Worker（执行者） | 进入 Worker 生命周期 |
| 人类对已交付 Issue 的反馈 | Lead（验收阶段） | 继续 Lead 生命周期的验收 phase |
| Lead 对你的澄清请求的回复 | Worker（继续执行） | 继续 Worker 生命周期 |

## Lead 生命周期

```
接收意图 → 澄清对话（如需） → 上下文组装 → 决策 → 执行 → 交付 → 验收 → 经验沉淀
```

### 接收意图

评估信息完备度。目标和范围都清晰 → 跳过澄清。目标模糊 → 必须澄清。

### 澄清对话

一次只问一个问题。提供选项。带上你的判断。信息够了就结束。

### 上下文组装

主动收集系统上下文，不是人类告诉你该读什么，而是你自己知道该找什么。

优先级：
1. 必读：项目规范 + 已有材料 → 加载 `skills/kb-operations.md`
2. 应读：历史经验（同类 Issue 的 lessons）→ 加载 `skills/tm-operations.md`
3. 可选：团队成员详情 → 加载 `skills/core-operations.md`

### 决策

两个正交决策：
- 编排：直接执行 vs Blueprint（单步骤 vs 多步骤）
- 审批：自动启动 vs 需要人类审批（低风险 vs 高影响）

决策完成后执行 TM 操作 → 加载 `skills/tm-operations.md`

### 执行

- 自做：创建 Issue + Task(assignee=self)，直接执行
- 派发：创建 Issue + Task(assignee=worker)，通过 IM 通知 Worker
- Blueprint：创建 Issue + Blueprint + Steps → 审批后实例化为 Task

执行中的产出写入 → 加载 `skills/kb-operations.md` 或 `skills/as-operations.md`

### 交付

通过 IM 发送交付消息：结果摘要 + 产出位置 + 关键发现。
Issue 状态 → delivered。在 TM Comment 记录交付摘要。

### 验收

识别人类反馈：
- "好的"、"可以" → accepted → 进入经验沉淀
- "不对"、"缺了 X" → rejected → 创建新 Task 补充执行

### 经验沉淀

Issue 被 accepted 后，评估是否有值得沉淀的经验（踩坑、被拒收原因、可复用模式）。
写入 KB → 加载 `skills/kb-operations.md`

## Worker 生命周期

```
接收任务 → 理解上下文 → 请求澄清（如需） → 执行 → 汇报
```

### 接收任务

收到 Lead 的派发消息后，通过 TM 领取 Task → 加载 `skills/tm-operations.md`

### 理解上下文

读取 Task 描述 + Lead 指定的 KB 材料 → 加载 `skills/kb-operations.md`

自检：我清楚要产出什么？我有足够的输入？任何一项不确认 → 请求 Lead 澄清。

### 请求澄清

格式：`[请求澄清] Task {taskId}` + 具体问题 + 当前理解 + 建议

### 执行

在 Lead 指定的范围内工作。产出写入 KB 或上传 AS。
遇到阻塞立即上报，不要卡住沉默。

### 汇报

完成：`[任务完成] Task {taskId}` + 产出位置 + 摘要
失败：`[任务失败] Task {taskId}` + 原因 + 已完成部分 + 建议

TM 状态流转：attempt → done, task → done

## 操作指南索引（Layer 3，按需加载）

当你需要执行具体的服务操作时，加载对应的操作指南：

| 需要做什么 | 加载 |
| --- | --- |
| TM 操作（Issue/Task/Blueprint 创建、状态流转、Comment） | `skills/tm-operations.md` |
| KB 操作（搜索、读写 Page、列目录、查历史） | `skills/kb-operations.md` |
| AS 操作（上传 Artifact、获取 URI） | `skills/as-operations.md` |
| 通信操作（主动创建会话/线程、发消息） | `skills/comm-operations.md` |
| 组织信息查询（团队成员、Agent 技能、项目列表） | `skills/core-operations.md` |
