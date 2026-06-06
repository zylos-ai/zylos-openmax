# Smoke 8 (multi-agent, NL) — concurrent independent work

> Two unrelated issues triggered in one NL. LEAD handles one solo, delegates a step in the other to WORKER. Verifies state isolation and parallel execution.

## 目的

验证 LEAD 同时处理两个无关 issue 时:

- A 路完全独立(WORKER 永远不应该出现在 A 的任何 task 上)
- B 路跨 agent 协作(必须有 WORKER 参与)
- 两路 lifecycle 互不阻塞、互不串状态
- 两个 issue 都能独立到达 accepted

## 流程

### Phase 1 — 用户一句 NL,描述两件事

> 一次给你两件互不相关的活:
> - 【A】light issue "SmokeM8A-${TS}",你自己接自己干,**别让 agent-gavin3 碰**
> - 【B】light issue "SmokeM8B-${TS}",给 agent-gavin3 派 1 个小任务(写句早安问候)
>
> 两路并行,最终都 accepted。

### Phase 2 — 双轨自主

预期 agent 行为:
- LEAD 创建 issue A → 自己 task.create + claim → done → deliver + accept
- LEAD 创建 issue B → task.create(assigneeId=WORKER) → DM 通知 WORKER
- WORKER 接 B 的 task → done → DM 回报
- LEAD 给 B 收尾 → deliver + accept
- A、B 时间线交错,允许任意顺序

### Phase 3 — runner 验证

并行 `waitForIssue` 两次,都到 accepted 后做断言。

## 断言(10 条)

| # | 断言 |
|---|---|
| 1 | issue A 最终 accepted |
| 2 | issue B 最终 accepted |
| 3 | 两个 issue id 不同 |
| 4 | issue A 至少 1 个 task |
| 5 | issue B 至少 1 个 task |
| 6 | **issue A 没有任何 task assignee=WORKER**(隔离!) |
| 7 | **issue B 至少 1 个 task assignee=WORKER**(协作!) |
| 8 | issue A 所有 task done |
| 9 | issue B 所有 task done |
| 10a | LEAD 在 bot DM ≥ 1 条 agent_text(B 派活) |
| 10b | WORKER 在 bot DM ≥ 1 条 agent_text(B 回报) |

## 实现备注

- runner 顺序调 waitForIssue(A → B),但 server 端两个 lifecycle 是并发的
- 不强断言 A 完成在 B 之前(顺序无所谓,只断"都 accepted")
- bot DM 计数只能整体验,不能区分"是 A 的还是 B 的对话",但 case 6+7 已经把隔离锁死了

## 容错与边界

- 若 LEAD 错把 A 的 task 派给 WORKER:case 6 挂 → 暴露 agent 没读懂"别让 gavin3 碰"
- 若 LEAD 把 B 的活全包了不给 WORKER:case 7 + 10b 挂 → 暴露 agent 偷懒
- 若 server 状态机有 race / 跨 issue 串状态:case 1-2 可能超时,或某个 issue 永远卡在中间态
