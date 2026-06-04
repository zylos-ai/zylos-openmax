# Smoke 10 — KB 实例生命周期(纯脚本驱动)

> **验证目标**:把 **KB 实例本身**(不是 KB 里的 page / folder)的 CRUD +
> 归档/恢复 + page metadata 边缘命令一次性覆盖一遍。Smoke 5/6 覆盖了
> KB 里的 tree + page 内容,本 Smoke 补齐 KB **容器层面**的生命周期。
>
> 覆盖 **kb.js**:
>   `kb.init`、`kb.list`、`kb.create`、`kb.get`、`kb.update`、
>   `kb.archive`、`kb.unarchive`、`kb.delete`、
>   `kb.page_update`(metadata: title/path)、`kb.page_freeze`、
>   `kb.page_references`、`kb.node_breadcrumb`
>
> 不覆盖(留给其他 smoke):
> - page content / revision / search — Smoke 5/6
> - file_create / upload / preview / download — Smoke 11
> - page trash/restore 全链 — Smoke 12

---

## 1. 架构

```
TEST CLIENT (smoke-10-kb-instance-lifecycle.test.js)
    │
    ├─ Phase 1: kb.list 拿默认 KB(应已 init)+ kb.init 幂等性
    ├─ Phase 2: kb.create 一个新 KB X(`Smoke10-<TS>`) → kb.get / kb.update
    ├─ Phase 3: 在 X 里建 folder + page,用来挂后面的 metadata 测
    ├─ Phase 4: page_update(改 title / path)+ page_freeze + page_references
    │            + node_breadcrumb
    ├─ Phase 5: kb.archive(X) → kb.list 看 X 不在 active → kb.unarchive(X) →
    │            kb.list 看 X 又回 active
    └─ Phase 6: kb.delete(X) → kb.get(X) 期待 4xx(已删)
```

---

## 2. 前置 / Env

跟 Smoke 8/9 一致:
- `TEST_USER_TOKEN`(user 身份;`/kbs` POST 需要 org-owner / org-admin)
- `TEST_AGENT_ID`(可选,本 smoke 不用)
- `TEST_PROJECT_ID`(可选,本 smoke 不用)

需要的额外能力:
- caller 在 org 里有 org-owner 角色(KB 实例 CRUD 需要)。我们这边的 user `gavin-test-002` 是 org-owner,满足。

---

## 3. 流程细节

### Phase 1 — 默认 KB

```js
kb.list { limit: 50 }
// assert: data 数组里至少 1 个 default KB

// 幂等性:再 init 一次,期待 200(返已存在的 default KB id) 或专属错误码
kb.init {}
// 不强约束 status code,记下 response
```

### Phase 2 — kb.create / get / update

```js
kb.create { name: `Smoke10-<TS>`, slug: `smoke10-<ts>`, description: 'KB 实例测试' }
// 取 newKbId
kb.get { kbId: newKbId }
// assert: name 对得上,visibility / status / is_default 都返回了

kb.update { kbId: newKbId, description: 'updated description' }
kb.get { kbId: newKbId }
// assert: description 含 'updated description'
```

### Phase 3 — 建 folder + page 作 metadata 测试载体

```js
kb.folder_create { kbId: newKbId, name: `Smoke10-<TS>/notes` }
// 取 folderId

// page 直接 POST /api/v1/kbs/{kb_id}/pages(CLI 没暴露 page_create,
// 沿用 Smoke 5/6 那条 fetch path)
POST /api/v1/kbs/{newKbId}/pages
  { title: `Smoke10-<TS> page`, format: 'markdown',
    body: '# Smoke10\n初版内容', parent_id: folderId }
// 取 pageId
```

### Phase 4 — page metadata 边缘

```js
kb.page_update { pageId, title: `Smoke10-<TS> page (renamed)`, path: '/renamed-path' }
kb.page_get   { pageId }
// assert: title 含 '(renamed)', path 含 '/renamed-path'

kb.page_freeze { pageId }
// assert: 2xx (或 status 字段含 frozen)
// 二次写应被拒;本 smoke 不深测,只看 freeze 本身的 200

kb.page_references { pageId }
// assert: 返列表(可能是空)

kb.node_breadcrumb { kbId: newKbId, nodeId: pageId }
// assert: 返路径(数组,至少含 page 自身;或者含 folder + page)
```

### Phase 5 — archive / unarchive

```js
kb.archive { kbId: newKbId }
kb.list { status:'archived', limit: 50 }
// assert: newKbId 在结果里
kb.list { status:'active',   limit: 50 }
// assert: newKbId 不在结果里

kb.unarchive { kbId: newKbId }
kb.list { status:'active',   limit: 50 }
// assert: newKbId 回到 active
```

### Phase 6 — delete

```js
kb.delete { kbId: newKbId }
// 后续 kb.get 期待 4xx
try { kb.get { kbId: newKbId } } catch (e) { ok }
```

---

## 4. 断言表(15)

| # | Phase | 断言 |
|---|---|---|
| 1 | 1 | kb.list 返 ≥ 1 个 KB(默认 KB 存在) |
| 2 | 1 | kb.init 不抛(幂等) |
| 3 | 2 | kb.create 返 uuid kbId,name 对得上 |
| 4 | 2 | kb.get(new) 返完整结构,name + visibility + status 都在 |
| 5 | 2 | kb.update 后 kb.get description 含 'updated description' |
| 6 | 3 | folder_create + 页面 create 都 2xx + 返 id |
| 7 | 4 | page_update 后 title 含 '(renamed)' |
| 8 | 4 | page_update 后 path 含 '/renamed-path' |
| 9 | 4 | page_freeze 返 2xx |
| 10 | 4 | page_references 返 2xx(数组,可空) |
| 11 | 4 | node_breadcrumb 返数组 ≥ 1 |
| 12 | 5 | archive 后 kb.list(active) 不含 newKbId |
| 13 | 5 | archive 后 kb.list(archived) 含 newKbId |
| 14 | 5 | unarchive 后 kb.list(active) 含 newKbId |
| 15 | 6 | delete 后 kb.get(newKbId) 抛 4xx |

---

## 5. 已知/相关 bug 留观

- 不出意外仍踩 #190 派生写哑火(page_count 不会跟着 page_create 自增),本 smoke **不验证 page_count**,把它留给 #190 单独的活体复现。
- `kb.delete` 是硬删还是软删?如果是软删 + 还能 kb.list(status='deleted')`,断言 15 要相应调整;实测时若 kb.get 返 200 而非 4xx,留 request_id 单独提一笔。

---

## 6. 跑法

```bash
node docs/smoke-tests/smoke-10-kb-instance-lifecycle.test.js
```

预期 5-10 秒。
