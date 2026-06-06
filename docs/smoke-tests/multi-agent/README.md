# Smoke Tests — Multi Agent (NL-driven, user-invisible)

> 多 agent runtime 端到端冒烟测试。两个真 agent 都跑各自的 zylos-coco-workspace runtime,**测试客户端只触发一次 user → LEAD 的自然语言**,之后 LEAD 自主通过跟 WORKER 的 bot↔bot DM 协调完成整个生命周期 — user 全程不感知中间步骤。runner 不查 agent 内部状态,只轮服务端真实状态 + 检查 bot DM 里双向 agent_text 消息证明做断言。

## 范式演进

- **v0(commit 3609544 引入)**:dual-JWT 脚本驱动,无 NL,无 agent runtime — 验 server 跨 actor authz,但验不了 agent 自主行为
- **v1(commit 65b1441,2026-06-06 上午)**:NL 驱动,user 给 LEAD 和 WORKER 各发一条 NL 拍每一步 — agent 能动了,但 user 还在每步插手
- **v2(本目录当前版本)**:**user 只发 1 条 NL**,LEAD 全程自主协调 WORKER(via bot↔bot DM),user 全程不感知 — 才是真正"多 agent 协作"的目标形态

## 跟 single-agent 的关系

- **single-agent 验**:1 agent + NL 决策 + 服务端状态机
- **multi-agent 验**:2 agent + NL 决策(双向) + 服务端跨 actor authz / visibility / assignee 等 cross-actor 语义

两套互补,**不替代**。同一个业务用例(Heavy + Blueprint + Worker)在两边各跑一遍,各看一面。

## 用例清单(共 4)

| 用例 | 主验项 | 文档 | 脚本 |
|---|---|---|---|
| **2** | LEAD 排 heavy + blueprint + executing + 派 step1 (无 assignee);WORKER 自主认领 step1 完成;LEAD 自做 step2/3 + 验收。**核心:cross-actor assignee + 跨 actor KB/attempt visibility**。 | [md](./smoke-2-heavy-multi-agent.md) | [test.js](./smoke-2-heavy-multi-agent.test.js) |
| **3** | rework 循环:LEAD 排 heavy + 1 step;WORKER 交一版简陋稿;LEAD set_acceptance(false);WORKER 开新 attempt 重做;LEAD 接受。**核心:reject 信号 cross-actor 传递 + attempt 序号递增**。 | [md](./smoke-3-cross-actor-rework.md) | [test.js](./smoke-3-cross-actor-rework.test.js) |
| **4** | KB 协作:LEAD 写一篇 page;WORKER 在同一 page 上追加内容(不开新 page);双方 POV 拉 revision 内容一致。**核心:跨 actor KB read/write + revision 归属正确**。 | [md](./smoke-4-kb-collaboration.md) | [test.js](./smoke-4-kb-collaboration.test.js) |
| **5** | AS 文件交付:LEAD 上传 markdown artifact;WORKER 跨 actor 拉、下载、把内容写到 KB page。**核心:AS cross-actor 可见 + sha256 byte 一致 + AS→KB 二次处理流**。 | [md](./smoke-5-as-file-handoff.md) | [test.js](./smoke-5-as-file-handoff.test.js) |

## NL 范式约束

- 所有"指令"都是面向用户的自然语言,**不直接出现 CLI 命令名**(不写 `task.claim` / `kb.page_create` 这种)
- 每个 agent 根据描述选合适的工具实现行为
- runner 通过服务端接口轮询观察状态,与 agent 自报的话无关 —— agent 喊"做完了"不算数,服务端状态机说 done 才算数

## 公共 lib

[`lib/runner.js`](./lib/runner.js) 提供:

| 导出 | 用途 |
|---|---|
| `loadEnv()` | 校验 + 加载必需 env(包含 lead + worker 两套) |
| `sendInstruction(env, text, {to: 'lead' \| 'worker'})` | 把 NL 发到指定 actor 的对话 |
| `tm(cmd, params, {actor: 'lead' \| 'worker'})` | shell out 到 tm.js,JWT 按 actor 切换 |
| `listIssuesInProject / listTasks / listAttempts(..., {actor})` | tm 包装 + envelope 拆 |
| `waitForIssue(env, predicate, {actor, targetStatus, ...})` | 轮 issue 状态直到 predicate / targetStatus |
| `waitForTaskAssignee(env, issueId, taskPredicate, {actor, ...})` | 轮 task assignee 变化(跨 actor 接活场景) |
| `getWorkerJwt(env)` | 用 worker api_key 换 org-scoped JWT(带 60s 缓存) |
| `assertEq / assertTrue / assertNot / assertIn / assertNullish / log / ok / warn / die / summary` | 标准断言 + 日志 |

## Env

```bash
# 共享
export COCO_API_URL=https://cws-int.coco.xyz
export TEST_USER_TOKEN=<owner JWT,用来代表用户向两个 conv 发消息>
export TEST_ORG_ID=<目标 org uuid>
export TEST_PROJECT_ID=<smoke 跑在哪个 project>

# Lead agent (本机 zylos-coco-workspace runtime)
export TEST_CONV_ID=<lead 与 user 的 DM conv id>
export TEST_AGENT_ID=<lead agent member_id>

# Worker agent (另一台服务器上的 zylos-coco-workspace runtime)
export TEST_WORKER_CONV_ID=<worker 与 user 的 DM conv id (仅历史保留,v2 已不再用)>
export TEST_WORKER_API_KEY=<worker cwsk_... — runner 用它换 JWT,member_id 从 JWT claims 取>

# Bot-to-bot DM (LEAD ↔ WORKER) — v2 单 NL 模式核心通道
# 通过 `comm.create_dm {peerMemberId: <worker.member_id>}` 创建
export TEST_LEAD_WORKER_CONV_ID=<LEAD ↔ WORKER 的 DM conv id>

# 可选(CF Access 网关)
export CF_ACCESS_CLIENT_ID=...
export CF_ACCESS_CLIENT_SECRET=...
```

## 跑

```bash
cd ~/zylos/workspace/zylos-coco-workspace
node docs/smoke-tests/multi-agent/smoke-2-heavy-multi-agent.test.js
node docs/smoke-tests/multi-agent/smoke-3-cross-actor-rework.test.js
node docs/smoke-tests/multi-agent/smoke-4-kb-collaboration.test.js
node docs/smoke-tests/multi-agent/smoke-5-as-file-handoff.test.js
```

NL 单 case 跑时长 3-7 分钟(双 agent NL 各处理一次或多次)。

## 设计来源

[`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/coco-workspace/cws-deploy/-/blob/main/docs/smoke-test-design.md) § **Smoke 2: Heavy 多 Agent 编排** 是 case 2 的源,case 3-5 在本 PR 中扩。

## 未覆盖(下一批可选)

- 群会话三方协作(LEAD + WORKER + user 在同一 group conv 里 @mention)
- 权限边界拒绝(WORKER 被要求做只有 org-owner 能干的事,应礼貌拒绝)
- 跨 agent reassign(WORKER 把 task 抛回 LEAD)
- 并发独立工作(LEAD + WORKER 并行做无关 issue,token / state 不串)

如需添加,在新建 `smoke-6 / smoke-7 ...` 时复用本目录 runner.js 即可。
