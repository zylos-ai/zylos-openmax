# Smoke 14 — Comm Sync + Search(混合驱动)

> **验证目标**:覆盖 comm.js 里剩下的 `comm.sync` 和 `comm.search`。
> sync 是诊断向(离线追平),NL 包装成"我离线一会儿,补一下漏掉的消息"
> 这种实际场景;search 是真正用户语义"帮我搜一下 'Smoke' 相关的页面"。
>
> 覆盖 **comm.js**:`comm.sync`、`comm.search`、`comm.list_conversations`
> (includeArchived flag)

---

## 1. NL 文本

### Round 1 — 离线追平 + 搜索

```
我刚才电脑挂起了一段时间没看 IM。帮我:
1. 从 seq=0 开始把所有会话事件都补一下,看下离线期间漏了多少条
   (用 comm.sync 这条 CLI,deviceId 随便用一个 uuid 就行)
2. 列下当前所有会话(包括归档的也算上)
3. 帮我搜一下 KB 里跟 "Smoke" 相关的页面,大概有多少

3 项做完一行简报:漏了几条 / 总共多少会话 / 搜到几页。
```

---

## 2. 断言表(8)

### 卡片体(4)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 90s 内到,含 "漏了" / "事件" / "条" 任一 |
| 2 | 1 | 含 "会话" 数报数 |
| 3 | 1 | 含 "搜到" 或 "条" / "页面" 关于搜索结果数 |
| 4 | 1 | 3 个数字简报齐全 |

### 旁路(4)

| # | 阶段 | 断言 |
|---|---|---|
| 5 | round1 | comm.sync(sinceSeq=0, deviceId=<uuid>) 返 events 数组(可空可有)+ has_more boolean |
| 6 | round1 | comm.list_conversations(includeArchived=true) 长度 ≥ comm.list_conversations(false) |
| 7 | round1 | comm.search({query: "Smoke"}) 返 data 数组 + pagination.total_count integer |
| 8 | round1 | comm.sync(sinceSeq=99999999) → events 空 + has_more false |

---

## 3. 跑法

```bash
node docs/smoke-tests/smoke-14-comm-sync-search.test.js
```

预期 2-3 分钟。
