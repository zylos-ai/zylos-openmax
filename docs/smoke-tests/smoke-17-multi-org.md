# Smoke 17 — 多 Org 上下文(纯脚本驱动)

> **验证目标**:覆盖 core.js 里**org 容器级**命令——`core.org_list`、
> `core.org_create`、`core.org_switch`。gavin 已确认允许 agent 动态建/删 org。
>
> 覆盖 **core.js**:`core.org_list`、`core.org_create`、`core.org_switch`,
> 顺带验证 `core.me` / `core.project_list` 在 switch 后跟着切。

---

## 1. 架构

```
TEST CLIENT (smoke-17-multi-org.test.js)
    │
    ├─ Phase 1: org_list 拿 USER1 当前能见的 org 列表(≥ 1)
    ├─ Phase 2: org_create 新 org B(name=Smoke17-<TS>,slug=smoke17-<ts>)
    │            → 拿 newOrgId
    ├─ Phase 3: org_list 再查,B 在列表里
    ├─ Phase 4: org_switch 切到 B
    │            → core.me.org_id == B
    │            → core.project_list 反映 B 的项目(应只有默认 inbox 或空)
    ├─ Phase 5: org_switch 切回原 org A
    │            → core.me.org_id == A
    │            → core.project_list 反映 A 的 ≥ 1 个项目
```

---

## 2. 前置 / Env

跟 Smoke 8/9 一致(`TEST_USER_TOKEN`)。

---

## 3. 注意

- 本 smoke 创建的 org B **不主动删除**(留 DB 痕迹便于排查;清理交给 ops/定期 GC)
- `org_switch` 需要的是**重新 login 拿新 org-scoped JWT**?还是 server-side 切?
  → 看 cws-core auth 设计。如果是后者(server-side principal-binding),则 caller token 不变,直接 switch 200;如果是前者,需要走 /auth/refresh + org_id。本 smoke 用 CLI 调一次,以 CLI 行为为准

---

## 4. 断言表(10)

| # | Phase | 断言 |
|---|---|---|
| 1 | 1 | org_list 返 ≥ 1 org |
| 2 | 1 | 当前 org_id(USER1 org A)在列表里 |
| 3 | 2 | org_create 返 uuid orgId,name 含 `Smoke17-<TS>` |
| 4 | 3 | org_list 含 newOrgId |
| 5 | 4 | org_switch(newOrgId) 返 2xx |
| 6 | 4 | switch 后 core.me.org_id == newOrgId(若需要 refresh token,这里可能需要走刷新逻辑;本 smoke 先期待 server-side switch) |
| 7 | 4 | core.project_list 在 B 下返数组(可能空,可能含默认 inbox) |
| 8 | 5 | org_switch 切回 USER1 org A,返 2xx |
| 9 | 5 | core.me.org_id 回到 A |
| 10 | 5 | core.project_list 在 A 下返 ≥ 1 个项目(因为 USER1 在 A 是 org-owner 且有 Smoke Suite project) |

---

## 5. 跑法

```bash
node docs/smoke-tests/smoke-17-multi-org.test.js
```

预期 4-8 秒。
