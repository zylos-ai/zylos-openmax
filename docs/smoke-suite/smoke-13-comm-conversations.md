# Smoke 13 — Comm 会话生命周期(NL 驱动)

> **验证目标**:用户用自然语言让 agent 拉第二个同事开群聊、发消息、
> 拉单条历史、查未读数。日常工作场景。
>
> 覆盖 **comm.js**:
>   `comm.create_dm`、`comm.create_group`、`comm.get_conversation`、
>   `comm.send`、`comm.get_messages`、`comm.get_message`、`comm.unread`

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

### Round 2 — 查未读 + 拉单条

```
群里两条消息我已经看过了,帮我:
1. 用 comm.unread 查一下这个群当前未读多少条
2. 用 comm.get_message 把最后那条消息单独拉出来,确认能定位到

最后给我个简报:unread 数 + 单条拉取的 message_id。
```

---

## 3. 断言表(6)

### 卡片体(4)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 120s 内到,含 group id + ≥ 2 个消息 id |
| 2 | 1 | round1 包含群聊标题 `Smoke13-<TS> 项目同步` |
| 3 | 2 | round2 在 90s 内到,提到 "unread" / 未读 |
| 4 | 2 | round2 提到单条消息 id |

### 旁路(2)

| # | 阶段 | 断言 |
|---|---|---|
| 5 | round2 | `comm.unread(group)` 返回数值 |
| 6 | round2 | `comm.get_message(group, lastMsgId)` 拉到对应单条 |

---

## 4. 跑法

```bash
node docs/smoke-tests/single-agent/smoke-13-comm-conversations.test.js
```

预期 3-5 分钟(含 USER2 self-provision)。

---

## 5. 历史变更

v0.5 之前这个 smoke 还覆盖 `comm.delete_message` 和 `comm.mark_read` 两条,后来:

- `comm.delete_message` cws-core 没注册对应 DELETE 路由(实地 probe HTTP 405),实际不可用 → CLI + doc 都删了。
- `comm.mark_read` 同批从 doc 和 CLI 里移除,简化已读语义(WS 推送已经能完成读位点同步)。
- `comm.edit_message` / `pin` / `unpin` / `typing` cws-comm 有但 cws-core BFF 不代理,doc 里删掉避免误导。
