# zylos-coco-workspace 能力清单

> **架构说明**：所有接口在架构设计上应通过 **cws-core 作为 BFF 转发**。目前 COMM / TM 已走
> cws-core；**KB 和 AS 的接口尚未在 cws-core 中暴露**，当前直连 cws-kb / cws-as，待
> cws-core 完成代理后统一路由。
>
> CLI 调用方式：`node src/cli/<service>.js <command> '<json>'`
>
> 状态说明：
> - ✅ 后端已实现，可用
> - ⏳ 接口路径已占位，后端尚未实现（调用返回 404）

---

## 1. AS — ArtifactStore（文件存储）

**CLI**：`src/cli/as.js` | **后端**：cws-as（直连，`COCO_AS_URL`）

上传采用三步流程：`POST /artifacts` → `PUT 原始字节` → `POST /finalize`，支持 SHA-256 内容寻址秒传去重。

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `as.upload` | `{filePath, mediaType?, contentType?, description?, metadata?}` | 上传本地文件（3 步流程，含秒传去重） | ✅ |
| `as.list` | `{pageSize?, pageToken?, mime?, status?, producer?}` | 列出 artifact 列表 | ✅ |
| `as.get` | `{artifactId}` | 查看单个 artifact 元数据 | ✅ |
| `as.update` | `{artifactId, name?, description?, metadata?}` | 修改元数据（字节不可变） | ✅ |
| `as.delete` | `{artifactId}` | 软删除（status → deleted） | ✅ |
| `as.url` | `{artifactId, mode?}` | 获取预签名下载 URL（mode: download\|preview） | ✅ |
| `as.download` | `{artifactId, filename?}` | 下载 artifact 字节到本地 | ✅ |
| `as.abort` | `{artifactId}` | 取消进行中的上传 | ✅ |
| `as.resolve` | `{uris: ["as://org/art", ...]}` | 批量解析 `as://` URI 为预签名 URL | ✅ |

> **注**：cws-core 尚未代理 AS 接口，当前直连 cws-as。

---

## 2. COMM — 通信（即时消息）

**CLI**：`src/cli/comm.js` | **后端**：cws-core（`COCO_API_URL`）

响应式 IM（接收用户消息）由 `src/comm-bridge.js` + WebSocket 自动处理；此 CLI 用于主动发消息、查历史等场景。

### 会话管理

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comm.list_conversations` | `{pageSize?, pageToken?}` | 列出所有会话 | ✅ |
| `comm.create_conversation` | `{type, title?, participantIds?}` | 创建群聊/频道（type: dm\|group） | ✅ |
| `comm.create_dm` | `{participantId}` | 与指定用户发起私信（快捷方式） | ✅ |
| `comm.get_conversation` | `{conversationId}` | 获取单个会话详情 | ⏳ |

### 消息

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comm.send` | `{conversationId, content, replyTo?, clientMsgId?}` | 发送消息（支持文本/markdown/媒体，clientMsgId 自动生成） | ✅ |
| `comm.get_messages` | `{conversationId, afterSeq?, beforeSeq?, limit?}` | 拉取消息历史 | ✅ |
| `comm.edit_message` | `{messageId, content}` | 编辑已发消息 | ⏳ |
| `comm.delete_message` | `{messageId}` | 删除消息 | ⏳ |
| `comm.pin` | `{messageId}` | 置顶消息 | ⏳ |
| `comm.unpin` | `{messageId}` | 取消置顶 | ⏳ |
| `comm.mark_read` | `{conversationId, messageId}` | 标记已读 | ⏳ |
| `comm.typing` | `{conversationId, state?}` | 发送正在输入状态 | ⏳ |

### 搜索

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comm.search` | `{q, type?, conversationId?, senderId?, pageSize?, pageToken?}` | 全文搜索消息 | ⏳ |

---

## 3. CORE — 组织/成员/权限目录

**CLI**：`src/cli/core.js` | **后端**：cws-core（`COCO_API_URL`）

提供只读的组织架构查询，是其他服务操作的成员 ID 来源。

### 身份

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.me` | `{}` | 当前身份（workspace + agent 信息） | ✅ |

### 成员目录

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.member_list` | `{orgId?, kind?, status?, search?, cursor?, limit?}` | 列出成员（kind: human\|agent\|all） | ✅ |
| `core.member_get` | `{memberId}` | 获取单个成员详情 | ✅ |
| `core.project_members` | `{projectId}` | 获取项目成员列表 | ✅ |

### 团队

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.team_list` | `{cursor?, limit?}` | 列出团队 | ⏳ |
| `core.team_get` | `{teamId, include?}` | 获取团队详情 | ⏳ |
| `core.team_members` | `{teamId}` | 获取团队成员 | ⏳ |

### Agent

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.agent_list` | `{pageSize?, pageToken?}` | 列出所有 Agent | ✅ |
| `core.agent_get` | `{agentId}` | 获取 Agent 详情 | ⏳ |
| `core.agent_skills` | `{agentId}` | 获取 Agent 技能列表 | ⏳ |
| `core.agent_metrics` | `{agentId}` | 获取 Agent 指标 | ⏳ |

### 项目 / 组织

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.project_list` | `{status?, pageSize?, pageToken?}` | 列出项目（目录视图） | ✅ |
| `core.org_list` | `{}` | 列出组织 | ✅ |
| `core.org_get` | `{orgId}` | 获取组织详情 | ✅ |

---

## 4. KB — 知识库

**CLI**：`src/cli/kb.js` | **后端**：cws-kb（直连，`COCO_KB_URL`）

基于 PostgreSQL + Meilisearch + NATS，支持全文搜索和版本历史。`org_id` 是所有操作的 scope 单位。

> **注**：cws-core 尚未代理 KB 接口，当前直连 cws-kb。

### KB 集合

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.init` | `{orgId?}` | 初始化组织知识库 | ✅ |
| `kb.list` | `{orgId?, status?}` | 列出知识库（status: active\|archived\|all） | ✅ |
| `kb.archive` | `{orgId?}` | 归档知识库 | ✅ |
| `kb.unarchive` | `{orgId?}` | 取消归档 | ✅ |

### 目录树

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.tree_roots` | `{orgId?}` | 获取目录树根节点 | ✅ |
| `kb.folder_create` | `{parentId, name, sortOrder?, orgId?}` | 创建文件夹节点 | ✅ |
| `kb.node_get` | `{nodeId, orgId?}` | 获取单个树节点 | ✅ |
| `kb.node_breadcrumb` | `{nodeId, orgId?}` | 获取节点路径（面包屑） | ✅ |
| `kb.node_children` | `{parentId, orgId?, pageSize?, pageToken?}` | 列出子节点 | ✅ |
| `kb.node_move` | `{nodeId, parentId, sortOrder?, orgId?}` | 移动节点 | ✅ |
| `kb.node_rename` | `{nodeId, name, orgId?}` | 重命名节点 | ✅ |
| `kb.node_delete` | `{nodeId, orgId?}` | 删除节点（含子树） | ✅ |

### 页面

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.pages` | `{parentId?, orgId?, pageSize?, pageToken?}` | 列出页面 | ✅ |
| `kb.page_get` | `{pageId, orgId?}` | 获取页面元数据 | ✅ |
| `kb.page_create` | `{title, parentId, format?, content:{body, front_matter?}, commitMessage?, orgId?}` | 创建页面（含初始内容） | ✅ |
| `kb.page_update` | `{pageId, title?, parentId?, content?, baseRevisionId, commitMessage?, orgId?}` | 更新页面属性/内容（乐观锁） | ✅ |
| `kb.page_delete` | `{pageId, orgId?}` | 删除页面 | ✅ |
| `kb.page_content` | `{pageId, orgId?}` | 读取页面正文 | ✅ |
| `kb.page_content_write` | `{pageId, content:{body, front_matter?}, baseRevisionId, commitMessage?, orgId?}` | 仅更新页面内容（适合大段编辑） | ✅ |
| `kb.page_revisions` | `{pageId, orgId?, pageSize?, pageToken?}` | 列出历史版本 | ✅ |
| `kb.page_revision` | `{pageId, revisionId, orgId?}` | 获取特定版本内容 | ✅ |
| `kb.page_diff` | `{pageId, fromRevisionId, toRevisionId, orgId?}` | 对比两个版本差异 | ✅ |
| `kb.page_restore` | `{pageId, revisionId, commitMessage?, orgId?}` | 恢复到历史版本 | ✅ |

### 搜索

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.search` | `{query, folderId?, authorId?, format?, pageSize?, pageToken?, sync?, orgId?}` | 全文搜索（Meilisearch，`sync=true` 等待索引就绪后返回，适合 Agent 刚写完立即搜） | ✅ |

### 关联关系

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.relations_list` | `{resourceType?, resourceId?, targetType?, targetId?, orgId?}` | 列出关联关系 | ✅ |
| `kb.relations_create` | `{resourceType, resourceId, targetType, targetId, role, orgId?}` | 创建关联（如 Project ↔ KB folder） | ✅ |
| `kb.relations_check` | 同 list | 检查关联是否存在 | ✅ |
| `kb.relations_delete` | `{resourceType, resourceId, targetType, targetId, role?, orgId?}` | 删除关联 | ✅ |

### 文件附件

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.upload` | `{filePath, mediaType?, contentType?, description?, nodeId?, pageId?, orgId?}` | 上传文件（委托给 as.upload，返回 artifactId 供页面引用） | ✅ |

---

## 5. TM — 任务管理

**CLI**：`src/cli/tm.js` | **后端**：cws-core（`COCO_API_URL`）

Project 全部可用；Issue 读操作可用；Task 写操作及 Blueprint/Attempt/Comment 等均等待 cws-core 实现。

### Project

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `project.list` | `{status?, pageSize?, pageToken?}` | 列出项目 | ✅ |
| `project.create` | `{name, description?, icon?, leadIds?, memberIds?}` | 创建项目 | ✅ |
| `project.get` | `{id}` | 获取项目详情 | ✅ |
| `project.update` | `{id, description?, icon?, leadIds?, memberIds?}` | 更新项目 | ✅ |
| `project.archive` | `{id}` | 归档项目 | ✅ |
| `project.restore` | `{id}` | 恢复归档项目（alias: `project.unarchive`） | ✅ |
| `project.members` | `{id}` | 获取项目成员 | ✅ |

### Issue

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `issue.list` | `{status?, assigneeId?, pageSize?, pageToken?}` | 全局 Issue 列表（跨项目） | ✅ |
| `issue.list_in_project` | `{projectId, status?, archived?, pageSize?, pageToken?}` | 项目内 Issue 列表 | ✅ |
| `issue.get` | `{projectId, id}` | 获取 Issue 详情 | ✅ |
| `issue.create` | `{projectId, title, description?, mode, leadAgentId, originConversationId?, ...}` | 创建 Issue | ⏳ |
| `issue.update` | `{projectId, id, title?, description?}` | 更新 Issue | ⏳ |
| `issue.transition` | `{projectId, id, status}` | Issue 状态流转 | ⏳ |
| `issue.move_project` | `{projectId, id, targetProjectId}` | Issue 跨项目移动 | ⏳ |
| `issue.set_acceptance` | `{projectId, id, accepted, source}` | 设置 Issue 验收结果 | ⏳ |

### Task

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `task.list` | `{projectId?, issueId?, status?, assigneeId?, pageSize?, pageToken?}` | 列出任务 | ✅ |
| `task.get` | `{id}` | 获取任务详情 | ⏳ |
| `task.create` | `{issueId?, projectId?, title, description?, assigneeId?, skillTags?, mode?, priority?, ...}` | 创建任务 | ⏳ |
| `task.transition` | `{id, status}` | 任务状态流转（alias: `task.status`） | ⏳ |
| `task.archive` | `{id}` | 归档任务 | ⏳ |
| `task.subtask_create` | `{id, title, assigneeId?, status?}` | 创建子任务 | ⏳ |
| `task.claim` | `{id, assigneeId}` | 认领任务 | ⏳ |
| `task.reassign` | `{id, assigneeId}` | 重新分配任务 | ⏳ |

### Blueprint（蓝图）

| 命令 | 描述 | 状态 |
|------|------|------|
| `blueprint.create` | 为 Issue 创建执行蓝图 | ⏳ |
| `blueprint.get` | 获取蓝图详情 | ⏳ |
| `blueprint.list` | 列出蓝图 | ⏳ |
| `blueprint.add_step` | 添加蓝图步骤 | ⏳ |
| `blueprint.update_step` | 更新蓝图步骤 | ⏳ |
| `blueprint.delete_step` | 删除蓝图步骤 | ⏳ |
| `blueprint.set_step_depends_on` | 设置步骤依赖关系 | ⏳ |
| `blueprint.set_estimated_budget` | 设置预估成本 | ⏳ |
| `blueprint.set_notes` | 设置备注 | ⏳ |
| `blueprint.render_markdown` | 渲染蓝图为 Markdown | ⏳ |
| `blueprint.submit_for_approval` | 提交蓝图审批 | ⏳ |
| `blueprint.create_amendment` | 创建蓝图修正版本 | ⏳ |

### Attempt / Comment / Link / TaskBoard / System

| 命令 | 描述 | 状态 |
|------|------|------|
| `attempt.create/get/list/transition` | 执行尝试（Attempt）生命周期管理 | ⏳ |
| `comment.append/list` | 工作项评论 | ⏳ |
| `link.create/list` | 工作项与会话关联 | ⏳ |
| `taskboard.list` | 任务看板视图 | ⏳ |
| `system.initialize_workspace` | 初始化工作区 | ⏳ |
| `system.approval_decision` | 蓝图审批决策 | ⏳ |
| `system.auto_archive` | 自动归档过期工作项 | ⏳ |

---

## 统计汇总

| 服务 | 已实现 | 总计 | 覆盖率 |
|------|--------|------|--------|
| AS   | 9      | 9    | 100%   |
| COMM | 5      | 13   | 38%    |
| CORE | 8      | 14   | 57%    |
| KB   | 29     | 29   | 100%   |
| TM   | 11     | 34   | 32%    |
| **合计** | **62** | **99** | **63%** |

> COMM / CORE / TM 的 ⏳ 项均已在 CLI 中占好路径和参数，等 cws-core 实装后即可直接使用，无需改动客户端代码。
