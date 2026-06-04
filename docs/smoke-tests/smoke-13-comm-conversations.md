# Smoke 13 — Comm 会话生命周期(纯脚本驱动)

> **验证目标**:把 comm.js 里**用户向(非 sync/search)**的命令全覆盖一遍——
> 建 DM / 建 group / 发消息 / 读消息 / 删消息 / 已读未读。**会自动 provision
> 第二个测试用户**(`gavin-test-003@example.com` / `TestPass123!`),无需
> 外部准备(如果已存在,login 路径走通即可)。
>
> 覆盖 **comm.js**:
>   `comm.create_dm`、`comm.create_group`、`comm.get_conversation`、
>   `comm.send`、`comm.get_messages`、`comm.get_message`、
>   `comm.delete_message`、`comm.mark_read`、`comm.unread`
>
> 不覆盖:`comm.sync` / `comm.search` → Smoke 14。

---

## 1. 架构

```
TEST CLIENT (smoke-13-comm-conversations.test.js)
    │
    ├─ Phase 0: 确保 USER2 (gavin-test-003) 存在
    │            - try /auth/register(失败 = 已存在,OK)
    │            - login 拿 user2 access_token + member_id
    ├─ Phase 1: USER1 调 comm.create_dm(participantId = USER2.member_id)
    │            → DM 会话 D
    ├─ Phase 2: USER1 调 comm.create_group(title, memberIds=[USER1.member_id, USER2.member_id])
    │            → group 会话 G
    ├─ Phase 3: USER1 调 comm.send 在 D / G 各发 2 条消息
    ├─ Phase 4: USER1 调 comm.get_messages(D) / get_messages(G) 拉历史
    │            + comm.get_message 取单条 + comm.get_conversation 取元数据
    ├─ Phase 5: USER1 调 comm.mark_read + comm.unread
    └─ Phase 6: USER1 调 comm.delete_message 删一条 → get_messages 不再含
```

---

## 2. 前置 / Env

| 资源 | 备注 |
|---|---|
| `TEST_USER_TOKEN` | USER1(org-owner)org-scoped JWT |
| `TEST_AGENT_ID` | 不强必需,但记下来便于复用 fixture |
| 新自动 provision | USER2:`gavin-test-003@example.com` / `TestPass123!` |

---

## 3. 流程

### Phase 0 — provision USER2

```js
// 1) try register
POST /auth/register
  {email:'gavin-test-003@example.com', password:'TestPass123!', display_name:'GavinTest003'}
// 200 = 新建;409/422 = 已存在

// 2) login(必须传 org_id 拿 org-scoped token)
POST /auth/login
  {email, password, token_delivery:'body', org_id:<同 USER1 的 org_id>}
// → user2_token, user2_member_id

// 注意:如果 USER2 是新 register 但不在同一个 org,需要 invitation 加入。
// 本 smoke 假设 USER1 是 org-owner,可以通过 invitation_create 直接邀请;
// 但为减少跨 smoke 依赖,简化方案:
//   - 如果 login 返 user2 没有 org_id claim → 调 invitation_create + 直接 accept
//   - 如果 login 返 user2 有 org_id 且 == USER1 org_id → 跳过 invitation 路径
```

### Phase 1 — DM

```js
const dm = comm.create_dm { participantId: USER2.member_id }
// dm.id 是 conversation uuid
```

### Phase 2 — group

```js
const group = comm.create_group {
  title:    `Smoke13-<TS> group`,
  memberIds: [USER1.member_id, USER2.member_id],
}
```

### Phase 3 — send 各 2 条

```js
for (const conv of [dm, group]) {
  for (let i=1; i<=2; i++) {
    comm.send { conversationId: conv.id, content: `Smoke13-<TS> msg ${i} in ${conv.type||'?'}` }
  }
}
```

### Phase 4 — 读

```js
const msgsD = comm.get_messages { conversationId: dm.id,    limit: 20 }
const msgsG = comm.get_messages { conversationId: group.id, limit: 20 }

const first = msgsD[0]   // or last,看 sort
const single = comm.get_message { conversationId: dm.id, messageId: first.id }

const dmMeta = comm.get_conversation { conversationId: dm.id }
```

### Phase 5 — read receipts

```js
comm.mark_read { conversationId: dm.id, seq: maxSeqInD }
const u = comm.unread { conversationId: dm.id }
// u.count === 0
```

### Phase 6 — delete

```js
const targetMsg = msgsG[0]   // 删 group 第一条
comm.delete_message { conversationId: group.id, messageId: targetMsg.id }
const msgsG2 = comm.get_messages { conversationId: group.id, limit: 20 }
// assert: msgsG2 不含 targetMsg.id(可能 status='deleted' 而非真删,见下)
```

---

## 4. 断言表(14)

| # | Phase | 断言 |
|---|---|---|
| 1 | 0 | USER2 register 200 或 409/422(已存在) |
| 2 | 0 | USER2 login 拿到 org-scoped token + member_id |
| 3 | 1 | create_dm 返 conversation id (uuid) |
| 4 | 2 | create_group 返 id + 含 USER1 + USER2 |
| 5 | 3 | 4 条 send 全部 2xx |
| 6 | 4 | get_messages(D) 返 ≥ 2 条 |
| 7 | 4 | get_messages(G) 返 ≥ 2 条 |
| 8 | 4 | get_message 返单条且 id 对得上 |
| 9 | 4 | get_conversation 返 dm 元数据(type=DM, member_count=2) |
| 10 | 5 | mark_read 返 2xx |
| 11 | 5 | unread.count == 0 |
| 12 | 6 | delete_message 返 2xx |
| 13 | 6 | get_messages(G) 不再含 deleted msg id(或 status=='deleted') |
| 14 | 6 | get_message(deleted) 返 4xx 或 200+status=deleted |

---

## 5. 已知/留观

- USER2 在同一 org 的前提是 smoke 自己保证:如果走 invitation 路径,会顺带覆盖 Smoke 16 的一部分,本 smoke 不强依赖 16
- 如果 cws-comm DM 自动同向去重(同两人之间只有 1 个 DM),create_dm 第二次会返已有 dm.id,本 smoke 接受

---

## 6. 跑法

```bash
node docs/smoke-tests/smoke-13-comm-conversations.test.js
```

预期 6-12 秒。
