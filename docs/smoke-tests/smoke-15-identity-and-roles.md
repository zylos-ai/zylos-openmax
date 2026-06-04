# Smoke 15 — Identity + Role + Org Switch(纯脚本驱动)

> **验证目标**:覆盖 core.js 里**身份/角色目录**类命令——`core.member_get`
> (按 id 取单条 member)、`core.role_list`(列 org 内可分配角色)、
> `core.org_switch`(切当前 principal 的 active org)。
>
> 覆盖 **core.js**:`core.member_get`、`core.role_list`、`core.org_switch`
>
> 不覆盖(gavin 不允许 / 别的 smoke 负责):
> - `core.platform_agent_create / delete`(gavin 已说**不允许**)
> - `core.org_list / org_create`(Smoke 17 负责)
> - `core.invitation_*`(Smoke 16 负责)

---

## 1. 架构

```
TEST CLIENT (smoke-15-identity-and-roles.test.js)
    │
    ├─ Phase 1: core.me 拿到 self member_id
    ├─ Phase 2: core.member_list 拿 ≥ 1 个 member
    ├─ Phase 3: core.member_get(self) + core.member_get(other,如果有)
    ├─ Phase 4: core.role_list(scope='org') → 返 role 列表(含 org-owner / org-member)
    └─ Phase 5: core.org_switch(self 当前 org) → 等价 no-op,验证 2xx 不抛
                (真正的 cross-org switch 留给 Smoke 17,因为本 smoke 不创建第二个 org)
```

---

## 2. 前置 / Env

跟 Smoke 8/9 一致。

---

## 3. 断言表(10)

| # | Phase | 断言 |
|---|---|---|
| 1 | 1 | core.me 返 member_id + org_id |
| 2 | 2 | core.member_list 返 ≥ 1 (self 至少) |
| 3 | 3 | core.member_get(self.member_id) 返同一个 member 且 id 对得上 |
| 4 | 3 | member 含 kind(human/agent)+ status 字段 |
| 5 | 3 | 如果 member_list 里有 other(非 self),member_get(other) 也返 2xx |
| 6 | 4 | core.role_list 返数组 ≥ 1 |
| 7 | 4 | role 含 id + slug/name + scope 字段 |
| 8 | 4 | role 列表里能找到 org-owner / org-member 任一(标签匹配宽松) |
| 9 | 5 | core.org_switch(self 当前 org) 返 2xx |
| 10 | 5 | switch 后 core.me 仍返同一个 org_id |

---

## 4. 跑法

```bash
node docs/smoke-tests/smoke-15-identity-and-roles.test.js
```

预期 2-4 秒。
