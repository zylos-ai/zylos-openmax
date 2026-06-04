# Smoke 11 — AS 工件 + KB 文件集成(纯脚本驱动)

> **验证目标**:把 **as.js 整个 0 覆盖** 全部补上,顺带覆盖 kb.js 的
> 文件向命令(file_create / upload / preview / download / batch_download)。
> 这是当前 Smoke 0-10 里**唯一一条**覆盖 ArtifactStore 路径的用例。
>
> 覆盖 **as.js**(全部 4 条):
>   `as.upload`(IM + KB 双模式)、`as.url`、`as.download`、`as.resolve`
>
> 覆盖 **kb.js** 文件向:
>   `kb.upload`(高层封装,内含 prepare+PUT+finalize)、
>   `kb.file_create`(把已存在的 artifact 挂到 tree 上做 file node)、
>   `kb.file_preview`、`kb.file_download`、`kb.file_batch_download`
>
> 跟 #190 漏索引 bug 无直接关系:文件不进 Meili 全文索引(只有 page 才进),
> 但**会**触碰 cws-as 的 KB 文件落地链路,如果 cws-as 也有同源 hush bug
> 这里能暴露。

---

## 1. 架构

```
TEST CLIENT (smoke-11-as-kb-files.test.js)
    │
    ├─ Phase 0: 在本地 /tmp 造 2 个 fixture
    │             - smoke11-<TS>.png      (~ 8KB PNG,1x1 像素也行)
    │             - smoke11-<TS>.md       (~ 12KB markdown 文本)
    ├─ Phase 1: KB 上传(low-level path:as.upload 不带 conversationId)
    │             → 拿到 {artifactId, nodeId} + 落到默认 KB 根
    ├─ Phase 2: as.url + as.download 验证下载链路 + 字节级回环
    ├─ Phase 3: as.resolve 批量解析两个 artifactId
    ├─ Phase 4: kb.upload(高层封装)上传第二个 fixture
    │             → 验证 high-level 和 low-level 等价 + 都能在 tree 里找到
    ├─ Phase 5: kb.file_create 用已有 artifact 在另一个 folder 下挂第二个引用
    ├─ Phase 6: kb.file_preview + kb.file_download(单个)+ kb.file_batch_download(多个)
    │             → 验证内联+下载链都通,并且 batch 一次返多个
    └─ Phase 7: 收尾(留资产做 DB 追踪)
```

---

## 2. 前置 / Env

跟 Smoke 8/9/10 一致 + `TEST_DEFAULT_KB_ID`(已在 state.md 里有)。

不需要 `TEST_CONV_ID`(本 smoke 不走 IM 模式)。

---

## 3. 流程细节

### Phase 0 — fixtures

```js
const fixturePng = '/tmp/smoke11-<TS>.png'  // 8KB binary
const fixtureMd  = '/tmp/smoke11-<TS>.md'   // 12KB text

// PNG: 用最小 1x1 PNG header + zero-padded body 到 ~8KB
// MD : 用 'Smoke11-<TS>\n' 重复填充到 ~12KB
```

### Phase 1 — KB mode upload (low-level)

```js
const up1 = as.upload({ filePath: fixturePng })  // 不传 conversationId
// up1 = {artifactId, nodeId, treeNode, fileName, mimeType, sizeBytes, instantUpload}
```

期待:
- `artifactId` 形如 uuid 或 `artifact://...`
- `nodeId` 是新建的 file tree node 的 id
- `treeNode.kb_id` == 默认 KB id
- `sizeBytes` ≈ 8192 ±

### Phase 2 — url + download 回环

```js
const meta = as.url({ artifactId: up1.artifactId })
// meta = {url, expiresAt, contentType, contentLength, name}

const dl = as.download({ artifactId: up1.artifactId })
// dl = {localPath}

// 字节级回环
hash(localFile(dl.localPath)) === hash(localFile(fixturePng))
```

### Phase 3 — resolve 批

```js
const resolved = as.resolve({ uris: [`artifact://${up1.artifactId}`] })
// resolved = {resolved: [{...}], failed: []}
// 至少 1 条 resolved,0 条 failed
```

### Phase 4 — KB high-level upload

```js
const up2 = kb.upload({
  filePath:    fixtureMd,
  contentType: 'text/markdown',
  // parentId 不传 → 落 KB 根
})
// up2 也包含 artifactId / nodeId
```

### Phase 5 — file_create 在另一个 folder 下挂 artifact 引用

```js
// 先建个 folder
const folder = kb.folder_create({ kbId: TEST_DEFAULT_KB_ID, name: `Smoke11-<TS>/refs` })

// 用 up1 的 artifactId 在 folder 下挂第二个 file node
const fileNode2 = kb.file_create({
  kbId:       TEST_DEFAULT_KB_ID,
  name:       `Smoke11-<TS>.png (ref)`,
  artifactId: up1.artifactId,
  parentId:   folder.id,
})
```

### Phase 6 — preview + download + batch

```js
const preview = kb.file_preview({ kbId, nodeId: up1.nodeId })
// preview.url 可拿来在浏览器内联展示;响应里至少有 url

const download = kb.file_download({ kbId, nodeId: up1.nodeId })

const batch = kb.file_batch_download({ kbId, nodeIds: [up1.nodeId, up2.nodeId] })
// 至少返 2 条 download URL
```

---

## 4. 断言表(16)

| # | Phase | 断言 |
|---|---|---|
| 1 | 0 | 两个 fixture 都被写到 /tmp 且 size 合法 |
| 2 | 1 | as.upload(KB mode) 返 artifactId + nodeId |
| 3 | 1 | up1.treeNode.kb_id == TEST_DEFAULT_KB_ID |
| 4 | 1 | up1.sizeBytes 在 ±20% 范围内 |
| 5 | 2 | as.url 返 url + expiresAt + contentType |
| 6 | 2 | as.download 落地文件存在 |
| 7 | 2 | 字节级 hash(下载) == hash(原 fixture) |
| 8 | 3 | as.resolve 返 ≥ 1 条 resolved,0 条 failed |
| 9 | 4 | kb.upload (markdown) 返 artifactId + nodeId(跟 up1 不同) |
| 10 | 5 | kb.folder_create 返 id(refs folder) |
| 11 | 5 | kb.file_create 返新 fileNode2.id,parent_id == folder.id |
| 12 | 5 | fileNode2 复用了 up1.artifactId(同 artifact 两个 tree node 引用) |
| 13 | 6 | kb.file_preview 返带 url 字段 |
| 14 | 6 | kb.file_download 返带 url 或 localPath 字段 |
| 15 | 6 | kb.file_batch_download 返 ≥ 2 条结果 |
| 16 | 6 | batch 里两条 url 都能 HTTP HEAD 通(可选,失败 warn-only) |

---

## 5. 已知 / 留观

- cws-as 的 v5 收口设计(uploads/prepare → PUT → uploads/finalize 三段),任何一段挂掉都在断言 2/4/9 里暴露
- 如果 `instantUpload === true`(blob dedup 命中),fixture 应该和已有完全相同;为避免命中 dedup,fixture 名字带 TS,bytes 也用 TS 做种子
- `kb.file_create` 复用现有 artifactId 是 v5 的新支持;旧 cws-as 这个能力是 file 上传时自动创建,本 smoke 是验证手动挂载

---

## 6. 跑法

```bash
node docs/smoke-tests/smoke-11-as-kb-files.test.js
```

预期 8-15 秒(2 次 upload + 2 次 download + N 次 metadata 调用)。
