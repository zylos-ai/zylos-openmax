# KB 操作指南

CLI 位置:`src/cli/kb.js`
调用方式:`node src/cli/kb.js <command> '<json>'`

状态:✅ cws-kb code 里已有 · ⏳ 在 cws-kb api-design.md 但 transport 层未实装

> 本 CLI **直连 cws-kb**(不走 cws-core BFF,因为 cws-core OpenAPI 没暴露 KB)。
> Base URL:`config.comm.kb_url`(env `COCO_KB_URL` 可覆盖)
> 真实路径以 cws-kb 仓库代码为准:`https://git.coco.xyz/coco-workspace/cws-kb`

## 数据模型

```
Org(组织,scope 单位)
  └─ KB Config(每 org 1 个,storage_quota / search 开关等)
       │
       ├─ Tree Node(目录树节点)
       │    ├─ kind="folder"  → 文件夹,只有子节点
       │    └─ kind="page"    → 页面外壳,关联一个 Page
       │
       ├─ Page(内容主体,与 tree node 1:1)
       │    └─ Revision(版本,从 1 开始自增)
       │
       └─ Relation(KB ↔ Project / Issue 等的关联)
```

`org_id` 是所有 KB 操作的 scope 单位 —— 从 `config.org_id` 或 `COCO_ORG_ID` env 取,安装时配。

## 命令列表

### KB 集合

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `kb.init` | `{}` | `POST /api/v1/kbs/init` — 给当前 org 初始化默认 KB(幂等) |
| ✅ | `kb.list` | `{limit?, offset?}` | `GET /api/v1/kbs` |
| ✅ | `kb.create` | `{name, visibility?, description?, icon?}` | `POST /api/v1/kbs` — `visibility` 取 `open` / `closed` / `private`(默认 `closed`);`slug` 服务端从 name 派生,不接受 |
| ✅ | `kb.get` | `{kbId}` | `GET /api/v1/kbs/{kb_id}` |
| ✅ | `kb.update` | `{kbId, name?, description?, setDescription?, visibility?, icon?, setIcon?}` | `PATCH /api/v1/kbs/{kb_id}` — `set_description` / `set_icon` 是 tri-state 信号(显式清空 vs 不动) |
| ✅ | `kb.delete` | `{kbId}` | `DELETE /api/v1/kbs/{kb_id}` |
| ✅ | `kb.archive` | `{kbId}` | `POST /api/v1/kbs/{kb_id}/archive` |
| ✅ | `kb.unarchive` | `{kbId}` | `POST /api/v1/kbs/{kb_id}/unarchive` |

### 目录树

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `kb.tree_roots` | `{orgId?}` | `GET /tree/roots` |
| ✅ | `kb.folder_create` | `{parentId, name, sortOrder?, orgId?}` | `POST /tree/folders` |
| ✅ | `kb.node_get` | `{nodeId, orgId?}` | `GET /tree/nodes/{nodeId}` |
| ✅ | `kb.node_breadcrumb` | `{nodeId, orgId?}` | `GET /tree/nodes/{nodeId}/breadcrumb` |
| ✅ | `kb.node_children` | `{parentId, orgId?, pageSize?, pageToken?}` | `GET /tree/nodes/{parentId}/children` |
| ✅ | `kb.node_move` | `{nodeId, parentId, sortOrder?, orgId?}` | `PATCH /tree/nodes/{nodeId}/move` |
| ✅ | `kb.node_rename` | `{nodeId, name, orgId?}` | `PATCH /tree/nodes/{nodeId}/rename` |
| ✅ | `kb.node_delete` | `{nodeId, orgId?}` | `DELETE /tree/nodes/{nodeId}` |

节点 ID 形态:`tn-{uuid}`。`kb.folder_create` 是 cws-kb 唯一的建节点入口(page 通过 `kb.page_create` 间接建出对应 tree node)。

### 页面

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `kb.pages` | `{parentId?, orgId?, pageSize?, pageToken?}` | `GET /pages` |
| ✅ | `kb.page_get` | `{pageId, orgId?}` | `GET /pages/{pageId}` |
| ✅ | `kb.page_create` | `{title, parentId, format?, content:{body, front_matter?}, commitMessage?, orgId?}` | `POST /pages` |
| ✅ | `kb.page_update` | `{pageId, title?, parentId?, content?, baseRevisionId, commitMessage?, orgId?}` | `PATCH /pages/{pageId}` |
| ✅ | `kb.page_delete` | `{pageId, orgId?}` | `DELETE /pages/{pageId}` — **permanent delete; page MUST be in `trashed` state first** |
| ✅ | `kb.page_content` | `{pageId, orgId?}` | `GET /pages/{pageId}/content` |
| ✅ | `kb.page_content_write` | `{pageId, content:{body, front_matter?}, baseRevisionId, commitMessage?, orgId?}` | `POST /pages/{pageId}/content` |
| ✅ | `kb.page_revisions` | `{pageId, orgId?, pageSize?, pageToken?}` | `GET /pages/{pageId}/revisions` |
| ✅ | `kb.page_revision` | `{pageId, revisionId, orgId?}` | `GET /pages/{pageId}/revisions/{revId}` |
| ✅ | `kb.page_diff` | `{pageId, fromRevisionId, toRevisionId, orgId?}` | `GET /pages/{pageId}/diff?from_revision_id=&to_revision_id=` |
| ✅ | `kb.page_restore` | `{pageId, revisionId, commitMessage?, orgId?}` | `POST /pages/{pageId}/restore-version` — restore page **content** to a prior revision (NOT trash-restore) |
| ✅ | `kb.page_trash` | `{pageId, orgId?}` | `POST /pages/{pageId}/trash` — soft-delete, sets status=`trashed`, shows up in `kb.pages_trashed` |
| ✅ | `kb.page_restore_trash` | `{pageId, orgId?}` | `POST /pages/{pageId}/restore` — un-trash, restores to status=`active` |
| ✅ | `kb.pages_trashed` | `{limit?, offset?, orgId?}` | `GET /pages/trashed` — list trashed pages |
| ✅ | `kb.page_freeze` | `{pageId, orgId?}` | `POST /pages/{pageId}/freeze` — mark page read-only (write rejected) |
| ✅ | `kb.page_references` | `{pageId, orgId?}` | `GET /pages/{pageId}/references` — list places referencing this page |

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

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `kb.search` | `{query, folderId?, authorId?, format?, pageSize?, pageToken?, sync?, orgId?}` | `GET /search/pages` |

底层:**Meilisearch(模糊+typo容错+中文分词)+ NATS 事件驱动索引**。返回结构:

```json
{
  "results": [
    {
      "page": { "id": "pg-...", "title": "...", "path": "...", "format": "markdown", ... },
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

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `kb.upload` | `{kbId, filePath, parentId?, contentType?, filename?}` | 委托给 `as.uploadMedia()`(KB 模式)→ 三步:`POST /api/v1/uploads/prepare` + 预签名 PUT + `POST /api/v1/uploads/finalize` |
| ✅ | `kb.file_create` | `{kbId, name, artifactId, parentId?}` | `POST /api/v1/kbs/{kb_id}/tree/files` — 用已有 artifact 在 KB 树里登记一个 file 节点(`kb.upload` 内部就是 prepare/finalize + 这一步) |
| ✅ | `kb.file_batch_download` | `{kbId, nodeIds, inline?}` | `POST /api/v1/kbs/{kb_id}/tree/files/batch-download` — 一次拿多个文件节点的预签名下载 URL |

`kb.upload` 等价于 `as.upload {filePath, parentId?, ...}` 不带 conversationId 的 KB 模式语糖,**会在 KB 树里出现一个 file 节点**(返回里有 `nodeId` + `treeNode`),后续可以 `kb.node_get` / `kb.file_preview` / `kb.file_download` 操作它。

**不要用 `kb.upload` 发会话附件**:会话/DM 里的图片或文件要走 **IM 上传**(`as.upload` 带 `conversationId`,详见 [as-operations.md](./as-operations.md) 顶部那节"上传走哪条路径"),否则文件挂到 KB 但接收方对话框里看不到。

返回的 `mediaId` / `artifactId` 也可以塞到 Page body 里(比如 markdown 里写 `![](artifact://<id>)`),让页面正文直接引用这份 artifact。

## 典型流程

### Agent 写一页周会纪要后立即搜索验证(⏳ + ✅)

```bash
# 1. 创建页面(⏳ 待 cws-kb 实装)
node src/cli/kb.js kb.page_create '{
  "title":"2026-05-21 周会纪要",
  "parentId":"tn-projects-root",
  "format":"markdown",
  "content":{
    "body":"# 2026-05-21 周会纪要\n\n## 议题\n\n...",
    "front_matter":{"tags":"meeting,weekly","date":"2026-05-21"}
  },
  "commitMessage":"feat: Agent 自动生成周会纪要"
}'
# -> {page:{id:"pg-...", revision_id:1}, revision_id:1}

# 2. 立即搜索验证(sync=true 等索引建好)
node src/cli/kb.js kb.search '{
  "query":"周会纪要",
  "sync":true,
  "limit":5
}'
# -> {results:[{page:{id:"pg-..."}, highlights:[...], score:0.95}], pagination:{...}}
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
# 1. 通过 as.js 上传产出文件
node src/cli/as.js as.upload '{
  "filePath":"/tmp/q2-report.pdf",
  "mediaType":"file",
  "description":"Q2 报告终版"
}'
# -> {artifactId:"art_...", mediaId:"art_...", instantUpload:false}

# 2. 写一页 deliverables 索引(⏳)引用这个 artifact
node src/cli/kb.js kb.page_create '{
  "parentId":"tn-deliverables",
  "title":"Q2 交付物索引",
  "content":{"body":"# Q2 交付物\n\n- [报告](as://<org_id>/art_...)"}
}'
```

## 注意事项

- **org_id 必填**:每个命令都要 scope。`config.org_id` 没设就 throw。
- `lb.list` 一个 org 通常只有 1 个 KB(per `kb_org_configs`),但 list 返回的是配置数组以便未来扩展
- 页面写入有限流:60 次/分钟/用户(`rate_limited` 429)
- `kb.search` 结果受 ReBAC 过滤:只返回调用者有 `viewer+` 权限的页
- `format` 取值:`markdown` / `code` / `pdf` / `image` / `archive` / `other`
- 树节点排序:同 parent 下按 `sort_order` 排,移动节点时可指定新 `sortOrder`
- 跨 org 引用通过 `kb://pg-{uuid}` URI(stable ID,移动/重命名不变)

## 环境变量

- `COCO_KB_URL` — cws-kb 直连地址(默认 `config.comm.kb_url`,即 `http://127.0.0.1:8080`)
- `COCO_AUTH_TOKEN` — Bearer token(跟 cws-core / cws-as 共用)
- `COCO_ORG_ID` — 覆盖 `config.org_id`
