# KB 操作指南

**作用**:Knowledge Base 操作——管 KB 实例本身、目录树(folder / file / page 节点)、page 内容 + revision + trash 三态、跨 page 搜索、文件上传与下载。链路 `kb.js → cws-core (/api/v1) → cws-kb`。

**何时加载本文档**:

- Lead 上下文组装,从 KB 里搜参考材料(`kb.search` + `kb.page_content`)
- 沉淀经验 / 写决策文档 / 记笔记到 KB(`kb.page_create` / `kb.page_content_write`)
- 整理 KB 目录(`kb.folder_create` / `kb.node_move` / `kb.node_rename`)
- 给 page 改内容 / 回滚到旧 revision(`kb.page_update` / `kb.page_restore`)
- 软删除 page / 永久删除(`kb.page_trash` → `kb.page_delete` 三态链)
- 把文件附件登记到 KB 树(`kb.upload` 或 `as.upload` 不带 conversationId)
- 项目交付物拿预签名链接批量下载(`kb.file_batch_download`)

**不在本文档范围**:

- IM 消息附件(走会话):`as.upload` 带 `conversationId` → `references/as-operations.md`
- 任务 / Issue / Blueprint workflow → `references/tm-operations.md`
- 主动发消息 / 拉群 → `references/comm-operations.md`
- 成员 / 项目 / 角色目录 → `references/core-operations.md`

**依赖前置**:

- 任何带 `kbId` 的命令,前面先 `kb.list` 确认 KB 存在(每个 org 默认 1 个 KB,`is_default=true`)
- `kb.page_create` 需要 `parentId`(folder node id);从 `kb.tree_roots` / `kb.node_children` 拿
- `kb.page_update` / `kb.page_content_write` 需要 `baseRevisionId`,先 `kb.page_get` 拿当前 `revision_id`
- 完整参数依赖树见 [`SKILL.md` 效率捷径 > 参数解析](../SKILL.md)

---

> Layer 3 操作参考。本文档与 `src/cli/kb.js` dispatch 表保持 1:1 对应。
> 真实路径以 cws-core OpenAPI 为准:`https://zylos01.jinglever.com/cws-core/openapi.json`

CLI 位置:`src/cli/kb.js`
调用方式:`node src/cli/kb.js <command> '<json>'`

状态:✅ cws-core BFF 已暴露(全部命令都能从 CLI 触达)。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF 基地址 |
| `COCO_API_PREFIX` | `/api/v1` | 路径前缀 |
| `COCO_AUTH_TOKEN` | (空) | Bearer token(跟 tm / as / comm / core CLI 共用) |
| `COCO_ORG_ID` | (空) | 覆盖 `config.org_id` |

## 数据模型

```
Org(组织,scope 单位)
  └─ KB Config(每 org 1 个,storage_quota / search 开关等)
       │
       ├─ Tree Node(目录树节点)
       │    ├─ kind="folder"  → 文件夹,只有子节点
       │    └─ kind="page"    → 页面外壳,关联一个 Page
       │
       └─ Page(内容主体,与 tree node 1:1)
            └─ Revision(版本,从 1 开始自增)
```

`org_id` 是所有 KB 操作的 scope 单位——从 `config.org_id` 或 `COCO_ORG_ID` env 取,安装时配。

## 命令清单

### KB 集合

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `kb.init` | 给当前 org 初始化默认 KB(幂等,重复调返已有) | `{}` | `POST /api/v1/kbs/init` |
| ✅ | `kb.list` | 列当前 org 的 KB 实例(目前每 org 通常 1 个) | `{limit?, offset?}` | `GET /api/v1/kbs` |
| ✅ | `kb.create` | 新建 KB 实例;`visibility` 取 `open` / `closed` / `private`(默认 closed);slug 服务端从 name 派生 | `{name, visibility?, description?, icon?}` | `POST /api/v1/kbs` |
| ✅ | `kb.get` | 取单个 KB 实例详情 | `{kbId}` | `GET /api/v1/kbs/{kb_id}` |
| ✅ | `kb.update` | 改 KB 元数据;`set_description` / `set_icon` 是 tri-state(显式清空 vs 不动)| `{kbId, name?, description?, setDescription?, visibility?, icon?, setIcon?}` | `PATCH /api/v1/kbs/{kb_id}` |
| ✅ | `kb.delete` | 永久删 KB(物理删,慎用) | `{kbId}` | `DELETE /api/v1/kbs/{kb_id}` |
| ✅ | `kb.archive` | 归档 KB(可恢复) | `{kbId}` | `POST /api/v1/kbs/{kb_id}/archive` |
| ✅ | `kb.unarchive` | 归档恢复 active | `{kbId}` | `POST /api/v1/kbs/{kb_id}/unarchive` |

### 目录树

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `kb.tree_roots` | 列 KB 根下所有顶层节点(folder / page / file) | `{kbId}` | `GET /api/v1/kbs/{kb_id}/tree/roots` |
| ✅ | `kb.folder_create` | 新建文件夹节点(KB 唯一显式建节点的入口) | `{kbId, parentId?, name}` | `POST /api/v1/kbs/{kb_id}/tree/folders` |
| ✅ | `kb.node_get` | 取节点详情(folder / page / file 通用) | `{kbId, nodeId}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}` |
| ✅ | `kb.node_breadcrumb` | 拿节点的祖先路径(root → ... → 当前) | `{kbId, nodeId}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/breadcrumb` |
| ✅ | `kb.node_children` | 列某节点下的直接子节点 | `{kbId, parentId}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{parent_id}/children` |
| ✅ | `kb.node_move` | 把节点移到另一个 parent(同 KB 内) | `{kbId, nodeId, parentId}` | `POST /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/move` |
| ✅ | `kb.node_rename` | 改节点显示名 | `{kbId, nodeId, name}` | `PATCH /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/rename` |
| ✅ | `kb.node_delete` | 删节点(folder 要先空;page / file 走对应的 trash → delete) | `{kbId, nodeId}` | `DELETE /api/v1/kbs/{kb_id}/tree/nodes/{node_id}` |

节点 ID 形态:`tn-{uuid}`。Page 通过 `kb.page_create` 间接建出对应 tree node,不走 folder_create。

### 页面

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `kb.pages` | 列 page(可按 parent 过滤,分页) | `{kbId, parentId?, cursor?, limit?, offset?}` | `GET /api/v1/pages` |
| ✅ | `kb.page_get` | 取 page 元数据(含当前 revision_id) | `{pageId}` | `GET /api/v1/pages/{page_id}` |
| ✅ | `kb.page_create` | 在指定 folder 下建 page;同时建出对应 tree node | `{kbId, title, parentId?, format?, body, message?}` | `POST /api/v1/kbs/{kb_id}/pages` |
| ✅ | `kb.page_update` | 改 page 任意属性(title / parent / 内容均可);乐观并发,需带 baseRevisionId | `{pageId, title?, path?, content?, baseRevisionId, commitMessage?}` | `PATCH /api/v1/pages/{page_id}` |
| ✅ | `kb.page_delete` | 永久删(物理删);page 必须先在 `trashed` 状态,否则 404 | `{pageId}` | `DELETE /api/v1/pages/{page_id}` |
| ✅ | `kb.page_content` | 取 page 当前正文内容 | `{pageId}` | `GET /api/v1/pages/{page_id}/content` |
| ✅ | `kb.page_content_write` | 只改内容主体(更专的写入入口,适合大段编辑);乐观并发 | `{pageId, body, message?, baseRevisionId?, autoSave?}` | `POST /api/v1/pages/{page_id}/content` |
| ✅ | `kb.page_revisions` | 列 page 的所有 revision | `{pageId, limit?, offset?}` | `GET /api/v1/pages/{page_id}/revisions` |
| ✅ | `kb.page_revision` | 取指定 revision 的快照内容 | `{pageId, revisionId}` | `GET /api/v1/pages/{page_id}/revisions/{rev_id}` |
| ✅ | `kb.page_diff` | 两个 revision 之间的 diff(unified format) | `{pageId, fromRevisionId, toRevisionId}` | `GET /api/v1/pages/{page_id}/diff` |
| ✅ | `kb.page_restore` | 回滚 page 内容到旧 revision(status 不变,**不是** trash-restore) | `{pageId, revisionId}` | `POST /api/v1/pages/{page_id}/restore-version` |
| ✅ | `kb.page_trash` | 软删除(status → `trashed`,进回收站) | `{pageId}` | `POST /api/v1/pages/{page_id}/trash` |
| ✅ | `kb.page_restore_trash` | 从回收站恢复(status → `active`,**不是** revision restore) | `{pageId}` | `POST /api/v1/pages/{page_id}/restore` |
| ✅ | `kb.pages_trashed` | 列当前 org 在回收站里的 page | `{limit?, offset?}` | `GET /api/v1/pages/trashed` |
| ✅ | `kb.page_freeze` | 把 page 标只读(后续写入被拒) | `{pageId}` | `POST /api/v1/pages/{page_id}/freeze` |
| ✅ | `kb.page_references` | 列引用本 page 的位置(其它 page / context_page_ids 等) | `{pageId}` | `GET /api/v1/pages/{page_id}/references` |

页面 ID 形态:`pg-{uuid}`。Revision 是每页自增整数从 1 起。

**两个写入入口的区别**:

- `kb.page_update`(`PATCH /pages/{pid}`):改页面**任意属性**(标题、parent、内容…),body 里能传哪个传哪个
- `kb.page_content_write`(`POST /pages/{pid}/content`):**只**改内容主体,语义更专,适合 Agent 后续大段编辑

两者都支持乐观并发:先 `kb.page_get` 拿 `revision_id`,写时把它当 `baseRevisionId` 传过去,服务端若发现不一致返回 409 + 当前 revision_id,客户端重读后合并再写。

**两个 "restore" 不是一回事,Agent 经常搞错**:

- `kb.page_restore`(`POST /pages/{pid}/restore-version`):**回滚到一个旧 revision**,page 的 status 不变。用于"撤销最近 N 次编辑"。
- `kb.page_restore_trash`(`POST /pages/{pid}/restore`):**从回收站恢复**,把 status 从 `trashed` 改回 `active`。跟 revision 无关。
- 路径相似但语义不同,**别看名字猜**——遇到 "restore" 先弄清楚是 trash-restore 还是 revision-restore。

**三态保护链:trash → permanent_delete**:

- `kb.page_delete` 是**永久删**(物理删),不可恢复,所以 cws-kb 强制要求 page 已经在 `trashed` 状态:必须先 `kb.page_trash` 把 page 丢进回收站,再 `kb.page_delete`。
- 直接对 `active` page 调 `kb.page_delete`,cws-kb 会返 404(语义不太诚实,这是 cws-kb#193;但语义保护本身保留,不要绕)。
- 完整流程:`page_create → ... → page_trash → page_delete`。如果中间想撤销,用 `page_restore_trash` 把它捞回来,**再删时还得先 trash 一次**。

### 搜索 ⭐

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `kb.search` | 跨 page 全文搜索;ReBAC 过滤(只返调用者有 viewer+ 权限的 page) | `{query, kbId?, folderId?, authorId?, format?, pageSize?, pageToken?, sync?}` | `GET /api/v1/search/pages` |

底层:**Meilisearch(模糊 + typo 容错 + 中文分词)+ NATS 事件驱动索引**。返回结构:

```json
{
  "results": [
    {
      "page": { "id": "pg-...", "title": "...", "path": "...", "format": "markdown" },
      "highlights": [
        { "field": "title", "snippet": "Week 21 <mark>周会纪要</mark>" },
        { "field": "body",  "snippet": "..." }
      ],
      "score": 0.98
    }
  ],
  "pagination": { "next_page_token": null, "total_count": 1 }
}
```

**`sync=true` 给 Agent 用**:Agent 刚写完一页就搜,异步索引可能还没建好。`sync=true` 等 Meilisearch task 完成才返回(最长 5s 超时),保证读到刚写的。人类用户默认走 async,UX 快。

限流:1000 次/分钟/工作区。

### 文件附件(KB 上传专用)

| 状态 | 命令 | 说明 | 入参 | 真实端点 |
| --- | --- | --- | --- | --- |
| ✅ | `kb.upload` | 上传文件并在 KB 树里登记 file 节点(KB 模式上传的语糖) | `{kbId, filePath, parentId?, contentType?, filename?}` | 委托给 `as.uploadMedia()` → prepare/PUT/finalize 三步,见 `references/as-operations.md` |
| ✅ | `kb.file_create` | 用已有 artifact 在 KB 树里登记 file 节点(`kb.upload` 内部最后一步) | `{kbId, name, artifactId, parentId?}` | `POST /api/v1/kbs/{kb_id}/tree/files` |
| ✅ | `kb.file_preview` | 拿 file 节点的 inline 预览 URL(浏览器内嵌) | `{kbId, nodeId}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/preview` |
| ✅ | `kb.file_download` | 拿单个 file 节点的下载 URL(可选 inline) | `{kbId, nodeId, inline?}` | `GET /api/v1/kbs/{kb_id}/tree/nodes/{node_id}/download` |
| ✅ | `kb.file_batch_download` | 一次拿多个 file 节点的预签名下载 URL | `{kbId, nodeIds, inline?}` | `POST /api/v1/kbs/{kb_id}/tree/files/batch-download` |

`kb.upload` = `as.upload` 不带 `conversationId` 的 KB 模式语糖,**会在 KB 树里出现一个 file 节点**(返回里有 `nodeId` + `treeNode`),后续可以 `kb.node_get` / `kb.file_preview` / `kb.file_download` 操作它。

**不要用 `kb.upload` 发会话附件**:会话 / DM 里的图片或文件要走 **IM 上传**(`as.upload` 带 `conversationId`,详见 [as-operations.md](./as-operations.md) 顶部的"上传走哪条路径"),否则文件挂到 KB 但接收方对话框里看不到。

返回的 `mediaId` / `artifactId` 也可以塞到 Page body 里(比如 markdown 里写 `![](artifact://<id>)`),让页面正文直接引用这份 artifact。

## 典型流程

### Agent 写一页周会纪要后立即搜索验证

```bash
# 1. 创建页面
node src/cli/kb.js kb.page_create '{
  "kbId":"<kb-uuid>",
  "title":"2026-05-21 周会纪要",
  "parentId":"<folder-node-id>",
  "format":"markdown",
  "body":"# 2026-05-21 周会纪要\n\n## 议题\n\n...",
  "message":"feat: Agent 自动生成周会纪要"
}'
# -> {id:"pg-...", current_revision_id:1, ...}

# 2. 立即搜索验证(sync=true 等索引建好)
node src/cli/kb.js kb.search '{"query":"周会纪要","sync":true,"limit":5}'
# -> {results:[{page:{id:"pg-..."}, highlights:[...], score:0.95}], ...}
```

### Lead 上下文组装 —— 找项目的设计决策文档

```bash
# 1. 在指定 folder 内搜索
node src/cli/kb.js kb.search '{
  "query":"架构决策",
  "folderId":"tn-projects-growth",
  "format":"markdown",
  "limit":20
}'

# 2. 拿到 page_id 后读详细内容
node src/cli/kb.js kb.page_content '{"pageId":"pg-arch-decisions-001"}'

# 3. 看历史改动(如果发现内容不太对)
node src/cli/kb.js kb.page_revisions '{"pageId":"pg-arch-decisions-001"}'
node src/cli/kb.js kb.page_diff '{
  "pageId":"pg-arch-decisions-001",
  "fromRevisionId":3,
  "toRevisionId":5
}'
```

### Agent 产出物挂到 KB 节点下

```bash
# 1. 通过 as.js 上传产出文件(KB 模式,不带 conversationId)
node src/cli/as.js as.upload '{
  "filePath":"/tmp/q2-report.pdf",
  "mediaType":"file"
}'
# -> {artifactId:"art_...", nodeId:"tn-...", treeNode:{...}, instantUpload:false}

# 2. 写一页 deliverables 索引,引用这个 artifact
node src/cli/kb.js kb.page_create '{
  "kbId":"<kb-uuid>",
  "parentId":"<deliverables-folder-id>",
  "title":"Q2 交付物索引",
  "body":"# Q2 交付物\n\n- [报告](artifact://art_...)"
}'
```

## 与 SKILL.md 的关系

本文档是 [`SKILL.md`](../SKILL.md) 的 Layer 3 子 skill,只负责 KB CLI 的**命令机制**。下面这些行为面内容**在 SKILL.md 里**,本文档不重复:

| 想看 | 去 SKILL.md 的哪节 |
|---|---|
| Lead vs Worker 的 KB 写入边界(经验沉淀 vs 任务产出) | [角色模型](../SKILL.md) |
| 何时通过 `contextPageIds` 把 page 传给 Issue/Task | [效率捷径 > 上下文传递](../SKILL.md) |
| KB 经验沉淀的时机和位置(`/projects/{slug}/decisions/` 等) | [记忆触发点 > 经验沉淀判断](../SKILL.md) |
| 通用错误防护(比如不该用 curl 直接调 KB API) | [行为护栏 > 常见错误](../SKILL.md) |

## KB 专属注意事项

- **org_id 必填**:每个命令都要 scope。`config.org_id` 没设就 throw。
- `kb.list` 一个 org 通常只有 1 个 KB(per `kb_org_configs`),但 list 返回数组以便未来扩展
- 页面写入有限流:60 次/分钟/用户(`rate_limited` 429)
- `kb.search` 结果受 ReBAC 过滤:只返回调用者有 `viewer+` 权限的页
- `format` 取值:`markdown` / `code` / `pdf` / `image` / `archive` / `other`
- 树节点排序:同 parent 下按 `sort_order` 排,移动节点时可指定新 `sortOrder`
- 跨 org 引用通过 `kb://pg-{uuid}` URI(stable ID,移动 / 重命名不变)
- `kb.page_delete` 直接调会 404 — 必须先 `kb.page_trash`,这是 cws-kb 的三态保护链(不要绕)
- `kb.page_restore` vs `kb.page_restore_trash` 名字像、语义完全不同,见上面"两个 restore 不是一回事"
