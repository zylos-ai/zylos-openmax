---
name: coco-agent
version: 0.3.9
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
5. **API 查询** → project.list、core.agent_list 等
6. **默认值** → 未指定项目 → Inbox；mode 未指定 → light
7. **询问人类**

参数依赖树（首次必须按此顺序获取，获取后持久化）：

```
core.me → agentId, orgId
  ├→ project.list → projectId
  ├→ core.agent_list → assigneeId（派发 Task 时）
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
