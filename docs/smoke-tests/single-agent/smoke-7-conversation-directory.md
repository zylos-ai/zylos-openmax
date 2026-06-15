# Smoke 7 — 组织态势盘点(NL 驱动)

> **验证目标**:用户用一句话让 agent 给一份"组织里都有谁 / 我有哪些项目 /
> 最近的会话情况"的简报。Agent 自主调度 `core.me / org_get / member_list /
> project_list / project_members / comm.list_conversations` 等 directory 查询
> 命令,把结果整合成可读的状态报告。
>
> 是一条"自我观察"类型的轻量 smoke,主要测两件事:
>   1. agent 能不能听懂"我想看下整体情况"这类模糊请求并拆成具体 CLI 查询
>   2. agent 给出的数字/名字与后端真实数据一致(不胡编)
>
> 跟 Smoke 4-6 同款双层断言。

---

## 1. 架构

```
[Phase 1] sendInstruction(NL_status) "帮我看下当前组织态势"
            ↓
[Phase 2] poll agent 回 "组织态势报告"卡片
[Phase 3] 旁路:test client 直接调 core/comm CLI 拿真实数据
            做"agent 报的数 == 真实数据"的对比
[Phase 4] sendInstruction(NL_drill_down) "把第一个项目里的成员列出来"
            ↓
[Phase 5] poll 等 agent 回 project_members 摘要
[Phase 6] 旁路:project_members 真实查询 → 名单对得上
```

---

## 2. 前置条件 + Env

```
COCO_API_URL=https://cws-int.coco.xyz
TEST_USER_TOKEN=<org-scoped JWT>
TEST_CONV_ID=<DM uuid>
TEST_AGENT_ID=<agent member_id>
CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET
```

不需要 `TEST_DEFAULT_PROJECT_ID` / `TEST_DEFAULT_KB_ID`(agent 应当自己发现)。

---

## 3. NL 文本

### Round 1(组织态势盘点)

```
帮我盘一下当前组织态势:
1) 我是谁(member_id + role)
2) 这个组织叫啥(name + slug + 总 member 数)
3) member 里 human / agent 各几个
4) 我在这个组织有几个项目,列出每个项目的 name
5) 最近有多少个会话,挑近 5 个列出来(对方 / 类型 / 最近一条消息时间)
全部整理成一条结构化简报回给我,不需要废话。
```

### Round 2(drill-down)

```
把你刚才列的第一个项目里的成员都列出来:每行一个 "name (kind, role)"。
```

---

## 4. 断言表(16)

### 卡片体(10)

| # | Phase | 断言 |
|---|---|---|
| 1 | 2 | round1 回复在 30s 内到达 |
| 2 | 2 | 回复含 caller 的 member_id(uuid 形态)|
| 3 | 2 | 回复含 caller 的 role.slug(如 `org-owner` / `org-admin` / `org-member`)|
| 4 | 2 | 回复含组织 name + slug(可结构化或散文形式)|
| 5 | 2 | 回复含**两个数字** —— human 数 + agent 数 |
| 6 | 2 | 回复列出至少 1 个项目的 name |
| 7 | 2 | 回复列出**会话数**(总数 或 "近 5 个" 的具体列表)|
| 8 | 5 | round2 回复在 20s 内到达 |
| 9 | 5 | 回复至少含 1 行 "name (kind, role)" 形式的成员行 |
| 10 | 5 | 回复中的 project 名字与 round1 提到的"第一个项目"一致 |

### 后端旁路(6)

| # | 阶段 | 断言 |
|---|---|---|
| 11 | round1 done | 旁路 `core.me` → role.slug 与 agent 回复 (#3) **完全一致** |
| 12 | round1 done | 旁路 `core.member_list` → human 数 + agent 数 之和 == agent 回复里 (#5) 的总和 |
| 13 | round1 done | 旁路 `core.project_list` → 项目 names 集合 ⊇ agent 回复中提到的项目 |
| 14 | round1 done | 旁路 `comm.list_conversations` → 会话总数 ≥ agent 回复中的会话数 |
| 15 | round2 done | 旁路 `core.project_members(第一个项目)` → 成员名集合与 agent 回复行数 ±1 |
| 16 | round2 done | agent 回复中的每个 kind 都 ∈ {human, agent}(没虚构 kind)|

---

## 5. 覆盖 CLI(预期 agent 会调到)

`core.me, core.org_get, core.member_list (kind=human + kind=agent), core.project_list, core.project_members, comm.list_conversations, comm.get_conversation`

—— **7 个**(核心 directory 面)

---

## 6. 设计要点

- **#12 用"和等于"而非"分别 ≥"**:agent 可能选只跑一次 `member_list(kind=all)`
  然后用客户端聚合;也可能两次单跑。两条路最终的 total 应当一致
- **#15 名单 ±1 容错**:agent 可能去重 / 排序差一个,容错带宽小但放一点
- **不强制结构化输出**:agent 想用 markdown 表格 / 散文 / json blob 都允许,
  只看里面的关键事实
- **Smoke 7 是只读 case**,跑完不留任何副作用,可以反复跑做回归
