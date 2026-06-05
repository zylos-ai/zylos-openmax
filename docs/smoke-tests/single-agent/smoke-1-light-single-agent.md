# Smoke 1 — Light 单 Agent 全生命周期(基线)

> **验证目标**:用户经 IM(WS 链路)给 agent 下达自然语言指令,agent
> **完全自主决策**调用 zylos-coco-workspace 的 tm.js 完成 Light Issue 的
> 最简生命周期(创建直达 `executing` → 自做 task 跑到 attempt done →
> task done → issue delivered → `set_acceptance(accepted=true)` → 终态
> `accepted`)。测试 client 只负责**触发指令**与**外部断言 TM 状态**,
> **全程黑盒**不干预 agent 决策。
>
> 对照设计:`cws-deploy/docs/smoke-test-design.md` Smoke 1 章节。

---

## 1. 测试架构

```
┌─ TEST CLIENT (smoke-1-light-single-agent.test.js) ─────────────────────┐
│   [Phase 1: trigger]                                                   │
│        HTTP POST → cws-core /api/v1/conversations/{TEST_CONV_ID}/messages
│        Authorization: Bearer <TEST_USER_TOKEN>                         │
│        CF-Access-* headers (when applicable)                           │
│        body: { client_msg_id, type:"TEXT",                             │
│                content:{content_type:"text", body:{text:"<指令>"},     │
│                         attachments:[]} }                              │
│        ↓                                                               │
│   ╔════════════ 黑盒区 ════════════════════════════════════════════════╗
│   ║  cws-core → cws-comm SendMessage → outbox → NATS → gateway-push    ║
│   ║         ↓                                                          ║
│   ║  agent runtime WS → comm-bridge.js → C4 inbound queue              ║
│   ║         ↓ deliver                                                  ║
│   ║  AGENT (Claude Code runtime, bound to TEST_AGENT_ID)               ║
│   ║         ↓ 读 SKILL.md + references/                                ║
│   ║         ↓ 自主决策需要的 CLI                                       ║
│   ║         ↓ tm.js {issue.create / task.create / attempt.transition  ║
│   ║                  / task.transition / issue.transition              ║
│   ║                  / issue.set_acceptance}                           ║
│   ╚════════════════════════════════════════════════════════════════════╝
│   [Phase 2: wait]   轮询 cws-core(经 tm.js)直到 title 包含 TITLE 的    │
│                     issue 出现且 status=accepted。**默认 10 分钟超时**。 │
│   [Phase 3: assert] 拉 issue / task.list / attempt.list,逐字段断言。   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 前置条件

### 测试环境

| 资源 | 用途 |
|---|---|
| cws-core / cws-comm / cws-work | 部署到位且健康(`/healthz=200`) |
| 测试 Org + Project | 至少 1 个 Project,`TEST_PROJECT_ID` 即其 id |
| 测试 User member | 用 `TEST_USER_TOKEN` 发起指令的"用户"身份 |
| 测试 Agent member | agent 自己,member 类型 = agent,有 Lead 资格 |
| Conversation | 测试 user ↔ agent 的 DM 或 group,`TEST_CONV_ID` |
| Agent runtime | Claude Code session,bind 到测试 Agent member;**为本测试新开 session 跑** |

### Env vars

```bash
COCO_API_URL=https://cws-int.coco.xyz
TEST_USER_TOKEN=<bearer>
TEST_CONV_ID=<uuid>
TEST_AGENT_ID=<uuid>
TEST_PROJECT_ID=<uuid>
CF_ACCESS_CLIENT_ID=<...>.access     # cws-int 走 CF Access 时必填
CF_ACCESS_CLIENT_SECRET=<...>        # 同上
# COCO_AUTH_TOKEN= 可省,缺省 = TEST_USER_TOKEN
# COCO_TM_CLI=     可省,默认 = installed skill 的 tm.js
```

---

## 3. 指令文本

> agent 唯一收到的输入。`${TITLE}` 由 runner 替换成 `Smoke1-<毫秒时间戳>`。

```
请帮我跑一个 smoke-1 测试。

要求:
- 创建一个 light issue,标题严格写成 "${TITLE}"(完全照抄不要改),
  priority=low,leadAgentId 用你自己。
- 给这个 issue 自建一个 task,assigneeId 用你自己(Lead 自做)。
- 走完 attempt → task → issue 整条状态流转,attempt 和 task 都
  transition 到 done,issue 先 transition 到 delivered。
- 最后调 `set_acceptance(accepted=true, source=explicit)` 把 issue
  闭环到 accepted。
- 每一步执行完用一行简要日志告诉我,全部完成后给我返回
  issueId / taskId / attemptId 三个 id 和最终 status。
- 不要建 blueprint,不要用 task.claim,按 light 模式走 Lead 自做最
  简路径。
```

**为什么这样写**:

- **title 强约束** —— runner 用 `title.includes(TITLE)` 匹配,允许 agent 加前后缀但保留主体
- **mode / priority / lead / assignee 全部点名** —— 减少 agent 决策歧义
- **明确"不要 blueprint / 不要 task.claim"** —— 锚到 Light 单 Agent 路径
- **`source=explicit` 显式写** —— `set_acceptance` 的 `source` 是 caller 传参,strict 断言 `=== "explicit"` 站得住

---

## 4. 跑法

```bash
cd ~/zylos/workspace/zylos-coco-workspace

export COCO_API_URL=https://cws-int.coco.xyz
export TEST_USER_TOKEN=<test user bearer>
export TEST_CONV_ID=<conversation id>
export TEST_AGENT_ID=<agent member id>
export TEST_PROJECT_ID=<project id>
export CF_ACCESS_CLIENT_ID=<...>.access
export CF_ACCESS_CLIENT_SECRET=<...>

node docs/smoke-tests/smoke-1-light-single-agent.test.js
```

---

## 5. 断言总表(14 条)

| # | 字段 | 期望 | 来源 |
|---|---|---|---|
| 1a | `statusTrace` | 不含 `"draft"` | Light 关键行为 —— **跳过 draft**(否定断言,避开 sub-second 跑完时的 poll 竞态) |
| 1b | `firstObservedStatus` | 不等于 `"draft"` | 冗余兜底 |
| 2 | `issue.mode` | `"light"` | 指令约束 |
| 3 | `issue.priority` | `"low"` | 指令约束 |
| 4 | `issue.status` | `"accepted"` | 流转终点 |
| 5 | `issue.lead_agent_id` | `TEST_AGENT_ID` | 指令约束 |
| 6 | `issue.current_blueprint_id` | `null` | Light 不走 blueprint |
| 7 | `issue.acceptance_source` | `"explicit"` | `set_acceptance` 调用留下的痕迹 |
| 8 | task 数 | `1` | Light 单 Agent 单 task |
| 9 | `task.status` | `"done"` | 流转结束 |
| 10 | `task.assignee_id` | `TEST_AGENT_ID` | Lead 自做 |
| 11 | `task.blueprint_step_id` | `null` | 不挂任何 step |
| 12 | attempt 数 | `1` | Light 一次跑完 |
| 13 | `attempt.status` | `"done"` | 流转结束 |
| 14 | `attempt.attempt_number` | `1` | 首次尝试 |

任意 1 条失败:`process.exit(1)` + stderr 打印失败字段。

---

## 6. 期望输出

```
[2026-...] === Smoke 1: Light 单 Agent 全生命周期 ===
[2026-...] [Phase 1] 发指令到 conversation <conv>
[2026-...]   response body: {"data":{"id":"...","seq":N, ...}}
[2026-...]   ✓ instruction sent (client_msg_id=smoke-1780...)
[2026-...] [Phase 2] 等待 agent 自主跑完 (poll 3s, max 10min)
[2026-...]   · first observed: status=executing
[2026-...]   · status transition → delivered (+18.3s)
[2026-...]   · status transition → accepted (+22.1s)
[2026-...] [Phase 3] 深度断言
[2026-...]   ✓ firstObservedStatus = "executing"
[2026-...]   ✓ issue.mode = "light"
... (14 条断言全过)
[2026-...] ✅ Smoke 1 PASS
[2026-...]    issueId   = <uuid>
[2026-...]    duration  = 22.1s
[2026-...]    trace     = executing → delivered → accepted
```

---

## 7. 失败排查

| 现象 | 可能原因 | 排查 |
|---|---|---|
| `sendInstruction HTTP 302 / Location: cloudflareaccess` | 缺 CF Access 头 | 设 `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` |
| `sendInstruction HTTP 422 ... expected required property type` | runner 被改回了旧 cws-core schema | 对齐 `runner.js:sendInstruction` 的 body 形状 |
| `sendInstruction HTTP 401/403` | `TEST_USER_TOKEN` 失效 | 重 `/auth/login` 拿新 token |
| `waitForCompletion timed out` | agent 没收到 / 卡某一步 | runner 自动 dump 最后观测;另看 `pm2 logs zylos-coco-workspace` |
| `firstObservedStatus ≠ executing` | TM 在 light 模式下也插了 draft 中转态 | 查 `cws-work` issue 状态机定义 |
| `acceptance_source ≠ explicit` | agent 没传 source 或传错值 | 看 agent 调用 `issue.set_acceptance` 时的 params(指令明确要求 `source=explicit`) |
| `task.blueprint_step_id ≠ null` | agent 自作主张建了 blueprint | 看指令是否清楚说了"不要 blueprint" |

---

## 8. 不在本测试范围

- agent 给用户回复的 IM 消息文本内容 —— 不验
- 失败 / 重试 / 取消 路径 —— 走单独 Smoke 系列
- Heavy / Blueprint / Worker 路径 —— 走 Smoke 2
- KB / AS 集成 —— Smoke 1 不涉及
