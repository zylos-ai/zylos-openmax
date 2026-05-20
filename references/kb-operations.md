# KB 操作指南

CLI 位置:`src/cli/kb.js`
调用方式:`node src/cli/kb.js <command> '<json>'`

> ⚠️ **整个 KB 域 cws-core 尚未暴露**。OpenAPI 里没有 `/knowledge-bases/*` 任何路径。
> 全部命令 ⏳,调用今天都会 404。本文档把"期望的接口形态"先定下来,等 core 上线即用即跑。

状态:**全部 ⏳**

## 数据模型(规划中)

```
KB(仓库,顶层)
  └─ Node(节点,目录树的格子)
       ├─ kind:"folder"     (没有内容,只有子节点)
       └─ kind:"page"       (有 Page 内容主体)
              ↓
            Page(内容)
```

一个 `kind:"page"` 的 Node 通过 `page_id` 关联一个 Page。这样目录结构 / 元信息 / 重命名只动 Node,大内容只动 Page,扩展性好。

## 命令列表

### KB 集合

| 状态 | 命令 | 入参 | 期望端点 |
| --- | --- | --- | --- |
| ⏳ | `kb.list` | `{tab?, q?, cursor?, limit?}` | `GET /api/v1/knowledge-bases` |
| ⏳ | `kb.get` | `{kbId}` | `GET /api/v1/knowledge-bases/{id}` |
| ⏳ | `kb.create` | `{name, description?, teamId?, icon?}` | `POST /api/v1/knowledge-bases` |
| ⏳ | `kb.archive` | `{kbId}` | `POST /api/v1/knowledge-bases/{id}/archive` |
| ⏳ | `kb.restore` | `{kbId}` | `POST /api/v1/knowledge-bases/{id}/restore` |

### 节点(目录树)

| 状态 | 命令 | 入参 | 期望端点 |
| --- | --- | --- | --- |
| ⏳ | `kb.tree` | `{kbId}` | `GET /api/v1/knowledge-bases/{id}/tree` |
| ⏳ | `kb.nodes` | `{kbId, parentId?, cursor?, limit?}` | `GET /api/v1/knowledge-bases/{id}/nodes` |
| ⏳ | `kb.node_create` | `{kbId, parentId?, kind, title, icon?}` | `POST /api/v1/knowledge-bases/{id}/nodes` |
| ⏳ | `kb.node_get` | `{kbId, nodeId}` | `GET /api/v1/knowledge-bases/{id}/nodes/{nid}` |
| ⏳ | `kb.node_update` | `{kbId, nodeId, title?, parentId?, icon?}` | `PATCH /api/v1/knowledge-bases/{id}/nodes/{nid}` |
| ⏳ | `kb.node_delete` | `{kbId, nodeId}` | `DELETE /api/v1/knowledge-bases/{id}/nodes/{nid}` |

`kind` 取值:`folder` / `page`(创建 `page` 时同步开 Page 主体)。

### 页面内容

| 状态 | 命令 | 入参 | 期望端点 |
| --- | --- | --- | --- |
| ⏳ | `kb.read` | `{kbId, pageId}` | `GET /api/v1/knowledge-bases/{id}/pages/{pid}` |
| ⏳ | `kb.write` | `{kbId, pageId, title?, content, contentFormat?, commitMessage?, baseVersion?}` | `PUT /api/v1/knowledge-bases/{id}/pages/{pid}` |

写入约束(规划):`baseVersion` 用于乐观并发 —— 先 read 拿 version,write 时附上,409 时重读合并再写。

### 文件附件

| 状态 | 命令 | 入参 | 期望端点 |
| --- | --- | --- | --- |
| ⏳ | `kb.upload` | `{kbId, filePath, mediaType?, contentType?}` | 委托给 `as.uploadMedia()` |

`kb.upload` **不走 KB 私有 multipart 端点**,而是统一走 `as.uploadMedia()`(`as.js` 是仓库唯一上传入口)。`kbId` 作为 scoping 字段传给 `conversationId`(后端访问控制按 scope 校验即可)。返回 `{mediaId, ...}`,在 KB 节点里登记这个 `mediaId` 即可。

## 搜索策略(没有 `kb.search` 怎么办)

cws-core 现在 + 规划里都没有 `kb.search` —— 语义搜索是更上游的能力,可能由独立服务做。临时方案:

1. **已知节点 id** → 直接 `kb.node_get` / `kb.read`
2. **目录已知** → `kb.tree` 一次拉树,客户端筛选 → `kb.read`
3. **路径未知** → 走 `kb.nodes {parentId}` 逐层下钻
4. **关联 Issue / Task** → 通过 `tm.*` 拿 link 后回到 `kb.read`

## 常用 KB 用途规划

| 用途 | 典型节点 | 操作 |
| --- | --- | --- |
| 组织级知识 | 顶层 `org/` | 读 |
| 团队 playbook | team KB 下的 `playbooks/` | 读,偶尔 PR |
| 项目背景 / ADR | project KB 下的 `decisions/`、`research/` | 读 + 写 |
| 交付物索引 | project KB 下的 `deliverables/` | 写(链向 `kb.upload` 文件) |
| Agent 主记忆 | agent 私有 KB 下的 `memory.md` | 读 + 写 |

## 错误处理(规划)

- `404 NOT_FOUND` → 资源不存在或无读权限
- `403 PERMISSION_DENIED` → 有读无写,换写入位置
- `409 CONFLICT` → 并发写,重读后合并
- `413 PAYLOAD_TOO_LARGE` → 单 Page 体积超限,拆页或用 `kb.upload`

## 环境变量

- `COCO_API_URL` — cws-core 入口(默认 `http://127.0.0.1:8080`)
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀(默认 `/api/v1`)
