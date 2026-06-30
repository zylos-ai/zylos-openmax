# cws-kb 依赖接口覆盖清单

本文档列出 **zylos-openmax** 当前依赖的 cws-kb HTTP 接口,逐项说明:

- 该接口在 **cws-kb** 中是否已实现
- 该接口在 **cws-core** 中是否有转发定义
- 接口干什么(Summary / Description 直接采自 cws-kb 的 `huma.Operation` 注册)
- 入参(path + query + body / header)
- 出参(响应 body)

依赖端来源:仅 `src/cli/kb.js`。openmax 中所有调用 cws-kb 的入口都通过 `src/lib/client.js` 的 `kbClient()` 走这一个文件。

服务端来源:

- cws-kb 路由:`cws-kb/internal/transport/http/{org_kb,tree,page,search,rebac}_handler.go`
- cws-core 路由:`cws-core/internal/transport/http/`(全量 grep,详见下文 "Coverage Summary")

> 文档生成时间 2026-05-28。**接口描述与参数定义以 cws-kb 服务为准**。两端路由表有变更时,需重新生成本文。
>
> ⚠️ **重要提示**:写文档过程中发现 `kb.js` 中有 **大量参数命名 / 结构与 cws-kb 不一致** 的问题,远多于 AS。所有"参数对不上"的地方都集中在文末 [发现的协议错位](#发现的协议错位) 一节,**对接 cws-kb 前请先看那一节**,不要直接照搬当前 `kb.js` 的入参。

---

## Coverage Summary

下表 8 列,覆盖所有 28 条依赖。"入参 / 出参"列仅展示关键字段简写(`*` 标记 required;完整字段表见每个接口的"逐项详解"小节)。

> "cws-kb" 列后括号注明该接口在 cws-kb 路由表中的源码定位。"接口描述"以 cws-kb `huma.Operation` 的 Summary + Description 为准。

### KB 集合 / Org 级

| # | Method + Path | as.js 调用点 | cws-kb | cws-core 转发 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|---|
| 1 | `POST /api/v1/kbs/init` | `kb.js:49`(`kb.init`) | ✅ `org_kb_handler.go:158` | ❌ | "Initialize org knowledge base" —— 用默认配置 bootstrap 一个 org 的 KB | body:`org_id*`、`creator_id*`、`creator_type*`(enum:user/agent/team/system) | `{ org_id, status: "initialized" \| "already_initialized" }`,Status 201 / 200 |
| 2 | `GET /api/v1/orgs/{org_id}/kbs` | `kb.js:54`(`kb.list`) | ✅ `org_kb_handler.go:71` | ❌ | "List knowledge bases" —— 返回该 org 的 KB,含 page_count 和 last_modified | path:`org_id*`;query:`status`(all/active/archived,默认 all)、`limit`(1..100,默认 50)、`offset` | `{ items: kbSummary[], total }` |
| 3 | `PUT /api/v1/orgs/{org_id}/kbs/archive` | `kb.js:59`(`kb.archive`) | ✅ `org_kb_handler.go:112` | ❌ | "Archive a knowledge base" | path:`org_id*`;header:`X-Org-ID*`(caller org,租户隔离) | 空 body,204 No Content |
| 4 | `PUT /api/v1/orgs/{org_id}/kbs/unarchive` | `kb.js:60`(`kb.unarchive`) | ✅ `org_kb_handler.go:135` | ❌ | "Unarchive a knowledge base" | 同上 | 同上 |

### 目录树 (Tree)

| # | Method + Path | as.js 调用点 | cws-kb | cws-core 转发 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|---|
| 5 | `GET /api/v1/orgs/{org_id}/tree/roots` | `kb.js:67`(`kb.tree_roots`) | ✅ `tree_handler.go:152` | ❌ | "List root nodes" | path:`org_id*` | `{ nodes: treeNode[] }` |
| 6 | `POST /api/v1/orgs/{org_id}/tree/folders` | `kb.js:72`(`kb.folder_create`) | ✅ `tree_handler.go:118` | ❌ | "Create a folder" | path:`org_id*`;body:`parent_id`(可选,null=根)、`name*`、`creator_id*`、`creator_type*` | `treeNodeBody`,Status 201 |
| 7 | `GET /api/v1/orgs/{org_id}/tree/nodes/{node_id}` | `kb.js:79`(`kb.node_get`) | ✅ `tree_handler.go:138` | ❌ | "Get a tree node" | path:`org_id*`、`node_id*` | `treeNodeBody` |
| 8 | `GET /api/v1/orgs/{org_id}/tree/nodes/{node_id}/breadcrumb` | `kb.js:84`(`kb.node_breadcrumb`) | ✅ `tree_handler.go:184` | ❌ | "Get breadcrumb path from root to node" | path:`org_id*`、`node_id*` | `{ nodes: treeNode[] }`(根 → 节点的链路) |
| 9 | `GET /api/v1/orgs/{org_id}/tree/nodes/{parent_id}/children` | `kb.js:89`(`kb.node_children`) | ✅ `tree_handler.go:168` | ❌ | "List children of a node" | path:`org_id*`、`parent_id*`(**无任何 query 参数**,cws-kb 不支持分页) | `{ nodes: treeNode[] }` |
| 10 | `PATCH /api/v1/orgs/{org_id}/tree/nodes/{node_id}/move` | `kb.js:95`(`kb.node_move`) | ✅ `tree_handler.go:218` | ❌ | "Move a tree node to a new parent" | path:`org_id*`、`node_id*`;body:`parent_id`(null=根) | 空 body |
| 11 | `PATCH /api/v1/orgs/{org_id}/tree/nodes/{node_id}/rename` | `kb.js:101`(`kb.node_rename`) | ✅ `tree_handler.go:200` | ❌ | "Rename a tree node" | path:`org_id*`、`node_id*`;body:`name*` | 空 body |
| 12 | `DELETE /api/v1/orgs/{org_id}/tree/nodes/{node_id}` | `kb.js:107`(`kb.node_delete`) | ✅ `tree_handler.go:236` | ❌ | "Delete a tree node" | path:`org_id*`、`node_id*` | 空 body |

### Page CRUD + 内容

| # | Method + Path | as.js 调用点 | cws-kb | cws-core 转发 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|---|
| 13 | `GET /api/v1/orgs/{org_id}/pages` | `kb.js:116`(`kb.pages`) | ✅ `page_handler.go:174` | ❌ | "List pages" —— 列出该 org 的 active 页 | path:`org_id*`;query:`limit`(1..100,默认 50)、`offset`。**无 `parent_id` 过滤** | `{ pages: pageBody[] }` |
| 14 | `POST /api/v1/orgs/{org_id}/pages` | `kb.js:166`(`kb.page_create`) | ✅ `page_handler.go:156` | ❌ | "Create a page" —— 带初始内容创建新 KB 页 | path:`org_id*`;body:`title*`、`path*`(树路径)、`format`(markdown/plain_text,默认 markdown)、`body*`、`creator_id*`、`creator_type*`、`message`(可选 commit message) | `pageBody`,Status 201 |
| 15 | `GET /api/v1/orgs/{org_id}/pages/{page_id}` | `kb.js:123`(`kb.page_get`) | ✅ `page_handler.go:165` | ❌ | "Get a page" —— 取页元数据 | path:`org_id*`、`page_id*` | `pageBody` |
| 16 | `PATCH /api/v1/orgs/{org_id}/pages/{page_id}` | `kb.js:179`(`kb.page_update`) | ✅ `page_handler.go:183` | ❌ | "Update page metadata" —— **只更新 title/path**(标题与树路径),内容更新走另一个 endpoint | path:`org_id*`、`page_id*`;body:`title`(可选)、`path`(可选);至少传 1 个 | `pageBody` |
| 17 | `DELETE /api/v1/orgs/{org_id}/pages/{page_id}` | `kb.js:191`(`kb.page_delete`) | ✅ `page_handler.go:192` | ❌ | "Trash a page" —— **软删(进回收站)**,不是硬删 | path:`org_id*`、`page_id*` | 空 body |
| 18 | `GET /api/v1/orgs/{org_id}/pages/{page_id}/content` | `kb.js:128`(`kb.page_content`) | ✅ `page_handler.go:210` | ❌ | "Get latest content" —— 取页的最新内容 revision | path:`org_id*`、`page_id*` | `contentBody`(含 revision_id + body) |
| 19 | `POST /api/v1/orgs/{org_id}/pages/{page_id}/content` | `kb.js:133`(`kb.page_content_write`) | ✅ `page_handler.go:201` | ❌ | "Update page content" —— 为页创建一个新的内容 revision | path:`org_id*`、`page_id*`;body:`body*`、`author_id*`、`author_type*`、`message`、`additions`、`deletions`、`base_revision_id`(乐观锁)、`auto_save`(自动保存合并) | `contentBody`,Status 201 |
| 20 | `GET /api/v1/orgs/{org_id}/pages/{page_id}/revisions` | `kb.js:143`(`kb.page_revisions`) | ✅ `page_handler.go:228` | ❌ | "List revisions" —— 页的版本历史 | path:`org_id*`、`page_id*`;query:`limit`(1..100,默认 50)、`offset` | `{ revisions: revisionSummary[], total }` |
| 21 | `GET /api/v1/orgs/{org_id}/pages/{page_id}/revisions/{revision_id}` | `kb.js:149`(`kb.page_revision`) | ✅ `page_handler.go:219` | ❌ | "Get a specific revision" —— 按 revision 号取内容 | path:`org_id*`、`page_id*`、`revision_id*`(int64) | `contentBody` |
| 22 | `GET /api/v1/orgs/{org_id}/pages/{page_id}/diff` | `kb.js:154`(`kb.page_diff`) | ✅ `page_handler.go:237` | ❌ | "Diff two revisions" —— unified diff | path:`org_id*`、`page_id*`;query:`from*`(int64,≥1)、`to*`(int64,≥1) | `{ page_id, org_id, from_rev, to_rev, diff }` |
| 23 | `POST /api/v1/orgs/{org_id}/pages/{page_id}/restore-version` | `kb.js:160`(`kb.page_restore`) | ✅ `page_handler.go:246` | ❌ | "Restore a previous version" —— 用旧版内容创建一个新 revision | path:`org_id*`、`page_id*`;body:`revision_id*`(int64,≥1)、`actor_id*`、`actor_type*` | `contentBody`,Status 201 |

### Search

| # | Method + Path | as.js 调用点 | cws-kb | cws-core 转发 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|---|
| 24 | `GET /api/v1/orgs/{org_id}/search/pages` | `kb.js:200`(`kb.search`) | ✅ `search_handler.go:48` | ❌ | "Search pages" —— Org 内全文搜索 | path:`org_id*`;query:`q*`(query,minLength 1)、`kb_id`、`limit`(1..100,默认 20)、`offset`、`sort`(relevance / created_at:asc / created_at:desc / updated_at:asc / updated_at:desc,默认 relevance) | `{ hits: searchHit[], total, query_time_ms }` |

### Relations (ReBAC)

| # | Method + Path | as.js 调用点 | cws-kb | cws-core 转发 | 接口描述 | 入参 | 出参 |
|---|---|---|---|---|---|---|---|
| 25 | `GET /api/v1/orgs/{org_id}/relations` | `kb.js:218`(`kb.relations_list`) | ✅ `rebac_handler.go:93` | ❌ | "List relations" —— 列出资源上的所有 relation | path:`org_id*`;query:`resource_type*`(org/folder/page)、`resource_id*`、`actor_type`、`actor_id`(actor 用于权限检查 —— 必须有 viewer 权限) | `{ relations: relationBody[] }` |
| 26 | `POST /api/v1/orgs/{org_id}/relations` | `kb.js:224`(`kb.relations_create`) | ✅ `rebac_handler.go:111` | ❌ | "Grant a relation" —— 授予或更新 subject 对 resource 的 relation | path:`org_id*`;body:`resource_type*`、`resource_id*`、`relation*`(owner/editor/commenter/viewer)、`subject_type*`、`subject_id*`、`actor_type`、`actor_id`、`expires_at`(RFC3339) | `relationBody`,Status 201 |
| 27 | `GET /api/v1/orgs/{org_id}/relations/check` | `kb.js:232`(`kb.relations_check`) | ✅ `rebac_handler.go:102` | ❌ | "Check a relation" —— 检查 subject 是否拥有指定 relation(含角色层级) | path:`org_id*`;query:`resource_type*`、`resource_id*`、`relation*`、`subject_type*`、`subject_id*` | `{ allowed: bool }` |
| 28 | `DELETE /api/v1/orgs/{org_id}/relations` | `kb.js:239`(`kb.relations_delete`) | ✅ `rebac_handler.go:120` | ❌ | "Revoke a relation" —— 删除 subject 对 resource 的 relation | path:`org_id*`;**body**(不是 query!):`resource_type*`、`resource_id*`、`subject_type*`、`subject_id*`、`actor_type`、`actor_id` | 空 body |

**结论:**

- **cws-kb 侧** 28/28 全部实现。
- **cws-core 侧** 0/28 —— `grep -rn "kbs\|/pages\|/tree\|/relations\|/search/pages" cws-core/` 0 命中,没有 handler、没有 proxy、router 也没注册。

cws-kb 还暴露但 **openmax 没用** 的接口(供后续参考):

- `GET /api/v1/orgs/{org_id}/tree` —— 全树嵌套 JSON
- `POST /api/v1/orgs/{org_id}/pages/{page_id}/freeze` —— 冻结页
- `GET /api/v1/orgs/{org_id}/pages/{page_id}/references` —— 解析页内容拿到所有 artifact 嵌入引用
- `GET /api/v1/orgs/{org_id}/pages/trash` —— 列出回收站页
- `POST /api/v1/orgs/{org_id}/pages/{page_id}/restore-from-trash` —— 从回收站恢复
- `DELETE /api/v1/orgs/{org_id}/pages/{page_id}/permanent` —— 永久删除(硬删)
- `POST /api/v1/orgs/{org_id}/archives` —— 归档相关
- `POST /api/v1/orgs/{org_id}/agent/store` —— agent 存储
- `/api/v1/kb/*` —— cws-kb 还有一套并行的"未来 surface"(带 `X-Org-Id` header),目前我们走的是 `/api/v1/orgs/{org_id}/*` 这套

---

## 逐项详解

下文每节中,"入参 / 出参"的字段名和类型直接抄自 cws-kb 端 `huma.Operation` 的 struct tag。

### KB 集合 / Org 级

#### 1. `POST /api/v1/kbs/init` —— Initialize org knowledge base

"Bootstrap KB configuration for an organization with default settings."

**入参(body):**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `org_id` | string | ✅ | minLength 1 |
| `creator_id` | string | ✅ | minLength 1 |
| `creator_type` | string enum | ✅ | `user` / `agent` / `team` / `system` |

**出参(body):**

| 字段 | 类型 | 说明 |
|---|---|---|
| `org_id` | string | |
| `status` | string enum | `initialized` / `already_initialized` |

Status code:`initialized` → 201;`already_initialized` → 200。

---

#### 2. `GET /api/v1/orgs/{org_id}/kbs` —— List knowledge bases

"Returns KBs for the specified org, with page counts and last-modified times."

**入参:**

- path: `org_id`(string, minLength 1)
- query: `status`(enum `all` / `active` / `archived`,默认 `all`)、`limit`(1..100,默认 50)、`offset`(默认 0)

**出参(body):** `{ items: kbSummary[], total: int64 }`,其中 `kbSummary` 见[通用类型](#通用类型)。

---

#### 3. `PUT /api/v1/orgs/{org_id}/kbs/archive` —— Archive a knowledge base

**入参:**

- path: `org_id`(string)
- header: `X-Org-ID`(string)—— 调用方所属 org,用于租户隔离;**未传或为空时返回 400**(TODO #47 会迁到 JWT claim)

**出参:** 空 body,Status 204 No Content。

---

#### 4. `PUT /api/v1/orgs/{org_id}/kbs/unarchive` —— Unarchive a knowledge base

与 #3 完全对称,入出参形态相同。

---

### 目录树 (Tree)

#### 5. `GET /api/v1/orgs/{org_id}/tree/roots` —— List root nodes

**入参:** path `org_id`

**出参(body):** `{ nodes: treeNodeBody[] }`,见[通用类型](#通用类型)。

---

#### 6. `POST /api/v1/orgs/{org_id}/tree/folders` —— Create a folder

**入参:**

- path: `org_id`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `parent_id` | string | | null = 根 |
| `name` | string | ✅ | minLength 1 |
| `creator_id` | string | ✅ | minLength 1 |
| `creator_type` | string enum | ✅ | `user` / `agent` / `team` / `system` |

**出参:** `treeNodeBody`,Status 201。

---

#### 7. `GET /api/v1/orgs/{org_id}/tree/nodes/{node_id}` —— Get a tree node

**入参:** path `org_id` + `node_id`

**出参:** `treeNodeBody`

---

#### 8. `GET /api/v1/orgs/{org_id}/tree/nodes/{node_id}/breadcrumb` —— Get breadcrumb path from root to node

**入参:** path `org_id` + `node_id`

**出参(body):** `{ nodes: treeNodeBody[] }`,从根到目标节点。

---

#### 9. `GET /api/v1/orgs/{org_id}/tree/nodes/{parent_id}/children` —— List children of a node

**入参:** path `org_id` + `parent_id`(注意路径参数名是 `parent_id`,不是 `node_id`)。**无 query 参数。**

**出参(body):** `{ nodes: treeNodeBody[] }`

---

#### 10. `PATCH /api/v1/orgs/{org_id}/tree/nodes/{node_id}/move` —— Move a tree node to a new parent

**入参:**

- path: `org_id` + `node_id`
- body: `{ "parent_id": string? }`(null = 移到根)

**出参:** 空 body。

---

#### 11. `PATCH /api/v1/orgs/{org_id}/tree/nodes/{node_id}/rename` —— Rename a tree node

**入参:**

- path: `org_id` + `node_id`
- body: `{ "name": string }`(必填,minLength 1)

**出参:** 空 body。

---

#### 12. `DELETE /api/v1/orgs/{org_id}/tree/nodes/{node_id}` —— Delete a tree node

**入参:** path `org_id` + `node_id`

**出参:** 空 body。

---

### Page CRUD + 内容

#### 13. `GET /api/v1/orgs/{org_id}/pages` —— List pages

"List active pages for an organization."

**入参:**

- path: `org_id`
- query: `limit`(1..100,默认 50)、`offset`(默认 0)

**出参(body):** `{ pages: pageBody[] }`,见[通用类型](#通用类型)。

---

#### 14. `POST /api/v1/orgs/{org_id}/pages` —— Create a page

"Create a new KB page with initial content."

**入参:**

- path: `org_id`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `title` | string | ✅ | minLength 1 |
| `path` | string | ✅ | 树路径(minLength 1) |
| `format` | string enum | | `markdown` / `plain_text`,默认 `markdown` |
| `body` | string | ✅ | 初始内容(纯文本/markdown) |
| `creator_id` | string | ✅ | minLength 1 |
| `creator_type` | string enum | ✅ | `user` / `agent` / `team` / `system` |
| `message` | string | | 可选 commit message |

**出参:** `pageBody`,Status 201。

---

#### 15. `GET /api/v1/orgs/{org_id}/pages/{page_id}` —— Get a page

**入参:** path `org_id` + `page_id`

**出参:** `pageBody`

---

#### 16. `PATCH /api/v1/orgs/{org_id}/pages/{page_id}` —— Update page metadata

"Update page title and/or path without creating a content revision."

注意:**这里 path 指 KB 树路径,不是 URL path**;**不能改内容**(内容更新走 #19)。

**入参:**

- path: `org_id` + `page_id`
- body(至少传一个,否则 400):

| 字段 | 类型 | 说明 |
|---|---|---|
| `title` | string? | 新标题 |
| `path`  | string? | 新树路径 |

**出参:** `pageBody`

---

#### 17. `DELETE /api/v1/orgs/{org_id}/pages/{page_id}` —— Trash a page

"Soft-delete a page (moves to trash)."

这是软删 / 入回收站,不是物理删除。物理删除是另一个 endpoint:`DELETE .../permanent`(我们没用)。

**入参:** path `org_id` + `page_id`

**出参:** 空 body。

---

#### 18. `GET /api/v1/orgs/{org_id}/pages/{page_id}/content` —— Get latest content

"Retrieve the latest content revision for a page."

**入参:** path `org_id` + `page_id`

**出参:** `contentBody`,见[通用类型](#通用类型)。

---

#### 19. `POST /api/v1/orgs/{org_id}/pages/{page_id}/content` —— Update page content

"Create a new content revision for a page."

**入参:**

- path: `org_id` + `page_id`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `body` | string | ✅ | 新内容(纯文本/markdown) |
| `author_id` | string | ✅ | minLength 1 |
| `author_type` | string enum | ✅ | `user` / `agent` / `team` / `system` |
| `message` | string | | 可选 commit message |
| `additions` | int32 | | 新增行数 |
| `deletions` | int32 | | 删除行数 |
| `base_revision_id` | int64 | | 乐观锁;不匹配返回 409 |
| `auto_save` | bool | | 自动保存合并 |

**出参:** `contentBody`,Status 201。

---

#### 20. `GET /api/v1/orgs/{org_id}/pages/{page_id}/revisions` —— List revisions

**入参:**

- path: `org_id` + `page_id`
- query: `limit`(1..100,默认 50)、`offset`

**出参(body):** `{ revisions: revisionSummary[], total: int64 }`

`revisionSummary`:`{ revision_id (int64), author_id, author_type, message?, additions?, deletions?, created_at }`

---

#### 21. `GET /api/v1/orgs/{org_id}/pages/{page_id}/revisions/{revision_id}` —— Get a specific revision

**入参:** path `org_id` + `page_id` + `revision_id`(int64)

**出参:** `contentBody`

---

#### 22. `GET /api/v1/orgs/{org_id}/pages/{page_id}/diff` —— Diff two revisions

"Compute a unified diff between two content revisions."

**入参:**

- path: `org_id` + `page_id`
- query: `from*`(int64,≥1)、`to*`(int64,≥1)

**出参(body):** `{ page_id, org_id, from_rev (int64), to_rev (int64), diff (unified diff 文本) }`

---

#### 23. `POST /api/v1/orgs/{org_id}/pages/{page_id}/restore-version` —— Restore a previous version

"Restore page to a previous revision by creating a new revision with the old content."

**入参:**

- path: `org_id` + `page_id`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `revision_id` | int64 | ✅ | ≥1,要恢复到哪个 rev |
| `actor_id` | string | ✅ | minLength 1 |
| `actor_type` | string enum | ✅ | `user` / `agent` / `team` / `system` |

**出参:** `contentBody`,Status 201。

---

### Search

#### 24. `GET /api/v1/orgs/{org_id}/search/pages` —— Search pages

"Full-text search across pages within an organization."

**入参:**

- path: `org_id`(minLength 1)
- query:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `q` | string | ✅ | 搜索 query,minLength 1 |
| `kb_id` | string | | 限定到某个 KB |
| `limit` | int64 | | 1..100,默认 20 |
| `offset` | int64 | | 默认 0 |
| `sort` | enum | | `relevance`(默认) / `created_at:asc` / `created_at:desc` / `updated_at:asc` / `updated_at:desc` |

**出参(body):** `{ hits: searchHit[], total: int64, query_time_ms: int64 }`,`searchHit` 见[通用类型](#通用类型)。

---

### Relations (ReBAC)

#### 25. `GET /api/v1/orgs/{org_id}/relations` —— List relations

"List all relations for a resource."

**入参:**

- path: `org_id`
- query:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `resource_type` | enum | ✅ | `org` / `folder` / `page` |
| `resource_id` | string | ✅ | |
| `actor_type` | enum | | caller 实体类型 |
| `actor_id` | string | | 传了的话,actor 必须对 resource 有 viewer 权限 |

**出参(body):** `{ relations: relationBody[] }`,`relationBody` 见[通用类型](#通用类型)。

---

#### 26. `POST /api/v1/orgs/{org_id}/relations` —— Grant a relation

"Grant or update a relation between a subject and a resource."

**入参:**

- path: `org_id`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `resource_type` | enum | ✅ | `org` / `folder` / `page` |
| `resource_id` | string | ✅ | minLength 1 |
| `relation` | enum | ✅ | `owner` / `editor` / `commenter` / `viewer` |
| `subject_type` | enum | ✅ | `user` / `agent` / `team` / `system` |
| `subject_id` | string | ✅ | minLength 1 |
| `actor_type` | enum | | caller 实体类型(授权检查) |
| `actor_id` | string | | 传了的话 actor 必须是 owner |
| `expires_at` | string (RFC3339) | | 失效时间 |

**出参:** `relationBody`,Status 201。

---

#### 27. `GET /api/v1/orgs/{org_id}/relations/check` —— Check a relation

"Check whether a subject has the required relation to a resource (with role hierarchy)."

**入参:**

- path: `org_id`
- query:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `resource_type` | enum | ✅ | `org` / `folder` / `page` |
| `resource_id` | string | ✅ | |
| `relation` | enum | ✅ | `owner` / `editor` / `commenter` / `viewer` —— **要检查的具体 relation** |
| `subject_type` | enum | ✅ | |
| `subject_id` | string | ✅ | |

**出参(body):** `{ allowed: bool }`

---

#### 28. `DELETE /api/v1/orgs/{org_id}/relations` —— Revoke a relation

"Remove a relation between a subject and a resource."

注意:**入参在 body,不是 query**。

**入参:**

- path: `org_id`
- body:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `resource_type` | enum | ✅ | `org` / `folder` / `page` |
| `resource_id` | string | ✅ | minLength 1 |
| `subject_type` | enum | ✅ | |
| `subject_id` | string | ✅ | minLength 1 |
| `actor_type` | enum | | caller 实体类型 |
| `actor_id` | string | | 传了的话 actor 必须是 owner |

**出参:** 空 body。

---

## 通用类型

### `treeNodeBody`

(取自 `tree_handler.go:16`,适用于所有 tree endpoint 的响应)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | Node ID |
| `org_id` | string | |
| `parent_id` | string? | null 表示根 |
| `name` | string | |
| `node_type` | string | `folder` / `page` / `file` |
| `page_id` | string? | page 节点的关联 page ID |
| `artifact_id` | string? | file 节点的关联 artifact ID |
| `creator_type` | string? | |
| `creator_id` | string? | |
| `sort_order` | int32 | 父节点下的排序 |
| `children_count` | int? | 仅在全树响应里出现 |
| `created_at` | RFC3339 string | |
| `updated_at` | RFC3339 string | |

### `pageBody`

(取自 `page_handler.go:35`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | Page ID |
| `org_id` | string | |
| `title` | string | |
| `path` | string | KB 树路径 |
| `format` | string | `markdown` / `plain_text` |
| `status` | string | Page 状态 |
| `current_revision_id` | int64? | 最新 revision ID |
| `created_by` | string | |
| `created_by_type` | string | |
| `last_edited_by` | string? | |
| `last_edited_by_type` | string? | |
| `created_at` | RFC3339 string | |
| `updated_at` | RFC3339 string | |

### `contentBody`

(取自 `page_handler.go:102`,适用于 #18 / #19 / #21 / #23 的响应)

| 字段 | 类型 | 说明 |
|---|---|---|
| `page_id` | string | |
| `org_id` | string | |
| `revision_id` | int64 | |
| `body` | string | 内容正文 |
| `author_id` | string | |
| `author_type` | string | |
| `message` | string? | commit message |
| `additions` | int32? | |
| `deletions` | int32? | |
| `created_at` | RFC3339 string | |

### `kbSummary`

(取自 `org_kb_handler.go:42`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `org_id` | string | |
| `status` | enum | `active` / `archived` |
| `visibility` | string | |
| `page_count` | int64 | active page 数 |
| `last_modified_at` | RFC3339 string? | |
| `created_at` | RFC3339 string | |

### `searchHit`

(取自 `search_handler.go:22`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `page_id` | string | |
| `org_id` | string | |
| `kb_id` | string? | |
| `title` | string | 可能含高亮标记 |
| `path` | string | |
| `snippet` | string | 带高亮的正文片段 |
| `author_id` | string | |
| `author_type` | string | |
| `accessible` | bool | 当前用户是否有访问权 |
| `created_at` | string | |
| `updated_at` | string | |

### `relationBody`

(取自 `rebac_handler.go:35`)

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | Relation ID |
| `org_id` | string | |
| `resource_type` | string | |
| `resource_id` | string | |
| `relation` | string | `owner` / `editor` / `commenter` / `viewer` |
| `subject_type` | string | |
| `subject_id` | string | |
| `granted_by` | string? | 授权人 ID |
| `expires_at` | RFC3339 string? | |
| `created_at` | RFC3339 string | |

---

## 发现的协议错位

写文档时把 `src/cli/kb.js` 的每一个调用都和 cws-kb 端 struct tag 对了一遍,**有大量不一致**。这里按"影响半径"从高到低排:

### 🔴 F1 —— 高半径:核心 page CRUD / 内容 / search / relations 参数全错

直接拷贝改完之前,这些调用基本都会失败或行为错乱:

| `kb.js` 命令 | 不一致 | 实际效果 |
|---|---|---|
| `kb.page_create`(`kb.js:166`)        | 我们发 `{ title, parent_id, format, content, commit_message }`;cws-kb 要 `{ title, path*, format, body*, creator_id*, creator_type*, message }` | 关键字段名错位 + 缺必填 `creator_id` / `creator_type` —— **直接 400** |
| `kb.page_content_write`(`kb.js:133`) | 我们发 `{ content: {body, front_matter?}, base_revision_id, commit_message }`;cws-kb 要 `{ body*, author_id*, author_type*, message, additions?, deletions?, base_revision_id?, auto_save? }` | 内容字段名错(`content.body` vs `body`)+ 缺必填 `author_id` / `author_type` —— **直接 400** |
| `kb.page_restore`(`kb.js:160`)       | 我们发 `{ revision_id, commit_message }`;cws-kb 要 `{ revision_id*, actor_id*, actor_type* }` | 缺必填 `actor_id` / `actor_type` —— **400** |
| `kb.page_update`(`kb.js:179`)        | 我们发 `{ title, parent_id, content, base_revision_id, commit_message }`;cws-kb 只接 `{ title?, path? }` | PATCH 在 cws-kb 只改 metadata,内容改动 **没生效**;`parent_id` 字段不存在(对应的应该是 `path`) |
| `kb.search`(`kb.js:200`)             | 我们发 `{ query, folder_id, author_id, format, page_size, page_token, sync }`;cws-kb 要 `{ q*, kb_id, limit, offset, sort }` | 查询关键字 `q` 错成 `query`、`folder_id`/`author_id`/`format`/`sync` 完全不存在 —— **400(`q` 缺失 / minLength 1)** |
| `kb.relations_check`(`kb.js:232`)    | 我们发 `{ resource_type, resource_id, target_type, target_id }`;cws-kb 要 `{ resource_type, resource_id, relation*, subject_type, subject_id }`(都在 query) | `target_*` → `subject_*` 错位 + **缺必填 `relation`(检查哪种权限)** |
| `kb.relations_create`(`kb.js:224`)   | 我们发 `{ resource_type, resource_id, target_type, target_id, role }`;cws-kb 要 `{ resource_type, resource_id, relation*, subject_type*, subject_id*, actor_type?, actor_id?, expires_at? }` | `target_*` / `role` → `subject_*` / `relation` 错位 |
| `kb.relations_delete`(`kb.js:239`)   | 我们把所有字段拼进 query string(`?resource_type=...`);cws-kb 要 `revokeRelationRequest.Body`,即 **JSON body**;且字段是 `subject_*` 不是 `target_*` | 传输位置错(query → body)+ 字段名错 —— **400** |
| `kb.relations_list`(`kb.js:218`)     | 我们发 `{ resource_type, resource_id, target_type, target_id }`;cws-kb 要 `{ resource_type*, resource_id*, actor_type?, actor_id? }` | `target_*` 字段不存在,cws-kb 这是"列出 resource 上的全部 subject"(用 actor 做权限检查),不是"查 A 和 B 是否相连"的 graph 查询。语义不同 |

### 🟡 F2 —— 中半径:缺 required 字段,直接 400

| `kb.js` 命令 | 缺什么 |
|---|---|
| `kb.init`(`kb.js:49`)           | 缺 `creator_id*`、`creator_type*` |
| `kb.folder_create`(`kb.js:72`)  | 缺 `creator_id*`、`creator_type*`;另发了一个 cws-kb 不接的 `sort_order` |
| `kb.archive` / `kb.unarchive`(`kb.js:59-60`) | 没传 `X-Org-ID` header(由 `kbClient` 全局头注入决定;**需要核对 `client.js` 里有没有自动注入**)。 cws-kb 端没有就直接 400 |

### 🟢 F3 —— 低半径:参数名错但 cws-kb 静默忽略

下面这些不会立刻 400,但会让我们"以为传了过滤/分页"实际上没生效:

| `kb.js` 命令 | 我们传 → cws-kb 接 |
|---|---|
| `kb.pages`(`kb.js:116`)          | `{ parent_id, page_size, page_token }` → cws-kb 只接 `{ limit, offset }`(无 `parent_id` 过滤);分页全失效,parent 过滤无效 |
| `kb.node_children`(`kb.js:89`)   | `{ page_size, page_token }` → cws-kb **无任何 query**,直接全量返回 |
| `kb.page_revisions`(`kb.js:143`) | `{ page_size, page_token }` → cws-kb 要 `{ limit, offset }`,我们的分页全失效 |
| `kb.page_diff`(`kb.js:154`)      | `{ from_revision_id, to_revision_id }` → cws-kb 要 `{ from*, to* }`(且 ≥1,required)—— **可能 400 因为 `from`/`to` 缺失** |
| `kb.node_move`(`kb.js:95`)       | `{ parent_id, sort_order }` → cws-kb 只接 `{ parent_id }`,`sort_order` 被忽略 |

### F4 —— 语义提醒:`kb.page_delete` 其实是软删

`DELETE /api/v1/orgs/{org_id}/pages/{page_id}` 在 cws-kb 是 **trash**(进回收站),不是物理删除。物理删除是另一个 endpoint `DELETE .../permanent`,我们没用到。命名上 `kb.page_delete` 容易误以为是硬删,在 UI 提示时需要说"已移入回收站"。

---

## 重新生成本文

cws-kb 增删改路由时:

```bash
cd cws-kb
grep -rnE 'Path:\s*"/api/v1' internal/transport/http/
```

检查 cws-core 转发覆盖时:

```bash
cd cws-core
grep -rnE "kbs|/pages|/tree|/relations|/search/pages|/orgs/.*/kbs" internal/ pkg/ cmd/
```
