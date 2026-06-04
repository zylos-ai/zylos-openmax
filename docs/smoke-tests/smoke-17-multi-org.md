# Smoke 17 — 多 Org 上下文(NL 驱动)

> **验证目标**:用户用自然语言让 agent 建一个新测试 org,切过去看看,
> 然后切回来 —— 跨 org 上下文切换的实际场景。
>
> 覆盖 **core.js**:`core.org_list`、`core.org_create`、`core.org_switch`,
> 顺带验证 `core.project_list` 在 switch 后跟着切。

---

## 1. NL 文本

```
我想开个新测试 org 跑一些隔离的实验,你帮我:
1. 列下我现在能见的所有 org(给我个数 + 名字)
2. 新建一个 org,叫 "Smoke17-<TS> 实验场",slug 用 "smoke17-<ts>"
3. 把活跃 org 切到刚建的那个,然后看下新 org 里有几个 project
4. 看完切回我们原来的 org(用 org_id <ORIGINAL_ORG_ID>),
   确认 project_list 又能看到我们原来的项目

最后简报:原 org 项目数、新 org 项目数、新 org 的 id。
```

---

## 2. 断言表(7)

### 卡片体(3)

| # | 来自轮 | 断言 |
|---|---|---|
| 1 | 1 | round1 在 120s 内到,含 new org id (uuid) + `Smoke17-<TS>` |
| 2 | 1 | 含 "切到" + "切回" / switch 语义 |
| 3 | 1 | 提到 ≥ 2 个不同的 org_id 或项目数对比 |

### 旁路(4)

| # | 阶段 | 断言 |
|---|---|---|
| 4 | round1 | core.org_list 含 ≥ 2 个 org(原 org + 新 org) |
| 5 | round1 | 新 org name 含 `Smoke17-<TS>` |
| 6 | round1 | 最后 core.me.org_id == 原 org_id(已切回) |
| 7 | round1 | core.project_list 在原 org 下 ≥ 1 个 project |

---

## 3. 注意 / 跑法

- 创建的 org **不主动清理**,留 DB 痕迹
- `org_switch` 行为 server-side vs token-side 都支持(本 smoke 在最终态校验,中间态宽松)

```bash
node docs/smoke-tests/smoke-17-multi-org.test.js
```

预期 2-4 分钟。
