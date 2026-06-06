# Smoke 10 (multi-agent, NL) — task cancel and re-path

> Mid-flight scope change. LEAD cancels a task already in progress at WORKER, then creates a fresh one. Verifies the cancellation path and clean state after re-path.

## 目的

验证任务进行中的取消 + 改向的协作链路:

- LEAD 改主意能通过 DM 让 WORKER 中止当前工作
- attempt 标 cancelled、task 标 cancelled 路径走通
- 重新派的新 task 跟被取消的 task 是独立 record(不是 status 来回改)
- 整个 issue 仍能正常 lifecycle 到 accepted

## 流程

### Phase 1 — 用户给 LEAD 一句 NL

> 开 light issue "SmokeM10-${TS}":
> 1. 派 task 1 给 agent-gavin3:调研云厂商对象存储定价
> 2. 等它 DM 说"开始干"后,**立即**让它取消(attempt + task 都 cancelled),理由"方向变了"
> 3. 等取消确认后,**新建** task 2 给它:写一段"调研暂缓"的通知文案
> 4. 等 task 2 done,推 issue → delivered + accept

### Phase 2 — agent 多轮协商

预期序列:
1. LEAD task.create #1 → WORKER
2. WORKER 收到 → claim → attempt#1 running → DM "我开始干了"
3. LEAD DM "方向变了,取消"
4. WORKER attempt.transition→cancelled → task.transition→cancelled → DM "已取消"
5. LEAD task.create #2 → WORKER(全新 task)
6. WORKER claim → attempt → done → DM "新任务完成"
7. LEAD issue.transition→delivered → set_acceptance(true)

### Phase 3 — runner 验证

`waitForIssue(targetStatus='accepted')` → 检 task 数 / status 分布 / attempt 终态。

## 断言(13 条)

| # | 断言 |
|---|---|
| 1 | issue 最终 status === accepted |
| 2 | issue 上**恰好 2 个 task**(cancelled 1 + done 1) |
| 3 | 恰好 1 个 task status=cancelled |
| 4 | 恰好 1 个 task status=done |
| 5 | 被取消的 task assignee === WORKER |
| 6 | 完成的 task assignee === WORKER |
| 7 | 两个 task id 不同(独立 record,不是同一个改 status) |
| 8 | 被取消 task 至少 1 个 attempt |
| 9 | 被取消 task 所有 attempt 在终态(cancelled / failed / done) |
| 10 | **被取消 task 至少 1 个 attempt status=cancelled** |
| 11 | 新 task 至少 1 个 attempt |
| 12 | 新 task 最终 attempt status === done |
| 13a | LEAD 在 bot DM ≥ 3 条 agent_text(派 + 取消 + 重派) |
| 13b | WORKER 在 bot DM ≥ 2 条 agent_text(开始 + 取消确认 / 完成) |

## 容错与边界

- 若 server 不允许 attempt → cancelled 转换:case 10 / 9 挂
- 若 WORKER 误把第一个 task 改成 done(忽略取消请求):case 3 / 5 挂
- 若 LEAD 直接改 task 1 的状态来代替重派(没新建 task 2):case 2 / 4 挂
- 若 WORKER 完全没动手(LEAD DM 已经说取消就没派工作):case 9 / 10 挂(没 running attempt 怎么 cancel)

## 与其他 case 的区别

| 维度 | smoke-3(rework) | smoke-10(本) |
|---|---|---|
| 触发条件 | LEAD 对成品打回(scope 不变) | LEAD 改 scope(成品作废,**做的内容变了**) |
| Task 结构 | 1 个 task,2 个 attempt | **2 个 task**(1 cancelled + 1 fresh) |
| Attempt 状态 | done → done | cancelled → done |
| 验证重点 | rework 状态机 + attempt 序号 | **task cancel 路径 + 重派独立性** |
