# Smoke 8 — TM 元数据 + 边缘转移(NL 驱动)

> **验证目标**:用户用自然语言让 agent 完成"调整项目和 issue 元数据 + 跨项目迁移"。
> 验证 agent 自主选择 `project.update / issue.update / issue.move_project /
> project.archive / project.members / task.reassign`
> 这些**修改型 / 容器迁移型** CLI 命令完成任务。
>
> 双层断言:卡片体短语(agent 自然语言报告)+ 后端旁路状态(test client
> 直接调 tm CLI 验证终态)。
>
> 覆盖 **tm.js**:
>   `project.update`、`project.archive`、
>   `project.members`、`issue.update`、`issue.move_project`、
>   `task.reassign`、`blueprint.list`、`task.list`、`task.get`、
>   `attempt.list`、`attempt.get`
>
> 跟 Smoke 1/2/3 的区别:1/2/3 是 issue/task 主链路;**8 是元数据 + 迁移
> + 归档闭环这一组边缘**,平时用户会喊"帮我把这个挪到别的项目"或者
> "项目用完归档掉吧"。

---

## 1. 架构

```
[Round 1] NL: "建临时项目 + issue + task"     → agent 建好 project B + issue I + task T
[Round 2] NL: "改 issue 元数据 + 跨项目挪"    → priority/desc 改 + I 挪到 B
[Round 3] NL: "改主项目描述 + 看人 + 归档项目"  → project.update A / project.members A /
                                                 project.archive B
```

3 轮 NL,每轮卡片体 ≥ 1 个关键短语 + 旁路 ≥ 2 个硬断言。

---

## 2. 前置 / Env

跟 Smoke 5/6 一致:`TEST_USER_TOKEN` / `TEST_CONV_ID` / `TEST_AGENT_ID` /
`TEST_PROJECT_ID` / CF Access。

---

## 3. NL 文本

### Round 1 — 建临时项目 + issue + task

```
我准备做个 Smoke8-<TS> 的小实验,你帮我:
1. 新建一个项目叫 "Smoke8-<TS>/move-target",描述写"挪过来的临时实验"
2. 在我们 Smoke Suite 项目里建一个 light issue,标题就叫 "Smoke8-<TS> 实验任务",
   优先级 low,你做 lead,描述写"先放着,后面要挪走"
3. 在那个 issue 下建一个 task 直接分配给你自己

建完用一行报给我 project id、issue id、task id。
```

### Round 2 — 改 issue 元数据 + 跨项目挪

```
那个 Smoke8-<TS> 实验任务,情况变了:
- 优先级提到 high
- 描述改成 "紧急,优先级临时拉高"
- 整个挪到刚才那个 "Smoke8-<TS>/move-target" 项目下面

挪完跟我确认下 issue 现在所属项目。
```

### Round 3 — 改主项目元数据 + 看人 + 归档项目

```
顺手再做几件:
1. 我们 Smoke Suite 这个项目的描述改成 "Smoke8-<TS> metadata edges round"
2. 列一下 Smoke Suite 这个项目里现在都有哪些 member(顺带说一下你是不是 lead)
3. "Smoke8-<TS>/move-target" 这个项目实验差不多了,先归档掉

每一步一行简短日志。
```

---

## 4. 断言表(14)

### 卡片体(7)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 回复在 120s 内到达,含 project id(uuid)+ issue id + task id |
| 2 | 1 | 回复表达"项目已建 / issue 已建 / task 已建"语义 |
| 3 | 2 | round2 回复在 90s 内到达,含"优先级 high"+"挪到"或"已迁移"语义 |
| 4 | 2 | 回复明确包含目标项目名 `Smoke8-<TS>/move-target` |
| 5 | 3 | round3 回复在 120s 内到达,含 member 列表语义 + "归档" |
| 6 | 3 | 回复表达 Smoke Suite 主项目描述已改 |
| 7 | 3 | 回复表达 "Smoke8-<TS>/move-target" 当前状态已归档 |

### 后端旁路(7)

| # | 阶段 | 断言 |
|---|---|---|
| 8 | round1 done | project B 存在,name 含 `Smoke8-<TS>/move-target` |
| 9 | round1 done | issue I 存在,projectId == TEST_PROJECT_ID (A),title 含 `Smoke8-<TS>` |
| 10 | round2 done | issue I `priority == high` 且 description 含"紧急" |
| 11 | round2 done | issue I `projectId == B.id`(已迁移) |
| 12 | round3 done | project A `description` 含 "metadata edges" |
| 13 | round3 done | project B 当前 status == archived |
| 14 | round3 done | project.members(A) 调通(返 list 或空集,后者 warn-only) |

---

## 5. 已知/相关 bug 留观

- **cws-work #32**:assertion 14 大概率拿到空集(已知 P1)。本 smoke warn-only,
  作为 #32 的 NL-driven 回归监测点。
- agent 可能选择不同 CLI 链路达到同样目标(比如改名 vs 直接 update 等),
  断言**只看终态**,不审计 CLI 调用顺序。

---

## 6. 跑法

```bash
node docs/smoke-tests/smoke-8-tm-metadata-edges.test.js
```

预期 3-6 分钟(3 轮 NL × 1-2 min agent 响应)。
