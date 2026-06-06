# Smoke 2 (multi-agent, NL) — Heavy + cross-actor Worker

> NL-driven, two live agent runtimes. Replaces the previous dual-JWT scripted
> implementation. Mirrors [`../single-agent/smoke-2-heavy-blueprint-worker`](../single-agent/smoke-2-heavy-blueprint-worker.md)
> at the business level but puts a real second agent on the Worker side.

## 目的

验证两个独立 agent runtime 在 cws-core 同一个 org 下,通过自然语言协作完成
Heavy + Blueprint 流程,且各自端到端的 cross-actor 状态机 / authz / visibility
都正确:

- LEAD 排活、不指定 assignee
- WORKER 自主感知到 claimable task、领取、完成
- assignee_id 在 task / attempt 两层都对齐到 WORKER.member_id
- 后续 step 由 LEAD 自做
- LEAD 走 set_acceptance 闭环

## NL 范式

测试客户端只通过对话发送自然语言:
- 给 LEAD 的指令进 `TEST_CONV_ID`
- 给 WORKER 的指令进 `TEST_WORKER_CONV_ID`

**指令里不直接出现 CLI 命令名**(不写 `task.create` / `task.claim` 这类词)。每个
agent 自己根据描述选工具。runner 通过轮询 `issue.list_in_project` 等接口观察
服务端真实状态,与 agent 自报无关。

## 流程

### Phase 1 — LEAD 排活
NL → LEAD(conv id = `TEST_CONV_ID`):

> 建一个 heavy issue,标题严格写成 "SmokeM2-${TS}",描述 "smoke 2 cross-actor 测试 heavy + worker 协作",priority=medium,你做 Lead。然后给它做一份 3 步的 blueprint:第 1 步「调研竞品定价层级」、第 2 步「整理对比模型」(依赖第 1 步)、第 3 步「输出分析报告」(依赖第 2 步)。蓝图提交评审,然后批准它,把 issue 推到 executing。再为第 1 步生成一个 task,不要指定承接人 — 让别人来认领。
> 全部走完之后用一行把 issueId 告诉我。

### Phase 2 — WORKER 自主领取并完成
NL → WORKER(conv id = `TEST_WORKER_CONV_ID`):

> 看看现在你们 org 里有没有可以认领的 task,有就挑一个领走。领到之后做实际工作:在 KB 里建一篇标题为 "Smoke2 W-${TS} 调研结果" 的页面,正文随便写几句调研结论。然后把这次尝试和任务都标完成。做完报一下 taskId。

`waitForTaskAssignee` 轮 `issue.tasks`,直到出现一个 `assignee_id === WORKER.member_id` 且 `status === 'done'` 的 task。

### Phase 3 — LEAD 收尾 step 2 / 3 + 验收
NL → LEAD:

> 刚才那个 issue 的第 2 步和第 3 步还没做。你自己来 — 各自建任务、自己承接、自己完成。两步都做完之后,把 issue 推到 delivered,然后做最终验收(accepted=true,source=explicit)闭环掉。

`waitForIssue(targetStatus='accepted')`。

## 断言(共 18 条)

跨 Phase 后,以 LEAD JWT 拉 issue / tasks / attempts,以 WORKER JWT 重复
读一次确认 visibility 跨 actor 通:

| # | 断言 | 描述 |
|---|---|---|
| 1 | `issue.title` 包含 `SmokeM2-${TS}` | LEAD 准确执行标题指令 |
| 2 | `issue.mode === 'heavy'` | |
| 3 | `issue.priority === 'medium'` | |
| 4 | `issue.lead_agent_id === TEST_AGENT_ID` | |
| 5 | `issue.current_blueprint_id` 非空 | submit-for-approval 落库 |
| 6 | blueprint 含 3 steps,DAG: s2←s1, s3←s2 | |
| 7 | `issue.statusTrace` 含 `pending_approval` → `approved` → `executing` | |
| 8 | step1 task `assignee_id === WORKER.member_id` | **核心 cross-actor 断言** |
| 9 | step1 task `assignee_id !== TEST_AGENT_ID` | |
| 10 | step1 task 仅有 1 个 attempt,attempt.assignee_id === WORKER.member_id | |
| 11 | step1 task / attempt 都 `done` | |
| 12 | step2/3 task `assignee_id === TEST_AGENT_ID`(LEAD 自做) | |
| 13 | step2/3 task 都 `done` | |
| 14 | issue 最终 `status === 'accepted'` | |
| 15 | issue.statusTrace 走到 `delivered` → `accepted` | |
| 16 | 以 WORKER JWT 拉 step1 attempt,可见,assignee 与 LEAD 视角一致 | 跨 actor visibility |
| 17 | 以 WORKER JWT 拉 step2 attempt,可见(同 org 可见) | |
| 18 | 以 WORKER JWT 列 issue 的 KB pages,能拿到 worker 写的那一页 | KB cross-actor visibility |

任意失败 → exit 1。

## 与 single-agent 版的关系

| 维度 | single-agent smoke-2 | multi-agent smoke-2 (本) |
|---|---|---|
| 触发 | NL 给一个 agent | NL 给两个 agent(分别发) |
| Worker 身份 | 同 agent 自己 claim | 真·独立 runtime,自己 api_key,自己 conv |
| 关键验项 | 状态机 + KB write | 状态机 + KB **+ cross-actor assignee + cross-actor visibility** |
| 用时 | 2-5 分钟(NL ~2 步) | 3-7 分钟(NL ~3 步,2 个 agent 各自处理) |

两套互补;在 single-agent 版基础上严格升级。
