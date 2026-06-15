# Smoke Tests — COCO Workspace

> 端到端冒烟测试目录,按 agent 维度组织。每个子目录是一个独立分类,共享同一套
> `lib/runner.js` 风格的 NL 驱动 + 卡片体短语校验 + 后端旁路状态比对的三段式架构。

## 分类

| 分类 | 子目录 | 说明 |
|---|---|---|
| **单 agent** | [`single-agent/`](./single-agent/) | 一个 user ↔ 一个 agent 的端到端 NL 流(19 个用例,Smoke 0-18)。覆盖 Issue / Task / Attempt / Blueprint / KB / AS / Comm 全表面,跟 agent NL 决策路径一起验。 |
| **多 agent** | [`multi-agent/`](./multi-agent/) | 多 actor(LEAD + WORKER 等)端到端,test client 持多套 JWT 直接打 API,无 NL。专门覆盖 single-agent 验不了的 cross-actor 路径(assignee 切换 / 跨 actor visibility / 权限)。 |

> 后续若加 cross-runtime / harness 之类场景,可再开 sibling 子目录。

## 共享 runner

每个分类自带自己的 lib/runner.js,因为关注点不同(NL 卡片轮询 vs 多 JWT 直接打 API)。两套都源自同一个设计:`sendInstruction`-or-`bearerFetch` → `waitForCard`-or-`callApi` → assertion 三段式。

- 单 agent runner:[`single-agent/lib/runner.js`](./single-agent/lib/runner.js)
- 多 agent runner:[`multi-agent/lib/runner.js`](./multi-agent/lib/runner.js)

## 跑

各分类有各自的 README,详见子目录:

- 单 agent 用例:[`single-agent/README.md`](./single-agent/README.md)
- 多 agent 用例:[`multi-agent/README.md`](./multi-agent/README.md)

设计文档(分类源头):[`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/coco-workspace/cws-deploy/-/blob/main/docs/smoke-test-design.md)
