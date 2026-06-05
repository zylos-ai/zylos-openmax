# Smoke Tests — Multi Agent

> 多 actor 端到端冒烟测试,跟 [`../single-agent/`](../single-agent/) 并列。本子目录里的 smoke 验证 **cws-core 在多 member 视角下的 authz / assignment / visibility 语义** —— 比如 LEAD 派活、WORKER 接活、assignee_id 跨 actor 切换、各方 token 互不污染等等。
>
> 父级 [`docs/smoke-tests/`](../) 的分类索引。

## 跟 single-agent 的关系

- **single-agent 验"agent NL 决策 + 跑 CLI 正确"**:test client 发自然语言,agent 自主调 CLI,验 KB / Task / Issue 状态机 + 卡片回复语义
- **multi-agent 验"server 跨 actor 的状态机 / 权限"**:test client 直接持多套 JWT 调 API/CLI,无 NL,无 agent runtime 参与。专门覆盖 single-agent 验不了的 cross-actor 路径

两套互补,**不替代**。同一个业务用例(比如 Heavy + Blueprint + Worker)会在两边各跑一遍,各看一面。

## 用例清单

| 用例 | 主验项 | 文档 | 脚本 |
|---|---|---|---|
| **2** | Heavy issue + LEAD 派 step1 + **WORKER cross-actor claim** + LEAD 自做 step2/3 + 交付验收。验 assignee/attempt.assignee 切到 WORKER,visibility 跨 actor OK。 | [md](./smoke-2-heavy-multi-agent.md) | [test.js](./smoke-2-heavy-multi-agent.test.js) |

## 公共 lib

[`lib/runner.js`](./lib/runner.js) 提供:

| 导出 | 用途 |
|---|---|
| `loadEnv()` | 校验 + 加载必需 env(增加 `TEST_ORG_ID` 比 single-agent 多一个) |
| `bearerFetch(env, method, path, {token, body})` | 接受**每次调用单独的 token**,同一 env 持多套 JWT 不冲突 |
| `callApi(env, method, path, opts)` | bearerFetch + auto-unwrap `.data` + die on non-2xx |
| `provisionMember(env, {rolePrefix, label})` | **核心**:register → invite → accept → org-scoped login,一步拿到新 member 的 `{email, password, identityId, memberId, jwt, displayName}` |
| `assertEq / assertTrue / assertNot / log / ok / warn / die / summary` | 标准断言 + 日志(跟 single-agent 风格一致,但是独立实现 —— 单 agent 那套带 NL/卡片轮询,这里不需要) |

provisionMember 是这个 lib 的招牌:把"造一个干净的 org-member 来扮演 Worker"压成 1 行调用,可重复(每次 timestamped email 不撞)。

## Env

跟 single-agent 大体一致,但**多一个 `TEST_ORG_ID`**(member provision 时 re-login 需要传 `org_id`):

```bash
export COCO_API_URL=https://cws-int.coco.xyz
export TEST_USER_TOKEN=<lead org-owner JWT>
export TEST_ORG_ID=<目标 org uuid>
export TEST_PROJECT_ID=<smoke 跑在哪个 project>
export TEST_AGENT_ID=<lead agent 的 member_id>
export CF_ACCESS_CLIENT_ID=...                # 可选
export CF_ACCESS_CLIENT_SECRET=...             # 可选
```

## 跑

```bash
cd ~/zylos/workspace/zylos-coco-workspace
node docs/smoke-tests/multi-agent/smoke-2-heavy-multi-agent.test.js
```

单个用例 ~2 秒,因为无 NL 等待。

## 设计来源

[`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/coco-workspace/cws-deploy/-/blob/main/docs/smoke-test-design.md) § **Smoke 2: Heavy 多 Agent 编排**。

> 设计里的"多 Agent" 在本 smoke 实现成"多 member"(register-and-invite 流的 humans 当 worker,不是 platform_agent_create 出来的真 agent)。原因:平台 agent provisioning 需要 platform-admin 权限,smoke 测试用 owner 跑不动;改用新 org member 后,**所有需要被验的 cross-actor 服务器行为(assignee / attempt assignment / visibility)语义完全一致**。后续 agent 与 human member 行为分化时(比如 skill-based dispatch),再开 `smoke-2-heavy-multi-AGENT.test.js` 单独验那条线。
