# Smoke 2 — Heavy + Blueprint + Worker claim + KB

> **验证目标**:0.5 最核心的用例。Heavy Issue → Blueprint 编排 → 按 Step
> 派 Task → Worker 领取执行(claim 模式)→ KB 写入并搜索回 → 逐层交付 →
> 验收。覆盖 Lead/Worker 协作、Blueprint 驱动的任务分解、以及 KB 集成。
>
> 对照设计:`cws-deploy/docs/smoke-test-design.md` Smoke 2 章节。

---

## 1. 测试架构

```
TEST CLIENT                                 ↓
  Phase 1: 发一条指令(包含 3 步要求)
  Phase 2: 轮询 issue 直到 status=accepted
  Phase 3: 拉 issue + 3 个 task + 3 个 attempt + KB page,断言
                          ↓
                ┌─── 黑盒区(agent 自主)──────────────────────┐
                │  Step 1: issue.create (heavy)                  │
                │  Step 2: blueprint.create(3 steps, 有依赖链)   │
                │  Step 3: blueprint.get 自检 steps              │
                │  Step 4: issue.transition draft→executing      │
                │  Step 5: task.create(step1,无 assignee → pending)
                │  Step 6: task.list claimable + skillTags 自查
                │  Step 7: task.claim → status=running           │
                │  Step 8: kb.tree_roots + page_create + page_content_write
                │  Step 9: kb.search 自验                         │
                │  Step 10: attempt.transition done, task.transition done
                │  Step 11: task.create(step2, assigneeId 自带 → running)
                │  Step 12: attempt done + task done             │
                │  Step 13: task.create(step3, 同上)              │
                │  Step 14: issue.transition delivered           │
                │  Step 15: set_acceptance(accepted=true)         │
                └────────────────────────────────────────────────┘
```

注意:同一个 agent 既扮演 Lead 又扮演 Worker(单 runtime 模拟双角色),
这跟设计文档的 "**Worker 角色用同一个 agent 模拟**" 一致。

---

## 2. 前置条件

跟 Smoke 1 相同。额外要求:

- **cws-kb 必须健康**(`/healthz=200`),且测试 org 下有至少一个 KB tree root
  - 多数环境默认 `default tree` 已存在,agent 跑 `kb.tree_roots` 应该能拿到至少一个
- agent runtime 有 KB 写入权限

---

## 3. 指令文本

> `${TITLE}` 由 runner 替换成 `Smoke2-<毫秒时间戳>`。

```
请帮我跑一个 smoke-2 测试 —— Heavy Blueprint + Worker claim + KB 集成。

要求:
1) 创建一个 heavy issue,标题严格 "${TITLE}",priority=medium,
   leadAgentId 用你自己,description 写 "竞品定价对比"。
2) 紧接着 blueprint.create,3 个 step:
   - s1 "采集 5 个竞品的定价页面数据"
   - s2 "建立定价对比模型",depends_on s1
   - s3 "撰写定价分析报告",depends_on s2
   用 blueprint.get 验证三个 step 都建上且依赖关系正确。
3) issue.transition 把 issue 推到 executing(跳过 review)。
4) Step 1 用 **Worker claim 模式**:
   - task.create,blueprintStepId=s1 的 id,**不指定 assigneeId**,
     skillTags=["research"],预期 task.status="pending"。
   - 然后立刻 task.list 自查(claimable:true + agentSkills:["research"]),
     确认该 task 在列表里。
   - 你自己 task.claim 这个 task(模拟 Worker 角色),预期 status="running",
     attempt 自动创建。
   - 然后你作为 Worker 跑业务:
     a. kb.tree_roots 拿根节点 rootId
     b. kb.page_create 在 rootId 下面建一个 page,title="${TITLE} - 数据采集"
     c. kb.page_content_write 写入一段 markdown(写一个简单的 table 即可,
        含 5 行竞品数据,自己编)
     d. kb.search 用关键词 "${TITLE}",sync=true,自检 page 被搜到
   - attempt.transition done + task.transition done。
5) Step 2 和 Step 3 用 **Lead 自做模式**:
   - task.create 各带 blueprintStepId=对应 step 的 id,
     **assigneeId 用你自己**,预期 task 直接 status="running"(自动 claim)。
   - 各自 attempt.transition done + task.transition done。
6) 全部 3 个 task 都 done 后,issue.transition 到 delivered。
7) set_acceptance(accepted=true, source=explicit) 闭环到 accepted。
8) 每一步用一行简要日志报。结束打印 issueId / blueprintId / 三个 taskId /
   三个 attemptId / pageId / 最终 status。
```

**关键点**:

- Step 1 走 **task.claim 路径**(无 assignee 创建 → pending → 第三方 claim → running),覆盖 Worker 模式
- Step 2 / 3 走 **task.create 带 assigneeId 路径**(直接 running),覆盖 Lead 自做模式
- KB 写入 + 搜索回路是 Step 4d 的 sync=true,**应当能立刻搜到**(0.5 设计是同步索引)

---

## 4. 跑法

```bash
cd ~/zylos/workspace/zylos-coco-workspace

# 同 Smoke 1 的 env vars
node docs/smoke-tests/smoke-2-heavy-blueprint-worker.test.js
```

> 这个用例从 send → accepted **典型 60-180 秒**(3 个 task + KB 写入 + 搜索同步)。
> runner 默认 10 分钟超时够用。

---

## 5. 断言总表(20 条)

### Issue 字段(7)

| # | 字段 | 期望 | 来源 |
|---|---|---|---|
| 1 | `firstObservedStatus` | `"draft"` 或 `"executing"`(允许两者)| Heavy 路径会经过 draft;但 agent 可能跑得快导致 poll 错过 |
| 2 | `issue.mode` | `"heavy"` | 指令约束 |
| 3 | `issue.priority` | `"medium"` | 指令约束 |
| 4 | `issue.status` | `"accepted"` | 流转终点 |
| 5 | `issue.lead_agent_id` | `TEST_AGENT_ID` | 指令约束 |
| 6 | `issue.current_blueprint_id` | non-null UUID | Heavy 必走 blueprint |
| 7 | `issue.acceptance_source` | `"explicit"` | set_acceptance 留下的痕迹 |

### Blueprint(2)

| # | 字段 | 期望 |
|---|---|---|
| 8 | blueprint.steps 数 | `3` |
| 9 | s2 / s3 依赖链 | s2 depends_on 含 s1.id;s3 depends_on 含 s2.id |

### Tasks(6)

| # | 字段 | 期望 |
|---|---|---|
| 10 | task 数 | `3` |
| 11 | 所有 task `.status` | `"done"` |
| 12 | 所有 task 都有非空 `blueprint_step_id` | true |
| 13 | step1 对应 task 的 `assignee_id` | `TEST_AGENT_ID`(由 claim 设置;同一 agent 自 claim) |
| 14 | step2 / step3 对应 task 的 `assignee_id` | `TEST_AGENT_ID`(Lead 自做) |
| 15 | task 跟 blueprint step 的对应是 1:1 | true |

### Attempts(3)

| # | 字段 | 期望 |
|---|---|---|
| 16 | 每个 task 恰好 1 个 attempt | true |
| 17 | 所有 attempt `.status` | `"done"` |
| 18 | 所有 attempt `.attempt_number` | `1` |

### KB(2)

| # | 字段 | 期望 |
|---|---|---|
| 19 | 至少有一个 KB page 的 title 含 `${TITLE}` | true |
| 20 | kb.search 用 `${TITLE}` 关键词能搜到至少 1 条结果 | true(sync=true 同步索引) |

任意断言失败:`process.exit(1)` + 打印失败字段。

---

## 6. 期望输出

```
[2026-...] === Smoke 2: Heavy + Blueprint + Worker claim + KB ===
[2026-...] [Phase 1] 发指令到 conversation <conv>
[2026-...]   ✓ instruction sent (client_msg_id=smoke-1780...)
[2026-...] [Phase 2] 等待 agent 自主跑完 (poll 3s, max 10min)
[2026-...]   · first observed: status=draft
[2026-...]   · status transition → executing (+5.4s)
[2026-...]   · status transition → delivered (+98.7s)
[2026-...]   · status transition → accepted  (+102.1s)
[2026-...] [Phase 3] 深度断言
[2026-...]   ✓ firstObservedStatus ∈ ["draft","executing"] (got "draft")
[2026-...]   ✓ issue.mode = "heavy"
... (20 条断言)
[2026-...] ✅ Smoke 2 PASS
[2026-...]    issueId      = <uuid>
[2026-...]    blueprintId  = <uuid>
[2026-...]    taskIds      = [<uuid>, <uuid>, <uuid>]
[2026-...]    duration     = 102.1s
[2026-...]    trace        = draft → executing → delivered → accepted
```

---

## 7. 失败排查

| 现象 | 可能原因 | 排查 |
|---|---|---|
| `task 数 ≠ 3` | agent 漏建或多建 task | 看指令是否清晰约束"3 个 task,每个 blueprintStepId 对应一个 step" |
| step1 对应 task `.assignee_id` 不是 `TEST_AGENT_ID` | task.claim 没正确填 assignee;或多个 worker | 看 agent 日志的 task.claim 入参 + cws-work 行为 |
| step2 / step3 task `.status` 不是 `running` 而是 `pending` | agent 没传 assigneeId(走错了 claim 路径) | 看 agent 调用 task.create 的入参 |
| kb.search 搜不到 | sync 没真正同步;或 page_content_write 写空了 | 看 agent kb 调用日志;手动 `kb.search '{"query":"<TITLE>","sync":true}'` |
| `acceptance_source ≠ explicit` | agent 没传 source 或传错 | 看指令是否清楚要求 source=explicit |
| Blueprint depends_on 不对 | agent 自由发挥忽略依赖关系 | 指令明确写了 s2 depends s1 / s3 depends s2,看 agent blueprint.create 入参 |

---

## 8. 与设计文档的差异

跟 `cws-deploy/docs/smoke-test-design.md` Smoke 2 章节对照,本实现做了以下显式简化:

1. **不强制断言 `firstObservedStatus === "draft"`** —— 设计要求 heavy 走 draft,但 agent 跑得快可能让 poll(3s)错过 draft,改成允许 `["draft", "executing"]` 都通过(本质是 light 跳过 draft 才是关键差异;heavy 经过 draft 是默认,只要不是从 executing 直接到 delivered 就 OK)
2. **同一个 agent 模拟 Lead + Worker** —— 跟设计一致,真正多 agent 分布式走 Harness 测试
3. **KB 写入只 1 个 page** —— 设计示例里 Step 1 写一段简短 markdown,本实现保留;Step 2 / 3 没强制要 KB(设计也没强制)
4. **不验 KB 搜索结果的具体内容** —— 只验"能搜到含 ${TITLE} 的 page",不验 markdown 表格行数

如果以后要更严格,可加 `kb.page_get` 拉回 content 做字符串断言。

---

## 9. 不在本测试范围

- Worker 跨 agent 真正分布(单 runtime 模拟够用)
- Blueprint step 的 review / approval 路径
- AS(ArtifactStore)集成
- 失败 / 重试 / 取消 / 拒收(Smoke 3 才覆盖拒收)
