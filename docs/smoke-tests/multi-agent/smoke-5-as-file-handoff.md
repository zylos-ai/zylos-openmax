# Smoke 5 (multi-agent, NL) — cross-actor AS file hand-off

> Two live agent runtimes. LEAD uploads an artifact; WORKER finds it, downloads it, and uses its contents. Verifies AS visibility + sha256 integrity across actors.

## 目的

验证 ArtifactStore 中文件在同 org 不同 agent 之间的可见 + 完整性:

- LEAD 通过对话上传一份文件(包含已知字节内容)
- AS 落库,创建 artifact 记录 + KB tree 引用(creator=LEAD)
- WORKER 跨 actor 拉 artifact 列表,能看到这一项
- WORKER 下载内容,sha256 与 LEAD 上传时一致
- WORKER 把内容写到一个 KB page(模拟"二次处理")
- LEAD 拉 worker 写的 page,内容正确

## 流程

### Phase 1 — LEAD 上传 artifact
NL → LEAD:

> 我给你一段内容,完整内容如下(三引号之间是文件正文,不包含引号):
> ```
> # smoke-5 cross-actor 文件交付测试 ${TS}
> line1: alpha
> line2: beta
> line3: gamma
> ```
> 把这整段内容当一个文件保存进 artifact store,文件名 "smoke5-${TS}.md",mime 用 text/markdown。保存完之后告诉我 artifact id。

`waitForArtifact(predicate: filename includes "smoke5-${TS}.md")`

### Phase 2 — WORKER 拉取 + 写到 KB
NL → WORKER:

> Lead 刚在 artifact store 里上传了一个名字含 "smoke5-${TS}" 的 markdown 文件,你找到它,把里面的文字内容完整读出来,然后在 KB 建一个标题为 "Smoke5 W-${TS} 引用文件内容" 的 page,正文 = 文件原文(一字不改)。

`waitForKbPage(predicate: title includes "Smoke5 W-${TS}")`

### Phase 3 — LEAD 核验
NL → LEAD:

> 看一下 Worker 刚才写的 "Smoke5 W-${TS}" KB page,里面应该原封不动是你之前上传的 smoke5-${TS}.md 的内容。一致就回"已核验"。

(NL only; assertions run independently.)

## 断言(12 条)

| # | 断言 |
|---|---|
| 1 | AS 中存在一个 filename="smoke5-${TS}.md" 的 artifact |
| 2 | LEAD JWT 拉 artifact 元信息,creator member_id === LEAD.agent_id 或 member_id |
| 3 | LEAD JWT 下载 artifact 字节内容,sha256 与上传计算值一致 |
| 4 | WORKER JWT 拉同一 artifact,可见 |
| 5 | WORKER JWT 下载内容,sha256 与 LEAD POV 一致 |
| 6 | artifact mime === text/markdown |
| 7 | artifact size 与 KNOWN_BYTES_LENGTH 一致 |
| 8 | KB page "Smoke5 W-${TS} 引用文件内容" 存在 |
| 9 | KB page content === artifact 原文(一字不改) |
| 10 | LEAD JWT 拉 page content,与 WORKER 写入时内容一致(byte-for-byte) |
| 11 | KB page revision 数 = 1(WORKER 只写了一次) |
| 12 | artifact 的 creator !== KB page 的 creator(LEAD upload,WORKER write page) |

## 与单 agent AS smoke (smoke-11) 的关系

| 维度 | smoke-11 single-agent | smoke-5 multi-agent (本) |
|---|---|---|
| Actor 数 | 1 | 2 |
| AS 验证点 | upload + download 自洽 | upload + download **+ cross-actor 可见 + cross-actor sha256 一致** |
| 二次处理 | 单 agent 自己 | LEAD 上传,WORKER 二次处理 |
