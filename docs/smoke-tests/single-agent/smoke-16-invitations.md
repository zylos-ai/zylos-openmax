# Smoke 16 — Invitations(NL 驱动)

> **验证目标**:用户用自然语言让 agent 邀请一个新同事入 org,然后再发
> 一条邀请又改主意撤回。覆盖 invitation 4 条命令的真实用户场景。
>
> 覆盖 **core.js**:`core.invitation_create`、`core.invitation_list`、
>   `core.invitation_accept`、`core.invitation_revoke`
>
> cws-core `/invitations/{id}/accept` 当前 schema 要求 body 含
> `{token, display_name}`(2026-06-04 实测,纯 invitation_id 路径
> 422 / 401)。test client 从 agent round1 回复里抓 token + id 用于旁路 accept。

---

## 1. 前置:provision USER3 identity-only

test client 先 register `gavin-test-004-<TS>@example.com`(每次跑 TS 不同,
保证全新身份;若已存在则 409/422 也 OK),identity-only login 拿 user3
token,这部分**不**在 NL 里。然后 NL 让 agent 发邀请,test client 用
user3 token 调 accept 完成入组。

> **为什么 timestamp**:cws-core 当前 `/invitations/{id}/accept` 在用户
> 已是 active member 时返 500(PG 唯一索引 `idx_members_org_identity_active`
> 直接打穿);应当 409/422 返语义错误。固定邮件第二次跑就 500,所以
> 每次用全新 email 隔离。bug 单独追踪。

---

## 2. NL 文本

### Round 1 — 发邀请

```
我想邀请一个新同事 gavin-test-004-<TS>@example.com 加入我们 org 当 org-member,
帮我发一条邀请,附言写 "${NS} 入组测试"。

发完报 invitation id 和 token(两行,格式
`invitation_id: <uuid>` 和 `token: <string>`)。
```

(`<TS>` 是 Date.now() ms,test client 每次跑随 NS 一起变。)

### Round 2 — 错发邀请 + 撤回

```
顺便测一下撤回流程:再发一条邀请到一个写错的邮箱
"smoke16-revoked-<TS>@example.com",同样 org-member 角色。
发完之后我立马反悔,把这条撤回(invitation_revoke)。

撤回完拉一下 invitation_list,告诉我刚才那条的状态变成什么了。
```

---

## 3. 断言表(8)

### 卡片体(4)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 90s 内到,含 invitation id(uuid) |
| 2 | 1 | 含 "邀请已发" / "已邀请" / "created" 语义 |
| 3 | 2 | round2 在 90s 内到,含 "撤回" / "revoke" + 状态名 |
| 4 | 2 | round2 含 "revoked" / "cancelled" / "expired" 任一 |

### 旁路(4)

| # | 阶段 | 断言 |
|---|---|---|
| 5 | round1 | invitation_list 含 USER3 邀请,status='pending' |
| 6 | round1 | test client 用 USER3 token POST /invitations/{id}/accept 返 2xx |
| 7 | round1 | core.member_list 现在含 USER3(identity match) |
| 8 | round2 | invitation_list 里那条 revoked invitation status ∈ {revoked, cancelled, expired} |

---

## 4. 跑法

预期 3-5 分钟(含 USER3 provision)。
