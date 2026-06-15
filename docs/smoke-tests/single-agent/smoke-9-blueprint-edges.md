# Smoke 9 — Blueprint 编排调整 + Worker claim(NL 驱动)

> **验证目标**:用户用自然语言让 agent 起一个 heavy issue + 初版 blueprint,
> 看完觉得步骤可以合并,要求 agent 改 blueprint(整组替换),然后用
> worker claim 模式跑第一步到 done。验证 agent 会自主用
> `blueprint.set_steps / task.list(claimable+skillTags) / attempt.list 链`
> 的完整边缘。
>
> 双层断言。
>
> 覆盖 **tm.js**:
>   `blueprint.create`、`blueprint.get(includeSteps)`、`blueprint.list`、
>   **`blueprint.set_steps`**、`task.list(claimable + agentSkills)`、
>   `task.claim`、`attempt.list`、`attempt.get`、`attempt.transition`、
>   `task.transition`、`issue.transition`

---

## 1. 架构

```
[Round 1] NL: 起 heavy issue + 3 步 blueprint(采集/建模/写报告)
[Round 2] NL: 合并前两步成 1 步,blueprint 变 2 步
[Round 3] NL: 用 worker claim 模式跑第一步到 done(不指定 assignee)
```

---

## 2. NL 文本

### Round 1

```
我想做个 Smoke9-<TS> 的竞品调研项目,你帮我:
1. 在 Smoke Suite 项目下开个 heavy issue,标题 "Smoke9-<TS> 竞品定价对比",
   优先级 medium,你做 lead,描述 "采 5 家竞品定价然后输出对比报告"
2. blueprint 先排 3 步:s1 "采 5 家竞品定价页"、
   s2 "建立定价对比模型"(depends on s1)、
   s3 "写分析报告"(depends on s2)

建完一行报 issue id + blueprint id + 3 个 step 的 id。
```

### Round 2

```
看完 blueprint 我觉得 s1 + s2 太碎,合并起来一个人能搞定。改成 2 步:
- 新 s1 "采集 + 建模合并"
- s2 "写分析报告"(depends on 新 s1)

改完 blueprint.get 一下确认现在只剩 2 步。
```

### Round 3

```
ok 推到 executing 状态。新 s1 那一步用 worker claim 模式:
- 建 task 不指定 assignee,skillTags 加 ["research"]
- 你自己以 worker 身份接(模拟有 research 技能的 agent)
- 接完跑到 done(attempt + task 都 done)

最后给我汇报 attempt id 跟最终 status。
```

---

## 3. 断言表(12)

### 卡片体(6)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 回复在 120s 内到达,含 issue + blueprint + ≥ 3 uuid |
| 2 | 1 | 回复表达"3 步已建"语义,含 "采" / "模型" / "报告" |
| 3 | 2 | round2 回复在 90s 内到达,含"2 步"+"合并"语义 |
| 4 | 2 | 回复明确说当前 step 数 == 2 |
| 5 | 3 | round3 回复在 120s 内到达,含 "worker" 或 "claim" 或 "已接" |
| 6 | 3 | 回复表达 attempt + task 已 done |

### 旁路(6)

| # | 阶段 | 断言 |
|---|---|---|
| 7 | round1 | blueprint.get(includeSteps) → steps.length == 3 |
| 8 | round2 | blueprint.get(includeSteps) → steps.length == 2 |
| 9 | round2 | step titles 至少有 1 个包含 "合并" / "采" / "merged" |
| 10 | round3 | task.list(issueId, claimable=false) 含 1 个 task,status ∈ {done, running} |
| 11 | round3 | attempt.list(taskId) ≥ 1,首条 attempt.status == done |
| 12 | round3 | issue.status == executing 或 delivered |

---

## 4. 已知 bug 留观

- Smoke 2 之前踩过 `task.claim` 不设 `assignee_id` 的 bug(参 state.md);如果重现,断言 10 任务 status 可能停在 pending → fail。

---

## 5. 跑法

```bash
node docs/smoke-tests/smoke-9-blueprint-edges.test.js
```

预期 4-7 分钟。
