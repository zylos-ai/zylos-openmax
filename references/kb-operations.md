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
| ✅ | `kb.init` | `{orgId?}` | `POST /api/v1/kbs/init` |
| ✅ | `kb.list` | `{orgId?, status?}` | `GET /api/v1/orgs/{orgId}/kbs?status=` |
| ✅ | `kb.archive` | `{orgId?}` | `PUT /api/v1/orgs/{orgId}/kbs/archive` |
| ✅ | `kb.unarchive` | `{orgId?}` | `PUT /api/v1/orgs/{orgId}/kbs/unarchive` |

`status` 取值:`active` / `archived` / `all`。

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
| ✅ | `kb.page_delete` | `{pageId, orgId?}` | `DELETE /pages/{pageId}` |
| ✅ | `kb.page_content` | `{pageId, orgId?}` | `GET /pages/{pageId}/content` |
| ✅ | `kb.page_content_write` | `{pageId, content:{body, front_matter?}, baseRevisionId, commitMessage?, orgId?}` | `POST /pages/{pageId}/content` |
| ✅ | `kb.page_revisions` | `{pageId, orgId?, pageSize?, pageToken?}` | `GET /pages/{pageId}/revisions` |
| ✅ | `kb.page_revision` | `{pageId, revisionId, orgId?}` | `GET /pages/{pageId}/revisions/{revId}` |
| ✅ | `kb.page_diff` | `{pageId, fromRevisionId, toRevisionId, orgId?}` | `GET /pages/{pageId}/diff?from_revision_id=&to_revision_id=` |
| ✅ | `kb.page_restore` | `{pageId, revisionId, commitMessage?, orgId?}` | `POST /pages/{pageId}/restore-version` |

页面 ID 形态:`pg-{uuid}`。Revision 是每页自增整数从 1 起。

**两个写入入口的区别**:

- `kb.page_update`(`PATCH /pages/{pid}`):改页面**任意属性**(标题、parent、内容…),body 里能传哪个传哪个
- `kb.page_content_write`(`POST /pages/{pid}/content`):**只**改内容主体,语义更专,适合 Agent 后续大段编辑

两者都支持乐观并发:先 `kb.page_get` 拿 `revision_id`,写时把它当 `baseRevisionId` 传过去,服务端若发现不一致返回 409 + 当前 revision_id,客户端重读后合并再写。

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

### 关联(KB ↔ Project / Issue 等)

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `kb.relations_list` | `{resourceType?, resourceId?, targetType?, targetId?, orgId?}` | `GET /relations` |
| ✅ | `kb.relations_create` | `{resourceType, resourceId, targetType, targetId, role, orgId?}` | `POST /relations` |
| ✅ | `kb.relations_check` | 同 list | `GET /relations/check` |
| ✅ | `kb.relations_delete` | `{resourceType, resourceId, targetType, targetId, role?, orgId?}` | `DELETE /relations?...` |

用例:把一个 Project 关到一个 KB folder("项目交付物归档到这"),后续 `kb.search` 可以按 `folder_id` 限定到这个 folder。

### 文件附件

| 状态 | 命令 | 入参 | 真实端点 |
| --- | --- | --- | --- |
| ✅ | `kb.upload` | `{filePath, mediaType?, contentType?, description?, nodeId?, pageId?, orgId?}` | 委托给 `as.uploadMedia()` |

`kb.upload` **不调 KB 私有 multipart 端点**,统一走 `as.uploadMedia()`(cws-as 3-step:create artifact + PUT + finalize)。返回的 `mediaId` / `artifactId` 可以塞到 Page body 里(比如 markdown 里写 `![](as://org_x/art_y)`),配合 `kb.relations_create` 把这个 artifact 跟当前页面挂上。

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
