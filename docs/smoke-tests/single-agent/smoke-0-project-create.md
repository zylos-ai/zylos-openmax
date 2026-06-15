# Smoke 0 — 创建项目(基础 API 链路)

> **验证目标**:用 human owner 的 email/password 经 cws-int 走完 `auth/login →
> me → create project → get → archive` 的最小闭环。只用 cws-core REST 表面,
> 不涉及 agent runtime / cws-comm WS / outbox 等异步链路,作为其他 Smoke
> 用例的前置健康检查 + project fixture。

---

## 1. 测试架构

```
┌─ TEST CLIENT (smoke-0-project-create.test.js) ─────────────────────────┐
│  [Phase 1] POST /auth/login {email, password, org_id, token_delivery}  │
│              ↓  data.access_token (org-scoped JWT)                      │
│  [Phase 2] GET  /api/v1/me  (Bearer)                                    │
│              ↓  data.member_id, data.role.slug == "org-owner"           │
│  [Phase 3] POST /api/v1/projects {name, slug, lead_member_id}           │
│              ↓  data.id (新 project)                                    │
│  [Phase 4] GET  /api/v1/projects/{id}                                   │
│              ↓  字段断言                                                │
│  [Phase 5] POST /api/v1/projects/{id}/archive  + re-GET                 │
│              ↓  status=archived,archived_at 非空                        │
└────────────────────────────────────────────────────────────────────────┘
```

CF Access 头(`CF-Access-Client-Id` / `CF-Access-Client-Secret`)在 env 提供时
自动附加,不提供则跳过,所以这个脚本对裸 cws-core 部署也能直接跑。

---

## 2. 前置条件

| 资源 | 用途 |
|---|---|
| cws-core + cws-work | 部署到位且健康 |
| 测试 Org | 已存在,owner 已绑定 email/password 凭据 |
| 网络 | 能直连 `COCO_API_URL`,需要时 CF Access service token 可用 |

### Env vars

```bash
COCO_API_URL=https://cws-int.coco.xyz
TEST_EMAIL=<owner 邮箱>
TEST_PASSWORD=<owner 密码>
TEST_ORG_ID=<目标 org UUID>
CF_ACCESS_CLIENT_ID=<...>.access     # 仅当 cws-int 走 CF Access 时必填
CF_ACCESS_CLIENT_SECRET=<...>        # 同上
```

> **注**:这里的 user 必须是 `TEST_ORG_ID` 的 org-owner;Phase 2 会强校验
> `me.role.slug === "org-owner"`。如果你是用 admin/member 跑,需要把
> Phase 2 的 role 断言改成 `assertIn` 或注释掉。

---

## 3. 14 条断言

| # | Phase | 字段 | 期望 |
|---|---|---|---|
| 1a | login | `data.access_token` | 存在且 length > 20 |
| 1b | login | `data.refresh_token` | 存在且 length > 20 |
| 2a | me | `kind` | `"human"` |
| 2b | me | `org_id` | `TEST_ORG_ID` |
| 2c | me | `member_id` | 非空 |
| 2d | me | `role.slug` | `"org-owner"` |
| 3a | create | `id` | 非空 |
| 3b | create | `name` | `Smoke0-<ts>` |
| 3c | create | `slug` | `smoke0-<ts>` |
| 3d | create | `org_id` | `TEST_ORG_ID` |
| 3e | create | `lead_member_id` | `me.member_id` |
| 3f | create | `status` | `"active"` |
| 3g | create | `is_default` | `false` |
| 4a-d | get | id / name / slug / status | 与 create 一致 |
| 5a | archive | `status` | `"archived"` |
| 5b | archive | `archived_at` | 非空字符串 |

---

## 4. 跑法

```bash
cd ~/zylos/workspace/zylos-coco-workspace

COCO_API_URL=https://cws-int.coco.xyz \
TEST_EMAIL=gavin-test-002@example.com \
TEST_PASSWORD='<test-account-password>' \
TEST_ORG_ID=019e8b9b-364e-7105-b83e-14cedfd381aa \
CF_ACCESS_CLIENT_ID=<...>.access \
CF_ACCESS_CLIENT_SECRET=<...> \
node docs/smoke-tests/smoke-0-project-create.test.js
```

退出码:
- `0` —— 全部断言通过
- `1` —— 至少一条断言失败(失败时 stderr 打印失败位置 + 上下文)
- `2` —— 必填 env 缺失

每跑一次会产出一个 `Smoke0-<毫秒时间戳>` 项目并在结束时 archive,所以 slug
唯一性不会跨次冲突;重复跑不需要清理。

---

## 5. 关键设计决策

- **`token_delivery=body`** —— refresh_token 走 body 字段而不是 cookie,
  脚本只用 native fetch,不需要管 cookie jar。
- **在 case 内部用 `/api/v1/me` 推 `member_id`** —— 避免把 `TEST_USER_MEMBER_ID`
  再做一个 env 暴露面;owner 在哪个 org 都能直接跑。
- **Phase 5 archive 当 cleanup** —— 不删项目(cws-work 多半没有 hard-delete
  接口),archive 即可使下一次 list 默认不再看到。slug 因带时间戳天然唯一,
  archive 状态下也不会和后续创建冲突。
- **CF Access 头按 env 注入** —— 与 `lib/runner.js::sendInstruction` 行为
  对齐,本地 / cws-int 双部署同一份脚本。

---

## 6. 与其他 Smoke 的关系

- Smoke 0 是 Smoke 1/2/3 的可选 **fixture step**:跑完后产生的 project id
  可以作为后续用例的 `TEST_PROJECT_ID`(只要把 Phase 5 archive 注释掉)。
- 也可以反向跑:先让运维准备 long-lived test project,Smoke 1/2/3 用它;
  Smoke 0 只在网关健康检查 / 回归冒烟里跑。

如果要把 Smoke 0 改成 fixture-mode(不 archive,把 project id 写到 stdout
最后一行供 caller 抓):在 Phase 5 之前 `process.exit(0)`,或加一个
`SMOKE0_KEEP=1` env 短路 archive 段。当前实现简单起见**不**支持 keep,需要
fixture 直接抄改。
