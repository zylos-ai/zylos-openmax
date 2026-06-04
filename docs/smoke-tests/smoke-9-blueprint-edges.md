# Smoke 9 — Blueprint 工作流边缘(纯脚本驱动)

> **验证目标**:补齐 Smoke 2 没覆盖的 blueprint / task.list 多 filter /
> attempt 链路边缘。重点是 **`blueprint.set_steps` 整组替换**、
> **`task.list` 用 worker-side filter(`claimable + agentSkills`)** 发现
> 待领任务、以及 **`attempt.list` / `attempt.get`** 在 worker claim 链路里
> 的可观测性。
>
> 覆盖 **tm.js**:
>   `blueprint.create`、`blueprint.get(includeSteps)`、`blueprint.list`、
>   **`blueprint.set_steps`**、`task.list`(claimable=true + agentSkills 过滤)、
>   `task.claim`、`attempt.list`、`attempt.get`、`attempt.transition`、
>   `task.transition`、`issue.transition`
>
> 跟 Smoke 2 的区别:
> - Smoke 2 是 **NL 驱动**,验证 agent 能自主跑通 worker claim 模式
> - Smoke 9 是 **脚本驱动**,把 worker 发现+attempt 可观测性的 CLI
>   表面拉直一次,不依赖 agent autonomy

---

## 1. 架构

```
TEST CLIENT (smoke-9-blueprint-edges.test.js)
    │
    ├─ Phase 1: 起 heavy issue + 初版 3-step blueprint
    ├─ Phase 2: blueprint.set_steps 整组替换 → 新 2 step
    ├─ Phase 3: issue.transition → executing
    ├─ Phase 4: 在新 step1 上 task.create(no assignee, skillTags=[research])
    ├─ Phase 5: task.list 用 worker filter(claimable=true + agentSkills=[research])
    │            → 确认 T 在结果里
    ├─ Phase 6: task.claim → attempt 自动生成 → attempt.list ≥ 1
    │            → attempt.get(first) 校验字段
    ├─ Phase 7: attempt.transition done → task.transition done
    └─ Phase 8: blueprint.list(issueId) → 确认 1 个 active blueprint
                + blueprint.get(includeSteps=true) 校验 step 数 == 2
```

---

## 2. 前置 / Env

跟 Smoke 8 一致(`TEST_USER_TOKEN` / `TEST_AGENT_ID` / `TEST_PROJECT_ID`)。
不需要 `TEST_CONV_ID` / `TEST_DEFAULT_KB_ID`。

---

## 3. 关键流程细节

### Phase 1 — 初版 3-step blueprint

```js
issue.create   { mode:'heavy', priority:'medium', leadAgentId, title:'Smoke9-<TS> issue' }
blueprint.create { issueId, authorAgentId, steps:[
  { title:'collect',  description:'采 5 个对手定价',    estimatedBudget: { ... }? },
  { title:'model',    description:'建对比模型',         dependsOn:[<s1.id>] },
  { title:'writeup',  description:'写分析报告',         dependsOn:[<s2.id>] },
] }
blueprint.get { id, includeSteps:true }  // assert steps.length == 3
```

### Phase 2 — set_steps 整组替换

新 step list 故意减到 2 条(模拟 PM 改了计划):

```js
blueprint.set_steps { blueprintId, steps:[
  { title:'merged_research', description:'采 + 建模合并' },
  { title:'writeup',          description:'写报告', dependsOn:[<new s1.id>] },
] }
blueprint.get { id, includeSteps:true }  // assert steps.length == 2,且 title 跟新组对得上
```

### Phase 4 — task.create 不带 assignee

```js
task.create {
  projectId, issueId, blueprintStepId: <new s1.id>,
  title:'Smoke9-<TS> claim task',
  skillTags:['research'],
  // 不传 assigneeId → pending,等 claim
}
```

### Phase 5 — task.list 用 worker filter

```js
task.list {
  issueId,
  claimable: true,
  agentSkills: ['research'],
}
// assert 结果含 T.id;
// 再跑一次 agentSkills=['unrelated-skill'] → 结果不含 T.id(filter 真生效)
```

### Phase 6 — claim + attempt 链

```js
task.claim { id: T.id }                  // 期待 status: running
attempt.list { taskId: T.id }            // ≥ 1
attempt.get { id: attempts[0].id }       // taskId == T.id,status 在 {running, in_progress}
```

### Phase 7 — 收尾状态机

```js
attempt.transition { id: attempts[0].id, targetStatus:'done' }
task.transition    { id: T.id,           targetStatus:'done' }
```

(为了把 attempt-task 状态机闭环到 done,但不要求一定把 issue 推到 delivered;留个不全闭环边缘验证 issue.transition 不强求)

### Phase 8 — 收集校验

```js
blueprint.list { issueId }               // 至少 1 个 blueprint
blueprint.get  { id, includeSteps:true } // steps.length == 2
```

---

## 4. 断言表(15)

| # | Phase | 断言 |
|---|---|---|
| 1 | 1 | issue.create heavy 返 id |
| 2 | 1 | blueprint.create 返 id + 3 steps |
| 3 | 1 | blueprint.get(includeSteps=true) → steps.length == 3 |
| 4 | 2 | blueprint.set_steps 返 2xx |
| 5 | 2 | blueprint.get 之后 steps.length == 2 |
| 6 | 2 | 新 step titles 含 `merged_research` + `writeup` |
| 7 | 3 | issue.transition 到 executing 返 2xx |
| 8 | 4 | task.create(no assignee, skillTags=['research']) 返 id,status=pending |
| 9 | 5 | task.list(claimable=true, agentSkills=['research']) 含 T.id |
| 10 | 5 | task.list(claimable=true, agentSkills=['unrelated-skill']) 不含 T.id |
| 11 | 6 | task.claim 后 task.status == running |
| 12 | 6 | attempt.list ≥ 1 |
| 13 | 6 | attempt.get(first).taskId == T.id |
| 14 | 7 | attempt.transition + task.transition done 链 都 2xx |
| 15 | 8 | blueprint.list 返 ≥ 1 个 active blueprint(对应同一 issue) |

---

## 5. 已知/相关 bug 留观

- assertion 11 之前 Smoke 2 踩过 `task.claim` leave `assignee_id` 不设的 bug(参 state.md)。Smoke 9 也会复测;如果踩到,本 Smoke 在此 fail 留 request_id,不绕过。
- assertion 12-13 attempt 链路同样是 cws-work 状态机的潜在弱点;失败留 request_id。
- assertion 4 `blueprint.set_steps` 是新覆盖路径,如果踩到 4xx/5xx,**直接 fail**,这是 Smoke 9 的首要价值点。

---

## 6. 跑法 + 设计要点

```bash
node docs/smoke-tests/smoke-9-blueprint-edges.test.js
```

预期 6-12 秒内跑完(15 条 REST 串行)。

设计:
- 不动 KB / AS / comm
- 不走 NL —— blueprint 编排 + worker 发现 + attempt 可观测性都不需要 NL
- attempt.transition 用 `done` 而非 `failed`,留 happy-path
- `set_steps` 是核心新覆盖,前后两次 blueprint.get 对比 step 数 + title 是主要约束
