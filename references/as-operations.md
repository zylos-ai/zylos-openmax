# AS 操作指南

CLI 位置：`src/cli/as.js`
调用方式：`node src/cli/as.js <command> '<json>'`

## AS 概念在网关上的实际形态

网关并没有一个独立的 `/artifacts` 命名空间。文件附件按"挂在哪"分两条路径：

| 场景 | 路径 | 流程 |
| --- | --- | --- |
| IM 会话内附件（图片、文档随消息发送） | `/im/uploads/*` | 两步：presign → 客户端 PUT → complete |
| KB 内的文件（产出物、附件、嵌入资源） | `/knowledge-bases/{kbId}/files` | 一步 multipart |

写代码时不需要纠结"这是 AS 还是 IM 还是 KB"——按文件最终要挂在哪里决定走哪个流程。

## 命令列表

### IM 附件流程

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `as.upload_im` | 完整流程：本地文件 → 会话附件 | `{conversationId, filePath, filename?, contentType?}` |
| `as.presign` | 只走 presign（拿 put_url） | `{conversationId, files:[{name,mime_type,size}]}` |
| `as.complete` | 只走 complete（已自行 PUT 完字节后） | `{uploadId}` |

`as.upload_im` 内部做了三步：

1. POST `/im/uploads/presign` 拿 `{upload_id, put_url, headers?}`
2. PUT 原始字节到 `put_url`（典型是 S3 预签名 URL，带 `Content-Type`）
3. POST `/im/uploads/{upload_id}/complete` 拿到 Attachment 元信息

随后用 `comm.send` 把 attachment 挂到消息上即可。

### KB 文件

| 命令 | 说明 | 参数 |
| --- | --- | --- |
| `as.upload_kb` | 上传到 KB（与 `kb.upload` 等价） | `{kbId, filePath, filename?, contentType?, parentId?, title?}` |

返回里会带 `node_id`，可在 KB 节点树中看到。

## 典型流程

### Agent 发产出物到 IM 群

```bash
# 1. 上传到当前会话
node src/cli/as.js as.upload_im '{
  "conversationId":"cv-growth-team",
  "filePath":"/tmp/q2-report.pdf"
}'
# -> {"data":{"attachment_id":"att-xxx","file_url":"...","size":...}}

# 2. 发消息挂附件
node src/cli/comm.js comm.send '{
  "conversationId":"cv-growth-team",
  "content":{"text":"Q2 报告草稿,请评审"},
  "attachments":[{"attachment_id":"att-xxx"}]
}'
```

### Agent 把交付物落到 KB

```bash
# 1. 上传到项目 KB 的 deliverables 节点下
node src/cli/as.js as.upload_kb '{
  "kbId":"kb-growth",
  "filePath":"/tmp/q2-report.pdf",
  "parentId":"nd-deliverables",
  "title":"Q2 报告(PDF)"
}'
# -> {"data":{"node_id":"nd-yyy","url":"..."}}

# 2. 在 deliverables 索引页里登记
node src/cli/kb.js kb.write '{
  "kbId":"kb-growth",
  "pageId":"pg-deliv-index",
  "content":"# Deliverables\n\n- [Q2 报告](./node/nd-yyy)",
  "commitMessage":"kb: add Q2 report"
}'
```

## 选型对照

| 信号 | 走哪条 |
| --- | --- |
| 内容能用 Markdown 表达 → 不要传文件 | KB Page（`kb.write`） |
| 图片、PDF、数据集等二进制 | KB file 或 IM 附件 |
| 体积偏大（MB / GB 级） | KB file（KB 是长期存储；IM 附件可能有 TTL） |
| 临时分享到对话里 | IM 附件 |
| 项目交付物、长期引用 | KB file（建立稳定引用，并在 KB index 中登记） |

## 注意事项

- Attachment 不可变；"修改"就是新建新的 attachment，旧的留作历史
- IM 附件目前没有官方 metadata 查询端点（pending #待确认问题）。需要再找回某个附件，从消息历史 `comm.get_messages` 里翻它的 `attachments`
- KB file 通过 `kb.tree` / `kb.nodes` 可以列举出来
- 大文件上传服务端可能开 multi-part；网关草案没明确，目前先按单段 PUT 实现，超大文件请拆分

## 环境变量

- `COCO_API_URL` — 网关入口（默认 `http://127.0.0.1:8080`）
- `COCO_AUTH_TOKEN` — Bearer token
- `COCO_API_PREFIX` — 路径前缀（默认 `/api/gateway/v1`）
