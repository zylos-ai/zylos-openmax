# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.63] — 2026-06-24

### Fixed

- **fix(comm-bridge): handleConfigUpdate 即时同步 + 错误日志修正**。收到 system 事件（group_mode_changed 等）更新本地 config 后，立即调 `syncConfigToComm()` 回报 cws-comm，不再只依赖 5 分钟定时兜底。同时将 `syncConfigToComm` 的 404 响应和 `makeOrgFrameDispatcher` 的 unknown frame type 从 `log()` 改为 `warn()`，确保异常写入 error.log。

## [1.0.62] — 2026-06-24

### Fixed

- **fix(comm-bridge): sync 游标修正 + dedup 加固 — 根治消息重放** (Issue #8ffdac40)。cws-comm 有两套独立 seq：per-conversation 消息 seq 和 per-user org-wide inbox seq。sync API 期望 inbox seq 但 coco-workspace 一直存 per-conversation 的消息 seq 作为 `last_seq`，导致重启后游标指向错误位置，拉回大量已处理消息。改动：
  - **P0**: 新增 `sync_seq` 字段（inbox seq）替代 `last_seq`；`syncMissedEvents` 只从 sync response 的 `ev.seq` 更新游标，不再被实时 WS 消息的 per-conversation seq 污染；首次连接通过 `initSyncSeq` 初始化游标位置
  - **P1**: dedup 窗口 500→3000（覆盖 SYNC_MAX_EVENTS 的 1.5×）
  - **P2**: 新增 `ackSync` — sync 完成后向 cws-comm 确认已处理的最高 seq
  - **P3**: 移除 `createDeduper` 的 `ttlMs` 死参数；清理 `last_seq` 相关注释
  - 向后兼容：首次升级自动从 `last_seq` 迁移到 `sync_seq`

## [Unreleased]

### Added

- **Skill 强制：`dependsOn` 必须使用上游 Task 的 `task.id`**。实例化 Sub-task 时，下游 Task 的 `dependsOn` 要用先建出来的上游 Task 返回的 `task.id`（先建上游、拿到 id、再设下游）。调度中心的「依赖就绪」开工通知与 `task.start` 开工闸都按 task.id 匹配；用错 id 会让依赖边失效——下游 Task 永不被通知、过不了开工闸、无报错地永久卡在 assigned。动机：concurrent-roles 探针实测复现，并已在 cws-work 侧加 `CreateTask` 校验兜底（!87）。
- **Skill 行为护栏：绝不隐式创建 Project**。项目归属只能"选已有"或"用户明确要求时新建"——即便用户提到某个项目名而 bot 查不到同名项目，也禁止擅自建一个兜底，必须回过头问用户（指哪个已有项目，还是要新建）。`project.create` 仅在人类明确指示新建时才调。动机：bot 隐式新建项目会让随后建的 Issue/Task/产出全落到错的项目上下文，前功尽弃（concurrent-roles 探针实测复现：lead 找不到指定项目就自建同名项目，工作落到游离项目里）。
- **Skill 行为护栏 #11/#12：激活即开工 + backlog 创建即澄清**。收到 `issue.activated`（owner 经 `issue.activate` 激活 backlog Issue）后，Lead **直接 `issue.start_execution` 开工**，不再回头问 owner「要不要开始 / 保持 backlog」——激活是 owner 最新的显式开工信号，压过描述里旧的「先不开发」备注；执行中若上下文确有缺失，DM owner 补**需求**（而非问许可）。配套：创建 backlog Issue 时主动 DM owner 做需求澄清，让上下文在 backlog 阶段就完备，激活后即可直接执行。

### Changed

- `core.project_list` 默认按 `status=active` 过滤。按名称解析归属项目时不再匹配到已归档项目（归档同名项目会让模糊匹配产生歧义）。需要归档项目时显式传 `status:"archived"`。

## [1.0.43] - 2026-06-18

### Added
- **Issue owner support in TM CLI**: `issue.create` now forwards optional
  `ownerMemberId` as `owner_member_id`, aligning with cws-work issue owner /
  owner-only acceptance semantics.

### Changed
- **TM Skill guidance now treats Issue owner as acceptance authority**:
  create Issues with `ownerMemberId` set to the requesting human when an Agent
  creates on their behalf; delivered Issues must be accepted/rejected by that
  owner, not by the Agent/Lead.

## [1.0.42] - 2026-06-17

### Changed
- **Owner and config sync moved to periodic timer (5 min)**: `syncOwnerFromCore`
  and `syncConfigToComm` no longer run on WS connect; both execute every 5 min
  via a single `startPeriodicSync()` timer. Avoids blocking WS setup.

### Removed
- **`notifyPolicyChanged()` removed**: policy enforcement is code-level
  (`shouldHandleMessage`), not LLM-level; notifying the agent via C4 on
  policy changes served no purpose.

## [1.0.41] - 2026-06-17

### Added
- **Org context in message envelope**: inbound messages now include the source
  org name/id in the tag line (e.g. `[COCO DM] (org: COCO)`), so the agent
  knows which org to operate in when serving multiple orgs simultaneously.
- **Multi-org awareness in SKILL.md**: added guidance to always operate within
  the org indicated by the message tag; never cross-org.

## [1.0.40] - 2026-06-17

### Added
- **Typing indicator via emoji reaction**: on message receive, adds 👀 reaction
  (configurable via `message.receive_reaction_code`); reaction is removed when
  the agent replies or after 120 s timeout. Graceful shutdown cleans up all
  active reactions. (`src/comm-bridge.js`, `scripts/send.js`)

### Fixed
- **Reaction removal for non-reply sends**: `markTypingDone` was only triggered
  on explicit `reply-to` sends; normal conversation sends (the default path)
  never wrote the `.done` marker. Now uses `conversationId` as fallback key,
  and the poller matches by both `messageId` and `conversationId`.

## [1.0.31] - 2026-06-16

### Added
- **`task.start`** (`src/cli/tm.js` → `POST /tasks/{id}/start`): v0.7 cws-work
  split claim/start. Claim now ONLY assigns a task (pending → assigned);
  `task.start` is the new step that actually begins work (assigned → running),
  opens the attempt, and enforces the `dependsOn` gate. Worker 接活两步:
  `task.claim` → `task.start`.
- **`issue.terminate`** (`POST /issues/{id}/terminate`, body `{reason?, source?}`):
  提前终止一个未结论 Issue → `terminated`. The server cascades cancellation to
  non-terminal Tasks and emits `issue.terminated` for the Lead to run cleanup.

### Changed
- **`task.claim` semantics**: no longer auto-runs or auto-creates an attempt; it
  only assigns (pending → assigned). The dependency gate moved from claim to
  `task.start`.
- **SKILL.md** state machine + guardrails updated for v0.7: new `assigned` Task
  state and `terminated` Issue state; archive is now terminal-only
  ({accepted, terminated}); added the **提前终止善后 SOP** (Lead handles
  `issue.terminated`: no revival, three-bucket triage, external irreversible
  actions decided with the human, closure message).
- `references/tm-operations.md`: documented `task.start` / `issue.terminate`,
  tightened `issue.archive` to terminal-only, fixed `task.claim` and
  create-with-assignee descriptions; command count 38 → 40.

## [1.0.21] - 2026-06-12

### Added
- **Agent owner is now synced from cws-core, the authoritative source**
  (`src/comm-bridge.js`, `src/lib/config.js`, `src/cli/comm.js`). An agent's
  owner can be reassigned server-side via cws-core
  (`POST /api/v1/platform-agents/{member_id}/transfer-owner`). On every WS
  (re)connect the bridge pulls its own member record and, when core reports a
  different `owner_member_id`, updates both the live in-memory org config and
  `config.json` — no restart needed. Pull-based by design: ownership is never
  mutated from a pushed WS payload (a forged frame must not be able to hand the
  bot to an attacker); the authoritative read is an authenticated GET.
- **`comm.get_owner` / `comm.set_owner` / `comm.sync_owner` CLI commands**
  (`src/cli/comm.js`) for inspecting and reconciling the local owner cache
  against core (manual / trigger path; the running service auto-syncs on each
  reconnect). Plus `setOwner()` in `src/lib/config.js` — an authoritative
  overwrite (vs `bindOwner`'s first-DM no-op-if-bound).

### Changed
- **First-DM owner auto-bind is now an explicit fallback** — it only takes
  effect when cws-core has no owner recorded for the agent. When core reports
  an owner it always wins. (`src/comm-bridge.js`)
- **Owner edits to `config.json` now apply live** via the config watcher (in
  place, no restart) — same treatment as access-policy edits. `org_id` /
  `api_key` / `self` remain structural (restart required). (`src/comm-bridge.js`)

## [1.0.19] - 2026-06-11

### Fixed
- **Media messages (image/file) rendered as a blank bubble; captions are now
  carried with the file** (`scripts/send.js`, `src/lib/message.js`).
  `sendMediaMessage` posted `content.body = {}`, while cws-fe's own web client
  sends `body = { file_name, text }`; the empty body left the file/image card
  blank and dropped any caption (forcing a separate follow-up text message).
  `sendMediaMessage` now sends `body: { file_name, text? }` matching the web
  client, and `parseMediaPrefix` supports an optional newline-separated caption
  after the path (`[MEDIA:file]/path\n<caption>`) instead of merging it into the
  path (which previously caused an ENOENT send failure). Verified live against
  cws-int. (GitHub #31)

### Changed
- **Message-dedup retention `maxEntries` is now configurable (default raised
  20 → 500)** (`src/comm-bridge.js`, `src/lib/config.js`). Read from
  `config.message.dedup_max_entries` if set, else `DEFAULT_DEDUP_MAX_ENTRIES`
  (500) — mirroring the existing `dedup_ttl` override pattern. The seen-id
  window must span a full reconnect/restart catch-up (up to SYNC_MAX_EVENTS =
  2000 events); at 20, any restart whose catch-up re-pulled more than 20
  messages let the older tail age out of the window and replay as "new" inbound
  messages (observed twice during v1.0.1x upgrade restarts). 500 covers normal
  restarts and typical catch-ups, and operators can raise it via config without
  a code change. No message was ever re-executed — dedup only affects delivery,
  not action — but the replays are noisy. (GitHub #30)

## [1.0.18] - 2026-06-11

### Fixed
- **DM access control now always allows the bound owner, regardless of
  `dmPolicy`** (`src/comm-bridge.js`). Previously the DM branch checked
  `open` / `allowlist` / `owner` policies without an owner short-circuit, so
  under `dmPolicy=allowlist` the bound owner's own DMs were dropped (and the
  sender got `NOTICE_DM_NOT_ALLOWED`) unless their `member_id` was also
  manually present in `dmAllowFrom`. The group branch already had an owner
  exemption (`senderIsOwner && mentioned`); the DM branch did not. Added a
  `dm:owner-exempt` short-circuit at the top of the DM branch to mirror it.
  Matches KB "CWS Issue 汇总 — 2026-06-09" #34 (GitLab coco-workspace #81).
  The auto-bind path (first-ever DM under `owner` policy with no bound owner)
  is unchanged.

## [1.0.17] - 2026-06-11

### Changed
- **Reworked the skill-flow injection: moved from a leading `<coco-workspace>`
  tag to an imperative directive placed INSIDE `<current-message>`, right after
  the user's words** (`src/lib/message.js`). Motivation: a leading
  component-named XML tag tends to be read as ignorable envelope/metadata
  (banner-blindness on every message), so task requests (e.g. "do a code
  review") sometimes weren't run through the task flow. Post-user placement
  uses recency + co-location with the actual ask so the directive can't be
  dismissed as envelope. New wording (English) is imperative, names task verbs
  (do-it-for-me / review / analyze / develop / integrate / research), and
  requires: for a **human** task, classify simple vs complex, register
  Issue→Task, and run the matching flow (simple = light; complex = heavy +
  Blueprint approval) before acting — don't answer as chat. `enforceSkillFlow`
  still gates the injection.

### Changed
- **Promoted "always use the coco CLI, never hand-roll BFF REST" from a 常见错误
  table row to a top-level iron rule in SKILL.md body** ("服务调用铁律"), placed
  just before the task-classification flow so it's seen whenever the skill is
  loaded. Motivation: an agent (with the skill installed) hand-rolled BFF REST
  and guessed the wrong nested path for issue-update (`PATCH
  /projects/{id}/issues/{id}`) instead of the flat `PATCH /issues/{id}` the CLI
  uses. The rule now states all TM/KB/AS/Comm/Core ops go through
  `src/cli/{tm,kb,as,comm,core}.js` and directs agents to run the CLI / read the
  ops doc rather than guess REST paths. Kept the rule general — the exact
  endpoint/field details (flat-vs-nested write paths, accepted PATCH fields)
  stay in the CLI and `references/*-operations.md` as the reference. Strengthened
  the matching 常见错误 row to point at the new rule.

### Changed
- **Corrected the complex-task dependency model to bot-driven self-claim
  (status must reflect reality).** v1.0.14 described dependent steps as
  "auto-advancing" to running when their predecessor completes — but the
  cws-work backend has no such auto-advance, and more importantly auto-flipping
  a task to RUNNING without a bot actually executing it makes the status lie.
  Revised the flow (复杂任务流程 step 5/6) and guardrail #9:
  - On instantiation, **dependent steps are created WITHOUT `assigneeId`** so
    they sit in 待办 (pending); only steps with no unmet dependency are created
    WITH `assigneeId` (auto-claim → 进行中). The planned executor of a dependent
    step is recorded in the Blueprint step, not on the task, until claim time.
  - Advance is **bot-driven**: the finishing bot notifies the downstream bot
    (bot-DM), which then `task.claim`s its own task (claim validates
    `dependsOn`) → becomes assignee → 进行中 → executes. RUNNING only ever flips
    when a real bot picks the task up — no phantom "in progress".
  - Rationale: creating a dependent task WITH `assigneeId` triggers cws-work's
    create-time auto-claim (which does NOT check `dependsOn`), forcing it
    straight to running and leaving 待办 empty.
  - Added matching 常见错误 rows (don't pass assigneeId for dependent steps;
    don't expect backend auto-advance).

## [1.0.14] - 2026-06-10

### Changed
- **SKILL.md: complex-task guardrail now mandates one-shot instantiation of all
  Blueprint steps.** After a Blueprint is approved, the Lead MUST instantiate
  *all* steps as Tasks at once with their `dependsOn` dependencies set —
  piecemeal "create one step at a time as you go" is now explicitly forbidden.
  Dependency-driven flow: independent steps enter `running` (进行中) in parallel;
  dependent steps wait in `pending` (待办) and auto-advance to `running` once
  their predecessor is `done`. This makes the kanban/task panel show the full
  DAG of an issue from the start (what's running / waiting / blocked). Documents
  the board semantic: **待办 = planned-but-dependency-blocked steps**, not
  not-yet-decomposed steps. Added a matching row to the 常见错误 table.
- **Renamed the skill from `coco-agent` to `coco-workspace`** for naming
  consistency — frontmatter `name`, and the per-message injected directive tag
  `<coco-agent>` → `<coco-workspace>` (src/lib/message.js; directive body
  already referenced "coco-workspace skill"). No code parses the tag literally,
  so the rename is behavior-neutral.
- **Trimmed redundant skill text (conservative dedup; 3-layer reinforcement
  structure kept):** removed the redundant "强制加载提示" note (enforcement lives
  in code, not in a skill declaration); consolidated the duplicated
  one-shot-instantiation wording between 复杂任务流程 step 6 and guardrail #9
  (step 6 is now the authority, #9 a terse red-line pointer); merged two
  near-identical Blueprint anti-pattern rows in the 常见错误 table into one.

## [1.0.13] - 2026-06-10

### Fixed
- **Dedup retention is now count-based instead of time-based (TTL).** The
  message_id deduper previously evicted ids after a 5-minute TTL. A
  reconnect/restart catch-up can replay up to `SYNC_MAX_EVENTS` (2000) events
  regardless of how long the bot was offline, so after an outage longer than the
  TTL the replayed ids had already aged out — letting duplicates leak back into
  delivery. `createDeduper` now retains the most recent `maxEntries` ids
  (default 5000, well above the catch-up cap) and drops the TTL sweep entirely;
  `ttlMs` is kept only for call-site backward-compat. `comm-bridge.js` wires the
  persistent deduper with `maxEntries: 20` — enough for a normal restart, where
  catch-up only re-pulls a handful. Caveat: an outage long enough that a single
  catch-up re-pulls >20 messages could replay the tail beyond the most-recent
  20; bump `maxEntries` to cover longer outages if needed.

## [1.0.12] - 2026-06-10

### Fixed
- **HOTFIX: revert the global seq-floor delivery gate from 1.0.10 — it dropped
  live messages and caused a delivery outage.** The 1.0.10 gate assumed `seq`
  was a per-org monotonic cursor and dropped any inbound with
  `seq <= sessionRef.last_seq`. In reality `seq` is **per-conversation**: after a
  reconnect catch-up advanced the single org-wide `last_seq` to a high value
  (from one busy conversation), brand-new messages in other conversations (with
  lower per-conversation seq) were misclassified as "already delivered" and
  silently dropped — no messages got through. Removed the seq gate entirely.
  Duplicate suppression now relies solely on the **id-based deduper**, which the
  1.0.10 change also made **persistent** (`runtime/dedup.json`) — that part is
  safe and is kept, so restart/reconnect still gets reduced (id-based) replay
  protection without the over-dropping bug. `last_seq` remains the catch-up
  cursor only. Lesson: never gate delivery on a per-conversation seq with an
  org-wide cursor.

## [1.0.11] - 2026-06-10

### Changed
- **post-install now gates env-vs-interactive on `COCO_API_KEY`.** Previously the
  hook chose its path purely by TTY (interactive on a terminal, env-driven
  without one). Now: if `COCO_API_KEY` has a value, the hook takes **everything**
  from env vars (borrowing the same env keys as `scripts/init-coco-workspace.sh`:
  `COCO_BFF_URL` / `COCO_WS_URL` / `COCO_IDENTITY_ID` / `COCO_MEMBER_ID` /
  `COCO_ORG_ID` / `COCO_ORG_NAME` / `COCO_OWNER_*` / `COCO_SELF_NAME` /
  `COCO_CF_ACCESS_*`) and writes config with **no prompts — even on a TTY**.
  When `COCO_API_KEY` is absent, behavior is **unchanged**: interactive prompts
  on a TTY, otherwise the non-interactive env + auto-register bootstrap. Minimal
  change — only the path-selection gate (`useEnvPath = hasEnvApiKey || !isInteractive`)
  was added; the interactive and env blocks themselves are untouched, so the
  existing idempotency (existing `agent.api_key` is never overwritten) and the
  auto-register fallback are preserved.

## [1.0.10] - 2026-06-10

### Fixed
- **Duplicate message delivery after a service restart / WS reconnect.** The
  inbound deduper was in-memory only (`createDeduper`, a TTL Map), so a process
  restart wiped it; the persisted `last_seq` cursor was only *advanced* after
  forwarding and never used to *gate* delivery. On restart/reconnect the
  catch-up re-sync re-pulled recent messages and, with the deduper empty, they
  were re-delivered as new (observed as a burst of already-handled messages).
  Two fixes:
  - **Persistent seq floor (primary)** — `comm-bridge.js` now drops any inbound
    whose `seq <= sessionRef.last_seq` right after seq is hoisted (covers both
    live frames and sync catch-up). Since `last_seq` is persisted to
    `runtime/session.json` and reloaded on warm restart, an already-processed
    message can't be re-delivered even after the in-memory deduper resets.
    `last_seq` is still advanced only after a message is forwarded, preserving
    exactly-once delivery.
  - **Persistent deduper (belt-and-suspenders)** — `createDeduper` gained an
    optional `persistPath`; the seen-id window is backed by `runtime/dedup.json`
    (debounced atomic writes, TTL-pruned on load) so it survives a restart and
    covers the narrow crash-window case where a message was forwarded but
    `last_seq` wasn't yet saved. Best-effort: fs errors degrade to in-memory.
  - Scope: `src/comm-bridge.js` + `src/lib/ws.js` (+ `RUNTIME_DIR` export from
    `src/lib/session.js`). No protocol or cross-component changes.

## [1.0.9] - 2026-06-10

### Added
- **Forced skill-flow directive injected into every inbound envelope
  (`message.enforceSkillFlow`, default true) — enforcement L1, belt-and-suspenders
  on top of the v1.0.7 imperative description.** A `SKILL.md` is load-on-demand
  guidance, not a runtime gate: an agent only follows the task flow if it
  actually loads + obeys the coco-agent skill on that message. The skill
  description (v1.0.7) already nudges this, but per Gavin's directive we now also
  inject the rule into the message itself. `formatInboundForC4` leads every coco
  inbound message with a short `<coco-agent>` directive block (mirrors the
  existing `<smart-mode>` injection) telling the agent to **load the coco-agent
  skill and run its task flow before handling** — judge task vs. chat; if a task,
  confirm project + KB, register Issue→Task (whoever executes creates it), follow
  the simple/complex flow, and wait for the initiator's acceptance before
  set_acceptance/archive; bidirectional DM-permission check before cross-agent
  dispatch. The block is deliberately terse (a pointer, not the full skill) to
  keep per-message token cost minimal. The rule **travels with the component**:
  upgrading coco-workspace on any bot auto-applies it, no per-bot instruction
  edits. Toggle off via `config.message.enforceSkillFlow = false`. Note: still
  strong guidance, not a hard gate — a true 100% gate needs server-side
  enforcement at task intake (cws-core). Revives the approach from PR #18
  (previously closed in favor of the description-only route).

## [1.0.8] - 2026-06-10

### Docs
- **Complex tasks now hard-require a Blueprint + approval (was descriptive, now a guardrail).**
  The complex-task flow already *described* generating a Blueprint and getting
  it approved, but nothing forbade running a genuinely complex job in `light`
  mode — decomposing it straight into a pile of Tasks and starting work,
  skipping the blueprint and its approval gate. That shortcut hollows out the
  complex-task flow (no plan, no approval). SKILL.md now states the constraint
  explicitly in three places:
  - **判断简单/复杂** section: a new callout — *复杂任务 = heavy 模式 + Blueprint（强制，不可绕过）*；
    `light` mode is only for single-output/single-agent simple tasks; anything
    multi-step / multi-agent / dependency-bearing must go heavy + Blueprint;
    when unsure, ask.
  - **复杂任务流程** steps 3–4: generating the Blueprint and passing approval are
    marked mandatory gates — no Task may be instantiated before the Blueprint is
    approved.
  - **行为护栏** new rule 8 + two 常见错误 rows: a complex task run via `light` to
    bypass the blueprint, and instantiating Tasks with no approved Blueprint,
    are both named as errors. Per Gavin's directive.

## [1.0.7] - 2026-06-09

### Changed
- **Skill `description` rewritten into an imperative load-and-follow directive.**
  The old description ("…首次行为决策时加载") was too soft — agents (even ones on
  the latest skill) judged a request answerable directly and never loaded the
  full SKILL.md, so the task flow never triggered. The description is the exact
  signal the model uses to decide whether to load a skill, and it's **always in
  context** (auto-discovered, prompt-cached) and **travels with the component**
  (no per-bot CLAUDE.md edits). It now says: any message received via
  coco-workspace → before handling a task, **must load and obey this skill** →
  judge task vs. chat; if a task, run the full flow (confirm project + KB →
  register Issue→Task [whoever executes creates it] → execute → initiator
  acceptance before completion/archive). Cost: the full skill loads at most once
  per session, then is cached. Chosen over per-message envelope injection
  (cheaper, portable). Honest limit: still strong guidance, not a hard runtime
  gate — a 100% gate needs server-side enforcement at task intake (cws-core).

## [1.0.6] - 2026-06-09

### Docs
- **Cross-agent delegation: DM-permission + whoever-executes-creates-the-task; acceptance gates completion.** Three fixes after a real delegation failure (a Worker finished but its bot-DM completion report never reached the Lead):
  - **DM permission at dispatch (root cause)**: a Worker's report DM is dropped when the Lead's `dmPolicy` is `owner`/`allowlist` and the Worker isn't allowlisted — so the Lead never learns the task finished. SKILL now mandates: before delegating, add the Worker's `member_id` to the Lead's `dmAllowFrom` (set `dmPolicy=allowlist` if needed) **and** confirm the Worker's policy allows the Lead. Corrected the stale "Worker reply surfaces via WS" claim in the cross-agent section.
  - **Whoever executes creates the Task**: the Lead creates only the **Issue** + conveys the goal; the **assigned bot creates its own Task** under that Issue and claims it (Lead no longer pre-`task.create({assigneeId})`). Reconciled the role-model note (carved out the "register your own delegated work" exception) and reordered the simple-flow steps (confirm executor → create Issue → executor creates Task → execute).
  - **Human acceptance gates BOTH completion and archive**: a Worker's `attempt/task → done` only means "execution finished"; the Issue reaching **accepted (「完成」)** and **archived** both require the initiating human's 验收 — the bot never self-advances to accepted/archived.
  - New guardrail rule 7 + three common-errors rows.

## [1.0.5] - 2026-06-09

### Docs
- **Human-acceptance loop + project/KB-first ordering encoded in `SKILL.md`.**
  Two follow-ups requested after v1.0.4:
  - **Acceptance loop (issue 789741f8)**: the API already supports it
    (`issue.set_acceptance {accepted, source:im|explicit, rejectionReason}` →
    accepted→archived / rejected→rework), but the behavior wasn't encoded. SKILL
    now mandates: after delivery the bot **must request acceptance from the human
    who INITIATED the task** (the task initiator, identified via the issue's
    `originConversationId` — NOT the bot itself, NOT the owner, NOT an arbitrary
    user; a Worker relays via its Lead) **and must NOT self-accept/self-archive**;
    on 验收通过 → `set_acceptance(accepted:true)` → archived; on 退回 →
    `set_acceptance(accepted:false, rejectionReason)` → reopened → executing.
    Added as guardrail rule 6 + rewrote the "验收 & 状态收敛" step in both
    simple/complex flows + three common-errors rows. "任务做完≠结束，发起人验收通过才
    归档." Stale `pending_acceptance` wording corrected to the real
    delivered→accepted→archived states.
  - **Project/KB-first ordering (issue cbc24d82) — BOTH simple AND complex
    tasks**: simple-task flow gets an explicit step 4 「登记 Issue→Task」 and the
    complex-task flow's step 2 now requires confirming **project + KB** with the
    user before orchestration/execution — both enforcing *confirm project/KB →
    register Issue→Task → execute* (no execute-then-backfill).
  - **Executor-bot selection must be user-confirmed**: the bot must NOT
    auto-assign the executing agent. It **recommends** based on agent
    descriptions (with rationale) but the **task initiator confirms/chooses**
    which bot runs it (COCO-self only as a confirmed fallback). Updated the
    trigger note, simple-flow step 5, complex-flow step 5 (assignee chosen at
    blueprint-approval/instantiation), guardrail rule 2, +1 common-errors row.

## [1.0.4] - 2026-06-09

### Fixed
- **Image/file messages now carry a `[image]` / `[file: name]` label in the
  message body** instead of an empty `said:`. The bridge built the C4 envelope
  with the raw text as the body (empty when an image has no caption) and only
  appended the media as a `---- <kind>: <path>` suffix, so a bare image arrived
  as `said:` with nothing after it. `comm-bridge.js` now sets the body to
  `[image]` / `[file: <name>]` (with any caption appended), keeping the
  `---- <kind>: <path>` suffix for the local path (`src/comm-bridge.js`).
- **Quoted image/file messages now reach the agent — with content, not just a
  label.** A reply that quotes an image/file with no caption produced empty
  quoted text, so the whole `<replying-to>` was dropped (the agent couldn't even
  tell an image was quoted). `comm-bridge.js` now (1) labels the quoted media as
  `[image]` / `[file: <name>]`, and (2) downloads the quoted message's
  attachment and appends `---- <kind>: <path>` to the quoted text, so the agent
  can actually read the referenced media — not merely know it exists
  (`src/comm-bridge.js`).

### Docs
- **Mandatory task-lifecycle guardrails added to `SKILL.md`** (new
  「任务生命周期护栏（强制）」section under 行为护栏). Encodes the behaviors that
  were defined-but-not-followed: (1) **every** handling must first create a Task
  in TM (Issue→Task) before executing — no "small enough to skip" exception, (2)
  require user project/KB selection for deliverable tasks
  (default Inbox only for internal bug-filing), (3) notify the user at the
  moment of every issue/task status transition, (4) notify on every task
  completion, (5) auto-continue to the next task by priority after finishing
  one. Closes the agent-conformance issues (e9291b91, 15cd9249).
- **Hardened the project/KB-selection + Issue→Task trigger rules** after a
  smoke test showed a simple research task (gold-price analysis / connector
  list) skipping project/KB selection. Changes: the 触发 section now lists two
  non-skippable up-front actions for any 任务 — register Issue→Task, and confirm
  project + KB — explicitly **not exempt for "simple" tasks**; simple-task flow
  steps 2/3 make project/KB a mandatory question (禁止默默用默认); guardrail rule 1
  names skipping Issue→Task registration as the #1 root cause of "task flow not
  triggered"; guardrail rule 2 states simple research/analysis reports are NOT
  exempt. Closes cbc24d82.

## [1.0.3] - 2026-06-09

### Added
- **`COCO_RPC_LOG_FILE` env var** — append every RPC request/response line to a
  file, independent of the stdout sink (`COCO_RPC_LOG`). Use case: in
  integration phase we run smoke tests with `COCO_RPC_LOG=0` to keep the test
  client output readable, but still want full RPC traces on disk for
  post-mortem. Set `COCO_RPC_LOG_FILE=<path>` to enable file logging; unset or
  empty disables it. Format: `<ISO-timestamp> [rpc] → <method> <url> req: ...`
  / `[rpc] ← <method> <url> resp <status>: ...`. Wired in both
  `src/lib/client.js` (REST traffic) and `src/lib/token.js` (auth handshake).
  Best-effort: disk errors are swallowed silently so RPCs never fail because
  the log file is unwritable.
- **Outbound @-mention canonicalization** (`src/lib/mention.js`). cws-fe
  highlights a mention by matching `@<participant display_name>` in the message
  text (no member_id/token in the body — purely client-side name matching). The
  bridge now records the display names it sees per conversation
  (`recordParticipants`, from inbound sender + group context), and `send.js`
  runs `resolveMentions` to canonicalize any `@name` token in outbound text to
  the exact recorded display_name (case/spacing-tolerant, longest-name-first),
  so the agent's mentions land on cws-fe's matcher. Render-side highlighting for
  agent (`AGENT_TEXT`) messages is tracked in cws-fe issue #6; once that lands,
  these canonicalized mentions light up with no further change here.

### Fixed
- **Quoted/reply messages now reach the agent.** When an inbound message is a
  reply (cws-comm `parent_id`), the bridge fetches the quoted message and
  surfaces it as a `<replying-to>` block. Previously `comm-bridge.js` never
  built `quotedContent`, so replies were invisible to the agent even though
  `formatInboundForC4` already supported the block (`src/comm-bridge.js`).
- **`<group-context>` is now chronological (oldest→newest).** cws-comm
  `list-messages` with `before_seq` returns DESC (newest→oldest); the bridge
  passed that order straight through, so group history read backwards. It now
  sorts the fetched context ascending by `seq` before formatting
  (`src/comm-bridge.js`).

### Docs
- **Access-control section added to `SKILL.md`** documenting per-org
  `dmPolicy` (`open`/`allowlist`/`owner`), `groupPolicy`
  (`open`/`allowlist`/`disabled`), per-group `mode`/`allowFrom`, and
  `dmAllowFrom` — all keyed by cws-core `member_id`, with a config example and
  the DM/group independence note (closes #10).

## [1.0.2] - 2026-06-09

### Changed
- **Invitation CLI aligned with the create-time display-name contract**
  (cws-core #86). The invitee display name is now set when the invitation is
  created (stored on the invitation, becomes `members.display_name` on accept)
  rather than supplied at accept time:
  - `core.invitation_create` now sends a **required** `display_name`
    (accepts `displayName` or `display_name`; server rejects blank with 400).
  - `core.invitation_accept` no longer sends `display_name` — the body is now
    just `{token}` (sending `display_name` would be schema-invalid post-#86).
  - Usage text and `references/core-operations.md` (command rows + flow
    examples) updated to match.
- **Improved the COCO inbound message envelope** delivered to the agent, for
  parity with other C4 channels:
  - Resolve the sender's display name (and group-context senders) via a cached
    `GET /api/v1/members/{id}`, falling back to the raw member id only when no
    name is available.
  - Minimal `reply via` target: `<conversationId>[|reply:..][|thread:..]
    [|parent:..]` — the `[COCO TYPE]/` prefix (never used for routing) is
    dropped. `parseEndpoint` still accepts the legacy `[COCO TYPE]/...` form,
    so in-flight messages remain replyable.
  - The attributed utterance (`<name> said: <content>`) now lives inside the
    `<current-message>` block, with the conversation-type tag on its own line.

## [0.3.9] - 2026-06-03

### Fixed
- **Outbound `scripts/send.js` was POSTing the old `MessageContent[]` array
  body, which cws-core now rejects with HTTP 422.** cws-core's current
  `sendMessageRequest` (see `internal/transport/http/message.go`) takes a
  single `content` object plus a top-level `type` enum:

  ```
  { client_msg_id, type, content: {content_type, body, attachments}, parent_id? }
  ```

  v0.3.8 and earlier sent:

  ```
  { client_msg_id, content: [{type, body}], reply_to? }
  ```

  Rewrote `sendText` and `sendMediaMessage` to the new schema:
  - text and markdown → `type: 'AGENT_TEXT'`,
    `content: { content_type: 'text'|'markdown', body: { text }, attachments: [] }`
  - image and file → `type: 'IMAGE'|'FILE'`, `content.attachments` array
    with `{artifact_id, file_name, content_type, size_bytes}` (mediaId
    from cws-as upload IS the artifact_id; mediaId stays as the
    short-name in the bridge but maps onto attachments)
  - reply target field renamed `reply_to` → `parent_id` to match
    cws-core's `ParentID *string` field

- **Inbound message content arrived empty in the C4 envelope** because
  the bridge read `msg.content.text`, but after spreading the
  get-message detail into `msg`, `msg.content` is the structured
  `{content_type, body, attachments}` object — the actual text is at
  `msg.content.body.text` (or, as a string shortcut, at
  `msg.message.content`). `formatInboundForC4` therefore got an empty
  string and Claude saw `said: ` with no body. Bridge now extracts text
  via:

  ```
  msg.content?.body?.text
    || (typeof msg.message?.content === 'string' ? msg.message.content : '')
    || (typeof msg.content === 'string' ? msg.content : '')
    || ''
  ```

  and pulls the media reference from `msg.content.attachments[0]`
  (`artifact_id` / `file_name`) instead of the legacy `media_id` /
  `filename` flat fields. Legacy fallbacks are kept so older payload
  shapes still parse.

- **`fetchRecentMessages` context lines** had the same blind spot; they
  now also read `m.content.body.text` before falling back to
  `typeof m.content === 'string' ? m.content : ''`.

## [0.3.8] - 2026-06-03

### Fixed
- **`forwardToC4` was calling `c4-receive.js` with positional args
  (`<channel> <endpoint> <body>`), which `c4-receive.js` now rejects with
  `Error: Unexpected argument: coco-workspace`.** The comm-bridge interface
  switched to named flags (`--channel` / `--endpoint` / `--content` /
  `--json`) and zylos-telegram / zylos-lark already use the new form;
  zylos-coco-workspace never followed. The breakage was masked until
  v0.3.7 because the case-sensitivity bug in `shouldHandleMessage` was
  dropping every inbound DM before it ever reached the C4 forward step.
  - Switched `forwardToC4` to the named-flag form
    (`--channel <slug> --endpoint <endpoint> --json --content <body>`).
  - `execFile` passes argv array directly, so `body` is forwarded
    verbatim with no shell escaping required.
  - `--json` matches what telegram/lark already do, paving the way for
    parsing structured rejection responses in a future change.

## [0.3.7] - 2026-06-03

### Fixed
- **DMs were misrouted into the group/thread branch of `shouldHandleMessage`
  because of a case mismatch.** cws-core's HTTP API returns conversation
  type as an uppercase enum (`DM` / `GROUP` / `STRAT` / `BROADCAST` /
  `BRIDGE`, per `internal/transport/http/cwscomm_models.go`), but
  `src/comm-bridge.js` and `src/lib/message.js` compared against the
  lowercase wire values `'dm'` / `'group'` / `'thread'`. As a result a real
  DM with `conv.type === "DM"` fell through to the group branch and was
  dropped by `groupPolicy: "allowlist"` with an empty `groups{}`, surfacing
  as `drop ...: group:allowlist (<conv> not in groups{})` in the bridge
  log even when the inbound message was a 1-on-1 DM with the owner.
  - `shouldHandleMessage` and the late `convType` recompute in
    `handleIncomingMessage` now both normalize `conv?.type` to lowercase
    before classification.
  - `formatInboundForC4` likewise lowercases before checking
    `VALID_TYPES`, so the C4 envelope tag (`[COCO DM]` / `[COCO GROUP]` /
    `[COCO THREAD]`) reflects the actual conversation type.

### Added
- **Log every inbound WS message frame** at the entry of
  `handleIncomingMessage`, before dedupe / fetch. Previously only the
  REST `GET /messages/{id}` follow-up call left a trace, which made it
  hard to see whether a WS push had actually arrived. New format:
  ```
  [ws] [<org-slug>] message frame: id=<id> conv=<conv_id> sender=<sender_id>
  ```
  Duplicate-suppressed frames now also log
  `[ws] [<org-slug>] msg=<id> duplicate, skipping` instead of silently
  returning, so a noisy retry loop is visible in the log instead of
  appearing as a missing push.

## [0.3.6] - 2026-06-03

### Fixed
- **`ws_url` was sticky across re-installs.** Both `hooks/configure.js`
  and `hooks/post-install.js` only auto-derived `ws_url` from the
  (possibly new) `bff_url` when the existing `config.server.ws_url` was
  empty. A previous install's `DEFAULT_CONFIG` seed
  (`ws://127.0.0.1:8080/ws`) therefore survived after the operator
  pointed `bff_url` at a real cws-core, and the runtime kept trying to
  connect to localhost.
  - `configure.js` now re-derives `ws_url` from `bff_url` unconditionally
    when the operator did not supply `COCO_WS_URL`. Explicit
    `COCO_WS_URL` is still honored verbatim for the case where cws-comm
    is on a different host.
  - `post-install.js` Step 1 default now comes from the freshly entered
    `bff_url`, not from the stale `config.server.ws_url`. Operators can
    still override at the prompt.

## [0.3.5] - 2026-06-03

### Fixed
- **Frame watchdog killed healthy WebSocket connections at ~90s.**
  `src/lib/ws.js` only refreshed `lastFrameAt` inside the `'message'`
  event handler, which fires for data frames only. cws-comm sends
  WebSocket protocol-level **Ping** control frames every 30s
  (`internal/transport/ws/conn.go` `RunPingLoop`), and the npm `ws`
  library auto-replies with Pong frames — but those control frames fire
  the `'ping'` / `'pong'` events, NOT `'message'`. So even on a perfectly
  healthy connection the watchdog saw "no frames received within the
  65 s window" at its third 30 s tick and called `ws.terminate()`,
  producing a misleading abnormal-close cycle (code 1006).
  - Subscribed `ws.on('ping')` and `ws.on('pong')` to also refresh
    `lastFrameAt`.
  - Added a single-line `[ws] ping received` debug trace so server-side
    Ping cadence is visible in `pm2 logs` (cheap — cws-comm default
    `PingInterval` is 30 s).

## [0.3.4] - 2026-06-02

### Breaking
- **`COCO_ORG_IDS` (plural, comma-separated) replaced by `COCO_ORG_ID`
  (singular).** The non-interactive install path now binds exactly one
  (agent, org) pair per prepare run, matching cws-agent-manager-sdk-go's
  `AgentInitialization.CoCoWorkspaceChannelAuth` proto field shape 1:1.
  Operators that need a single runtime to serve multiple orgs run the
  prepare hook once per org_id; the hook is idempotent (existing
  `config.agent.api_key` and existing `org_id` blocks short-circuit), so
  re-running is safe. The interactive (`zylos add`) flow keeps its
  multi-org loop unchanged.

### Added
- **Channel-auth-aligned org metadata env vars** in the non-interactive
  install path. An operator with a `CoCoWorkspaceChannelAuth` payload can
  map every field to env vars 1:1:
  - `COCO_ORG_NAME`        → proto `org_name`        → `orgs.<slug>.org_name`
  - `COCO_OWNER_MEMBER_ID` → proto `owner.member_id` → `orgs.<slug>.owner.member_id`
  - `COCO_OWNER_NAME`      → proto `owner.name`      → `orgs.<slug>.owner.name`
  - `COCO_SELF_NAME`       → proto `self.name`       → `orgs.<slug>.self.name`
  All four are optional; absent fields fall through to existing runtime
  defaults (`owner` auto-binds on first DM under `dmPolicy=owner`,
  `self.member_id` auto-fills from JWT claims on first WS connect,
  display names start empty).
- `seedOrg(orgId, opts)` refactor: takes an options object instead of a
  positional `memberId` arg so the five org-shape fields stay named.

### Mapping reference
`proto AgentInitialization.CoCoWorkspaceChannelAuth → env var`:

| proto                       | env var                |
|---|---|
| `server.bff_url`            | `COCO_BFF_URL`         |
| `server.ws_url`             | `COCO_WS_URL`          |
| `api_key`                   | `COCO_API_KEY`         |
| `org_id`                    | `COCO_ORG_ID`          |
| `org_name`                  | `COCO_ORG_NAME`        |
| `owner.member_id`           | `COCO_OWNER_MEMBER_ID` |
| `owner.name`                | `COCO_OWNER_NAME`      |
| `self.member_id`            | `COCO_MEMBER_ID`       |
| `self.name`                 | `COCO_SELF_NAME`       |

`identity_id` is **not** in the proto; the hook continues to require
`COCO_IDENTITY_ID` for the BYO path until the proto contract decides
whether to add it.

## [0.3.3] - 2026-06-02

### Fixed
- **BYO agent prompt never fires under `zylos add`.** The configure hook
  (`hooks/configure.js`) used to delegate to `hooks/post-install.js` via
  dynamic import. Because configure runs *before* the TTY-interactive
  post-install pass, post-install detected `process.stdin.isTTY === false`
  in that nested call and went down the env-driven non-interactive branch
  — which auto-registered the agent. By the time the real (TTY-interactive)
  post-install ran, `config.agent.api_key` was already set, so the idempotency
  guard short-circuited Step 2 and the v0.3.2 BYO prompt was never asked.
- The fix narrows `configure.js` to a single responsibility: read the stdin
  JSON, persist `COCO_BFF_URL` / `COCO_WS_URL` into `config.server.*`, exit.
  It no longer registers the agent, seeds orgs, or imports post-install.
  `zylos add`'s subsequent post-install invocation then runs in TTY mode
  with `config.server.*` pre-filled as defaults and prompts BYO + org_ids
  as designed in v0.3.2.

### Migration
- If you upgraded to v0.3.2 and the auto-register fired against your will,
  your `~/zylos/components/coco-workspace/config.json` already holds the
  unintended `agent.identity_id` + `api_key`. Two ways to recover:
  1. Delete config.json and re-run `zylos add coco-workspace`. The BYO
     prompt will fire correctly under v0.3.3+.
  2. Manually replace `config.agent.{identity_id, api_key}` with the values
     from your pre-provisioned agent, then set
     `orgs.<slug>.self.member_id` to the corresponding member_id.

## [0.3.2] - 2026-06-02

### Added
- **Bring-your-own (BYO) agent identity at install.** Step 2 of the install
  flow now asks three fields up front — `identity_id`, `api_key`,
  `member_id`. If all three are non-empty the install uses them verbatim
  and skips `POST /auth/register/agent` entirely. Any blank field falls
  back to the existing auto-register flow.
  - **Why:** when an agent was pre-provisioned elsewhere (e.g. via
    `POST /api/v1/platform-agents` from an admin UI), the operator already
    has these three IDs. Forcing a re-register would burn a second identity.
  - The provided `member_id` is applied to the **first** org_id entered in
    the loop (`orgs[first].self.member_id`), since a BYO member_id is by
    definition tied to one specific org. Subsequent orgs auto-fill their
    member_id from JWT claims at runtime as before.
  - Non-interactive (env-driven) path picks up `COCO_IDENTITY_ID`,
    `COCO_API_KEY`, `COCO_MEMBER_ID` with the same all-three-or-none gate.
  - Idempotency preserved: an existing `config.agent.api_key` still
    short-circuits the whole step.

### Changed
- `SKILL.md` `config.optional` adds the three BYO env vars (api_key marked
  `sensitive: true`).

## [0.3.1] - 2026-06-02

### Added
- **Verbose RPC logging.** `client.js` and `token.js` now print every
  outbound REST call as `[rpc] → METHOD url req: {...}` /
  `[rpc] ← METHOD url resp <status>: {...}`. Enabled by default in the test
  env; set `COCO_RPC_LOG=0` to silence (intended for production once Cloudflare
  Access plumbing is removed). 4xx/5xx responses log at `warn` level.

### Changed
- **Install seed: full default `orgs.<slug>` block.** Confirms the contract
  promised in v0.3.0 docs — when interactive install accepts an org_id, the
  written block now matches the layout operators are expected to edit
  manually:
  ```json
  {
    "enabled": true,
    "org_id":   "",
    "org_name": "",
    "owner": { "member_id": "", "name": "" },
    "self":  { "member_id": "", "name": "" },
    "access": {
      "dmPolicy":    "owner",
      "groupPolicy": "allowlist",
      "groups":      {}
    }
  }
  ```
  `dmAllowFrom` is no longer pre-seeded (runtime falls back to `[]` via the
  `access.dmAllowFrom || []` guard in `shouldHandleMessage`); `self.name`
  starts empty instead of `"Zylos"` so it doesn't leak a placeholder if the
  operator never edits it.
- `token.js` member_id write-back now seeds `self` as
  `{ member_id: '', name: '' }` (was `{ name: 'Zylos' }`) when the field
  is missing, matching the new install shape.

## [0.3.0] - 2026-06-02

### Breaking
- **register-agent contract aligned with current cws-core.** Previously the
  install hook sent `{ username, display_name }` to
  `POST /auth/register/agent`; cws-core now rejects those fields (HTTP 422)
  and the body must be empty `{}`. Old install transcripts have been failing
  since the cws-core auth refactor; this MR fixes the call.
- **Install prompt surface trimmed to the bare minimum.** Interactive install
  now asks only for `bff_url`, `ws_url`, then one or more `org_id`s in a
  loop. `username`, `display_name`, `member_id`, and per-org access policy
  are no longer asked at install time. `member_id` is auto-filled from JWT
  claims on first `/auth/agent/token` exchange; access policy defaults to
  `dmPolicy=owner` + `groupPolicy=allowlist` and can be edited in
  config.json afterwards.
- **`config.required` schema for `zylos add`** trimmed from five fields to
  one required (`COCO_BFF_URL`) plus two optional (`COCO_WS_URL`,
  `COCO_ORG_IDS` comma-separated). The legacy env vars
  (`COCO_AGENT_TICKET`, `COCO_AGENT_NAME`, `COCO_ORG_ID`,
  `COCO_SELF_MEMBER_ID`) are no longer read.

### Added
- **Multi-org JWT routing across the entire REST surface.** Previously
  `client.js` resolved the bearer token via `getAccessToken()` with no
  `orgId`, so multi-org agents fell back to the single-enabled-org or
  `COCO_ORG_ID` env var heuristic and could end up calling cws-core with the
  wrong org's JWT. New `getForOrg / postForOrg / patchForOrg / putForOrg /
  delForOrg` variants thread `orgId` straight through `doRequest` into
  `getAccessToken(orgId)`. `kbClient(orgId)` and `asClient(orgId)` also pass
  the org down, so every call from the per-org WS handlers, the CLIs, and
  the comm-bridge sync sweep uses that org's cached JWT.
- **JWT claim auto-fill for `self.member_id`.** When `token.exchange` returns
  an org-scoped JWT, the `member_id` claim is decoded and written back into
  `config.orgs[slug].self.member_id` if that field was empty. This lets
  interactive install stay one-shot and lets first-time agents respond to
  `@mentions` from the very first message after their JWT is minted.
- **Inflight Promise dedup** in `token.js` (per cache key: exchange / refresh
  / per-org). Concurrent boot of N orgs no longer fans out N parallel
  `/auth/agent/token` calls; the second-through-Nth caller awaits the
  first's Promise.
- **Identity-only JWT support** (`/auth/agent/token` body `{}`) — needed
  before an agent is in any org, e.g. to call `POST /api/v1/organizations`.
  `exchange('')` and `getAccessToken('')` mint and cache an identity-only
  JWT at `runtime/tokens/_identity.json`.
- **Bootstrap pre-mint.** `comm-bridge.js` now eagerly calls
  `getAccessToken(org_id)` for every enabled org before the first WS
  handshake, so `self.member_id` write-back lands before any inbound message
  hits the self-echo / @-mention filter. Failures are non-fatal — the WS
  urlProvider retries through the usual backoff loop.
- **Structured bootstrap logs** with `[install] / [bootstrap] / [token] /
  [ticket] / [ws]` prefixes; visible via `pm2 logs zylos-coco-workspace`.

### Changed
- Registration failure during install is now a **hard failure** (exit 1,
  config.json not written). Old behavior was to print a warning and let the
  operator retry by editing config.json — that left half-bootstrapped
  configs on disk.
- `token.invalidate()` distinguishes "clear all" (no arg) from "clear this
  org" (explicit org id, `''` for identity-only).

### Temporary — remove before production
- **`src/lib/cf-access.js`** hard-codes the `CF-Access-Client-Id` /
  `CF-Access-Client-Secret` service-token pair for `cws-int.coco.xyz`. Every
  outbound REST call (`client.js`, `token.js`, install hook fetch) and the
  WebSocket handshake (`ws.js`) spread `cfAccessHeaders()`. Production
  release MUST delete `cf-access.js` and the four import/spread sites it's
  referenced from.

## [0.2.5] - 2026-06-02

### Added
- `SKILL.md` frontmatter now declares the full lifecycle (modeled after
  `zylos-lark`), so `zylos add coco-workspace` drives the install
  end-to-end instead of stopping after download + register:
  - `type: communication`
  - `lifecycle.npm: true` → triggers `npm install --omit=dev`
  - `lifecycle.service.{type, name, entry}` → registers
    `pm2 zylos-coco-workspace` pointing at `src/comm-bridge.js`
  - `lifecycle.hooks.{post-install, post-upgrade, configure}` → wires
    the three hooks already in `hooks/`
  - `lifecycle.preserve: [config.json, logs/, runtime/]` → upgrade-safe
    fields
  - `lifecycle.data_dir` → declares the data root path explicitly
  - `upgrade.{repo, branch}` → `gitlab:coco-workspace/zylos-coco-workspace`
    on `main` (works with the existing zylos-core local patch that maps
    `gitlab:` repos to git.coco.xyz tarballs)
  - `config.required` → five fields (`COCO_BFF_URL`, `COCO_AGENT_TICKET`
    sensitive, `COCO_AGENT_NAME`, `COCO_ORG_ID`, `COCO_SELF_MEMBER_ID`)
    that `zylos add` will prompt the operator for.

- New `hooks/configure.js` — receives the prompted values as stdin JSON
  from `zylos add`, copies them into `process.env`, then delegates to
  `hooks/post-install.js`. This avoids reintroducing a `.env` round-trip
  (the canonical store remains `config.json`) while still letting the
  install flow drive the env-driven non-interactive bootstrap path that
  was added in v0.2.0.

### Behaviour after this version

```
zylos add coco-workspace --branch main
  → download from gitlab
  → npm install --omit=dev
  → prompt operator for 5 config fields
  → run hooks/configure.js (writes config.json via post-install)
  → run hooks/post-install.js again (idempotent no-op — api_key already
    set so registration is skipped)
  → start pm2 zylos-coco-workspace
```

## [0.2.4] - 2026-06-02

### Removed
- `agent.client_id` — generated by post-install as UUIDv4 but never read by
  the runtime. Dropped from `DEFAULT_CONFIG`, dropped from post-install
  generation, and stripped from existing configs (top-level and
  `agent.client_id`) by `hooks/post-upgrade.js`. Cleanup-only — no
  functional impact since the field was dead.
- `server.platform` — same story (never read by runtime). Dropped from
  `DEFAULT_CONFIG`. `hooks/post-upgrade.js` strips it from both
  `comm.platform` (legacy v0.3 location) and `server.platform`
  (intermediate v0.4 migrations).

### Changed
- `server.reconnect_max_delay` and `server.heartbeat_interval` are no
  longer in `DEFAULT_CONFIG`. Defaults are now hardcoded as constants in
  `src/comm-bridge.js`:
  - `DEFAULT_WS_RECONNECT_MAX_MS = 30_000`
  - `DEFAULT_WS_HEARTBEAT_MS     = 30_000`

  Behavior: `config.server.{reconnect_max_delay, heartbeat_interval}` are
  still honoured if set, but the `server` block can now drop down to just
  `{bff_url, ws_url}`. Existing configs that include the knobs continue
  to work — values present in config still take precedence over the
  hardcoded defaults.

## [0.2.3] - 2026-06-02

### Changed
- `message.context_messages` and `message.dedup_ttl` are no longer part of
  `DEFAULT_CONFIG`. Defaults are now hardcoded as constants in
  `src/comm-bridge.js`:
  - `DEFAULT_CONTEXT_MESSAGES = 5` (was 10; aligned with zylos-lark's
    `DEFAULT_HISTORY_LIMIT`)
  - `DEFAULT_DEDUP_TTL_MS = 5 * 60 * 1000` (unchanged; matches lark's
    `MESSAGE_DEDUP_TTL_MS`)

  Behavior: `config.message.context_messages` / `config.message.dedup_ttl`
  are still honoured if set, but the `message` block can now be **omitted
  entirely** from `config.json`. Existing configs that include the block
  continue to work — values present in config still take precedence over
  the hardcoded defaults.

## [0.2.2] - 2026-06-02

### Added
- **Reconnect catch-up**: `comm-bridge.js` now invokes `POST /api/v1/sync`
  after every successful WS open, pulling any conversation events
  (`{conversation_id, message_id, seq}`) with `seq > sessionRef.last_seq`
  and dispatching them through the normal message handler. Each event
  passes through the existing message dedupe, so a message that arrives
  via both WS and sync is processed once. First-ever connect with
  `last_seq=0` is a no-op. The sync sweep is bounded to 2000 events per
  open and paged at 100; further backlog is pulled on the next reconnect
  (or via the `comm.sync` CLI). Per-org `_syncInFlight` guard prevents
  overlapping sweeps from a rapid reconnect storm.

### Changed
- On WS close code `4003` (session expired), `last_seq` is now **preserved**
  (only the token cache is invalidated). Previous behavior wiped the
  org session entirely, defeating sync catch-up after a session expiry.

## [0.1.0] - 2026-05-19

### Added

- Project structure and directory layout
- Communication module: `comm-bridge.js` (WebSocket to C4 bridge) skeleton
- Service CLIs: `cli/{tm,kb,as,comm,core}.js` skeletons (stateless, JSON in/out)
- Skill layer: `SKILL.md` (L1+L2) + `references/*-operations.md` (L3 on demand)
- Shared infrastructure: `lib/{client,config,ws,message,media}.js`
- Design document `DESIGN.md` v0.2
