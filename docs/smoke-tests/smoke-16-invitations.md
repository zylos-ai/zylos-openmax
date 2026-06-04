# Smoke 16 — Invitations 邀请链(纯脚本驱动)

> **验证目标**:覆盖 core.js 的 invitation 4 条命令——**create / list / accept / revoke**。
> gavin 确认**不走邮件 token 链路**,可直接用 invitation_id 调 accept。
>
> 覆盖 **core.js**:`core.invitation_create`、`core.invitation_list`、
>   `core.invitation_accept`、`core.invitation_revoke`

---

## 1. 架构

```
TEST CLIENT (smoke-16-invitations.test.js)
    │
    ├─ Phase 0: provision USER3 (gavin-test-004) 用于"被邀请"
    │            - try /auth/register
    │            - identity-only login(不带 org_id)
    ├─ Phase 1: USER1 调 core.invitation_create
    │            { orgId: USER1_ORG_ID, roleId: 'org-member', email: USER3_EMAIL }
    ├─ Phase 2: USER1 调 core.invitation_list(orgId)
    │            → 列表里能看到刚发的邀请
    ├─ Phase 3: USER3 调 core.invitation_accept(invitationId)
    │            → USER3 现在是 org member
    ├─ Phase 4: USER1 调 core.member_list → USER3 在列表里
    ├─ Phase 5: USER1 发第二条 invitation 给虚构邮箱 → revoke 它
    │            → invitation_list 再查,刚 revoke 那条 status=revoked/cancelled
```

---

## 2. 前置 / Env

- `TEST_USER_TOKEN`(USER1, org-owner)
- 新自动 provision:USER3 邮箱 `gavin-test-004@example.com`(避免和 Smoke 13 的 USER2 撞)

---

## 3. 断言表(10)

| # | Phase | 断言 |
|---|---|---|
| 1 | 0 | USER3 register status ∈ {200,201,409,422} |
| 2 | 0 | USER3 identity-only login 拿到 access_token |
| 3 | 1 | invitation_create 返 id |
| 4 | 1 | invitation 含 email == USER3_EMAIL,role 字段 |
| 5 | 2 | invitation_list 含刚发的 id |
| 6 | 3 | USER3 invitation_accept 返 2xx |
| 7 | 4 | USER1 member_list 含 USER3 的 member_id |
| 8 | 5 | 第二条 invitation_create 返 id(给虚构邮箱) |
| 9 | 5 | invitation_revoke 返 2xx |
| 10 | 5 | revoke 后 invitation_list 里那条 status ∈ {revoked, cancelled, expired} |

---

## 4. 设计要点

- gavin 已确认**无需邮件 token**;accept 直接用 invitation_id
- USER3 register 失败(已存在)算 OK,**幂等设计**
- 第二条 invitation 故意给虚构邮箱(`smoke16-revoked-<TS>@example.com`),不会被 accept,只用来测 revoke 路径

---

## 5. 跑法

```bash
node docs/smoke-tests/smoke-16-invitations.test.js
```

预期 5-10 秒。
