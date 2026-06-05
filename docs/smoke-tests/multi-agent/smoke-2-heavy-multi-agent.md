# Smoke 2 (multi-agent) — Heavy + cross-actor Worker claim

> 直接对照 [`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/coco-workspace/cws-deploy/-/blob/main/docs/smoke-test-design.md) 里的
> **Smoke 2: Heavy 多 Agent 编排**。在 [`../single-agent/smoke-2-heavy-blueprint-worker`](../single-agent/smoke-2-heavy-blueprint-worker.md) 同样的业务路径上,把 Worker 角色从"同一个 agent 模拟"换成"独立的另一个 member,持自己的 JWT 跑全程"。

## 目的

`single-agent/smoke-2` 验证 heavy 工作流的状态机 + KB 集成 OK,但 Worker 角色是同一个 agent 在自我对话,**没法验证 cross-actor 的 assignee 切换 / 可见性 / 权限**。本 smoke 补这条:Worker 不是 Lead,是一个**当场注册的新 org member**(走 register → invite → accept → org-scoped login 拿到独立 JWT)。

## 与 single-agent 版的核心差异

| 维度 | single-agent | multi-agent (本) |
|---|---|---|
| 触发方式 | NL 驱动(test client 发自然语言指令,agent 接) | **直接 API/CLI 驱动**,无 NL |
| Worker 身份 | 同一个 agent,自己 claim 自己 | **当场新建的 org-member,持自己的 JWT** |
| Worker JWT 来源 | 复用 LEAD 的 token | provisionMember 拿独立 token |
| 核心断言 | issue 状态机 + KB 落地 | **cross-actor assignee 切换**:claim 后 task/attempt.assignee = WORKER ≠ LEAD ≠ lead agent |
| 用时 | ~5 分钟(等 agent NL) | ~2 秒(纯 API 直跑) |
| 业务范围 | 全链路(NL + 状态机 + KB write) | **只验状态机 + authz/visibility 跨 actor**(KB write 不在这里测,留给 single-agent 版) |

## 流程(8 个 Phase,38 断言)

### Phase 0 — Provision WORKER

跑 `lib/runner.js::provisionMember()`:

1. `POST /auth/register` — 用 `smoke-worker-<TS>@example.com` 注册,拿 identity JWT
2. LEAD JWT 发起 `POST /api/v1/invitations` (role_id = `org-member`)
3. WORKER 用 identity JWT `POST /api/v1/invitations/{id}/accept` (带 `token` + `display_name`)
4. WORKER 再做 `POST /auth/login` 带 `org_id`,拿**org-scoped JWT**(member_id 真的在 token 里)
5. 断言:`lead.member_id ≠ worker.member_id`

### Phase 1 — LEAD 建 heavy issue
```
POST /api/v1/projects/{pid}/issues
  body: { title, description, mode:"heavy", priority:"medium", lead_agent_id: TEST_AGENT_ID }
```
断言:status=draft, mode=heavy, lead_agent_id=TEST_AGENT_ID(3 条)

### Phase 2 — LEAD 建 3-step blueprint with DAG
```
POST /api/v1/issues/{issue_id}/blueprints
  body: { steps:[{temp_id:"s1",...}, {temp_id:"s2", depends_on_temp_ids:["s1"]}, ...] }
```
断言:steps.length=3, s2 depends_on s1, s3 depends_on s2(3 条)

### Phase 3 — LEAD 走 approval gate(post-MR !118)
```
POST /api/v1/blueprints/{bp_id}/submit-for-approval     # draft → pending_approval, 写 current_blueprint_id
POST /api/v1/issues/{id}/transition  target_status=approved
POST /api/v1/issues/{id}/transition  target_status=executing
```
断言:pending_approval 写入 current_blueprint_id, 最终 status=executing(3 条)

### Phase 4 — LEAD 派发 step1(无 assignee)
```
POST /api/v1/projects/{pid}/issues/{iid}/tasks
  body: { title, blueprint_step_id: s1.id, skill_tags:["research"] }   # no assignee_id
```
断言:task.status=pending, task.assignee_id null(2 条)

### Phase 5 — **WORKER claim**(关键 cross-actor 断言)
```
POST /api/v1/tasks/{task_id}/claim   (Authorization: Bearer <WORKER JWT>)
```
断言(6 条):
- task.status = running
- **task.assignee_id == WORKER.member_id**
- task.assignee_id ≠ LEAD.member_id
- task.assignee_id ≠ lead AGENT.member_id
- 自动创建 attempt
- **attempt.assignee_id == WORKER.member_id**
- attempt.status = running

### Phase 6 — WORKER 完成 step1
```
POST /api/v1/attempts/{att_id}/transition  body:{target_status:"done"}   (WORKER JWT)
POST /api/v1/tasks/{task_id}/transition    body:{target_status:"done"}   (WORKER JWT)
GET  /api/v1/tasks/{task_id}                                              (LEAD JWT)
```
断言:attempt → done, task → done, **LEAD 仍能读到 task 且 assignee 还是 WORKER**(3 条)

### Phase 7 — LEAD 自做 step2 + step3
```
POST .../tasks  body:{..., assignee_id: TEST_AGENT_ID}   → 直接 running(auto-claim)
POST .../attempts/{id}/transition  body:{target_status:"done"}
POST .../tasks/{id}/transition     body:{target_status:"done"}
```
每个 step:status=running 起手,assignee=lead AGENT(不是 LEAD user!),attempt 自动建,然后逐层 done(6 条 × 2 = 12 条,但合成 6 条标号 16.2a/2b/2c + 16.3a/3b/3c)

### Phase 8 — LEAD 交付 + 验收
```
POST /api/v1/issues/{id}/transition   body:{target_status:"delivered"}
POST /api/v1/issues/{id}/acceptance   body:{accepted:true, source:"explicit"}
```
断言:status delivered → accepted, acceptance_source=explicit, current_blueprint_id 持续指向 bp.id(4 条)

## Env

```bash
COCO_API_URL                 https://cws-int.coco.xyz
TEST_USER_TOKEN              LEAD (org-owner) 的 org-scoped JWT
TEST_ORG_ID                  本 org 的 uuid
TEST_PROJECT_ID              本 org 下任一 active project
TEST_AGENT_ID                LEAD agent 在本 org 的 member_id
CF_ACCESS_CLIENT_ID          可选,走 CF Access 时必填
CF_ACCESS_CLIENT_SECRET      可选,同上
```

## 跑

```bash
cd ~/zylos/workspace/zylos-coco-workspace
node docs/smoke-tests/multi-agent/smoke-2-heavy-multi-agent.test.js
```

## 期望耗时

~2 秒(纯 API,没有 agent NL 等待 / 没有 KB 异步刷新)。

## 与设计文档的差异

- 设计文档第 11 条 "KB 写入 + 搜索连通" 在本 smoke **不验**(已由 single-agent 版覆盖完整 KB 字节级 roundtrip)。本 smoke 的 Step 1 在 WORKER 端只走"领→做→done"的状态机,不写 KB。
- 设计文档 Phase 2 写的是 "DRAFT → EXECUTING 直接流转(不走审批)"。MR !118 之后 heavy 路径走 `draft → pending_approval → approved → executing`,经 `blueprint.submit_for_approval`(参考 `single-agent/smoke-2` 同步修订)。本 smoke 走新路径并显式断言 `current_blueprint_id` 在 pending_approval 后被写入。
