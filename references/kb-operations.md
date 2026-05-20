# KB 操作指南

CLI 位置：`src/cli/kb.js`
调用方式：`node src/cli/kb.js <command> '<json>'`

KB 数据模型分三层：

- **KB**（仓库）：`/knowledge-bases/{kbId}`
- **Node**（节点 = 文件夹或页面壳）：`/knowledge-bases/{kbId}/nodes/{nodeId}`
- **Page**（内容主体）：`/knowledge-bases/{kbId}/pages/{pageId}`

一个 `kind:"page"` 的 Node 对应一个 Page；Page 的内容存在独立路径下，便于做内容版本/大小拆分。

## 命令列表

### KB 集合

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `kb.list` | 列出当前 workspace 可见的 KB | `{tab?, q?, cursor?, limit?}` |
| `kb.get` | 获取 KB 详情 | `{kbId}` |
| `kb.create` | 创建 KB（可挂到 team 下） | `{name, description?, teamId?, icon?}` |
| `kb.archive` | 归档 KB | `{kbId}` |
| `kb.restore` | 从归档恢复 | `{kbId}` |

### 节点（目录树）

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `kb.tree` | 整棵目录树（一次性返回） | `{kbId}` |
| `kb.nodes` | 按父节点平铺列表（分页友好） | `{kbId, parentId?, cursor?, limit?}` |
| `kb.node_create` | 创建节点（文件夹 / 页面壳） | `{kbId, parentId?, kind, title, icon?}` |
| `kb.node_get` | 节点元信息 | `{kbId, nodeId}` |
| `kb.node_update` | 重命名 / 移动节点 | `{kbId, nodeId, title?, parentId?, icon?}` |
| `kb.node_delete` | 删除节点（连带子节点 / Page） | `{kbId, nodeId}` |

`kind` 取值：`folder`（文件夹）/ `page`（页面，创建时同步开 Page）。

### 页面内容

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `kb.read` | 读取 Page 完整内容 | `{kbId, pageId}` |
| `kb.write` | 写入 Page（全量 PUT） | `{kbId, pageId, title?, content, contentFormat?, commitMessage?, baseVersion?}` |

写入时若服务端要求乐观并发：

- 先 `kb.read` 拿到当前 `version` / `updated_at`
- `kb.write` 时把它放在 `baseVersion`
- 收到 409 → 重新读取后合并再写

### 文件附件

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `kb.upload` | 上传二进制文件挂在 KB 下 | `{kbId, filePath, filename?, contentType?, parentId?, title?}` |

返回携带 artifact URI / node id，可用于 Markdown 引用：

```bash
node src/cli/kb.js kb.upload '{"kbId":"kb-1","filePath":"/tmp/q2-report.pdf","parentId":"nd-deliv","title":"Q2 报告"}'
# 输出: {"data":{"node_id":"nd-xxx","url":"...","size":...}, ...}
```

## 搜索策略（无 `kb.search` 端点的临时方案）

网关目前尚未暴露语义搜索接口（pending #待确认问题），按下面顺序定位内容：

1. **已知节点 id** → `kb.node_get` / `kb.read` 直接打开
2. **目录已知** → `kb.tree` 一次拉树 + 客户端筛选 → `kb.read`
3. **大 KB 且路径未知** → 走目录分层 `kb.nodes {parentId}` 逐层下钻
4. **关联 Issue / Task** → 通过 `tm.*` 拿 link 后回到 `kb.read`

`kb.search` 等语义检索能力上线后，会作为优先级 0 的入口加回本指南。

## 常用 KB 用途

| 用途 | 典型节点 | 操作 |
| --- | --- | --- |
| 组织级知识 | 顶层 `org/` | 读 |
| 团队规范 / playbook | team KB 下的 `playbooks/` | 读，偶尔 PR |
| 项目背景 / ADR | project KB 下的 `decisions/`、`research/` | 读 + 写 |
| 交付物索引 | project KB 下的 `deliverables/` | 写（链向 `kb.upload` 文件） |
| Agent 主记忆 | agent 私有 KB 下的 `memory.md` | 读 + 写 |

## 权限错误处理

- `404 NOT_FOUND` → 资源不存在或无读权限，换路径或确认 `kbId` 来源
- `403 PERMISSION_DENIED` → 有读权限但无写权限，换写入位置或申请提权
- `409 CONFLICT` → 并发编辑或 `baseVersion` 过期，重读后重试
- `413 PAYLOAD_TOO_LARGE` → 单 Page 体积超限，拆页或改用 `kb.upload`

## 环境变量

- `COCO_API_URL` — 网关入口（默认 `http://127.0.0.1:8080`）
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀，默认 `/api/gateway/v1`。开发调试 cws-core 直连时改成 `/api`
