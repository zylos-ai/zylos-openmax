# KB 操作指南

CLI 位置：`src/cli/kb.js`
调用方式：`node src/cli/kb.js <command> '<json>'`

## 命令列表

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `kb.search` | 语义搜索 KB 内容 | `{query, scope?, limit?}` |
| `kb.read` | 读取 Page 内容 | `{pageId}` 或 `{path}` |
| `kb.write` | 写入/更新 Page | `{path, content, commitMessage}` |
| `kb.list` | 列出目录内容 | `{path, recursive?}` |
| `kb.meta` | 获取 Page 元数据 | `{pageId}` 或 `{path}` |
| `kb.history` | 查看 Page 变更历史 | `{pageId, limit?}` |
| `kb.resolve` | 将 `kb://pg-xxx` URI 解析为路径和内容 | `{uri}` |

## 搜索策略

按优先级使用：

1. **精确定位**：已知路径 → `kb.read {path}`
2. **范围内扫描**：已知目录 → `kb.list {path}` → 筛选 → `kb.read`
3. **语义搜索**：不确定位置 → `kb.search {query}`
4. **历史 Issue 关联**：需要先例 → TM 查 accepted Issue → `kb.read` 读 blueprint 快照

## 常用路径

| 路径 | 内容 | 典型操作 |
| --- | --- | --- |
| `/org/` | 组织级共享知识 | 读取 |
| `/teams/{slug}/` | 团队规范、playbooks | 读取 |
| `/projects/{slug}/overview.md` | 项目背景 | 读取 |
| `/projects/{slug}/decisions/` | ADR | 读取 + 写入 |
| `/projects/{slug}/research/` | 调研沉淀 | 读取 + 写入 |
| `/projects/{slug}/deliverables/` | 交付物索引 | 写入 |
| `/agents/{slug}/memory.md` | Agent 主记忆 | 读写 |
| `/agents/{slug}/lessons/` | 踩坑经验 | 读写 |
| `/agents/{slug}/private/` | 私有内容 | 读写 |

## 写入规范

- 持久引用使用 `kb://pg-xxx` id 形态，不嵌入路径
- 文件名使用 kebab-case
- 不往 `/issues/` 下写任何东西（系统只读快照）

## 权限错误处理

- `NOT_FOUND` → 资源不存在或无读权限，换搜索策略
- `PERMISSION_DENIED` → 有读权限但无写权限，换写入位置
- `CONFLICT` → 并发编辑冲突，重新读取后重试
