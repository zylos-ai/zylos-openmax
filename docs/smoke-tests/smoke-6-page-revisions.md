# Smoke 6 — 多轮编辑 + 版本对比(NL 驱动)

> **验证目标**:用户用自然语言让 agent 起一份文档,然后**分 3 轮**追加内容,
> 最后让 agent 拉一次 diff 把"现在 vs 初版"的变化总结出来。Agent 自主
> 完成 page 创建 + 多次内容写入 + 取 revisions / diff,并在汇报里把
> 变化点对得上。
>
> 覆盖 `kb.page_create / page_content_write / page_revisions / page_revision /
> page_diff / page_get` 这条版本面 CLI 链。同样**双层断言**(卡片体短语 +
> 后端旁路状态)。

---

## 1. 架构

```
[Phase 1] sendInstruction(NL1) "起一份 LLM 推理优化对比文档,初版包含 A B C 三点"
            ↓
[Phase 2] poll 等 agent 回 "已建,初版含 A B C" + pageId
[Phase 3] sendInstruction(NL2) "再加一点 D"
            ↓
[Phase 4] poll 等 agent 回 "已加 D,当前 revision 数 X"
[Phase 5] sendInstruction(NL3) "再加一点 E"
            ↓
[Phase 6] poll 等 agent 回 "已加 E"
[Phase 7] sendInstruction(NL4) "对比一下现在 vs 初版,告诉我加了哪些点"
            ↓
[Phase 8] poll 等 agent 给出 diff 总结 —— 关键短语含 D 和 E
[Phase 9] 旁路:test client 直查 page_revisions ≥ 4(初创 + 3 次 write,
            或 ≥ 3 取决于实现是否把 create 计为 revision 1)
[Phase 10] sendInstruction(NL5) "清理这个 page"
            ↓
[Phase 11] poll 等 agent 回"已删" + 旁路 page_get 返 4xx
```

---

## 2. 前置条件 + Env

跟 Smoke 5 一致(需要 `TEST_CONV_ID` 和 `TEST_DEFAULT_KB_ID`)。

---

## 3. NL 文本

### Round 1(起初版)

```
帮我起一份 Smoke6-<TS> 的 LLM 推理优化对比文档,放在默认知识库根目录下。

初版只写 3 个要点(每行一句):
- 点A:KV cache 压缩
- 点B:speculative decoding
- 点C:flash attention v3

建完用一行简短日志告诉我 pageId。
```

### Round 2(加点 D)

```
在刚才那个 Smoke6-<TS> 文档里加一个新要点:
- 点D:continuous batching
加完告诉我现在这个 page 有几个 revision。
```

### Round 3(加点 E)

```
继续加一点:
- 点E:tensor parallelism + sequence parallelism
加完汇报一次。
```

### Round 4(让 agent 做 diff 总结)

```
对比一下 Smoke6-<TS> 现在的版本和最初版,告诉我从初版到现在新增了哪些要点(不要重述初版有的内容)。
```

### Round 5(清理)

```
把 Smoke6-<TS> 这个 page 永久删掉,删完跟我确认。
```

---

## 4. 断言表(15)

### 卡片体(9)

| # | Phase | 断言 |
|---|---|---|
| 1 | 2 | round1 回复在 60s 内到达,含 pageId(uuid 形态)|
| 2 | 2 | 回复明确包含 "A" / "B" / "C" 三个要点(或"初版三点已写")|
| 3 | 4 | round2 回复在 30s 内到达,含 "D"(或"已加 D")|
| 4 | 4 | 回复**报数**:revision 数 ≥ 2(初建 + 1 次 write)|
| 5 | 6 | round3 回复在 30s 内到达,含 "E" |
| 6 | 8 | round4 回复在 30s 内到达,**diff 总结里明确含 D 和 E** 两个新增点 |
| 7 | 8 | 回复**不**重复 A/B/C 三点(按指令"不要重述初版内容"自检)|
| 8 | 11 | round5 回复在 30s 内到达,含 "已删除" / "已清理" 类语义 |
| 9 | 11 | 回复回归当前 pageId 与之前 round1 给出的一致 |

### 后端旁路(6)

| # | 阶段 | 断言 |
|---|---|---|
| 10 | round1 done | `kb.page_get(pageId)` 返 2xx,title 含 Smoke6-<TS>,父 folder 在默认 KB 根附近 |
| 11 | round1 done | `kb.page_content(pageId).body` 含 "点A" + "点B" + "点C" |
| 12 | round2 done | `kb.page_revisions` 返回数 ≥ 2 |
| 13 | round3 done | `kb.page_content(pageId).body` 含 "点D" + "点E" |
| 14 | round4 done | `kb.page_diff(rev_initial, rev_current).diff` 文本含 "+" 行 +  "点D" + "点E" |
| 15 | round5 done | `kb.page_get(pageId)` 返 4xx(已永久删)|

---

## 5. 覆盖 CLI(预期)

`kb.page_create, kb.page_content_write, kb.page_get, kb.page_content,
kb.page_revisions, kb.page_revision, kb.page_diff, kb.page_trash,
kb.page_delete`

---

## 6. 设计要点

- **diff 的语义验证靠 agent**(它要把"新增了 D 和 E"用自然语言说清),
  而不是测试客户端去解析 unified diff —— 这样能同时测 agent **理解
  page_diff 返回**的能力
- **不要求 agent 跑 4 次 content_write**;实现上它可能选 3 次 write +
  1 次 page_diff,或者别的路径,只要旁路断言 10-15 成立即可
- **Smoke 6 失败时不主动清理**,留 page 在 KB 里给排查(round 5 是 agent
  自己的清理,失败的话用户可以手动跑 round 5 的 NL 收尾)
