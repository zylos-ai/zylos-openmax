# Smoke 3 (multi-agent, NL) — cross-actor rework loop

> Two live agent runtimes. LEAD reviews WORKER's deliverable, sends it back, WORKER reworks. Verifies the rejection→new-attempt→re-deliver path across actors.

## 目的

验证当 LEAD 对 WORKER 的交付不满意时,通过自然语言把 issue 打回,
WORKER 自主开新 attempt 重做。重点:

- WORKER 自主感知"被打回"语义,无需明示 attempt API 名
- 同一个 task 上出现第 2 个 attempt,assignee_id 仍是 WORKER
- 第二次 attempt done 后,LEAD 才接受 issue
- attempt 序号正确递增、上一次的 attempt 留作历史

## 流程

### Phase 1 — LEAD 排活
NL → LEAD:

> 建一个 heavy issue 标题 "SmokeM3-${TS}",描述 "smoke 3 验证打回重做",priority=medium,你做 Lead。给它配一份 1 步的 blueprint,这一步「调研 3 家竞品定价并给一份 markdown 总结」。蓝图提交评审 → 批准 → issue 推到 executing → 为这步开一个 task 不指定承接人。

`waitForIssue(targetStatus='executing')`

### Phase 2 — WORKER 第一次接活(故意做得简单)
NL → WORKER:

> 看 org 里有没有可领的活,领一个。领到之后在 KB 建一个标题"SmokeM3 W-${TS} v1"的 page,正文只写一句"Competitor A pricing: $99/mo"就行(知道不全也没事 — 先交一版)。完成这次尝试和任务。

`waitForTaskAssignee(predicate: assignee=WORKER && status='done')` 记下 attempt #1 id

### Phase 3 — LEAD 审阅 + 打回
NL → LEAD:

> 刚才那个 "SmokeM3-${TS}" issue 的交付有人提交了,你看一眼 KB 那个 v1 page。内容明显不够 — 只覆盖了 1 家竞品,不是 3 家。把这个 issue 打回去重做,理由写"覆盖竞品不足,请补齐 3 家",别接受。

LEAD 调 `issue.set_acceptance` 设置 accepted=false + reason。状态机回退到 `executing`(或类似 returned)。

`waitForIssue(predicate: status ∈ ['executing','returned','running'] && i.acceptance?.accepted===false)`

### Phase 4 — WORKER 感知 + 重做
NL → WORKER:

> 之前那个 "SmokeM3-${TS}" 的活被打回了,理由是 "覆盖竞品不足,请补齐 3 家"。开一次新的尝试,把 KB page 内容更新成包含 3 家竞品(随便编内容也行),写完把新的尝试和任务标完成。

`waitForTaskAssignee(predicate: attempts.length >= 2 && latest.status='done' && latest.assignee=WORKER)`

### Phase 5 — LEAD 接受
NL → LEAD:

> 那个 issue 的重做交付了,这次合格。推到 delivered,然后做最终验收(accepted=true,source=explicit)。

`waitForIssue(targetStatus='accepted')`

## 断言(15 条)

| # | 断言 |
|---|---|
| 1 | issue.title 包含 SmokeM3-${TS} |
| 2 | task 在 issue 上有且仅 1 个(没多建) |
| 3 | task.assignee_id === WORKER.member_id 全程 |
| 4 | task 上有 2 个 attempt |
| 5 | attempt #1.assignee === WORKER |
| 6 | attempt #2.assignee === WORKER |
| 7 | attempt #1.status === 'done' (历史) |
| 8 | attempt #2.status === 'done' |
| 9 | attempt #1.attempt_number < #2.attempt_number |
| 10 | issue.statusTrace 含一段 returned/executing 之后再 delivered |
| 11 | issue.set_acceptance 历史里有 accepted=false 然后 accepted=true 各 1 次 |
| 12 | issue 最终 status === 'accepted' |
| 13 | KB page "SmokeM3 W-${TS} v1" 存在 |
| 14 | KB page 至少 2 个 revision(WORKER 改过 v1 内容) |
| 15 | WORKER JWT 视角:能看到 attempts 全部 2 条 |

## 与单 agent rejection-rework (smoke-3) 的关系

| 维度 | single-agent smoke-3 | multi-agent smoke-3 (本) |
|---|---|---|
| Worker | 同 agent 自我打回 | 真·跨 agent(LEAD 打回,WORKER 重做) |
| 验证点 | rework 状态机 | rework 状态机 **+ cross-actor 反馈传递** |
| NL 轮数 | 2-3 轮 | 5 轮(LEAD 排-WORKER 一-LEAD 打回-WORKER 二-LEAD 接) |
