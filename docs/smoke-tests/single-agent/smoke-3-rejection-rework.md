# Smoke 3 — Heavy 拒收 → reopened → 返工 → 再交付

> **验证目标**:Heavy Issue 走完一遍 delivered 之后,test client 显式调用
> `issue.set_acceptance(accepted=false, rejectionReason=...)` 触发拒收 →
> 状态机进入 `rejected` → 验证 `rejected → executing` **非法转移被服务端拒绝** →
> 走合法路径 `rejected → reopened → executing` → agent 收到返工指令、新建
> rework task、做完 → `delivered` → 再次 `set_acceptance(accepted=true)` →
> 终态 `accepted`。
>
> 对照设计:`cws-deploy/docs/smoke-test-design.md` Smoke 3 章节。

---

## 1. 测试架构

本用例**不**走 `runSmokeCase` 的 3 段式 wrapper —— 它有两轮指令、中间夹一个
test client 主动 `set_acceptance(false)`、还要验证一次非法 transition,所以
test 脚本直接编排:

```
[Phase 1: 第一轮指令]
   sendInstruction("create heavy issue with blueprint, complete all 3 steps, deliver")
                  ↓
   waitForCompletion(targetStatus="delivered")

[Phase 2: 主动拒收]
   tm('issue.set_acceptance', {id, accepted:false, rejectionReason:"..."})
   poll → status === "rejected"

[Phase 3: 负面 transition 断言]
   tm('issue.transition', {id, targetStatus:"executing"})
                  ↓ 应当抛错(状态机不允许 rejected → executing)

[Phase 4: 合法 transition]
   tm('issue.transition', {id, targetStatus:"reopened"})   → status="reopened"
   tm('issue.transition', {id, targetStatus:"executing"})  → status="executing"

[Phase 5: 第二轮指令(返工)]
   sendInstruction("issue 被拒,reason=...,请新建 task 返工并再次交付")
                  ↓
   waitForCompletion(targetStatus="accepted")
                  → set_acceptance 二次调用由 agent 完成或 test client 完成都可以
                    (本实现:agent 自己调,跟 Smoke 1 / 2 一致)

[Phase 6: 深度断言]
   - issue 终态 accepted
   - 共有 >=4 个 task(原 blueprint 3 个 + 1 个 rework task)
   - rework task 的 blueprint_step_id 为 null(不挂任何 step)
   - rework task 走完整 attempt → task done 流程
```

---

## 2. 前置条件

跟 Smoke 1 / 2 相同。无新增。

---

## 3. 指令文本

### 第 1 轮(创建并交付)

`${TITLE} = Smoke3-<毫秒时间戳>`

```
请帮我跑一个 smoke-3 测试的第一阶段。

要求:
1) 创建一个 heavy issue,标题严格 "${TITLE}",priority=high,
   leadAgentId 用你自己,description 写 "用户调研报告(将被故意拒收以验证返工流程)"。
2) blueprint.create 3 个 step:
   - s1 "设计访谈问卷"
   - s2 "执行用户访谈",depends_on s1
   - s3 "撰写调研报告",depends_on s2
3) issue.transition draft → executing。
4) 3 个 step 全部 Lead 自做(每个 task.create 带 assigneeId=自己):
   - 每个 task 走完 attempt.transition done + task.transition done。
5) issue.transition 到 delivered。
6) **不要**调 set_acceptance(等用户验收)。
7) 报每一步,结束打印 issueId / blueprintId / 3 个 taskId / 最终 status (应为 delivered)。
```

### 第 2 轮(返工)

```
我刚才那个 ${TITLE} 的 issue 被拒收了,rejectionReason 是
"访谈样本量不足,需要补充 3 个企业用户"。
状态机现在应该是 rejected → reopened → executing(test client 已经
帮你把状态走过去了)。

请你接着:
1) 给这个 issue 新建一个 task 做返工,标题 "${TITLE} - 返工:补充企业用户访谈",
   **不要**挂任何 blueprintStepId(blueprintStepId 留空 / null),
   assigneeId 用你自己。
2) 走完 attempt → task done。
3) issue.transition 到 delivered。
4) set_acceptance(accepted=true, source=explicit) 闭环到 accepted。
5) 报每一步,结束打印 reworkTaskId / reworkAttemptId / 最终 status。

注意:不要重新建 blueprint;返工 task 是额外补充,不在原 blueprint 中。
```

---

## 4. 跑法

```bash
cd ~/zylos/workspace/zylos-coco-workspace

# 同 Smoke 1 / 2 的 env vars
node docs/smoke-tests/smoke-3-rejection-rework.test.js
```

> **典型耗时 90 - 240 秒**(两轮 + 中间 test client 操作)。runner 默认 10 分钟
> 超时够用。中间 agent 在两轮之间应该会保持等待,不会主动继续往下走。

---

## 5. 断言总表(15 条)

### Phase 1 阶段(delivered)

| # | 字段 | 期望 |
|---|---|---|
| 1 | issue.mode | `"heavy"` |
| 2 | issue.priority | `"high"` |
| 3 | issue 经过 `delivered` 状态 | trace 含 `"delivered"` |
| 4 | blueprint.steps 数 | `3` |
| 5 | Phase 1 末 task 数 | `3`(对应 3 个 step) |

### Phase 2(拒收)

| # | 字段 | 期望 |
|---|---|---|
| 6 | set_acceptance 调用成功 | response 非 error |
| 7 | issue.status | `"rejected"` |
| 8 | issue.acceptance_source 仍 `"explicit"` 或仍记录拒收原因 | non-empty |

### Phase 3(负面 transition)

| # | 期望 |
|---|---|
| 9 | tm('issue.transition', {targetStatus:"executing"}) **抛错**(404 / 409 / 400 任一即可) |

### Phase 4(合法 transition)

| # | 字段 | 期望 |
|---|---|---|
| 10 | rejected → reopened 后 status | `"reopened"` |
| 11 | reopened → executing 后 status | `"executing"` |

### Phase 5(返工 + 再交付)

| # | 字段 | 期望 |
|---|---|---|
| 12 | issue 终态 | `"accepted"` |
| 13 | 总 task 数 ≥ 4(原 3 + 返工 ≥1) | true |
| 14 | 存在一个 task 满足 `blueprint_step_id === null` | true(返工 task)|
| 15 | 该返工 task 的 attempt status | `"done"` |

任意失败:`process.exit(1)`。

---

## 6. 期望输出

```
[2026-...] === Smoke 3: Heavy 拒收 → reopened → 返工 → 再交付 ===
[2026-...] [Phase 1] 发第一轮指令(创建 + 走到 delivered)
[2026-...]   ✓ instruction sent (round 1)
[2026-...] [Phase 1] 等 issue 到 delivered
[2026-...]   · first observed: status=draft
[2026-...]   · status transition → executing (+5.2s)
[2026-...]   · status transition → delivered (+62.3s)
[2026-...]   ✓ Phase 1 issue.status = "delivered"
[2026-...] [Phase 2] test client 主动拒收
[2026-...]   ✓ set_acceptance(accepted=false) 成功
[2026-...]   ✓ issue.status = "rejected"
[2026-...] [Phase 3] 验证非法转移 rejected → executing 被拒
[2026-...]   ✓ 状态机正确拒绝 (error: cannot transition from rejected to executing)
[2026-...] [Phase 4] 合法路径 rejected → reopened → executing
[2026-...]   ✓ issue.status = "reopened"
[2026-...]   ✓ issue.status = "executing"
[2026-...] [Phase 5] 发第二轮指令(返工 + 再交付)
[2026-...]   ✓ instruction sent (round 2)
[2026-...] [Phase 5] 等 issue 到 accepted
[2026-...]   · status transition → delivered (+30.1s)
[2026-...]   · status transition → accepted  (+33.4s)
[2026-...] [Phase 6] 深度断言
[2026-...]   ✓ task 数 ≥ 4 (got 4)
[2026-...]   ✓ 存在 blueprint_step_id=null 的返工 task
[2026-...]   ✓ rework task attempt.status = "done"
[2026-...] ✅ Smoke 3 PASS
[2026-...]    issueId      = <uuid>
[2026-...]    reworkTaskId = <uuid>
[2026-...]    duration     = 132.7s
[2026-...]    trace        = draft → executing → delivered → rejected → reopened → executing → delivered → accepted
```

---

## 7. 失败排查

| 现象 | 可能原因 | 排查 |
|---|---|---|
| Phase 3 没抛错 | 状态机没守 `rejected → executing` | 查 cws-work issue.go 状态机定义 |
| Phase 3 抛错但错误码不对 | 状态机抛了 panic / 500 而不是 4xx | 看具体错误响应,理论上应该 409 Conflict 或 400 BadRequest |
| Phase 2 set_acceptance 没切到 `rejected` | tm.js set_acceptance(false) 路径或入参 schema 漂移 | 看 tm.js cli + cws-core /api/v1/issues/{id}/acceptance contract |
| Phase 5 多发出来的 task 是又一个 blueprint step | agent 自作主张又建了 blueprint | 看指令是否清楚说"不要重新建 blueprint";看 agent 的 blueprint.create 调用日志 |
| Phase 5 没收到第二轮指令 | C4 dispatcher 没把第二条消息送给 agent | `pm2 logs zylos-coco-workspace --lines 100` 看 [ws] message frame 是否有第二条 |
| 整个 issue.status 一直是 `delivered` 没动 | agent 收第二轮指令后只 do nothing | 看 agent 是否在等更多输入;检查 round-2 指令是否清楚提到"状态已被 test client 推到 executing,你接着做" |

---

## 8. 不在本测试范围

- 多次拒收循环(rejected → reopened → executing → delivered → rejected 第二次)—— 单次拒收足够覆盖状态机
- 拒收后 `set_acceptance` 二次调入参 schema 验证 —— 由 Phase 2 自身覆盖
- Worker claim 路径 —— Smoke 2 已覆盖
- KB 集成 —— 返工 task 故意不挂 KB 写入(简化)
