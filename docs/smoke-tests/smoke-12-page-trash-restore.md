# Smoke 12 — Page Trash / Restore 全链(NL 驱动)

> **验证目标**:用户用自然语言走"建 page → 多版本编辑 → 回滚到初版 →
> 软删 → 从回收站恢复 → 永久删"完整 page 生命周期。覆盖 trash
> 中间态 + revision restore(回到旧版本)两条容易漏的链路。
>
> 覆盖 **kb.js**:
>   `kb.page_create`(via POST)、`kb.page_content_write`、
>   `kb.page_revisions`、`kb.page_revision`、**`kb.page_restore`** (revision restore)、
>   `kb.page_trash`、`kb.pages_trashed`、`kb.page_restore_trash`、`kb.page_delete`

---

## 1. NL 文本

### Round 1 — 建 page + 3 个版本

```
帮我起一份 Smoke12-<TS> 的工作笔记,放在默认知识库根目录下。

分 3 次写入:
1. 初版:body 写 "Smoke12-<TS> INIT 这是初版,只有这一段"
2. 第二版:在 body 后面追加一段 "—— V2 追加段"
3. 第三版:在 body 后面再追加 "—— V3 再追加一段"

每次写入都过一次 content_write(让 revision 序号递增)。
建完报 pageId,并告诉我当前总共有几个 revision。
```

### Round 2 — 回滚到初版

```
我想把这页回滚回**最初**那个版本,只剩 "Smoke12-<TS> INIT 这是初版,只有这一段"。
用 page_restore(revisionId) 来做,不要 content_write 重写。

回滚完拉一下 page_content 给我看下确认。
```

### Round 3 — trash → list → restore_trash → trash again → permanent delete

```
这一页现在状态有点乱,你帮我处理:
1. 先丢回收站(page_trash)
2. 列下回收站确认这条记录在里面
3. 等等我又想找回来,从回收站恢复(page_restore_trash),恢复完确认一下 page 又是 active 了
4. 真不用了,这次走永久删:
   - 先 page_trash(因为 page_delete 只能删 trashed 状态的 page,这是 cws-kb 的语义保护)
   - 然后 page_delete 永久删
5. 最后确认 page_get 拿不到了(4xx 或不存在)

每步一行日志。
```

> 备注:cws-kb `PermanentDeletePage` 的语义约束是"只能永久删已在回收站的 page"——active page 直接 page_delete 会返 404(见 cws-kb#193,推荐修法是改返 422/409 + 有语义的 detail,但语义保护本身保留)。本 spec 顺势把 round 3 的流程改成对 cws-kb 语义友好的形式:restore_trash 之后想真删一定要再走一次 trash。

---

## 2. 断言表(13)

### 卡片体(6)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 150s 内到,含 pageId(uuid)+ revision 数报数 |
| 2 | 1 | round1 提到的 revision 数 ≥ 3 |
| 3 | 2 | round2 在 90s 内到,含 "回滚 / 初版 / V1 / INIT" 任一 |
| 4 | 2 | round2 表达回滚后内容已是初版 |
| 5 | 3 | round3 在 120s 内到,含 "回收站" + "恢复" + "永久" / "删" |
| 6 | 3 | round3 表达 page 已删除拿不到 |

### 旁路(7)

| # | 阶段 | 断言 |
|---|---|---|
| 7 | round1 | page_revisions ≥ 3 |
| 8 | round1 | page_content.body 含 "V3" |
| 9 | round2 | page_content.body 只含 "INIT",不含 "V2" / "V3" |
| 10 | round3 | (trash 之后)pages_trashed 含 pageId |
| 11 | round3 | (restore_trash 之后)page_get 返 200 + status active |
| 12 | round3 | (delete 之后)page_get 抛 4xx 或 status=='deleted' |
| 13 | round3 | (delete 之后)kb.pages 不含 pageId(或 502 路径 warn-only) |

---

## 3. 跑法

```bash
node docs/smoke-tests/smoke-12-page-trash-restore.test.js
```

预期 5-8 分钟。
