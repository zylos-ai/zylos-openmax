# Smoke 13 — Comm 会话生命周期(NL 驱动)

> **验证目标**:用户用自然语言让 agent 拉第二个同事开群聊、发消息、
> 标已读、删一条不合适的。这是日常工作场景。
>
> 覆盖 **comm.js**:
>   `comm.create_dm`、`comm.create_group`、`comm.get_conversation`、
>   `comm.send`、`comm.get_messages`、`comm.get_message`、
>   `comm.delete_message`、`comm.mark_read`、`comm.unread`

---

## 1. test client 前置:provision USER2

**这部分不在 NL 里**,由 test client 自己 register + login + invitation
+ accept 把 `gavin-test-003@example.com` 拉进 org,然后把它的 member_id
作为参数注入到 NL 文本里。

---

## 2. NL 文本

### Round 1 — 拉 USER2 开 group + 发几条

```
我想跟同事 GavinTest003(member_id <USER2_MEMBER_ID>)对一下 Smoke13-<TS> 项目情况,你帮我:
1. 拉一个新群聊,标题 "Smoke13-<TS> 项目同步",成员就我俩
2. 在群里发两条:
   - 第一条 "${NS} 项目同步会准备开始"
   - 第二条 "${NS} 议题:KB / agent / token 三件事"

发完报群 id 和发出去的两条消息 id。
```

### Round 2 — 标已读 + 拉历史 + 删一条

```
现在群里那两条消息我已经看完了,帮我:
1. 全部标已读(mark_read 到最新 seq)
2. unread 查一下确认未读 == 0
3. 第一条消息("会准备开始"那条)写得不专业,直接删掉
4. 重新拉一下消息列表,确认那条不在了

最后给我个简报:删之前有几条、删之后有几条、unread 数。
```

---

## 3. 断言表(10)

### 卡片体(5)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 120s 内到,含 group id + ≥ 2 个消息 id |
| 2 | 1 | round1 包含群聊标题 `Smoke13-<TS> 项目同步` |
| 3 | 2 | round2 在 90s 内到,含 "已读" + "删" |
| 4 | 2 | round2 简报里说"删之前 ≥ 2 条 → 删之后 ≥ 1 条" |
| 5 | 2 | round2 说 "unread == 0" |

### 旁路(5)

| # | 阶段 | 断言 |
|---|---|---|
| 6 | round1 | comm.list_conversations 含新 group(title 含 `Smoke13-<TS>`) |
| 7 | round1 | comm.get_messages(group) ≥ 2 |
| 8 | round2 | comm.unread(group).count == 0 |
| 9 | round2 | comm.get_messages 后某一条 status 含 deleted 或列表数变少 |
| 10 | round2 | get_message(deletedId) 抛 4xx 或返 deleted 标记 |

---

## 4. 跑法

```bash
node docs/smoke-tests/smoke-13-comm-conversations.test.js
```

预期 3-5 分钟(含 USER2 self-provision)。
