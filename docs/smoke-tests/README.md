# Smoke Tests — COCO Workspace 0.5

> 端到端冒烟测试,验证用户经 IM(cws-comm WS 链路)给 agent 下达自然语言指令后,
> agent 能**完全自主**调用 zylos-coco-workspace 的 CLI 完成 Issue / Task / Attempt
> 的状态机流转。本目录跟 [`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/coco-workspace/cws-deploy/-/blob/main/docs/smoke-test-design.md)
> 三个用例严格对齐,作为可执行实现。

---

## 用例清单

| 用例 | 验证维度 | 对照设计 | 文档 | 脚本 |
|---|---|---|---|---|
| **Smoke 1** | Light 单 Agent 全生命周期(基线)| Smoke 1 | [smoke-1-light-single-agent.md](./smoke-1-light-single-agent.md) | [.test.js](./smoke-1-light-single-agent.test.js) |
| **Smoke 2** | Heavy + Blueprint + Worker claim + KB | Smoke 2 | [smoke-2-heavy-blueprint-worker.md](./smoke-2-heavy-blueprint-worker.md) | [.test.js](./smoke-2-heavy-blueprint-worker.test.js) |
| **Smoke 3** | Heavy 拒收 → reopened → 返工 → 再交付 | Smoke 3 | [smoke-3-rejection-rework.md](./smoke-3-rejection-rework.md) | [.test.js](./smoke-3-rejection-rework.test.js) |

Smoke 1 / 2 是 **happy path**(全部预期成功),Smoke 3 是**状态机边界**(故意拒收 + 验证非法转移被拒绝)。失败重试 / 异常路径属于后续 Smoke 系列,不在本目录内。

---

## 共享 runner

[`lib/runner.js`](./lib/runner.js) 提供:

| 导出 | 用途 |
|---|---|
| `loadEnv()` | 校验 + 加载必需 env vars;`COCO_AUTH_TOKEN` 缺省 fallback 到 `TEST_USER_TOKEN`(带 warn) |
| `sendInstruction(env, text, opts)` | POST 指令到 cws-core(**当前 schema**:top-level `type` + 单 object content),注入 CF Access 头(若提供 env) |
| `waitForCompletion(env, predicate, opts)` | 轮询 issue 列表直到 `targetStatus`(默认 `accepted`);记录 `firstObservedStatus` + `statusTrace`;**默认 10 分钟超时**,超时时 dump 最后观测到的 issue/task/attempt 状态 |
| `runSmokeCase({...})` | Smoke 1 / Smoke 2 通用 wrapper(send + wait + assertions 三段式)|
| `tm(cmd, params)` / `listTasks(issueId)` / `listAttempts(taskId)` / `listIssuesInProject(projectId)` | tm.js CLI 调用封装 |
| `assertEq` / `assertTrue` / `assertIn` | 小型断言 helper,失败 `process.exit(1)` 并打印期望 vs 实际 |
| `log` / `ok` / `warn` / `die` | 标准化日志 |

---

## Env vars

```bash
# 必需
export COCO_API_URL=https://cws-int.coco.xyz          # cws-core gateway(通常带 CF Access 保护)
export TEST_USER_TOKEN=<test user bearer JWT>          # /auth/login 拿到的 user access_token
export TEST_CONV_ID=<conversation uuid>                # user ↔ agent 的 DM 或 group
export TEST_AGENT_ID=<agent member uuid>               # agent 在测试 org 的 member id
export TEST_PROJECT_ID=<project uuid>                  # 用于 issue.list_in_project 过滤

# 可选 ——
export COCO_AUTH_TOKEN=<bearer>                        # 跟 TEST_USER_TOKEN 不同时才用;默认 fallback
export CF_ACCESS_CLIENT_ID=<...>.access                # cws-int 走 CF Access 时必填
export CF_ACCESS_CLIENT_SECRET=<...>                   # 同上
export COCO_TM_CLI=/path/to/tm.js                      # 覆盖默认 tm.js 路径
```

> **CF Access 必填场景**:cws-int.coco.xyz 整个域名被 Cloudflare Zero Trust Access 保护。没带 service token 的请求会被 302 到 `bitlayer.cloudflareaccess.com/cdn-cgi/access/login`。本 runner 检测到两个 env 都设了才注入对应头,否则不加(留给 plain HTTP 部署场景)。
>
> **TEST_PROJECT_ID 怎么拿**:create-organization 时 cws-core 会尽力创建一个 `slug: inbox` 的默认 project;没有的话用 `node src/cli/tm.js project.create '{...}'` 手工建一个,或者 `node src/cli/tm.js project.list '{}'` 看 org 下已有项目。

---

## 跑单个用例

```bash
cd ~/zylos/workspace/zylos-coco-workspace

node docs/smoke-tests/smoke-1-light-single-agent.test.js
# 或
node docs/smoke-tests/smoke-2-heavy-blueprint-worker.test.js
node docs/smoke-tests/smoke-3-rejection-rework.test.js
```

每个用例独立工作:
- 用带毫秒时间戳的 title 创建 issue,**不需要清理状态**;多次跑会留下多个 issue,靠 title 隔离不会互相干扰
- 任意断言失败 `process.exit(1)` + stderr 打印失败字段
- 全部通过打印 `✅ Smoke N PASS` + duration + statusTrace

---

## 顺序跑全部用例

```bash
for f in docs/smoke-tests/smoke-*.test.js; do
  echo "=========================================="
  echo "运行: $f"
  echo "=========================================="
  node "$f" || { echo "✗ $f FAILED"; exit 1; }
done
echo "✅ 所有 Smoke 用例通过"
```

> **注意**:agent runtime 是同一个 Claude session,接连多个用例之间建议**至少 1 分钟空闲间隔**让上一个对话完整收敛。Smoke 3 自身就涉及两轮指令 + 中间 set_acceptance(false),需要 agent 能处理"被打断 + 状态再启动"的语境切换。

---

## 与 cws-deploy 设计的对照

[`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/coco-workspace/cws-deploy/-/blob/main/docs/smoke-test-design.md) 是冒烟测试的设计来源,描述:

- 跟 Harness 测试的边界(冒烟:main CLI + cws-core gateway 集成视角;Harness:超前功能,直连 cws-work)
- 三个用例的具体 tm.js / kb.js 调用流 + 断言要点
- 状态机守卫(rejected → executing 必须被拒;只能走 rejected → reopened → executing)

本目录是**可执行实现**:
- 把设计里的 22 个 tm.js / kb.js 命令翻译成黑盒 IM 指令,由 agent 自主组装调用
- 把每个 phase 的断言收敛成可机器验证的字段比对(见每个 `.md` 的 "断言总表")
- runner 处理 CF Access / cws-core schema / tm.js 路径解析等基础设施细节

如果设计文档跟实现有冲突,以**设计文档为准**;实现里若做了简化(例如 Smoke 2 用 1 个 Worker step + 2 个 Lead step 而不是 3 Worker step),会在用例 `.md` 的"与设计差异"段落里说清楚。

---

## 失败排查速查

| 现象 | 可能原因 | 排查 |
|---|---|---|
| `Missing required env: XXX` | env var 没 export | runner 头部检查所有必需 env |
| `sendInstruction HTTP 302 / Location: cloudflareaccess` | 缺 CF Access 头 | 设 `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` |
| `sendInstruction HTTP 422 ... expected required property type to be present` | 你 fork 了 runner 但 schema 改回了旧形状 | 对齐 `runner.js:sendInstruction` 的 body 形状 |
| `sendInstruction HTTP 401/403` | `TEST_USER_TOKEN` 失效/过期 | 重 `POST /auth/login` 拿新 access_token |
| `sendInstruction HTTP 404` | `TEST_CONV_ID` 不存在或测试 user 不是该会话 member | `core.me` 查身份 + `tm.js issue.list_in_project` 验 org 通联 |
| `tm.js {"error":"fetch failed"}` | tm.js 没走 CF Access,或 COCO_API_URL 不对 | 确认 `COCO_TM_CLI` 指向带 cf-access.js 的副本(默认就是 installed skill 那个) |
| `waitForCompletion timed out after 600000ms` | agent 没收到指令 / 卡某一步 | runner 自动 dump 最后观测;另看 agent runtime 日志 `pm2 logs zylos-coco-workspace` |
| `first_observed_status ≠ executing`(Smoke 1)| TM 把 Light 也走了 draft | 查 cws-work 的 light mode 状态机定义 |
| Smoke 3 在 `set_acceptance(false)` 之后状态没到 `rejected` | issue.set_acceptance 入参 schema 漂移 | 看 tm.js set_acceptance 帮助 + cws-core /api/v1/issues/{id}/acceptance contract |

---

## 不在本目录范围

- **agent 给用户回复的 IM 文本内容** — 不验。功能正确性由 TM 状态字段覆盖
- **失败 / 重试 / 取消 / 超时** — 走单独 Smoke 系列
- **AS(ArtifactStore)集成** — 0.5 冒烟不涉及
- **多 agent 真正分布式**(不同 runtime)— Smoke 2 的 Worker 角色用同一个 agent 模拟,跟设计文档一致;真正多 agent 走 Harness 测试

---

## Design 参考

- 上游设计:[`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/coco-workspace/cws-deploy/-/blob/main/docs/smoke-test-design.md)
- Agent skill 行为规范:[`cws-work/docs/skill-design/agent-skill-spec.md`](https://git.coco.xyz/coco-workspace/cws-work/-/blob/main/docs/skill-design/agent-skill-spec.md)
- KB / AS 操作模式:[`cws-work/docs/skill-design/kb-as-operations-reference.md`](https://git.coco.xyz/coco-workspace/cws-work/-/blob/main/docs/skill-design/kb-as-operations-reference.md)
