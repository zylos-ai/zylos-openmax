# zylos-coco-workspace 能力清单

> **架构说明**：
> - **COMM**：直连 cws-comm（`COCO_COMM_URL`）
> - **TM 读操作**（project/issue/task 列表与详情）：通过 cws-core BFF（`COCO_API_URL`）
> - **TM 写操作**（issue/task/blueprint/attempt/comment/link 增删改）：直连 cws-work（`COCO_WORK_URL`），cws-core 尚未代理这些端点
> - **KB**：直连 cws-kb（`COCO_KB_URL`），cws-core 尚未代理
> - **AS**：直连 cws-as（`COCO_AS_URL`），cws-core 尚未代理
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
| `as.batch` | `{artifactIds: [...]}` | 批量获取多个 artifact 元数据 | ✅ |
| `as.update` | `{artifactId, name?, description?, metadata?}` | 修改元数据（字节不可变） | ✅ |
| `as.delete` | `{artifactId}` | 软删除（status → deleted） | ✅ |
| `as.url` | `{artifactId, mode?}` | 获取预签名下载 URL（mode: download\|preview） | ✅ |
| `as.download` | `{artifactId, filename?}` | 下载 artifact 字节到本地 | ✅ |
| `as.abort` | `{artifactId}` | 取消进行中的上传 | ✅ |
| `as.resolve` | `{uris: ["as://org/art", ...]}` | 批量解析 `as://` URI 为预签名 URL | ✅ |

---

## 2. COMM — 通信（即时消息）

**CLI**：`src/cli/comm.js` | **后端**：cws-comm（直连，`COCO_COMM_URL`）

响应式 IM（接收用户消息）由 `src/comm-bridge.js` + WebSocket 自动处理；此 CLI 用于主动发消息、查历史等场景。

### 会话管理

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comm.list_conversations` | `{pageSize?, pageToken?}` | 列出所有会话 | ✅ |
| `comm.create_conversation` | `{type, title?, participantIds?}` | 创建群聊/频道 | ✅ |
| `comm.create_dm` | `{participantId}` | 与指定用户发起私信 | ✅ |
| `comm.get_conversation` | `{conversationId}` | 获取单个会话详情 | ✅ |
| `comm.archive_conversation` | `{conversationId}` | 归档会话 | ✅ |
| `comm.pin_conversation` | `{conversationId}` | 置顶会话 | ✅ |
| `comm.unpin_conversation` | `{conversationId}` | 取消置顶会话 | ✅ |
| `comm.mute_conversation` | `{conversationId}` | 免打扰 | ✅ |
| `comm.unmute_conversation` | `{conversationId}` | 取消免打扰 | ✅ |
| `comm.mark_read` | `{conversationId, readUntilSeq}` | 标记已读 | ✅ |
| `comm.unread_count` | `{conversationId}` | 获取未读数 | ✅ |

### 消息

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comm.send` | `{conversationId, content, replyTo?, clientMsgId?}` | 发送消息 | ✅ |
| `comm.get_messages` | `{conversationId, afterSeq?, beforeSeq?, limit?}` | 拉取消息历史 | ✅ |
| `comm.get_message` | `{messageId}` | 获取单条消息 | ✅ |
| `comm.edit_message` | `{messageId, content}` | 编辑已发消息 | ✅ |
| `comm.delete_message` | `{messageId}` | 撤回消息 | ✅ |
| `comm.pin_message` | `{messageId}` | 置顶消息 | ✅ |
| `comm.unpin_message` | `{messageId}` | 取消置顶消息 | ✅ |
| `comm.list_pinned` | `{conversationId}` | 列出置顶消息 | ✅ |
| `comm.typing` | `{conversationId}` | 发送正在输入状态 | ✅ |
| `comm.search` | `{q, conversationIds?, senderIds?, types?, limit?, cursor?}` | 全文搜索消息 | ✅ |

### 通知

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comm.list_notifications` | `{pageSize?, pageToken?}` | 列出通知 | ✅ |
| `comm.mark_notification_read` | `{notificationId}` | 标记通知已读 | ✅ |
| `comm.mark_all_notifications_read` | `{}` | 全部标记已读 | ✅ |
| `comm.notification_unread_count` | `{}` | 获取未读通知数 | ✅ |

### 群组

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comm.create_group` | `{name, memberIds?}` | 创建群组 | ✅ |
| `comm.get_group` | `{groupId}` | 获取群组详情 | ✅ |
| `comm.update_group` | `{groupId, name?}` | 更新群组 | ✅ |
| `comm.add_group_member` | `{groupId, memberId}` | 添加群成员 | ✅ |
| `comm.remove_group_member` | `{groupId, memberId}` | 移除群成员 | ✅ |
| `comm.list_group_members` | `{groupId}` | 列出群成员 | ✅ |

### 媒体

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comm.media_upload` | `{filePath, contentType?}` | 上传媒体文件 | ✅ |
| `comm.media_get` | `{mediaId}` | 获取媒体元数据 | ✅ |
| `comm.media_download_url` | `{mediaId}` | 获取媒体下载 URL | ✅ |
| `comm.media_delete` | `{mediaId}` | 删除媒体 | ✅ |

---

## 3. CORE — 组织/成员/权限目录

**CLI**：`src/cli/core.js` | **后端**：cws-core（`COCO_API_URL`）

### 身份

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.me` | `{}` | 当前身份信息 | ✅ |

### 成员目录

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.member_list` | `{orgId?, kind?, status?, search?, cursor?, limit?}` | 列出成员 | ✅ |
| `core.member_get` | `{memberId}` | 获取单个成员详情 | ✅ |
| `core.project_members` | `{projectId}` | 获取项目成员列表 | ✅ |
| `core.role_list` | `{}` | 列出组织角色 | ✅ |

### 邀请

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.invitation_create` | `{email, roleId?}` | 邀请成员加入组织 | ✅ |
| `core.invitation_list` | `{}` | 列出待处理邀请 | ✅ |
| `core.invitation_accept` | `{invitationId}` | 接受邀请 | ✅ |

### Agent

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.agent_list` | `{pageSize?, pageToken?}` | 列出所有 Agent | ✅ |

### 项目 / 组织

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `core.project_list` | `{status?, pageSize?, pageToken?}` | 列出项目 | ✅ |
| `core.project_create` | `{name, description?}` | 创建项目 | ✅ |
| `core.project_get` | `{projectId}` | 获取项目详情 | ✅ |
| `core.project_archive` | `{projectId}` | 归档项目 | ✅ |
| `core.project_restore` | `{projectId}` | 恢复归档项目 | ✅ |
| `core.org_list` | `{}` | 列出我的组织 | ✅ |
| `core.org_get` | `{orgId}` | 获取组织详情 | ✅ |
| `core.org_create` | `{name, description?}` | 创建组织 | ✅ |

---

## 4. KB — 知识库

**CLI**：`src/cli/kb.js` | **后端**：cws-kb（直连，`COCO_KB_URL`）

> **注**：cws-core 尚未代理 KB 接口。

### KB 集合

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.init` | `{orgId?}` | 初始化组织知识库 | ✅ |
| `kb.list` | `{orgId?, status?}` | 列出知识库 | ✅ |
| `kb.get` | `{kbId}` | 获取知识库详情 | ✅ |
| `kb.archive` | `{orgId?}` | 归档知识库 | ✅ |
| `kb.unarchive` | `{orgId?}` | 取消归档 | ✅ |

### 目录树

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.tree` | `{orgId?}` | 获取完整目录树 | ✅ |
| `kb.tree_roots` | `{orgId?}` | 获取根节点列表 | ✅ |
| `kb.folder_create` | `{parentId, name, sortOrder?, orgId?}` | 创建文件夹 | ✅ |
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
| `kb.page_create` | `{title, parentId, format?, content:{body, front_matter?}, commitMessage?, orgId?}` | 创建页面 | ✅ |
| `kb.page_update` | `{pageId, title?, parentId?, content?, baseRevisionId, commitMessage?, orgId?}` | 更新页面（乐观锁） | ✅ |
| `kb.page_delete` | `{pageId, orgId?}` | 删除页面（移入回收站） | ✅ |
| `kb.page_delete_permanent` | `{pageId, orgId?}` | 永久删除页面 | ✅ |
| `kb.page_content` | `{pageId, orgId?}` | 读取页面正文 | ✅ |
| `kb.page_content_write` | `{pageId, content:{body, front_matter?}, baseRevisionId, commitMessage?, orgId?}` | 仅更新页面内容 | ✅ |
| `kb.page_freeze` | `{pageId, orgId?}` | 冻结页面（只读锁） | ✅ |
| `kb.page_references` | `{pageId, orgId?}` | 列出引用该页面的其他页面 | ✅ |
| `kb.trash_list` | `{orgId?, pageSize?, pageToken?}` | 列出回收站页面 | ✅ |
| `kb.trash_restore` | `{pageId, orgId?}` | 从回收站恢复页面 | ✅ |

### 版本历史

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.page_revisions` | `{pageId, orgId?, pageSize?, pageToken?}` | 列出历史版本 | ✅ |
| `kb.page_revision` | `{pageId, revisionId, orgId?}` | 获取特定版本内容 | ✅ |
| `kb.page_diff` | `{pageId, fromRevisionId, toRevisionId, orgId?}` | 对比两个版本差异 | ✅ |
| `kb.page_restore` | `{pageId, revisionId, commitMessage?, orgId?}` | 恢复到历史版本 | ✅ |

### 搜索

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.search` | `{query, folderId?, authorId?, format?, pageSize?, pageToken?, sync?, orgId?}` | 全文搜索（`sync=true` 等待索引就绪） | ✅ |

### 关联关系

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.relations_list` | `{resourceType?, resourceId?, targetType?, targetId?, orgId?}` | 列出关联关系 | ✅ |
| `kb.relations_create` | `{resourceType, resourceId, targetType, targetId, role, orgId?}` | 创建关联 | ✅ |
| `kb.relations_check` | `{resourceType, resourceId, targetType, targetId, role?, orgId?}` | 检查关联是否存在 | ✅ |
| `kb.relations_delete` | `{resourceType, resourceId, targetType, targetId, role?, orgId?}` | 删除关联 | ✅ |

### 文件附件 / Agent 存储

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `kb.upload` | `{filePath, mediaType?, contentType?, description?, nodeId?, pageId?, orgId?}` | 上传文件（委托 as.upload） | ✅ |
| `kb.agent_store` | `{content, title?, metadata?, orgId?}` | Agent 直接写入知识库（无需创建页面） | ✅ |
| `kb.archive_task_output` | `{taskId, content, metadata?, orgId?}` | 归档任务输出到 KB | ✅ |

---

## 5. TM — 任务管理

**CLI**：`src/cli/tm.js`

| 操作类型 | 后端 | URL |
|---|---|---|
| Project / Issue / Task 读操作 | cws-core（BFF） | `COCO_API_URL` |
| Issue / Task / Blueprint / Attempt / Comment / Link 写操作 | cws-work（直连） | `COCO_WORK_URL` |

### Project

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `project.list` | `{status?, pageSize?, pageToken?}` | 列出项目 | ✅ |
| `project.create` | `{name, description?, icon?, leadIds?, memberIds?}` | 创建项目 | ✅ |
| `project.get` | `{id}` | 获取项目详情 | ✅ |
| `project.update` | `{id, description?, icon?}` | 更新项目 | ✅ |
| `project.archive` | `{id}` | 归档项目 | ✅ |
| `project.restore` | `{id}` | 恢复归档项目 | ✅ |
| `project.members` | `{id}` | 获取项目成员 | ✅ |

### Issue

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `issue.list` | `{status?, assigneeId?, pageSize?, pageToken?}` | 全局 Issue 列表 | ✅ |
| `issue.list_in_project` | `{projectId, status?, archived?, pageSize?, pageToken?}` | 项目内 Issue 列表 | ✅ |
| `issue.get` | `{id}` | 获取 Issue 详情 | ✅ |
| `issue.create` | `{projectId, title, description?, mode, leadAgentId, originConversationId?}` | 创建 Issue | ✅ |
| `issue.update` | `{id, title?, description?}` | 更新 Issue | ✅ |
| `issue.transition` | `{id, status}` | Issue 状态流转 | ✅ |
| `issue.move_project` | `{id, targetProjectId}` | Issue 跨项目移动 | ✅ |
| `issue.set_acceptance` | `{id, accepted, source}` | 设置 Issue 验收结果 | ✅ |

### Task

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `task.list` | `{projectId?, issueId?, status?, assigneeId?, pageSize?, pageToken?}` | 列出任务 | ✅ |
| `task.get` | `{id}` | 获取任务详情 | ✅ |
| `task.create` | `{issueId, title, description?, assigneeId?, skillTags?, blueprintStepId?, dependsOn?}` | 创建任务 | ✅ |
| `task.transition` | `{id, status}` | 任务状态流转 | ✅ |
| `task.claim` | `{id, assigneeId}` | 认领任务 | ✅ |
| `task.reassign` | `{id, assigneeId}` | 重新分配任务 | ✅ |
| `taskboard.list` | `{projectId?, issueId?}` | 任务看板视图 | ✅ |

### Blueprint（蓝图）

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `blueprint.create` | `{issueId, title, description?}` | 为 Issue 创建执行蓝图 | ✅ |
| `blueprint.get` | `{id}` | 获取蓝图详情 | ✅ |
| `blueprint.list` | `{issueId}` | 列出蓝图版本 | ✅ |
| `blueprint.add_step` | `{blueprintId, title, description?, assigneeId?, skillTags?}` | 添加蓝图步骤 | ✅ |
| `blueprint.update_step` | `{stepId, title?, description?, skillTags?}` | 更新蓝图步骤 | ✅ |
| `blueprint.delete_step` | `{stepId}` | 删除蓝图步骤 | ✅ |
| `blueprint.set_step_depends_on` | `{stepId, dependsOn: [...]}` | 设置步骤依赖关系 | ✅ |
| `blueprint.set_estimated_budget` | `{blueprintId, budget}` | 设置预估成本 | ✅ |
| `blueprint.set_notes` | `{blueprintId, notes}` | 设置备注 | ✅ |
| `blueprint.render_markdown` | `{blueprintId}` | 渲染蓝图为 Markdown | ✅ |
| `blueprint.submit_for_approval` | `{blueprintId}` | 提交蓝图审批 | ✅ |
| `blueprint.create_amendment` | `{blueprintId, reason?}` | 创建蓝图修正版本 | ✅ |

### Attempt（执行尝试）

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `attempt.create` | `{taskId, assigneeId}` | 创建执行尝试 | ✅ |
| `attempt.get` | `{id}` | 获取尝试详情 | ✅ |
| `attempt.list` | `{taskId}` | 列出任务的所有尝试 | ✅ |
| `attempt.transition` | `{id, status}` | 尝试状态流转 | ✅ |

### Comment / Link / System

| 命令 | 参数 | 描述 | 状态 |
|------|------|------|------|
| `comment.append` | `{resourceType, resourceId, content}` | 添加评论 | ✅ |
| `comment.list` | `{resourceType, resourceId}` | 列出评论 | ✅ |
| `link.create` | `{resourceType, resourceId, conversationId, role?}` | 关联工作项与会话 | ✅ |
| `link.list` | `{resourceType, resourceId}` | 列出关联 | ✅ |
| `system.initialize_workspace` | `{orgId}` | 初始化工作区 | ✅ |
| `system.approval_decision` | `{blueprintId, approved, comment?}` | 蓝图审批决策 | ✅ |
| `system.auto_archive` | `{}` | 自动归档过期工作项 | ✅ |

---

## 统计汇总

| 服务 | 已实现 | 总计 | 覆盖率 |
|------|--------|------|--------|
| AS   | 10     | 10   | 100%   |
| COMM | 30     | 30   | 100%   |
| CORE | 16     | 16   | 100%   |
| KB   | 35     | 35   | 100%   |
| TM   | 34     | 34   | 100%   |
| **合计** | **125** | **125** | **100%** |

> 最后更新：2026-05-22，对照各服务 main 分支（cws-as `fc1020e`、cws-comm `bfb6db2`、cws-core `35ca93b`、cws-kb `1554242`、cws-work `18377d2`）
