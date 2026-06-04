# Smoke 8 — TM 元数据 + 边缘转移(纯脚本驱动)

> **验证目标**:把 tm.js 在 Smoke 1-3 之外**还没覆盖的元数据 / 边缘命令**
> 一次性扫一遍。**不走 NL,不依赖 agent 自主决策**;由 test client 直接
> 调 tm.js,验证 CRUD 修改型 API + 跨容器迁移 + 归档/恢复闭环。
>
> 覆盖 **tm.js**:
>   `project.update`、`project.archive`、`project.restore`、
>   `project.members`、`issue.update`、`issue.move_project`、
>   `task.reassign`、`blueprint.list`、`attempt.list`、`attempt.get`、
>   `task.list`(全 filter:`claimable + agentSkills`)、`task.get`
>
> Smoke 8 是 **happy path edge** —— 不刻意触发 4xx,但每个修改后都做
> 一次旁路读校验确认变更生效;每条命令的 200 + 字段对得上同时算 PASS。

---

## 1. 架构

```
TEST CLIENT (smoke-8-tm-metadata-edges.test.js)
    │
    ├─ Phase 1: 建场景    project.create(B) + issue.create(@A) + task.create
    ├─ Phase 2: 改元数据  project.update(A) + issue.update(I) + task.reassign(T)
    ├─ Phase 3: 跨容器    issue.move_project(I, A→B)
    ├─ Phase 4: 读校验    project.members / blueprint.list / task.list(filter) /
    │                     attempt.list/get / task.get / project.get
    ├─ Phase 5: 归档闭环  project.archive(B) → project.list(status=archived) →
    │                     project.restore(B) → project.list(status=active)
    └─ Phase 6: 收尾       不主动清理 issue,留作 DB 验证留痕
```

不需要 agent runtime,不需要 cws-comm WS。**Smoke 0 + Smoke 8 都属于
"纯 CLI 表面"**;Smoke 1-7 才是"NL 驱动 + agent autonomy"。

---

## 2. 前置条件

- `TEST_USER_TOKEN`:org-scoped JWT(user 身份足以操作 project / issue)
- `TEST_AGENT_ID`:作为 lead_member 的 agent member id(issue.leadAgentId 用它)
- 不需要 `TEST_CONV_ID` —— Smoke 8 不走会话
- 不需要 `TEST_DEFAULT_KB_ID` —— Smoke 8 不碰 KB

### Env

```
COCO_API_URL
TEST_USER_TOKEN
TEST_AGENT_ID
TEST_PROJECT_ID                       # 复用持久 Smoke Suite project 作为 project A
CF_ACCESS_CLIENT_ID/SECRET           # 走 CF Access 时必填
```

---

## 3. 流程(以 `Smoke8-<TS>` 作为命名空间)

### Phase 1 — 建场景

1. `project.create` 建 project **B**,name `Smoke8-<TS>/move-target`,slug 同名(去斜杠 / 转下划线)、leadMemberId 用 `TEST_AGENT_ID`。**A** = `TEST_PROJECT_ID`。
2. `issue.create` 在 A 上建 issue **I**:title `Smoke8-<TS> issue`、mode `light`、priority `low`、leadAgentId `TEST_AGENT_ID`、description `Smoke8 metadata edges`。
3. `task.create` 在 I 上建 task **T**:title `Smoke8-<TS> task`、assigneeId `TEST_AGENT_ID`(让它直接 running 落自动 claim)、issueId I、projectId A。

### Phase 2 — 改元数据

4. `project.update` 对 A:`description=Smoke8-<TS> metadata edges`(不动 name)。
5. `issue.update` 对 I:`priority=high`、`description=Smoke8-<TS> updated desc`。
6. `task.reassign` 对 T:`newAssigneeId=TEST_AGENT_ID`(self-reassign,触发路径但不改 owner)。**先记一下**:如果你想测真的换 owner,把 second agent member 给我,我加一步。

### Phase 3 — 跨容器迁移

7. `issue.move_project` 把 I 从 A 挪到 B。

### Phase 4 — 读校验

8. `project.get` 读 A:`description` 含 `Smoke8-<TS> metadata edges`。
9. `project.get` 读 B:存在 + 名字含 `Smoke8-<TS>/move-target`。
10. `project.members` 读 A:返 list(暴露 cws-work #32 的话,这里可能是空集 —— 已知 bug,本 Smoke **不**作为 P0 失败,而是**warn-only** + 记到结果里)。
11. `issue.get` 读 I:`projectId == B.id`、`priority == high`、`description` 含 `updated desc`。
12. `task.get` 读 T:`assigneeId == TEST_AGENT_ID`、`status` 在 {`pending`,`running`,`assigned`} 内(光看 reassign 是否触发状态机,不强约束)。
13. `task.list` 在 I 上 + filter `claimable=false`(I 上已分配 task)+ filter `agentSkills=[]`:返回数组含 T 的 id。
14. `blueprint.list` 在 I 上:I 是 light issue 没有 blueprint,期待返回**空数组**(`{data: [], total: 0}`)。
15. `attempt.list` 在 T 上:T 直接 running 模式自动起的 attempt 应至少 1 条;空集也接受(暴露 cws-work 的话标记 warn)。如果有 ≥ 1,从中取第一个 `attempt.get` 一次,校验 `taskId == T.id`。

### Phase 5 — 归档闭环

16. `project.archive` 对 B:返 200。
17. `project.list` 加 `status=archived`:B 出现在列表里。
18. `project.restore` 对 B:返 200。
19. `project.list` 加 `status=active`:B 出现在列表里;`status=archived` 列表里**不**再有 B。

### Phase 6 — 收尾

不主动清理 I / T / B。留作 DB 验证留痕(可手动 `project.archive` 收尾)。

---

## 4. 断言表(18)

| # | Phase | 断言 |
|---|---|---|
| 1 | 1 | project.create 返 id(uuid),name 含 `Smoke8-<TS>/move-target` |
| 2 | 1 | issue.create 返 id,projectId == A,title 含 `Smoke8-<TS>` |
| 3 | 1 | task.create 返 id,issueId == I,assigneeId == TEST_AGENT_ID |
| 4 | 2 | project.update 后 `project.get(A).description` 含 `metadata edges` |
| 5 | 2 | issue.update 后 `issue.get(I).priority == high` |
| 6 | 2 | issue.update 后 `issue.get(I).description` 含 `updated desc` |
| 7 | 2 | task.reassign 返 2xx(不抛) |
| 8 | 3 | issue.move_project 返 2xx,`issue.get(I).projectId == B.id` |
| 9 | 4 | project.get(B) 返 2xx + name 对得上 |
| 10 | 4 | project.members(A) 返 2xx(**warn-only** if data 为空,**fail** if 4xx/5xx) |
| 11 | 4 | task.get(T) 返 2xx + assigneeId 对得上 |
| 12 | 4 | task.list(issueId=I) 返列表,含 T.id;filter 字段 200 不抛 |
| 13 | 4 | blueprint.list(I) 返 2xx + `data: []`(light issue) |
| 14 | 4 | attempt.list(T) 返 2xx,**warn-only** if 空集 |
| 15 | 4 | 若 attempt.list 非空,attempt.get(first) 返 2xx + taskId == T.id |
| 16 | 5 | project.archive(B) 返 2xx |
| 17 | 5 | project.list(status=archived) 含 B.id |
| 18 | 5 | project.restore(B) 之后 project.list(status=active) 含 B.id 且 (status=archived) 不含 |

---

## 5. 已知/相关 bug

- **cws-work #32**:CreateProject 不 seed project_members for lead → assertion 10 大概率空集。本 Smoke 跑出来 warn 不 fail,作为 #32 的活体回归监测点。
- 若 `attempt.list` 空集,可作 cws-work 状态机另一处隐性 bug 的指针(同样 warn-only)。
- assertion 7 是 `task.reassign self-self`,可能踩到之前 Smoke 2 观测到的 `code: internal`。如果踩了就直接 fail,留 request_id。

---

## 6. 跑法

```bash
cd ~/zylos/workspace/zylos-coco-workspace
export COCO_API_URL=https://cws-int.coco.xyz
export TEST_USER_TOKEN=<...>
export TEST_AGENT_ID=<...>
export TEST_PROJECT_ID=<...>
export CF_ACCESS_CLIENT_ID=<...>
export CF_ACCESS_CLIENT_SECRET=<...>

node docs/smoke-tests/smoke-8-tm-metadata-edges.test.js
```

预期 4-8 秒内跑完(纯 REST 串行,无 agent / WS 链路开销)。

---

## 7. 设计要点

- **不走 NL**:这条用例的价值在于"修改型 + 边缘"命令,跟 agent autonomy 无关。
- **复用 TEST_PROJECT_ID**:不浪费一次性 project,A 用持久的;B 用一次性 archive 收尾。
- **不动 KB / AS / comm**:Smoke 10-14 各自负责。
- **失败留痕**:任何 assertion 失败都 dump `request_id` + 当时的 entity dump,便于和 cws-core / cws-work pod 日志关联。
