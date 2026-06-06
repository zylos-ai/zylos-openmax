# Smoke 4 (multi-agent, NL) — cross-actor KB collaboration

> Two live agent runtimes. LEAD writes a KB page; WORKER reads + appends. Verifies KB visibility, content-write authz, and revision attribution across actors in the same org.

## 目的

验证 KB 资源在同 org 不同 agent 之间的协作读写:

- LEAD 写一个 page,WORKER 跨 actor 可见
- WORKER 在同一 page 上追加内容(同 page,不开新 page)
- KB revision 历史里两次写入归属正确(creator_member_id 不同)
- LEAD JWT 拉 revisions 与 WORKER JWT 拉 revisions 内容一致(都能看到对方写的内容)

## 流程

### Phase 1 — LEAD 写初稿
NL → LEAD:

> 在 KB 根目录下建一个标题为 "SmokeM4-${TS} 项目交付说明" 的 page,正文写以下内容(整段照抄):
> ```
> # 交付概览
> - 本次交付包含:模块 A、模块 B
> - 交付时间:2026 Q3
> - Lead:Zylos
> ```
> 写完之后用一行告诉我 page 的 id。

`waitForKbPage(predicate: title contains "SmokeM4-${TS}")` — runner extends with kb-page-poll helper.

### Phase 2 — WORKER 读取 + 追加
NL → WORKER:

> 刚才 Lead 在 KB 里建了一个标题包含 "SmokeM4-${TS}" 的 page,你找到它,在原内容下面追加以下两段(原文一字不动地保留):
> ```
> ## Worker 补充
> - 模块 A 测试覆盖率:92%
> - 模块 B 待办:压力测试
> ```
> 用 KB 的页面更新机制写回,做完报一下 revision 数。

`waitForKbPageRevisions(pageId, expectedCount >= 2)`.

### Phase 3 — LEAD 核对
NL → LEAD:

> 看看 "SmokeM4-${TS}" 这个 KB page,Worker 应该已经追加了内容。你确认一下两段内容(交付概览 + Worker 补充)都还在,并且 page 有 2 个修订版本。如果没问题在对话里说一声"已确认"。

(此 phase 主要为了断言"agent 能跨 actor 读对方的内容";断言主要靠 runner 直接拉接口验证,不依赖 LEAD 的对话回应。)

## 断言(12 条)

| # | 断言 |
|---|---|
| 1 | KB page "SmokeM4-${TS} 项目交付说明" 存在 |
| 2 | LEAD JWT 拉 page content,包含 "# 交付概览" + "Worker 补充" |
| 3 | LEAD JWT 拉 revisions,数量 >= 2 |
| 4 | WORKER JWT 拉同一 page,可见(同 org 通) |
| 5 | WORKER JWT 拉 page content,内容与 LEAD POV 完全一致(byte-for-byte) |
| 6 | revision 数组按时间排序,第 1 个 creator_member_id === LEAD.agent_id 或 LEAD member_id |
| 7 | 第 2 个 revision creator_member_id === WORKER.member_id |
| 8 | rev[1].content 包含 "# 交付概览" (worker 没删 lead 的内容) |
| 9 | rev[1].content 包含 "Worker 补充" |
| 10 | WORKER 没有另开一个 page(KB 列表里 "SmokeM4-${TS}" 只匹配 1 个 page) |
| 11 | LEAD JWT 拉 KB tree,page 出现在预期路径(根目录下) |
| 12 | WORKER JWT 拉 KB tree,page 同位置 |
