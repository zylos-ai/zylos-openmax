# Smoke 14 — Comm Sync + Search(纯脚本驱动)

> **验证目标**:覆盖 comm.js 里**剩下的两条非交互命令**——`comm.sync`(离线
> 追平,WS 重连时关键)和 `comm.search`(就是 `kb.search` 的同源 alias,
> 走 `/search/pages`)。这是为了把 comm.js 13 条命令全部点亮。
>
> 覆盖 **comm.js**:`comm.sync`、`comm.search`
> 顺带覆盖 `comm.list_conversations`(verifies pagination + includeArchived flag)
>
> 不深测 search 命中率(那是 cws-kb #190 的事)——本 smoke 只验证响应
> shape 跟 spec 对齐。

---

## 1. 架构

```
TEST CLIENT (smoke-14-comm-sync-search.test.js)
    │
    ├─ Phase 1: comm.list_conversations(includeArchived=false / true)
    │            → 都返 2xx + 数组结构
    ├─ Phase 2: comm.sync(sinceSeq=0, deviceId=<uuid>, limit=200)
    │            → 返 {events[], next_cursor, has_more}
    │            - events 是 envelope,只含 message_id+seq+timestamp,不含 body
    │            - 检查 envelope shape + has_more 字段
    ├─ Phase 3: comm.sync(sinceSeq=巨大数, deviceId=<uuid>) → 空集 + has_more=false
    └─ Phase 4: comm.search(query='Smoke', limit=5) → 返 shape 对齐
                  (data[], pagination{total_count}) 即可,不强约束 ≥1 命中
```

---

## 2. 前置 / Env

跟 Smoke 8 一致。不需要新 fixture。

---

## 3. 断言表(10)

| # | Phase | 断言 |
|---|---|---|
| 1 | 1 | comm.list_conversations(includeArchived=false) 返数组 |
| 2 | 1 | comm.list_conversations(includeArchived=true) 返数组 ≥ false 的长度 |
| 3 | 1 | 至少包含一个 conversation 含 id+type 字段 |
| 4 | 2 | comm.sync(sinceSeq=0) 返 events 字段(数组) |
| 5 | 2 | 每个 event 含 conversation_id + message_id + seq + timestamp |
| 6 | 2 | has_more 是 boolean |
| 7 | 3 | comm.sync(sinceSeq=99999999) 返 events.length == 0 |
| 8 | 3 | has_more == false |
| 9 | 4 | comm.search(query='Smoke') 返 data 数组 + pagination.total_count(integer) |
| 10 | 4 | search 同时支持 kbId 限定:`{query, kbId: <TEST_DEFAULT_KB_ID>}` 也返 200 |

---

## 4. 设计要点

- sync 的 envelope 模型(只返 seq+id,不返 body)在 #190 #189 排查里都用过,本 smoke 把它的 shape 固化下来防止回归
- search 不强约束 ≥ 1 命中,因为 #190 漏索引时永远 0 命中——但 shape 一致 OK
- comm.list_conversations includeArchived 的差值能旁证归档逻辑没烂

---

## 5. 跑法

```bash
node docs/smoke-tests/smoke-14-comm-sync-search.test.js
```

预期 2-5 秒。
