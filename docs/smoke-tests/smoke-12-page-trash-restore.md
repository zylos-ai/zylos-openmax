# Smoke 12 — Page Trash / Restore 全链(纯脚本驱动)

> **验证目标**:把 page 软删/列回/恢复/永久删 + 旧版本还原这条完整链路
> 一次性扫一遍。Smoke 5/6 触碰了 page_create / page_delete 终端动作,
> 但 trash 中间态 + revision restore 都没专门覆盖。
>
> 覆盖 **kb.js**:
>   `kb.page_trash`(soft delete)、`kb.pages_trashed`(列回收站)、
>   `kb.page_restore_trash`(un-trash)、`kb.page_delete`(永久删),
>   **`kb.page_restore`(restore 一个**旧 revision**到当前 head,跟 `page_restore_trash` 不同!)**
>
> 跟 Smoke 6 区别:Smoke 6 用 `page_revisions / page_diff`,本 smoke
> 在 revision 列表里取一个旧版,跑 `page_restore` 让 head 回到旧版。

---

## 1. 架构

```
TEST CLIENT (smoke-12-page-trash-restore.test.js)
    │
    ├─ Phase 1: 建 page,写 3 个 revision(初版 + 2 次 content_write)
    ├─ Phase 2: kb.page_revisions → 取 oldest(初版) revision id
    ├─ Phase 3: kb.page_restore(pageId, oldestRevisionId)
    │            → page.body 回到初版内容
    ├─ Phase 4: kb.page_trash → page 进回收站
    ├─ Phase 5: kb.pages_trashed → list 含 pageId
    ├─ Phase 6: kb.page_restore_trash → page 复活
    ├─ Phase 7: kb.page_get → 200 + status active
    └─ Phase 8: kb.page_delete → 永久删 → page_get 期 4xx
```

---

## 2. 前置 / Env

跟 Smoke 6 一致(`TEST_USER_TOKEN` + `TEST_DEFAULT_KB_ID` + CF Access)。
不需要 NL / 不需要 `TEST_CONV_ID`。

---

## 3. 流程细节

### Phase 1 — 建 page + 3 revision

```js
// 初版(revision 1)
POST /kbs/{TEST_DEFAULT_KB_ID}/pages
  { title:'Smoke12-<TS>', format:'markdown', body:'INIT body' }
→ pageId

// revision 2
kb.page_content_write { pageId, body:'V2 body', message:'add v2' }
// revision 3
kb.page_content_write { pageId, body:'V3 body', message:'add v3' }
```

### Phase 2 — 取 revisions

```js
kb.page_revisions { pageId, limit: 50 }
// 假设按时间倒序(newest first):revs[0] = v3, revs[last] = v1
const oldest = revs[revs.length - 1]   // 初版
```

### Phase 3 — page_restore(restore old revision)

```js
kb.page_restore { pageId, revisionId: oldest.id }
const c = kb.page_content { pageId }
// assert: c.body 含 'INIT body'
```

注意:有的实现会在 `page_restore` 时**新建一个 revision**(把旧版复制为新 head),
所以 revisions 数量可能 +1。本 smoke **不**强约束 revisions 数,只看 head body。

### Phase 4-7 — trash → restore_trash

```js
kb.page_trash { pageId }
const trashList = kb.pages_trashed { limit: 50 }
// assert: trashList 含 pageId
kb.page_restore_trash { pageId }
const pg = kb.page_get { pageId }
// assert: 200 + status 在 {active, ok}
```

### Phase 8 — 永久删

```js
kb.page_delete { pageId }
try { kb.page_get { pageId } } catch (e) { ok }
```

---

## 4. 断言表(12)

| # | Phase | 断言 |
|---|---|---|
| 1 | 1 | page POST 返 pageId(uuid) |
| 2 | 1 | 2 次 content_write 都 2xx |
| 3 | 2 | page_revisions 返 ≥ 3 条(初版 + v2 + v3) |
| 4 | 3 | page_restore(oldest) 返 2xx |
| 5 | 3 | restore 后 page_content.body 含 'INIT body'(回到初版) |
| 6 | 4 | page_trash 返 2xx |
| 7 | 5 | pages_trashed 含 pageId |
| 8 | 5 | pages_trashed 不在 active 列表(`kb.pages` 不含 pageId)** |
| 9 | 6 | page_restore_trash 返 2xx |
| 10 | 7 | restore_trash 后 page_get 返 2xx + status 含 active/ok |
| 11 | 8 | page_delete 返 2xx |
| 12 | 8 | page_delete 后 page_get 抛 4xx |

** 断言 8 受 `kb.pages` 502 bug 影响(如果 cws-int 还没修),探到 5xx 算 warn-only,
   不 fail;只要 pages_trashed 含 pageId 即可视为 trash 进入回收站。

---

## 5. 已知/相关 bug 留观

- **#190 派生写哑火**也会影响这里:每次 page_restore / trash / restore_trash 都应该写 revision +
  更新 `last_modified_at`。本 smoke 不检查 last_modified,但日志记下来留 #190 顺带验证。
- 假设 `kb.page_delete` 是**硬删**(可见 page_get 4xx);如果实际是软删 + status='deleted',
  断言 12 改成"page_get 返 200 + status==deleted"——这种情况下记 warn 并继续,留待 cws-kb 团队确认。

---

## 6. 跑法

```bash
node docs/smoke-tests/smoke-12-page-trash-restore.test.js
```

预期 4-8 秒。
