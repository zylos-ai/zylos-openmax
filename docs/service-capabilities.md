# zylos-coco-workspace 能力清单

> **架构说明**：
> - **COMM**：直连 cws-comm（`COCO_COMM_URL`）
> - **TM 读操作**（project/issue/task 列表与详情）：通过 cws-core BFF（`COCO_API_URL`）
> - **TM 写操作**（issue/task/blueprint 增删改）：直连 cws-work（`COCO_WORK_URL`），cws-core 尚未代理这些端点
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

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `as.upload` | `{filePath, mediaType?, contentType?, description?, metadata?}` | 上传本地文件（3 步流程，含秒传去重） | `{id, name, mime_type, size_bytes, content_hash, status, storage_uri, producer_type, artifact_class, scan_status, created_at, updated_at}` | ✅ |
| `as.list` | `{pageSize?, pageToken?, mime?, status?, producer?}` | 列出 artifact 列表 | `{artifacts:[{id, name, mime_type, size_bytes, status, created_at, ...}], next_cursor?}` | ✅ |
| `as.get` | `{artifactId}` | 查看单个 artifact 元数据 | `{id, name, mime_type, size_bytes, content_hash, status, storage_uri, current_version, scan_status, metadata?, created_at, updated_at, finalized_at?}` | ✅ |
| `as.batch` | `{artifactIds: [...]}` | 批量获取多个 artifact 元数据 | `{artifacts:{id→artifactBody}, missing:[id]}` | ✅ |
| `as.update` | `{artifactId, name?, description?, metadata?}` | 修改元数据（字节不可变） | `{id, name, description, mime_type, status, updated_at, ...}` (同 get) | ✅ |
| `as.delete` | `{artifactId}` | 软删除（status → deleted） | `empty` | ✅ |
| `as.url` | `{artifactId, mode?}` | 获取预签名下载 URL（mode: download\|preview） | `{download_url, expires_at, content_type, content_length, filename}` | ✅ |
| `as.download` | `{artifactId, filename?}` | 下载 artifact 字节到本地 | 本地文件路径（stdout 输出） | ✅ |
| `as.abort` | `{artifactId}` | 取消进行中的上传 | `empty` | ✅ |
| `as.resolve` | `{uris: ["as://org/art", ...]}` | 批量解析 `as://` URI 为预签名 URL | `{resolved:{uri→{download_url, expires_at, content_type, content_length, name}}, failed:[uri]}` | ✅ |

---

## 2. COMM — 通信（即时消息）

**CLI**：`src/cli/comm.js` | **后端**：cws-comm（直连，`COCO_COMM_URL`）

响应式 IM（接收用户消息）由 `src/comm-bridge.js` + WebSocket 自动处理；此 CLI 用于主动发消息、查历史等场景。

### 会话管理

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `comm.list_conversations` | `{pageSize?, pageToken?}` | 列出所有会话 | `{conversations:[{id, org_id, type, name?, is_pinned, is_muted, unread_count, last_read_seq, last_message_id?, last_message_at?, member_count, created_at}], next_cursor?}` | ✅ |
| `comm.create_conversation` | `{type, title?, participantIds?}` | 创建群聊/频道 | `{id, org_id, type, name?, max_members, member_count, metadata?, created_at, updated_at}` | ✅ |
| `comm.create_dm` | `{participantId}` | 与指定用户发起私信 | `{id, org_id, type, name?, max_members, member_count, created_at, updated_at}` | ✅ |
| `comm.get_conversation` | `{conversationId}` | 获取单个会话详情 | `{id, org_id, type, name?, avatar_url?, owner_id?, last_message_id?, last_message_at?, max_members, member_count, metadata?, created_at, updated_at, archived_at?}` | ✅ |
| `comm.archive_conversation` | `{conversationId}` | 归档会话 | `empty` | ✅ |
| `comm.pin_conversation` | `{conversationId}` | 置顶会话 | `empty` | ✅ |
| `comm.unpin_conversation` | `{conversationId}` | 取消置顶会话 | `empty` | ✅ |
| `comm.mute_conversation` | `{conversationId}` | 免打扰 | `empty` | ✅ |
| `comm.unmute_conversation` | `{conversationId}` | 取消免打扰 | `empty` | ✅ |
| `comm.mark_read` | `{conversationId, readUntilSeq}` | 标记已读 | `{read_until_seq}` | ✅ |
| `comm.unread_count` | `{conversationId}` | 获取未读数 | `{unread}` | ✅ |

### 消息

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `comm.send` | `{conversationId, content, replyTo?, clientMsgId?}` | 发送消息 | `{id, seq, timestamp, conversation_id, mentions?, parent?}` | ✅ |
| `comm.get_messages` | `{conversationId, afterSeq?, beforeSeq?, limit?}` | 拉取消息历史 | `{messages:[{id, sender_id, sender_type, type, content?, seq, timestamp, parent_id?, mentions?, edited_at?, deleted_at?}], next_cursor?}` | ✅ |
| `comm.get_message` | `{messageId}` | 获取单条消息 | `{id, org_id, conversation_id, sender_id, sender_type, type, content?, content_version, seq, timestamp, edited_at?, deleted_at?, metadata?, parent_id?, parent?, mentions?}` | ✅ |
| `comm.edit_message` | `{messageId, content}` | 编辑已发消息 | `{edited_at}` | ✅ |
| `comm.delete_message` | `{messageId}` | 撤回消息 | `empty` | ✅ |
| `comm.pin_message` | `{messageId}` | 置顶消息 | `empty` | ✅ |
| `comm.unpin_message` | `{messageId}` | 取消置顶消息 | `empty` | ✅ |
| `comm.list_pinned` | `{conversationId}` | 列出置顶消息 | `{pinned_messages:[{message_id, conversation_id, pinned_by, pinned_at}]}` | ✅ |
| `comm.typing` | `{conversationId}` | 发送正在输入状态 | `empty` | ✅ |
| `comm.search` | `{q, conversationIds?, senderIds?, types?, limit?, cursor?}` | 全文搜索消息 | `{results:[{message_id, org_id, conversation_id, sender_id, type, content?, timestamp, highlights?[{field,snippet}], score}], total, next_cursor?}` | ✅ |

### 通知

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `comm.list_notifications` | `{pageSize?, pageToken?}` | 列出通知 | `{notifications:[{id, org_id, recipient_id, type, conversation_id?, message_id?, actor_id?, payload?, is_read, read_at?, created_at}], next_cursor?}` | ✅ |
| `comm.mark_notification_read` | `{notificationId}` | 标记通知已读 | `empty` | ✅ |
| `comm.mark_all_notifications_read` | `{}` | 全部标记已读 | `{marked_count}` | ✅ |
| `comm.notification_unread_count` | `{}` | 获取未读通知数 | `{count}` | ✅ |

### 群组

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `comm.create_group` | `{name, memberIds?}` | 创建群组 | `{id, org_id, name?, description?, max_members, member_count, permissions:{who_can_invite, who_can_pin}, created_at, updated_at}` | ✅ |
| `comm.get_group` | `{groupId}` | 获取群组详情 | `{id, org_id, name?, description?, max_members, member_count, permissions, created_at, updated_at}` | ✅ |
| `comm.update_group` | `{groupId, name?}` | 更新群组 | `{id, org_id, name?, description?, max_members, member_count, permissions, created_at, updated_at}` | ✅ |
| `comm.add_group_member` | `{groupId, memberId}` | 添加群成员 | `empty` | ✅ |
| `comm.remove_group_member` | `{groupId, memberId}` | 移除群成员 | `empty` | ✅ |
| `comm.list_group_members` | `{groupId}` | 列出群成员 | `{members:[{conversation_id, user_id, role, nickname?, is_muted, is_pinned, last_read_seq, joined_at, updated_at}], next_cursor?}` | ✅ |

### 媒体

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `comm.media_upload` | `{filePath, contentType?}` | 上传媒体文件 | `{media_id, upload_url, upload_headers?, expires_at}` (initiate)；finalize 后得 mediaDTO | ✅ |
| `comm.media_get` | `{mediaId}` | 获取媒体元数据 | `{id, org_id, artifact_id, media_type, mime_type, file_name?, file_size, content_hash?, width?, height?, duration?, scan_status, created_at}` | ✅ |
| `comm.media_download_url` | `{mediaId}` | 获取媒体下载 URL | `{url, expires_at}` | ✅ |
| `comm.media_delete` | `{mediaId}` | 删除媒体 | `empty` | ✅ |

---

## 3. CORE — 组织/成员/权限目录

**CLI**：`src/cli/core.js` | **后端**：cws-core（`COCO_API_URL`）

### 身份

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `core.me` | `{}` | 当前身份信息 | `{identity_id, kind, username, display_name, avatar_url?, created_at, org_id?, org_name?, org_slug?, member_id?, member_kind?, role?{slug,scope,scope_id,display_name}}` | ✅ |

### 成员目录

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `core.member_list` | `{orgId?, kind?, status?, search?, cursor?, limit?}` | 列出成员 | `{data:[{member_id, identity_id, kind, username, display_name, avatar_url?, status, joined_at}], page:{cursor?,has_more,limit}}` | ✅ |
| `core.member_get` | `{memberId}` | 获取单个成员详情 | `{member_id, identity_id, kind, username, display_name, avatar_url?, status, online_status, joined_at, role?{slug,display_name}, owner_member_id?, creator_member_id?}` | ✅ |
| `core.project_members` | `{projectId}` | 获取项目成员列表 | `{data:[{member_id, identity_id, kind, username, display_name, status}], page:{...}}` | ✅ |
| `core.role_list` | `{}` | 列出组织角色 | `{data:[{role_id, slug, scope, display_name, description, is_builtin}]}` | ✅ |

### 邀请

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `core.invitation_create` | `{email, roleId?}` | 邀请成员加入组织 | `{invitation_id, token, status, expires_at}` | ✅ |
| `core.invitation_list` | `{}` | 列出待处理邀请 | `{data:[{invitation_id, email?, role_slug, status, invited_by_member_id, created_at, expires_at, accepted_at?}], page:{...}}` | ✅ |
| `core.invitation_accept` | `{invitationId}` | 接受邀请 | `{member_id, org_id, role_slug}` | ✅ |

### Agent

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `core.agent_list` | `{pageSize?, pageToken?}` | 列出所有 Agent | `{data:[{member_id, identity_id, kind, username, display_name, status}], page:{...}}` | ✅ |

### 项目 / 组织

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `core.project_list` | `{status?, pageSize?, pageToken?}` | 列出项目 | `{items:[{id, workspace_id, name, slug, is_inbox, status, created_at}]}` | ✅ |
| `core.project_create` | `{name, description?}` | 创建项目 | `{id, workspace_id, name, slug, is_inbox, status, created_at}` | ✅ |
| `core.project_get` | `{projectId}` | 获取项目详情 | `{id, workspace_id, name, slug, is_inbox, status, created_at, archived_at?}` | ✅ |
| `core.project_archive` | `{projectId}` | 归档项目 | `empty` | ✅ |
| `core.project_restore` | `{projectId}` | 恢复归档项目 | `empty` | ✅ |
| `core.org_list` | `{}` | 列出我的组织 | `{data:[{org_id, name, slug, status, member_id, role_slug, created_at}]}` | ✅ |
| `core.org_get` | `{orgId}` | 获取组织详情 | `{org_id, name, slug, status, member_count, created_at}` | ✅ |
| `core.org_create` | `{name, description?}` | 创建组织 | `{org_id, name, slug, status, member_id, created_at}` | ✅ |

---

## 4. KB — 知识库

**CLI**：`src/cli/kb.js` | **后端**：cws-kb（直连，`COCO_KB_URL`）

> **注**：cws-core 尚未代理 KB 接口。

### KB 集合

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `kb.init` | `{orgId?}` | 初始化组织知识库 | `{org_id, status("initialized"\|"already_initialized")}` | ✅ |
| `kb.list` | `{orgId?, status?}` | 列出知识库 | `{items:[{org_id, status, visibility, page_count, last_modified_at?, created_at}], total}` | ✅ |
| `kb.get` | `{kbId}` | 获取知识库详情 | `{id, org_id, name, description?, visibility, icon?, status, creator_id, created_at, updated_at}` | ✅ |
| `kb.archive` | `{orgId?}` | 归档知识库 | `empty` | ✅ |
| `kb.unarchive` | `{orgId?}` | 取消归档 | `empty` | ✅ |

### 目录树

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `kb.tree` | `{orgId?}` | 获取完整目录树 | `{nodes:[{id, name, node_type, parent_id?, page_id?, sort_order, children_count?, children:[...], created_at}]}` | ✅ |
| `kb.tree_roots` | `{orgId?}` | 获取根节点列表 | `{nodes:[{id, name, node_type, page_id?, sort_order, children_count?, created_at}]}` | ✅ |
| `kb.folder_create` | `{parentId, name, sortOrder?, orgId?}` | 创建文件夹 | `{id, org_id, parent_id?, name, node_type, sort_order, children_count?, created_at, updated_at}` | ✅ |
| `kb.node_get` | `{nodeId, orgId?}` | 获取单个树节点 | `{id, org_id, parent_id?, name, node_type, page_id?, artifact_id?, sort_order, children_count?, created_at, updated_at}` | ✅ |
| `kb.node_breadcrumb` | `{nodeId, orgId?}` | 获取节点路径（面包屑） | `{nodes:[{id, name, node_type, parent_id?, ...}]}` | ✅ |
| `kb.node_children` | `{parentId, orgId?, pageSize?, pageToken?}` | 列出子节点 | `{nodes:[{id, name, node_type, page_id?, sort_order, children_count?, ...}]}` | ✅ |
| `kb.node_move` | `{nodeId, parentId, sortOrder?, orgId?}` | 移动节点 | `empty` | ✅ |
| `kb.node_rename` | `{nodeId, name, orgId?}` | 重命名节点 | `empty` | ✅ |
| `kb.node_delete` | `{nodeId, orgId?}` | 删除节点（含子树） | `empty` | ✅ |

### 页面

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `kb.pages` | `{parentId?, orgId?, pageSize?, pageToken?}` | 列出页面 | `{pages:[{id, org_id, title, path, format, status, current_revision_id?, created_by, last_edited_by?, created_at, updated_at}]}` | ✅ |
| `kb.page_get` | `{pageId, orgId?}` | 获取页面元数据 | `{id, org_id, title, path, format, status, current_revision_id?, created_by, created_by_type, last_edited_by?, created_at, updated_at}` | ✅ |
| `kb.page_create` | `{title, parentId, format?, content:{body, front_matter?}, commitMessage?, orgId?}` | 创建页面 | `{id, org_id, title, path, format, status, current_revision_id?, created_by, created_at}` | ✅ |
| `kb.page_update` | `{pageId, title?, parentId?, content?, baseRevisionId, commitMessage?, orgId?}` | 更新页面（乐观锁） | `{id, org_id, title, path, format, status, current_revision_id?, last_edited_by?, updated_at}` | ✅ |
| `kb.page_delete` | `{pageId, orgId?}` | 删除页面（移入回收站） | `empty` | ✅ |
| `kb.page_delete_permanent` | `{pageId, orgId?}` | 永久删除页面 | `empty` | ✅ |
| `kb.page_content` | `{pageId, orgId?}` | 读取页面正文 | `{page_id, org_id, revision_id, body, author_id, author_type, message?, additions?, deletions?, created_at}` | ✅ |
| `kb.page_content_write` | `{pageId, content:{body, front_matter?}, baseRevisionId, commitMessage?, orgId?}` | 仅更新页面内容 | `{page_id, org_id, revision_id, body, author_id, message?, created_at}` | ✅ |
| `kb.page_freeze` | `{pageId, orgId?}` | 冻结页面（只读锁） | `{page_id, org_id, revision_id, body, author_id, message?, created_at}` | ✅ |
| `kb.page_references` | `{pageId, orgId?}` | 列出引用该页面的其他页面 | `{references:[{artifact_id, display_name, status, offset, length}]}` | ✅ |
| `kb.trash_list` | `{orgId?, pageSize?, pageToken?}` | 列出回收站页面 | `{items:[{id, title, path, format, status, created_by, created_at}], total}` | ✅ |
| `kb.trash_restore` | `{pageId, orgId?}` | 从回收站恢复页面 | `empty` | ✅ |

### 版本历史

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `kb.page_revisions` | `{pageId, orgId?, pageSize?, pageToken?}` | 列出历史版本 | `{revisions:[{revision_id, author_id, author_type, message?, additions?, deletions?, created_at}], total}` | ✅ |
| `kb.page_revision` | `{pageId, revisionId, orgId?}` | 获取特定版本内容 | `{page_id, org_id, revision_id, body, author_id, author_type, message?, additions?, deletions?, created_at}` | ✅ |
| `kb.page_diff` | `{pageId, fromRevisionId, toRevisionId, orgId?}` | 对比两个版本差异 | `{page_id, org_id, from_rev, to_rev, diff}` | ✅ |
| `kb.page_restore` | `{pageId, revisionId, commitMessage?, orgId?}` | 恢复到历史版本 | `{page_id, org_id, revision_id, body, author_id, message?, created_at}` | ✅ |

### 搜索

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `kb.search` | `{query, folderId?, authorId?, format?, pageSize?, pageToken?, sync?, orgId?}` | 全文搜索（`sync=true` 等待索引就绪） | `{hits:[{page_id, org_id, kb_id, title, path, snippet, author_id, accessible, created_at, updated_at}], total, query_time_ms}` | ✅ |

### 关联关系

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `kb.relations_list` | `{resourceType?, resourceId?, targetType?, targetId?, orgId?}` | 列出关联关系 | `{relations:[{id, org_id, resource_type, resource_id, relation, subject_type, subject_id, granted_by?, expires_at?, created_at}]}` | ✅ |
| `kb.relations_create` | `{resourceType, resourceId, targetType, targetId, role, orgId?}` | 创建关联 | `{id, org_id, resource_type, resource_id, relation, subject_type, subject_id, granted_by?, created_at}` | ✅ |
| `kb.relations_check` | `{resourceType, resourceId, targetType, targetId, role?, orgId?}` | 检查关联是否存在 | `{allowed}` | ✅ |
| `kb.relations_delete` | `{resourceType, resourceId, targetType, targetId, role?, orgId?}` | 删除关联 | `empty` | ✅ |

### 文件附件 / Agent 存储

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `kb.upload` | `{filePath, mediaType?, contentType?, description?, nodeId?, pageId?, orgId?}` | 上传文件（委托 as.upload） | `{id, name, mime_type, size_bytes, status, created_at}` (artifactBody) | ✅ |
| `kb.agent_store` | `{content, title?, metadata?, orgId?}` | Agent 直接写入知识库（无需创建页面） | `{page:{id,title,path,status,created_at}, tree_node:{id,name,node_type,created_at}, created}` | ✅ |
| `kb.archive_task_output` | `{taskId, content, metadata?, orgId?}` | 归档任务输出到 KB | `{pages:[{id, title, path, format, status, created_by, created_at}]}` | ✅ |

---

## 5. TM — 任务管理

**CLI**：`src/cli/tm.js`

| 操作类型 | 后端 | URL |
|---|---|---|
| Project / Issue / Task 读操作 | cws-core（BFF） | `COCO_API_URL` |
| Issue / Task / Blueprint 写操作 | cws-work（直连） | `COCO_WORK_URL` |

### Project

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `project.list` | `{status?, pageSize?, pageToken?}` | 列出项目 | `{items:[{id, workspace_id, name, slug, is_inbox, status, created_at}]}` | ✅ |
| `project.create` | `{name, description?, icon?, leadIds?, memberIds?}` | 创建项目 | `{id, workspace_id, name, slug, is_inbox, status, created_at}` | ✅ |
| `project.get` | `{id}` | 获取项目详情 | `{id, workspace_id, team_id, name, slug, is_inbox, status, created_at, archived_at?}` | ✅ |
| `project.update` | `{id, description?, icon?}` | 更新项目 | `{id, workspace_id, name, slug, status, updated_at}` | ✅ |
| `project.archive` | `{id}` | 归档项目 | `empty` | ✅ |
| `project.restore` | `{id}` | 恢复归档项目 | `empty` | ✅ |
| `project.members` | `{id}` | 获取项目成员 | `{items:[{id, workspace_id, name, slug, ...}]}` | ✅ |

### Issue

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `issue.list_in_project` | `{projectId, status?, archived?, pageSize?, pageToken?}` | 项目内 Issue 列表 | `{items:[{id, project_id, title, description, mode, status, lead_agent_id, created_at}]}` | ✅ |
| `issue.get` | `{id}` | 获取 Issue 详情 | `{id, project_id, title, description, mode, status, lead_agent_id, origin_conversation_id?, origin_message_id?, accepted_at?, rejected_at?, acceptance_source?, created_at, updated_at}` | ✅ |
| `issue.create` | `{projectId, title, description?, mode, leadAgentId, originConversationId?}` | 创建 Issue | `{id, project_id, title, description, mode, status, lead_agent_id, created_at}` | ✅ |
| `issue.update` | `{id, title?, description?}` | 更新 Issue | `{id, project_id, title, description, status, updated_at}` | ✅ |
| `issue.transition` | `{id, status}` | Issue 状态流转 | `{id, project_id, title, status, updated_at}` | ✅ |
| `issue.move_project` | `{id, targetProjectId}` | Issue 跨项目移动 | `{id, project_id, title, status, updated_at}` | ✅ |

### Task

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `task.list` | `{projectId?, issueId?, status?, assigneeId?, pageSize?, pageToken?}` | 列出任务 | `{items:[{id, issue_id, title, status, assignee_id?, skill_tags?, current_attempt_number, created_at}]}` | ✅ |
| `task.get` | `{id}` | 获取任务详情 | `{id, issue_id, title, description, status, assignee_id?, skill_tags?, blueprint_step_id?, depends_on?, current_attempt_number, context_page_ids?, created_at, updated_at}` | ✅ |
| `task.create` | `{issueId, title, description?, assigneeId?, skillTags?, blueprintStepId?, dependsOn?}` | 创建任务 | `{id, issue_id, title, description, status, assignee_id?, skill_tags?, blueprint_step_id?, depends_on?, created_at}` | ✅ |
| `task.transition` | `{id, status}` | 任务状态流转 | `{id, issue_id, title, status, updated_at}` | ✅ |
| `task.reassign` | `{id, assigneeId}` | 重新分配任务 | `{id, issue_id, title, status, assignee_id, updated_at}` | ✅ |
| `taskboard.list` | `{projectId?, issueId?}` | 任务看板视图 | `{items:[{id, issue_id, title, status, assignee_id?, skill_tags?, created_at}]}` | ✅ |

### Blueprint（蓝图）

| 命令 | 参数 | 描述 | 返回 | 状态 |
|------|------|------|------|------|
| `blueprint.create` | `{issueId, title, description?}` | 为 Issue 创建执行蓝图 | `{id, issue_id, version_number, status, estimated_budget?, notes, content_hash?, created_at}` | ✅ |
| `blueprint.get` | `{id}` | 获取蓝图详情 | `{id, issue_id, version_number, status, estimated_budget?, notes, content_hash?, approved_at?, created_at, updated_at}` | ✅ |
| `blueprint.list` | `{issueId}` | 列出蓝图版本 | `{items:[{id, issue_id, version_number, status, notes, created_at}]}` | ✅ |
| `blueprint.add_step` | `{blueprintId, title, description?, assigneeId?, skillTags?}` | 添加蓝图步骤 | `{id, blueprint_id, description, sort_order, required_resources?, depends_on?, created_at}` | ✅ |
| `blueprint.update_step` | `{stepId, title?, description?, skillTags?}` | 更新蓝图步骤 | `{id, blueprint_id, description, sort_order, required_resources?, depends_on?, updated_at}` | ✅ |
| `blueprint.delete_step` | `{stepId}` | 删除蓝图步骤 | `empty` | ✅ |
| `blueprint.set_step_depends_on` | `{stepId, dependsOn: [...]}` | 设置步骤依赖关系 | `{id, blueprint_id, description, depends_on, updated_at}` | ✅ |
| `blueprint.set_estimated_budget` | `{blueprintId, budget}` | 设置预估成本 | `{id, issue_id, version_number, status, estimated_budget, updated_at}` | ✅ |
| `blueprint.set_notes` | `{blueprintId, notes}` | 设置备注 | `{id, issue_id, version_number, status, notes, updated_at}` | ✅ |
| `blueprint.render_markdown` | `{blueprintId}` | 渲染蓝图为 Markdown | `{markdown}` | ✅ |
| `blueprint.submit_for_approval` | `{blueprintId}` | 提交蓝图审批 | `{id, issue_id, version_number, status, updated_at}` | ✅ |
| `blueprint.create_amendment` | `{blueprintId, reason?}` | 创建蓝图修正版本 | `{id, issue_id, version_number, status, notes, created_at}` | ✅ |


---

## 统计汇总

| 服务 | 已实现 | 总计 | 覆盖率 |
|------|--------|------|--------|
| AS   | 10     | 10   | 100%   |
| COMM | 30     | 30   | 100%   |
| CORE | 16     | 16   | 100%   |
| KB   | 35     | 35   | 100%   |
| TM   | 20     | 20   | 100%   |
| **合计** | **111** | **111** | **100%** |

> 最后更新：2026-05-22，对照各服务 main 分支（cws-as `fc1020e`、cws-comm `bfb6db2`、cws-core `35ca93b`、cws-kb `1554242`、cws-work `18377d2`）
