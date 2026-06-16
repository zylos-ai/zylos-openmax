# Smoke 5 (multi-agent, NL) — cross-actor AS file hand-off

> Two live agent runtimes. User sends **one** NL to LEAD; LEAD uploads an artifact and instructs WORKER via their bot DM to fetch it and write contents into a KB page. Verifies AS visibility + sha256 integrity across actors.

## 范式

v2 单 NL — user 只给 LEAD 发一条自然语言,之后 LEAD 和 WORKER 通过 bot↔bot DM 协调,user 全程不再参与。runner 只轮服务端状态做断言。

## 目的

- LEAD 上传一份文件到 AS(已知字节,sha256 可算)
- AS 落库 + 在 KB 里建一个 file node(creator=LEAD)
- WORKER 跨 actor 拉 artifact,可见 + 可下载
- WORKER 把内容**原封不动**写到一个 KB page(模拟"二次处理")
- LEAD POV 和 WORKER POV 拉 page content,byte-for-byte 一致 + 等于原文件

## 流程

### Phase 1 — 用户给 LEAD 一句 NL(全程唯一一句)

> 你需要做这两件事(全程自己完成,不要中间问我):
>
> 1. 我给你一段内容,三引号之间是文件正文(不包含引号本身):
>    ```
>    # smoke-5 cross-actor 文件交付测试 ${TS}
>    line1: alpha
>    line2: beta
>    line3: gamma
>    ```
>    把这整段正文当一个文件保存到 artifact store(KB 模式上传:不带 conversationId,会同时在 KB 里建一个 file node),文件名 "smoke5-${TS}.md",mediaType=file,contentType=text/markdown。
>
> 2. 文件保存好之后,通知 agent-gavin3 这个 bot:在你跟它的 DM 里告诉它有一个名字含 "smoke5-${TS}" 的 markdown 文件刚通过 AS 上传(也作为 KB file node 可见),请它把内容完整读出来(用 as.download 或者 kb.file_download),在 KB 里建一个标题为 "Smoke5 W-${TS} 引用文件内容" 的 page,正文 = 文件原文一字不改(不要加任何前后缀)。等 agent-gavin3 在 DM 里回复 "完成" 或类似确认。

### Phase 2 — agent 自主协作 (无 user 参与)

预期 agent 行为序列:

1. LEAD `as.upload {filePath, mediaType=file, contentType, filename}` → 拿到 artifactId + nodeId
2. LEAD bot DM 告诉 WORKER artifactId / nodeId / kb_id
3. WORKER `as.download` 或 `kb.file_download` 读出内容
4. WORKER `kb.page_create` 在 KB 建一个标题 "Smoke5 W-${TS} 引用文件内容" 的 page,正文照抄
5. WORKER bot DM 回 "完成"

runner Phase 2 poll KB 里出现标题为 "Smoke5 W-${TS}" 的 page + 内容含原文 canary 字符串 (`line3: gamma`),命中后退出。

### Phase 3 — runner 静默断言

不需要 user 介入。

## 断言(8 条)

| # | 断言 |
|---|---|
| 1 | KB page "Smoke5 W-${TS} 引用文件内容" 存在(WORKER 创建) |
| 2 | page content === AS 原文,byte-for-byte(跨 bot 文件 → 页面 pipeline 无损) |
| 3a | WORKER JWT 拉同一 page id 可见(跨 actor visibility) |
| 3b | WORKER POV content === LEAD POV content,byte-identical |
| 4 | KB page creator === WORKER member_id(LEAD 上传 AS,WORKER 写 KB,归属正确,cws-kb #201 已修) |
| 5a | LEAD 在 bot DM ≥ 1 条 agent_text(派活通知,带 artifactId/nodeId) |
| 5b | WORKER 在 bot DM ≥ 1 条 agent_text("完成" 回复) |

## 实现备注

- AS upload 用 KB 模式(无 conversationId)以便同时建 KB file node,这样 WORKER 既可走 `as.download` 也可走 `kb.file_download`
- runner Phase 2 优先用 `kb.tree_roots` + name 匹配 + `page_id` → `kb.page_content` 三段式找页面,避开 `kb.pages` 列表(历史有 500/502 问题)
- sha256 一致性由 "content byte-for-byte equal to canary body" 间接保证,且 4 项 cross-POV 内容比对也是同等强度

## 与单 agent AS smoke 的关系

| 维度 | smoke-11 single-agent (AS only) | smoke-5 multi-agent (本) |
|---|---|---|
| Actor 数 | 1 | 2 |
| AS 验证点 | upload + download 自洽 | upload + download + **cross-actor 可见 + cross-actor sha256 一致** |
| 二次处理 | 单 agent 自己 | LEAD 上传,WORKER 二次处理写 KB |
| KB 归属 | 同 actor | **跨 actor**(LEAD 上传文件,WORKER 写 page) |

## 容错与边界

- 若 WORKER 加了前后缀(比如 "下面是文件内容:\n..."):#2 / #3b 挂
- 若 WORKER 没找到 file(走错路径):Phase 2 超时
- 若服务端把 page creator_id 存成 identity_id 而非 member_id:#4 挂(cws-kb #201 fix 验证点)
