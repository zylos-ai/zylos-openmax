# Smoke 5 — KB 研究工作区(NL 驱动)

> **验证目标**:用户用一句自然语言要求 agent 在默认 KB 下搭一个"研究项目
> 工作区"。Agent **自主**调度 `kb.tree_roots / folder_create /
> page_create / page_content_write / search / node_children` 等命令完成
> 全部操作并把结果汇报回会话。Smoke 5 同时度量两件事:agent 能不能
> 听懂"工作区"的语义 + agent 实际有没有把目录和页面真的落到默认 KB。
>
> 路径与 Smoke 4 同款(双层断言:卡片体短语 + 后端旁路状态),覆盖
> `kb.js` 里 **kb tree + page 创建 + 搜索 + 重命名/移动**等 ≈ 14 个命令。

---

## 1. 架构

```
[Phase 1] sendInstruction(NL_round1) — "建工作区"
            ↓
[Phase 2] poll agent 回复"工作区已建好"卡片 + 关键短语
[Phase 3] 旁路验证(test client 走 kb.js):
            · default KB 下确实多了 research + notes 两个 folder
            · notes 下确实有 2 个 page,title 含 Smoke5-<ts>
            · kb.search(Smoke5-<ts>, sync=true) hits ≥ 2

[Phase 4] sendInstruction(NL_round2) — "改名 + 挪位置"
            "把 notes 改名为 writeup,把 research 挪到 writeup 下面"
            ↓
[Phase 5] poll 等 agent 确认 + 旁路验证新 tree 结构

[Phase 6] sendInstruction(NL_round3) — "清理"
            "把刚才建的 Smoke5/<ts> 那批东西全部清掉"
            ↓
[Phase 7] poll 等 agent 报"已清理" + 旁路验证 namespace 下节点已删
```

3 次 NL + 全程旁路 ↔ agent 决策正确性 + CLI 调用正确性。

---

## 2. 前置条件

| 资源 | 用途 |
|---|---|
| 测试 Org 默认 KB(`TEST_DEFAULT_KB_ID`)已 init | tree 操作前置 |
| `TEST_CONV_ID` user ↔ agent DM 已存在 | 3 轮 NL 走它 |
| Agent runtime 在线,coco-workspace skill 已加载 KB 操作能力 | 否则 Phase 2 就 timeout |

### Env

```
COCO_API_URL=https://cws-int.coco.xyz
TEST_USER_TOKEN=<org-scoped JWT>
TEST_CONV_ID=<DM uuid>
TEST_AGENT_ID=<agent member_id>
TEST_DEFAULT_KB_ID=<默认 KB id>
CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET
```

---

## 3. NL 文本

### Round 1(建工作区)

```
帮我做一个 Smoke5-<TS> 的研究项目工作区:

1. 在默认知识库下建两个目录:research 和 notes(名字前面加上 Smoke5-<TS>/ 前缀以便区分)
2. 在 notes 目录下写两个对比页面:
   - 第一页标题 "Smoke5-<TS> Cursor vs Windsurf",内容写一段功能对比的 markdown
   - 第二页标题 "Smoke5-<TS> Claude Code vs Codex",同样写一段对比
3. 全部建好之后,用关键词 "Smoke5-<TS>" 在默认知识库搜一下,把搜到的标题列出来给我确认
4. 每一步执行完用一行简短日志报给我,结束打印两个目录的 nodeId、两个 page 的 pageId
```

### Round 2(改名 + 挪位置)

```
把刚才那个 Smoke5-<TS>/notes 目录改名成 Smoke5-<TS>/writeup,然后把 Smoke5-<TS>/research 整个挪到 writeup 下面(变成 writeup/research)。改完后给我打印新的目录结构。
```

### Round 3(清理)

```
把刚才建的 Smoke5-<TS> 那批东西全删掉:两个 page 永久删除,目录递归删除。删干净后跟我确认默认知识库里已经没有 Smoke5-<TS> 命名空间下的任何节点了。
```

---

## 4. 断言表(18)

### 卡片体短语(10)

| # | Phase | 断言 |
|---|---|---|
| 1 | 2 | round1 回复在 60s 内到达 |
| 2 | 2 | 回复含 "research" + "notes"(agent 确认建了俩目录)|
| 3 | 2 | 回复列出**两个** page 的标题或 id |
| 4 | 2 | 回复提到 "kb.search" 命中 / 搜到 / hits 或类似词 |
| 5 | 5 | round2 回复在 30s 内到达 |
| 6 | 5 | 回复含 "writeup"(改名生效)|
| 7 | 5 | 回复反映出新层级(writeup/research 或等价描述)|
| 8 | 7 | round3 回复在 30s 内到达 |
| 9 | 7 | 回复含 "已清理 / 删除完成 / 清空" 类语义 |
| 10 | 7 | 回复明确否定 "Smoke5-<TS> 命名空间下还有节点" |

### 后端旁路状态(8)

| # | 阶段 | 断言 |
|---|---|---|
| 11 | round1 done | `kb.tree_roots / node_children` 能找到 research + notes 两个 folder,name 含 Smoke5-<TS> |
| 12 | round1 done | notes 目录下 children **正好 2 个** node,都是 page 类型 |
| 13 | round1 done | 两个 page 的 title 都含 Smoke5-<TS> |
| 14 | round1 done | `kb.search(Smoke5-<TS>, sync=true)` hits ≥ 2 |
| 15 | round2 done | research 的 `parent_id` 等于(原 notes 已被改名的)writeup nodeId |
| 16 | round2 done | `node_breadcrumb(research)` 含 writeup |
| 17 | round3 done | 全 KB 内 name 含 Smoke5-<TS> 的节点数 == 0 |
| 18 | round3 done | 默认 KB 本身仍存在(未误删)|

---

## 5. 覆盖 CLI(预期 agent 在跑这条 case 时会调到)

`kb.tree_roots, kb.folder_create, kb.page_create(via cws-core HTTP),
kb.page_content_write, kb.search, kb.node_children, kb.node_rename,
kb.node_move, kb.node_breadcrumb, kb.page_trash, kb.page_delete,
kb.node_delete, kb.list, kb.page_get` —— **≥ 14 个**

agent 真实选用的 CLI 由它自主决定,以上是预期路径;测试**不**强制 agent 用哪条
具体调用,只要终态符合断言 11–18 即通过。

---

## 6. 设计要点 / 假定

- **Phase 3 / 5 / 7 的旁路用 test client 直接调 CLI,只查不改** —— 这是"裁判"
  视角,不破坏测试现场
- **Smoke 5 上线时大概率失败**(agent skill 这块业务能力还没扩),先作为
  contract baseline
- 不假设 agent 选择哪种 KB 节点类型存 page(可能用 page 也可能用 file +
  markdown artifact),旁路断言基于 "kb.search 能搜到 + node_children 能列到"
  这两件事,实现细节不限
