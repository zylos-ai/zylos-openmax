# Smoke 6 (multi-agent, NL) — cross-agent task reassign

> LEAD mis-delegates, WORKER pushes back through bot DM, LEAD reassigns to self and finishes. Verifies that scope renegotiation between agents is a first-class collaboration path.

## 目的

验证当 LEAD 把任务派给不合适的 agent 时,WORKER 能通过 bot↔bot DM 主动反馈,LEAD 据此把任务转回给自己。重点:

- WORKER 不被动接活,有判断能力(NL 描述里没有"必须做"的强约束)
- LEAD 不固执,能根据 WORKER 反馈调整 assignee
- `task.reassign` (Lead-only API) 在跨 agent 协商之后被正确调用
- 最终 attempt 由 LEAD 自己做完,task 终态 assignee = LEAD

## 流程

### Phase 1 — 用户给 LEAD 一句 NL(全程唯一一句)

> 开一个 light issue,标题 "SmokeM6-${TS}",描述 "smoke 6 验证跨 agent 任务转手",priority=low,你做 Lead。
>
> 然后派一个任务给 agent-gavin3,内容是「校对中文翻译 + 给三种语气英文版本」。其实这种语言润色你自己更擅长,但先按惯例派出去看看对方反应。
>
> 接下来跟 agent-gavin3 在你们 DM 里正常沟通,如果它觉得这事更适合你来,就把任务接回来自己完成。

### Phase 2 — agent 自主协商 (无 user 参与)

预期 agent 行为序列:

1. LEAD 建 light issue → executing
2. LEAD task.create(assigneeId=WORKER) 派活
3. WORKER 收到任务通知(WS 推送 + bot DM 提示)
4. WORKER 在 bot DM 回 LEAD:"这事感觉你来更合适,你要不要接回去?"(措辞由 agent 决定,核心语义是"建议转手")
5. LEAD 在 bot DM 同意:"行,我自己来"
6. LEAD 调用 `task.reassign` 把 assignee 改为自己
7. LEAD 自己跑 attempt → done → task → done
8. LEAD 把 issue 推到 delivered + accept

### Phase 3 — runner 静默轮 server 状态

`waitForIssue(targetStatus='accepted')`,最长 15min。

## 断言(10 条)

| # | 断言 |
|---|---|
| 1 | issue.title 包含 SmokeM6-${TS} |
| 2 | issue.lead_agent_id === LEAD |
| 3 | issue 最终 status === 'accepted' |
| 4 | issue 上至少 1 个 task(可能 1,reassign 不新建) |
| 5 | task.assignee_id 最终 === LEAD(已从 WORKER 转回) |
| 6 | task.status === 'done' |
| 7 | task 至少 1 个 attempt |
| 8 | 最终 attempt assignee === LEAD(LEAD 自己做的,不是 WORKER 的残留 attempt) |
| 9 | 最终 attempt status === 'done' |
| 10a | LEAD 在 bot DM 至少 2 条 agent_text(派活 + 收回确认) |
| 10b | WORKER 在 bot DM 至少 1 条 agent_text(建议转手) |

## 关键差异于其他 case

| 维度 | smoke-2 | smoke-6(本) |
|---|---|---|
| 任务派 | LEAD → WORKER → 完成 | LEAD → WORKER → **转回 LEAD** → 完成 |
| 验证点 | 跨 actor assignee + KB visibility | **task.reassign + agent 主观判断 + 协商沟通** |
| 反向通道 | WORKER 单向汇报"做完了" | WORKER 主动"我不该接,你来"|

## 容错与边界

- 如果 WORKER 直接接受任务做完(没建议转手),case 1-7 仍可能通过但 5 / 8 / 10b 会挂 — 暴露 agent 主观判断不足
- 如果 LEAD 不接受 WORKER 的建议,坚持等它做,case 5 / 8 会挂 — 暴露 LEAD 不灵活
- 若 server 不允许 `task.reassign` (Lead 权限或状态约束),case 5 / 8 直接挂 — 暴露权限/状态机问题
