# Smoke 11 (multi-agent, NL) — failure with reason

> LEAD assigns an intentionally impossible task. WORKER tries, fails, marks attempt failed with a meaningful reason, DMs LEAD. LEAD accepts the failure and closes the issue.

## 目的

验证失败路径的跨 agent 流转:

- WORKER 遇到无法完成的任务时走 attempt.failed + failureReason 标准路径
- failureReason 字段真的被填充并持久化(不是空字符串/敷衍)
- 失败信号通过 bot DM 显式传给 LEAD(不静默)
- 即使 task=failed,issue 仍能 lifecycle 到 accepted("我们暂时做不了"也是一个有效答复)

## 流程

### Phase 1 — 用户给 LEAD 一句 NL

> 开 light issue "SmokeM11-${TS}",派 agent-gavin3 一个**故意不可能**的任务:调用内部 SAP 财务 API(host + SAP_API_KEY 它都没有)拉应付账款明细。
>
> 让它认真试一下,做不到就如实标 failed + failure_reason + DM 汇报。
>
> 你收到后接受失败,task → failed,issue → delivered + accept(算闭环)。

### Phase 2 — agent 双向 failure 沟通

预期序列:
1. LEAD task.create → WORKER
2. WORKER claim → attempt#1 running → 尝试(可能调 web 工具发现没凭据,或直接评估自己没能力)
3. WORKER attempt.transition→failed (failure_reason="无 SAP_API_KEY 凭据,无法访问 sap-internal.coco.xyz")
4. WORKER DM LEAD:解释为啥不行
5. LEAD task.transition→failed
6. LEAD issue.transition→delivered → set_acceptance(true, explicit)

### Phase 3 — runner 验证

`waitForIssue(targetStatus='accepted')` → 检 attempt.failure_reason 字段是否真的有内容。

## 断言(10 条)

| # | 断言 |
|---|---|
| 1 | issue 最终 status === accepted(失败也算闭环) |
| 2 | acceptance_source === 'explicit' |
| 3 | issue 至少 1 个 task |
| 4 | 至少 1 个 task assignee=WORKER |
| 5 | **WORKER 的 task status === failed**(关键 — 不是 done 不是 cancelled) |
| 6 | task 至少 1 个 attempt |
| 7 | 最后一个 attempt status === failed |
| 8 | **attempt.failure_reason 非空** |
| 9 | failure_reason ≥ 5 字(言之有物,不是 "fail" 这种敷衍) |
| 10a | LEAD 在 bot DM ≥ 1 条 agent_text(派活) |
| 10b | WORKER 在 bot DM ≥ 1 条 agent_text(失败汇报) |

## 容错与边界

- 若 WORKER 装作做完了(伪造结果 done):case 5 / 7 挂 → 暴露 hallucination
- 若 WORKER 标 failed 但 failure_reason 留空:case 8 挂 → 暴露 protocol 缺失
- 若 LEAD 不接受失败,反复 reject 让 WORKER 重试:case 1 可能超时
- 若 server 不允许 issue accepted 含 failed 任务:case 1 挂 → 暴露状态机限制

## 跟其他 case 的区别

| 维度 | smoke-3(rework) | smoke-11(本) |
|---|---|---|
| WORKER 第一次结果 | done(简陋) | **failed**(主动认输) |
| LEAD 反应 | reject + 让重做 | **接受失败,闭环** |
| 最终任务 status | done | **failed** |
| issue 终态 | accepted | accepted(failure 也算"明确答复") |
| 验证重点 | rework 状态机 | **failure_reason 真实持久化 + 跨 agent failure 信号** |

## 失败 vs 取消的区分(对照 smoke-10)

| | smoke-10 cancelled | smoke-11 failed |
|---|---|---|
| 谁先发起 | LEAD 改主意 | WORKER 发现做不到 |
| 状态 | cancelled | failed |
| 字段 | (无 failure_reason) | failure_reason 必填 |
| 后续 | 新建 task 重来 | 接受失败,不重来 |
