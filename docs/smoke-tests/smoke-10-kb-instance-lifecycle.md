# Smoke 10 — KB 实例生命周期(NL 驱动)

> **验证目标**:用户用自然语言让 agent 从"建 KB → 写一页 → 改 metadata →
> 归档 → 恢复 → 删"完整走一遍 KB 容器层面的生命周期。这是 Smoke 5/6 之外
> KB 容器层的端到端验证。
>
> 覆盖 **kb.js**:
>   `kb.create / get / update / archive / unarchive / delete / list / init`、
>   `kb.folder_create / file_create(可选)`、
>   `kb.page_update`(metadata: title/path)、`kb.page_freeze`、
>   `kb.page_references`、`kb.node_breadcrumb`

---

## 1. NL 文本

### Round 1 — 建 KB + 写一页

```
我想新建一个独立 KB 做 Smoke10-<TS> 实验:
1. 新建一个 KB 叫 "Smoke10-<TS>",描述写"KB 实例生命周期实验"
2. 在这个新 KB 的根目录下建一页测试笔记,标题 "Smoke10-<TS> 测试笔记",
   内容写 "# Smoke10\n初版内容,一会儿要改名挪路径再冻结"

建完一行报 kbId + pageId。
```

### Round 2 — 改 page metadata + 冻结 + breadcrumb

```
那个 Smoke10-<TS> 测试笔记:
- 标题改成 "Smoke10-<TS> 测试笔记(已重命名)"
- path 改成 "/smoke10-renamed"
- 改完冻结这一页(以后不让人改了)

最后给我看下这个 page 在 KB 树里的 breadcrumb 路径,顺便列下有没有 references。
```

### Round 3 — archive → unarchive → delete

```
Smoke10-<TS> 这个 KB 实验做完了,操作三步:
1. 先归档(走 archive)
2. 等会发现还需要看,unarchive 恢复
3. 真不用了,delete 永久删

每一步操作完一行简单日志,最后确认这个 KB 已经删了(get 应该 4xx 或显示 deleted)。
```

---

## 2. 断言表(12)

### 卡片体(6)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 120s 内到,含 kbId + pageId(≥ 2 uuid) |
| 2 | 1 | round1 表达 "KB 已建" + "笔记已建" 语义 |
| 3 | 2 | round2 在 90s 内到,含 "重命名" / "renamed" + "冻结" / "freeze" |
| 4 | 2 | round2 包含 breadcrumb 路径语义 |
| 5 | 3 | round3 在 120s 内到,含 "归档" + "恢复" + "删" |
| 6 | 3 | round3 表达 KB 已删除 |

### 旁路(6)

| # | 阶段 | 断言 |
|---|---|---|
| 7 | round1 | kb.list 含 new KB,name 含 `Smoke10-<TS>` |
| 8 | round1 | kb.get(new) status == active |
| 9 | round2 | page_get title 含 "重命名" 或 "renamed",path 含 "smoke10-renamed" |
| 10 | round2 | kb.page_get 拿得到 page;kb.node_breadcrumb 调通 |
| 11 | round3 | kb.list 中要么找不到 new KB,要么 status='deleted' / archived 之外的 |
| 12 | round3 | kb.get(new) 抛 4xx 或返 deleted 状态 |

---

## 3. 跑法

```bash
node docs/smoke-tests/smoke-10-kb-instance-lifecycle.test.js
```

预期 4-6 分钟。
