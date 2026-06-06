# Smoke 7 (multi-agent, NL) — KB relay pipeline

> 3-step blueprint where each step writes a KB page consumed by the next. step1 LEAD → step2 WORKER → step3 LEAD. KB is the data contract between agents.

## 目的

验证多 agent 串行接力的最常见场景:每一步的产出落到 KB,下一步必须真去读上一步的产出再产出自己的页面。重点:

- 跨 agent 串行(LEAD → WORKER → LEAD)
- KB 作为 step 间数据接口,不是消息体
- WORKER 真的读了 LEAD 写的 page,而不是凭直觉编(用"调研标记"金丝雀字符串验证)
- 跨 actor KB 写入归属正确(WORKER 的 page creator = WORKER)

## 流程

### Phase 1 — 用户给 LEAD 一句 NL

> 建 heavy issue "SmokeM7-${TS}",blueprint 3 步:
> 1. step1 你自己:KB page 标题 "${TAG} step1 调研",正文照抄一段(含"调研标记 ALPHA-${TS}")
> 2. step2 派 agent-gavin3:让它**读** step1 page 后产出 "${TAG} step2 对比矩阵",**正文必须包含调研标记**(证明真读了)
> 3. step3 你自己:综合 step1+2 写 "${TAG} step3 最终建议",**也保留调研标记**

### Phase 2 — 自主执行

agent 自主走完整 lifecycle,user 不再参与。

### Phase 3 — runner 验证

`waitForIssue(targetStatus='accepted')` → 检 3 个 KB page 是否存在 + 各自正文是否含 STEP1_KEY canary。

## 断言(15 条)

| # | 断言 |
|---|---|
| 1 | issue.title 包含 SmokeM7-${TS} |
| 2 | issue 最终 status === 'accepted' |
| 3 | issue.mode === 'heavy' |
| 4 | issue 上恰好 3 个 task |
| 5 | 3 个 task 全部 done |
| 6 | 恰好 1 个 task assignee === WORKER(step2) |
| 7 | 恰好 2 个 task assignee === LEAD(step1+3) |
| 8 | KB 里能找到 step1 page |
| 9 | KB 里能找到 step2 page |
| 10 | KB 里能找到 step3 page |
| 11 | step1 page 正文含调研标记(LEAD 照抄成功) |
| 12 | **step2 page 正文含 step1 调研标记(WORKER 真读了 step1)** |
| 13 | step3 page 正文含调研标记(LEAD 综合时引用了 step1) |
| 14 | step2 KB node creator === WORKER(跨 actor KB 写入归属) |
| 15a | LEAD 在 bot DM ≥ 1 条 agent_text(派 step2) |
| 15b | WORKER 在 bot DM ≥ 1 条 agent_text(step2 done 确认) |

## 实现备注

- 用 `kb.tree_roots` 找 page,**不用 `kb.pages`**(cws-kb#199 未修)
- "调研标记" canary 设计:NL 没暗示 worker"必须 copy paste",但要求"正文里必须出现这串",worker 唯一可靠做法就是去读 step1 — 这是 cross-step 数据流的强证据

## 与 smoke-2 的区别

| 维度 | smoke-2 | smoke-7(本) |
|---|---|---|
| Step 数 | 3 | 3 |
| 跨 actor | step1 WORKER,step2/3 LEAD | step1 LEAD,step2 WORKER,step3 LEAD |
| KB 用途 | step1 产出物归档 | **3 个 page 形成串行接力链路** |
| Step 间数据传递 | 隐式(看 issue 描述) | **显式(canary 字符串穿透验证)** |
