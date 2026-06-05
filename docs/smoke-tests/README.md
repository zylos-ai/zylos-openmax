# Smoke Tests — COCO Workspace

> 端到端冒烟测试目录,按 agent 维度组织。每个子目录是一个独立分类,共享同一套
> `lib/runner.js` 风格的 NL 驱动 + 卡片体短语校验 + 后端旁路状态比对的三段式架构。

## 分类

| 分类 | 子目录 | 说明 |
|---|---|---|
| **单 agent** | [`single-agent/`](./single-agent/) | 一个 user ↔ 一个 agent 的端到端流(19 个用例,Smoke 0-18)。覆盖 Issue / Task / Attempt / Blueprint / KB / AS / Comm 全表面。 |

> 多 agent / cross-runtime 等更复杂场景预留为后续子目录,跟 Harness 测试体系对接。

## 共享 runner

每个分类自带自己的 [`lib/runner.js`](./single-agent/lib/runner.js)。当前只有 single-agent
分类,所以共享的 runner 也在那里;未来若新增分类,会按需复用或分叉 runner,设计文档在
[`cws-deploy/docs/smoke-test-design.md`](https://git.coco.xyz/coco-workspace/cws-deploy/-/blob/main/docs/smoke-test-design.md)。

## 跑

各分类有各自的 README,详见子目录:

- 单 agent 用例:[`single-agent/README.md`](./single-agent/README.md)
