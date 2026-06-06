# Smoke 4 (multi-agent, NL) — cross-actor KB collaboration

> Two live agent runtimes. User sends **one** NL to LEAD; LEAD writes a KB page and instructs WORKER via their bot DM to append. Verifies KB visibility, content-write authz, and revision attribution across actors.

## 范式

v2 单 NL — user 只给 LEAD 发一条自然语言,之后 LEAD 和 WORKER 通过 bot↔bot DM 协调,user 全程不再参与。runner 只轮服务端状态做断言。

## 目的

- LEAD 写一个 page,WORKER 跨 actor 可见
- WORKER 在同一 page 上追加内容(同 page,不开新 page,原文不动)
- KB revision 历史归属正确(rev#1 author === LEAD member_id, rev#2 author === WORKER member_id)
- LEAD POV 和 WORKER POV 拉 page content,byte-for-byte 一致

## 流程

### Phase 1 — 用户给 LEAD 一句 NL(全程唯一一句)

> 在 KB 根目录下建一个标题为 "SmokeM4-${TS} 项目交付说明" 的 page,正文严格写以下内容(整段照抄,不要加任何前后缀):
>
> ```
> # 交付概览
> - 本次交付包含:模块 A、模块 B
> - 交付时间:2026 Q3
> - Lead:Zylos
> ```
>
> 写完后**自主**完成下面这件事(不要再问我):
> 1. 通知 agent-gavin3 这个 bot:让它去找 KB 里这个标题为 "SmokeM4-${TS} 项目交付说明" 的 page,在原内容下面追加以下两段(原文不能动):
>    ```
>    ## Worker 补充
>    - 模块 A 测试覆盖率:92%
>    - 模块 B 待办:压力测试
>    ```
> 2. 等 agent-gavin3 在你跟它的 DM 里回复 "已追加完成"。

### Phase 2 — agent 自主协作 (无 user 参与)

预期 agent 行为序列:

1. LEAD `kb.page_create` 在根目录建 page,记下 page_id
2. LEAD 在 LEAD↔WORKER bot DM 发消息告诉 WORKER 这个 page 的 id + 要追加的内容
3. WORKER 收到 DM,`kb.page_content_write` 把原内容 + 追加内容写回(revision 自增到 2)
4. WORKER 在 bot DM 回 "已追加完成"

runner Phase 2 poll KB page 的 revision count,达到 ≥ 2 退出,然后 `waitForBotDM(WORKER_MID, afterSeq=baseline)` 等 worker 的 DM ack 到位(关闭 timing race)。

### Phase 3 — runner 静默断言

不需要 user 介入。

## 断言(10 条)

| # | 断言 |
|---|---|
| 1 | KB page 存在(标题包含 "SmokeM4-${TS}") |
| 2a | content 包含 "# 交付概览"(LEAD 原文保留) |
| 2b | content 包含 "Worker 补充"(WORKER 追加成功) |
| 3 | revisions ≥ 2(说明 WORKER 真的写了第 2 版) |
| 4 | WORKER JWT 拉同一 page id 可见(跨 actor visibility) |
| 5 | WORKER POV content === LEAD POV content,byte-identical |
| 6 | 最后一次 revision creator === WORKER member_id(归属正确,cws-kb #201 已修) |
| 7a | LEAD 在 bot DM ≥ 1 条 agent_text(派活通知) |
| 7b | WORKER 在 bot DM ≥ 1 条 agent_text("已追加完成" 回复) |

## 实现备注

- runner Phase 2 退出条件:`revisions ≥ 2` AND `waitForBotDM(WORKER_MID, ...)` 都满足才进 Phase 3,避免 timing race
- 不用 `kb.pages` 列表 endpoint(历史 cws-kb 502/500),改用直接 page_id + `kb.page_get` / `kb.page_content`

## 容错与边界

- 若 WORKER 另开新 page(没找到 LEAD 的 page):#2b 挂(原 page 没追加内容)
- 若 WORKER 覆盖了原文(没 append,直接覆盖):#2a 挂
- 若服务端把 author_id 存成 identity_id 不是 member_id:#6 挂(cws-kb #201 fix 验证点)
