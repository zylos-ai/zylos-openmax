---
name: coco-workspace
version: 0.1.0
description: >-
  COCO Workspace agent plugin. Wraps cws-core OpenAPI for IM, Tasks, Projects,
  and (forward-compat) KB/Teams/Blueprints. All file upload/download goes
  through src/cli/as.js (single source of truth). Lead/Worker lifecycle.
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
  preserve:
    - config.json

upgrade:
  repo: coco-workspace/zylos-coco-workspace
  branch: main

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
1. 必读：项目规范 + 已有材料 → 加载 `references/kb-operations.md`
2. 应读：历史经验（同类 Issue 的 lessons）→ 加载 `references/tm-operations.md`
3. 可选：团队成员详情 → 加载 `references/core-operations.md`

### 决策

两个正交决策：
- 编排：直接执行 vs Blueprint（单步骤 vs 多步骤）
- 审批：自动启动 vs 需要人类审批（低风险 vs 高影响）

决策完成后执行 TM 操作 → 加载 `references/tm-operations.md`

### 执行

- 自做：创建 Issue + Task(assignee=self)，直接执行
- 派发：创建 Issue + Task(assignee=worker)，通过 IM 通知 Worker
- Blueprint：创建 Issue + Blueprint + Steps → 审批后实例化为 Task

执行中的产出写入 → 加载 `references/kb-operations.md` 或 `references/as-operations.md`

### 交付

通过 IM 发送交付消息：结果摘要 + 产出位置 + 关键发现。
Issue 状态 → delivered。在 TM Comment 记录交付摘要。

### 验收

识别人类反馈：
- "好的"、"可以" → accepted → 进入经验沉淀
- "不对"、"缺了 X" → rejected → 创建新 Task 补充执行

### 经验沉淀

Issue 被 accepted 后，评估是否有值得沉淀的经验（踩坑、被拒收原因、可复用模式）。
写入 KB → 加载 `references/kb-operations.md`

## Worker 生命周期

```
接收任务 → 理解上下文 → 请求澄清（如需） → 执行 → 汇报
```

### 接收任务

收到 Lead 的派发消息后，通过 TM 领取 Task → 加载 `references/tm-operations.md`

### 理解上下文

读取 Task 描述 + Lead 指定的 KB 材料 → 加载 `references/kb-operations.md`

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

## 操作指南索引(Layer 3,按需加载)

当你需要执行具体的服务操作时,加载对应的操作指南。每份指南都按 ✅(cws-core 已暴露) / ⏳(暂未暴露,调用会 404) 标记了每条命令的状态。

| 需要做什么 | 加载 | 当前状态摘要 |
| --- | --- | --- |
| 通信(主动发消息、会话管理) | `references/comm-operations.md` | ✅ 收发消息 / 列会话 · ⏳ edit / pin / read / typing / search |
| 文件上传下载(IM 附件、KB 文件) | `references/as-operations.md` | ⏳ 全部(media 端点未暴露)。仓库**唯一**上传入口 |
| 任务管理(Issue / Task / Blueprint) | `references/tm-operations.md` | ✅ Project 全套 + Issue/Task 读 · ⏳ 所有写工作流 |
| 组织信息(成员、Agent、项目) | `references/core-operations.md` | ✅ me/members/agents/projects 读 · ⏳ teams / agent 详情 |
| KB(知识库) | `references/kb-operations.md` | ⏳ 全部(core 尚无 KB 域) |

接口契约权威源:cws-core OpenAPI(`https://zylos01.jinglever.com/cws-core/openapi.json`)。
整体接口覆盖对比见 `docs/cws-core-api-gaps.md`。

## 实现要点(关键约定)

- **认证**:Bearer api_key(env `COCO_AUTH_TOKEN`),所有 REST + WS upgrade 同一把 key
- **WS 鉴权**:cws-comm api-usage-guide §6 直连模式,header 带 Bearer,首帧 connect frame token = api_key
- **路径前缀**:默认 `/api/v1`(env `COCO_API_PREFIX` 可覆盖)
- **文件 IO**:**只用 `src/cli/as.js`**(`uploadMedia` / `getMediaUrl` / `downloadMedia`),不要重复造实现
- **C4 channel name**:`coco-workspace`(必须跟组件安装目录名一致)
- **配置存放**:
  - `~/zylos/components/coco-workspace/config.json` — workspace_id, device_id, client_id
  - `~/zylos/.env` — COCO_AUTH_TOKEN(敏感凭证)
