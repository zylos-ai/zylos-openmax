# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.11.0] — 2026-07-23

First stable of the 2.11 line. Promotes the `2.11.0-beta.1` and `2.11.0-beta.2` prereleases to stable — no code changes beyond those two betas. Highlights: the first-boot inbox-replay fix (#79 / cws-fe #175) from beta.2 — a freshly provisioned agent no longer discards its owner-welcome / onboarding-activation DM, so the onboarding guidance actually arrives — plus beta.1's channel-liveness 404 backoff, the `[COCO …]` → `[OPENMAX …]` inbound-tag rebrand, and the empty-message fix. See the beta entries below for full per-change detail.

## [2.11.0-beta.2] — 2026-07-23

Beta prerelease bundling the first-boot inbox-replay fix (#79 / cws-fe #175). Pre-release — stable `zylos upgrade --check` does not pull `-beta` tags; use `--beta` to test. Promote to `2.11.0` (no suffix) once validated.

### Fixed

- **comm-bridge: first-boot now replays and dispatches the inbox backlog instead of discarding it (`src/comm-bridge.js`, `src/lib/inbox-ledger.js`).** On the first-ever connect (`sync_seq=0`) the bridge used to call `initSyncSeq`, which paged the whole inbox only to seek the cursor to the **end** and `ackSync` past everything — silently dropping the messages a freshly provisioned agent must act on (owner welcome + scheduler/onboarding activation DM). Combined with the runtime briefly starting a comm-bridge during the prepare phase (which connects, then drops right as those DMs arrive), a fresh agent never received its activation and sat idle — the greeting shows but the onboarding guidance never arrives (#79 / cws-fe #175, live-reproduced on INT). Now the first-connect path **replays `/sync` from seq 0 and dispatches each event** (`syncMissedEvents(..., { fromStart: true })`), so the backlog is delivered in order. Also, the first-boot replay clears **both** dedupe layers so a prepare-phase bridge that recorded-but-never-delivered a message cannot suppress it: (a) `inbox-ledger` gains `resetReceived()` (seq-level), called before the replay; (b) the message-id deduper (`runtime/dedup.json`, checked earlier in the handler than the ledger) is `forget()`-ten per replayed backlog entry — the first-boot events now carry a `_firstBoot` marker so the handler drops any stale id mark before its duplicate check. Without (b) the replay would still be swallowed by a tainted `dedup.json` even after (a). Additionally: if the durable ledger `acked_seq` is ahead of a lost/reset session cursor, the session cursor is seeded from it so a warm agent is not mistaken for a first boot and does not replay its whole inbox. `initSyncSeq` (seek-to-inbox-end) is removed. The full unacked window replay is bounded by the existing `SYNC_MAX_EVENTS` per-sweep cap. (closes #79)

## [2.11.0-beta.1] — 2026-07-21

Beta bundling the unreleased channel-liveness 404 backoff (was staged as 2.10.3, never tagged), the inbound-tag rebrand, and the empty-message fix. Pre-release — stable `zylos upgrade --check` does not pull `-beta` tags; use `--beta` to test. Promote to `2.11.0` (no suffix) once validated.

### Changed

- **Inbound conversation tag rebranded `[COCO …]` → `[OPENMAX …]` (`src/lib/message.js`).** The `TYPE_TAG` prefix the agent sees on each inbound message (`[OPENMAX DM]`/`[OPENMAX GROUP]`/`[OPENMAX THREAD]`) was a hardcoded brand string. The `(org: <name>)` suffix is unchanged (still config `org_name`); `parseEndpoint` still strips the legacy `[COCO …]/` prefix (and now `[OPENMAX …]/`) for back-compat — routing is unaffected (by conversation id). (PR #75)

### Fixed

- **comm-bridge: retry inbound content fetch; never forward an empty message (`src/lib/inbound-content.js`, `src/comm-bridge.js`).** The WS `message` frame carries only metadata; the body comes from `GET /conversations/{conv}/messages/{id}`. On failure that GET used to return `null` and the handler forwarded a metadata-only **empty** message. Now: retry once (`config.message.content_fetch_retries`, default 1; `content_fetch_retry_delay_ms`, default 400); if still failing, do **not** forward and do **not** advance read-state/cursor — realtime frames `forceReconnect()` so `/sync` replays in order, sync-replay frames just halt cursor advance (no reconnect storm); the incident is warn-logged. (PR #76, closes #13)
- **channel-liveness reporter no longer floods `error.log` on a persistent 404 (`src/lib/channel-liveness-reporter.js`).** On production, `PUT /api/v1/agents/{member_id}/channel-liveness` returns `404 page not found` on every attempt (the endpoint isn't deployed on that host, while `runtime-metrics`/`reported-policy`/`sync/ack` all 200). The reporter's existing `warnedEndpoint404` guard muted its *own* warn after the first 404, but the PUT was still **issued every ~60s** — so the shared HTTP client (`client.js`) kept logging an `[rpc]` request+response pair per tick, filling `error.log` indefinitely.
  - **A 404 is not transient**, so after `disable404Threshold` (default **1**) consecutive 404s the reporter now **stops issuing the PUT entirely** — which is what actually stops the log flood — and logs the condition **once** at warn level (no per-tick pair).
  - **Self-healing:** while disabled it re-probes once every `reprobeEveryTicks` ticks (default **180**, ≈ once per 3 hours at the 60s cadence); a successful probe re-enables the reporter (logged as recovered). Set `reprobeEveryTicks: 0` to stay disabled until restart.
  - **200 and other/transient errors (5xx, network) are unchanged** — they keep retrying every tick, and any non-404 outcome resets the consecutive-404 streak so it can't accidentally disable the reporter.
  - **Config.** New optional `channelLiveness.disable404Threshold` and `channelLiveness.reprobeEveryTicks` (wired through `comm-bridge.js`).
  - Note: the endpoint being absent is **server-side** (cws-core hasn't shipped the route to that environment); this change is the correct client behavior in the meantime. Tests extended in `src/lib/channel-liveness-reporter.test.js`.

## [2.10.1] — 2026-07-17

### Fixed

- **Client-side WS keepalive ping (`src/lib/ws.js`).** The WS client's frame-watchdog terminates the connection when no inbound frame arrives for `heartbeatIntervalMs*2 + 5s` (65s at defaults), and was designed assuming the SERVER pings every 30s to feed it. On prod the client receives **zero** server pings (they don't traverse the prod path), so on quiet orgs the watchdog starved every ~65-90s and the connection churned — close code **1006** every few minutes. On int, server pings arrive every 30s and it stayed stable, masking the issue.
  - **Fix:** the client now sends its own WS-level ping every `pingIntervalMs` (default **20000**, comfortably below the 65s watchdog window) starting on `open`. An RFC-compliant server — or the nearest terminating proxy — auto-replies with a pong, which the existing `on('pong')` handler uses to advance `lastFrameAt`. This feeds the watchdog without depending on server pings arriving, and keeps the pipe warm through intermediaries (the standard IM keepalive direction).
  - **Purely additive / client-side.** The server-side ping path, the watchdog, and cws-comm are unchanged. The ping timer is armed on `open` (guarded against double-arming) and cleared in `_clearTimers()` so reconnects/closes don't leak timers.
  - **Config.** New `config.server.ws_ping_interval_seconds` (seconds) overrides the 20s default; wired through `comm-bridge.js` alongside the other WS options.
  - If control-frame ping/pong ever turns out to be stripped end-to-end, an app-level JSON heartbeat (would need a cws-comm handler) is the documented fallback — not in this change.

## [2.10.0] — 2026-07-16

### Added

- **Channel-liveness reporter (`src/lib/channel-liveness-reporter.js`).** On the same ~60s periodic tick that drives runtime-metrics, openmax now enumerates the 13 IM channel components' pm2 online/offline status and self-reports it to cws-core via `PUT /api/v1/agents/{member_id}/channel-liveness` (HTTP 202). Body is `{ "channels": [{ "channel_type": ..., "online": ... }, ...] }`; identity is derived from the JWT (not the body).
  - **Reuses existing pm2/channel plumbing.** The channel → pm2-process mapping is the existing `CHANNEL_COMPONENT` table (its keys already are the cws-connect catalog `channel_type` values), and pm2 status is read via a single shared `readPm2Statuses` helper extracted from `channel-connector.js` (one `pm2 jlist`, also now used by `defaultVerify`). No new pm2 logic.
  - **Mirrors the runtime-metrics self-report path.** Uses the authenticated org-scoped client (`putForOrg`/`apiPath`) and does a single PUT per tick to the PRIMARY org only, resolved via the shared `selectPrimaryOrg` helper (extracted from `metrics-reporter.js` and reused by both reporters) with that org's `self.member_id`. cws-connect keys channel state on identity (cross-org-stable), so one report is sufficient. No new HTTP/auth path.
  - **Safety guard.** If `pm2 jlist` fails or returns nothing, the tick is skipped (warned once, re-armed on recovery) — never reports "all 13 offline" on a pm2 error. Best-effort: individual PUTs are guarded (a missing endpoint 404 is warned once then skipped) and the report never throws into the shared metrics loop.
  - **Config gating.** New `channelLiveness` block mirrors `metricsReport`: enabled unless `channelLiveness.enabled: false`; cadence via `channelLiveness.intervalSeconds` (default 60s).
  - E2E requires cws-core (with the channel-liveness endpoint) deployed to the targeted environment (currently prod openmax.com); code-complete but E2E-pending-deploy.

## [2.9.8] — 2026-07-16

### Security

- **Bump `ws` to `^8.21.0` (resolves to 8.21.1).** `ws` `<8.21.0` is affected by a high-severity WebSocket memory-exhaustion DoS (GHSA-96hv-2xvq-fx4p) from tiny fragments and data chunks; the lockfile previously resolved to the affected `8.20.1`. `npm audit` is now clean.

## [2.9.7] — 2026-07-15

### Fixed

- **Knowledge page links now use the `node_id` returned by `kb.page_create`.** The BFF create-page contract now returns the generated tree node ID together with page metadata, so the Skill no longer tells agents to list the parent folder and match on `page_id`. The frontend `node=` parameter still strictly requires the tree node ID; using the page `id` remains invalid.

## [2.9.6] — 2026-07-15

### Fixed

- **`issue.accept_delivered` now defaults to the Lead's documented text-card proxy source.** The CLI previously sent `source=explicit` when the Lead omitted `source`, so cws-work treated the Agent as a non-Owner and returned `WORK_ISSUE_ACCEPTANCE_FORBIDDEN`, even after the Owner had explicitly accepted in chat. The default now matches `issue.accept_plan` and the Skill contract: during the text-card simulation period, the Lead sends `source=text_card_proxy` on the Owner's behalf after explicit human acceptance; callers may still override `source`.

## [2.9.5] — 2026-07-15

### Fixed

- **Runtime-metrics CPU and memory are now container-scoped (cgroup), not node-level.** The reporter previously took CPU/memory from the zylos-dashboard's `/api/state`, which derives them from `os.cpus()` / `os.totalmem()` — not cgroup-aware, so inside a limited container they reported the *host node's* cores/RAM and host-wide utilization instead of the container's quota and actual consumption. New `src/lib/cgroup-resources.js` (a faithful port of `cws-zylos-runtime`'s ops-daemon `resources.go`, `pkg/opsdaemon`) reads the container's real figures: CPU from `cpu.max` / `cpu.stat:usage_usec` (v1 fallback `cpu.cfs_quota_us` / `cpuacct.usage`) with per-tick differential sampling of the cumulative counter; memory from `memory.max` / `memory.current` (v1 `memory.limit_in_bytes` / `memory.usage_in_bytes`) reporting the **working set** (`current − inactive_file`, matching `kubectl top`). cgroup v2 primary with v1 fallback; the `"max"` / `-1` / `PAGE_COUNTER_MAX` unlimited sentinels are all handled. **Disk stays sourced from the dashboard** — its `statfs` on the volume mount is already the correct container-visible scope. The reported payload shape is unchanged; only the source of the CPU/memory numbers moves. When the agent is **not** in a cgroup (external / non-containerized, `cgroup_version` "none") the reporter falls back to the dashboard's node-level CPU/memory (logged once) rather than reporting null. Unit coverage added for the collector (v2/v1, unlimited sentinels, differential sampling, counter reset, no-cgroup) and the reporter's fallback path.

## [2.9.4] — 2026-07-14

### Changed

- **onboarding-lead now sends the clickable project link to the user after `project.create` succeeds** (PR #60, closes the guidance gap behind cws-core board #135). The SKILL.md onboarding guide step ③ previously instructed the agent to create the Project + Issue and deliver, but never to send the clickable `/workspace`-prefixed project link — the link-format table existed, the "send it" instruction did not. Docs-only change.

## [2.9.3] — 2026-07-13

### Changed

- **Issue intake now matches the backlog-first contract.** `issue.create` requires both `ownerMemberId` and `leadAgentId`; omitting `backlog` records the Issue in backlog, while workflows that immediately plan and execute pass `backlog:false`. The Skill now routes work that belongs in another Project by creating a separate target Issue with the original link and necessary context, without moving, closing, or otherwise mutating the original Issue.

## [2.9.2] — 2026-07-13

### Fixed

- **`tm` CLI aligned with the current (post-MR!321) cws-core BFF contracts.** `project.list`, `issue.list`, and `issue.list_in_project` now forward the `query` search parameter; `project.create` forwards `knowledgeBaseId`, `memberIds`, and `isDefault` (project members are explicitly supplied via `memberIds` — the CLI does not inject the caller; Blueprint authors remain derived from the authenticated principal). Added organization-level `issue.list` and Project member add/remove commands. Comment listing now uses cursor pagination (offset pagination retained elsewhere). The shared HTTP client (`src/lib/client.js`) honors the documented `COCO_AUTH_TOKEN` compatibility variable. TM operation docs (`references/tm-operations.md`, `docs/dependency-coverage/cws-tm.md`, `SKILL.md`) refreshed — Task and Attempt transition documentation now lists only valid terminal targets — and CLI wire-contract tests added (`src/cli/tm.test.js`).
  **Deployment dependency:** the `query` search parameter and `is_default` on project create require cws-core MR!321 to be deployed. Until then, current cws-core silently ignores `query` (list endpoints return unfiltered results) and rejects `project.create` with `isDefault` with a 422 (`unexpected property body.is_default`). These capabilities activate automatically once MR!321 lands; no CLI change needed.

## [2.9.1] — 2026-07-13

### Fixed

- **Group @-mentions of the bot are no longer silently dropped when the hand-configured `self.name` drifts from the agent's real display name — and the authoritative name is now guaranteed ready before any message is processed.** cws-comm-native group messages carry the @ as plain text (no structured `mentions[]`), so mention detection matched only `orgs.<slug>.self.name` — a hand-set value that silently drifts (wrong case / suffix / stale after a rename), causing real @s to be dropped as `group:mention (not @-ed)`. Two-part fix: (a) mention detection now matches against BOTH the authoritative per-org `display_name` from cws-core (read from the existing owner-sync self-member GET, persisted as `self.display_name` via `setSelfDisplayName`, no extra API call) and the configured `self.name` (kept as an alias). (b) A startup/reconnect readiness barrier guarantees the authoritative name is hydrated BEFORE the WS can deliver or replay a single frame: `syncOwnerFromCore` returns an explicit `{ nameReady, reason }` (a skipped or failed self-member read can no longer be mistaken for success), and the new `lib/self-name-hydration.js` hydrator (JWT acquire → member_id write-back backfill → authoritative sync, bounded exponential-backoff retries, per-org sticky success) runs at two structural barrier points — the awaited pre-connect bootstrap, and the `WsClient` `urlProvider`, which is awaited before the socket object exists, covering the initial connect AND every reconnect's catch-up replay. Bounded fail-open so a core outage at boot can't keep an org offline forever: after retries the connection proceeds with the persisted last-known `display_name` when one exists, else with a loud `SELF-NAME NOT HYDRATED` warning and matching degraded to the configured `self.name` until the next reconnect / periodic 5-min sync heals it. Deterministic unit coverage (9 tests) includes the incident regression: drifted `self.name`, no cached `display_name`, and an immediate plain-text `@<core display_name>` replay frame handled correctly on first connect.

## [2.9.0] — 2026-07-12

### Docs

- Translated `SKILL.md` and all `references/*-operations.md` (as/comm/core/kb/tm) from Chinese to English. Documentation-only change: the always-loaded behavioral spec and on-demand operation guides are model-facing, and English is comprehended more reliably. No behavioral rules, commands, JSON keys/values, enums, IDs, or paths were altered; a faithful one-to-one translation. Also harmonized the SKILL.md Layer 3 index labels with the reference files' section headers (`Purpose` / `When to load this document` / `Out of scope for this document` / `Prerequisites`).

## [2.8.12] — 2026-07-12

### Fixed

- **Credit-arrears overdue gate now applies only to platform-managed agents — external / self-hosted agents are exempt.** The overdue gate was false-blocking EXTERNAL agents: credit-arrears enforcement is applied via billing → agent-manager → DisableApiKeys → gateway, which only affects platform-managed agents (they have an agent-manager runtime + gateway-managed LLM keys). External agents (self-hosted, bringing their own LLM key) have no agent-manager record, so the org-level `usage_snapshot.enforcement_suspended` flag can read true while their LLM still works — the gate would then drop their messages and send a spurious "out of credits" notice. `isOrgLLMSuspended` now resolves the agent's origin FIRST (via `GET /api/v1/members/{self.member_id}` → `agent_origin`, through the existing per-org authed cws-core client) and only proceeds to the plan-state / `enforcement_suspended` check when the origin is positively `platform_created`; `external_invited` or an unknown/unresolved origin returns "not suspended" immediately and skips the plan-state query entirely (fail-open — never false-blocks external or origin-unknown agents). Origin is immutable (set once at member creation) so it is cached PERMANENTLY per org_id; lookup errors / missing member_id / absent field are not cached and retry on the next message until a definitive value lands. The origin `/members` lookup is itself timeout-bounded (~800ms, raced, no retry, mirroring the plan-state deadline): a timeout is treated exactly like the unknown/error path — origin null, not cached, message allowed through and the plan-state query skipped (fail-open). The 800ms plan-state timeout and 30s plan-state cache for the `platform_created` path are unchanged.

## [2.8.11] — 2026-07-12

### Added

- **Credit-arrears gate — notify the user instead of waking a suspended LLM.** When an org's LLM is suspended for non-payment (欠费), a user message reaching the openmax bridge is no longer forwarded to the runtime. Credit arrears does not drop the WS (the agent stays online and keeps receiving frames; only the LLM call is blocked at the gateway), so the bridge now intercepts after `shouldHandleMessage` accepts a real user message and BEFORE `forwardToC4`: it consults the authoritative signal — cws-core BFF `GET /api/v1/billing/plan-state` `usage_snapshot.enforcement_suspended` (queried through the existing per-org authed cws-core client, cached 30s per org) — and when suspended sends the sender a short bilingual "out of credits" notice via the same reply path a policy drop uses, then skips the forward. The check is **fail-open**: any billing-query error (network, non-200, missing field) — or the query exceeding an ~800ms hard timeout (raced, no retry) — is treated as "not suspended" so it can never black-hole a user's messages; the gateway remains the hard enforcement boundary. Only successful lookups are cached (30s); timeouts and errors are never cached, so a transient stall self-heals on the next frame. The "out of credits" notice is throttled to at most once per 5 minutes per (org + reply target) — a suspended org always has its message dropped, but a chatty sender isn't spammed. Sync-replay frames and agent senders receive no notice (avoids stale spam / reject-notice ping-pong). User-facing copy is interim pending final FE wording.

## [2.8.10] — 2026-07-12

### Added

- Parse canonical `proj://<uuid>` and `issue://<uuid>` references from inbound messages into a normalized `<work-references>` prompt block. References establish context only: they do not grant access, start work, or imply creation of a new Issue. The OpenMax skill now resolves referenced objects with the agent's own Principal and reuses an existing Issue instead of duplicating it. Canonical UUID shape is enforced and references are capped at 10 per message.

## [2.8.9] — 2026-07-11

### Fixed

- **`core.agent_domain` / `resolveAgentBaseUrl()` — malformed cws-core 200 responses now fail loudly instead of silently falling back to `AGENT_PUBLIC_BASE_URL`.** Two paths violated the documented "only a core 404 reaches the env tier" contract: (a) `resolveAgentIdentityId()` returned `''` when `GET /me` answered 200 without an `identity_id`, silently skipping the core domain tier entirely; (b) `resolveAgentBaseUrl()` treated a 200 from `GET /platform-agents/{identity_id}/domain` without `full_domain` as "no bound domain" and fell through to env. Both masked cws-core protocol corruption as a valid fallback — a stale env URL could keep receiving webhooks. Both cases now throw a descriptive protocol-violation `Error` (CLI: message on stderr, exit 1). **Breaking note:** callers that relied on the malformed-200 → env fallback now see an error; the env fallback remains ONLY for the 404 (no bound domain) case, and non-404 HTTP/network errors still propagate. Docs (`src/cli/core.js` usage/comments, `references/core-operations.md`) updated to the strict semantics; unit tests flipped from pinning the silent fallback to asserting the throw.

## [2.8.8] — 2026-07-11

### Added

- **`core.agent_domain` — self public base-URL resolution (TM 79ad2910, step 2).** New `src/cli/core.js` command (thin wrapper over the reusable `resolveAgentBaseUrl()` in `src/lib/agent-domain.js`) that resolves the agent's OWN publicly-reachable base URL for webhook-channel URL construction (WhatsApp Business / LINE / Teams). Two-tier resolution order: **(1)** call cws-core `GET /api/v1/platform-agents/{identity_id}/domain` (identity_id from config `agent.identity_id`, falling back to `GET /me`) → `{ok:true, source:"core", full_domain, label, root_suffix, base_url}` where `base_url = "https://" + full_domain`; **(2)** on 404 (no bound domain) fall back to the `AGENT_PUBLIC_BASE_URL` env var → `{ok:true, source:"env", base_url}` (trailing slash stripped); if neither yields a URL → `{ok:false, error:"no bound domain and AGENT_PUBLIC_BASE_URL unset"}` with exit code 1. Non-404 core errors propagate. The resolver takes injectable deps so step-3 channel code can import the same logic.

## [2.8.7] — 2026-07-10

### Removed

- **Reverted the component-reported connection-state consumption (#34 / v2.8.5)** per the 2026-07-10 architecture decision: existing channel components must not be modified for platform features, so no component will write `runtime/connection-state.json`. Connect verification returns to the bounded pm2 process-health poll. Definitive credential validation now happens server-side in cws-connect (MR !30) before any command reaches the agent.

## [2.8.6] — 2026-07-10

### Fixed

- **whatsapp QR relay never fired**: `whatsappQrLogin` read `.status` from the component's `status.json`, but zylos-whatsapp writes `.state` — the flow was blind to `qr_waiting`, relayed zero QR codes, and every connect timed out ("whatsapp login timed out waiting for scan"). Now reads `state` with `status` fallback. Found live on int (binding 80b45491, 2026-07-10).

## [2.8.5] — 2026-07-10

### Changed

- **Channel-connect verification now consumes the component's REAL login state (#34).** A channel component may report its connection state by atomically writing `~/zylos/components/<component>/runtime/connection-state.json` with `{ "state": "connected" | "auth_failed" | "connecting" | "disconnected", "detail": "<short human reason, optional>", "updatedAt": "<ISO8601>" }` on every connection-state transition. The connect verification poll treats a **fresh** file (`updatedAt` ≤ 10 minutes old) as authoritative: `connected` resolves the binding as connected, `auth_failed` fails it **immediately** with the component-reported detail in the receipt (no more waiting out the verify timeout on bad credentials), and `connecting`/`disconnected` keep polling until the deadline (`component never reached connected state`). A stale, absent, or unparseable file falls back to the previous pm2-online process-health check for that tick, so components that don't write the file behave exactly as before. Fixes the incident where garbage wecom credentials still produced a `connected` binding because only pm2 process health was checked.
- `defaultVerify` now returns `{ ok, detail }` and the component-reported detail feeds the failure receipt (composing with a start error when both exist); injected `verifyConnected` deps that return a plain boolean are still accepted and normalized.

## [2.8.4] — 2026-07-10

### Fixed

- **Channel connect no longer reports a false failure when the service start races `zylos add`'s own startup** (int E2E 2026-07-10: telegram binding went `error` while the component came up fine). A thrown pm2 start/restart now defers to the connect verification (process-health poll / QR flow) instead of failing the connect immediately; the receipt only reports `starting service failed: …` when the service truly never comes online.
- **wechat QR login waits for the just-started component to become ready** (bounded 45s window) instead of crashing with `fetch failed` when the admin token file / HTTP listener hasn't appeared yet — this made the frontend show no QR at all on first connect.

### Changed

- **Failure receipts now carry a bounded, sanitized slice of the underlying error** (`install/upgrade failed: …`, `writing credentials failed: …`, `QR login flow failed: …`, `starting service failed: …`) — whitespace-collapsed, capped at 300 chars, with any credential values the flow handled masked out — so operators can diagnose from the binding row without shell access to the agent host.

## [2.8.3] — 2026-07-10

### Removed

- **Dropped the `[SYSTEM · DO FIRST]` skill-flow directive** that was appended inside every inbound `<current-message>` block (and its `message.enforceSkillFlow` config flag). Inbound messages now carry the user's words unmodified.

### Fixed

- **Config-first loaders could keep stale credentials after connect.** Five components (discord, zalo, line, whatsapp-business, ms-teams) resolve credentials config-first (`config.json` value beats the env var), so writing fresh credentials only to `~/zylos/.env` left a previously-configured `config.json` credential in effect after the restart — the pre-restart credential probe (which validates the *submitted* values) plus pm2-online could then report a false `connected`. The connector now mirrors the submitted credentials into each component's canonical `config.json` keys (`botToken`; `channelAccessToken`/`channelSecret`; `credentials.*`; `teamsAppCatalogId`) alongside the env write, so the fresh submit always wins regardless of loader precedence. The env-first components (feishu, lark, telegram, dingtalk, wecom, slack) are unaffected.

## [2.8.2] — 2026-07-10

### Added

- **QR-login channels: wechat / whatsapp.** All 13 catalog channels are now connectable. QR channels skip the credential pull entirely: connect installs/starts the component, then drives the login — wechat via the local admin API (`/v1/login/start` → poll session → relay each `qr_ready` code → `finalize` on confirm; a 409 "account already exists" resolves as already-connected), whatsapp via the component's `status.json`/`qr.png` files (`qr_waiting` → relay, `open` → connected; a persisted session reconnects with no scan). Each fresh/rotated QR is relayed through the new `reportQR` callback → `POST /connect/channel-bindings/{binding_id}/qr` (cws-core passthrough) so the frontend renders it on the connecting card (D-3). Login window is 270s (inside the FE's 5-min cap); QR payloads are never logged.

## [2.8.1] — 2026-07-10

### Added

- **Channel connector: 10 more credential channels.** `CHANNEL_COMPONENT` now covers all non-QR channels — lark, telegram, dingtalk, wecom, slack, discord, zalo (Tier A outbound) and line, whatsapp_business, ms_teams (webhook-inbound; public ingress is user-managed). Each entry maps the cws-connect catalog form fields to the component's env contract (verified against every component's config loader) plus its `enabled`/mode config.json flags. Underscore channel_types (`ms_teams`, `whatsapp_business`) translate to the hyphenated component names here — no backend rename.
- **One-shot credential probes (deep-verify).** Before any install/restart side effects, `connect` validates the submitted credentials directly against the IM platform (telegram/zalo `getMe`, feishu/lark `tenant_access_token`, dingtalk v1.0 `accessToken`, slack `auth.test` + `apps.connections.open`, discord `/users/@me`, line `/v2/bot/info`, WhatsApp Business Graph lookup, ms_teams AAD client-credentials grant). A definitive rejection reports `error` (`credential check failed: …`, secret-free detail) without touching the installed component; an unreachable API is treated as inconclusive (components may use their own proxy) and connect proceeds with the process-health fallback. wecom has no public check endpoint and skips the probe.

### Notes

- wechat / whatsapp (QR-login channels) remain unsupported by this path — they need the QR-relay flow (batch 2).
- Probe timeout is 8s; probes never log URLs, bodies, or credential values.

## [2.8.0] — 2026-07-10

### Added

- **Channel connect/disconnect lifecycle connector (feishu).** cws-connect dispatches a `channel.connect` / `channel.disconnect` command over cws-comm to this openmax runtime — the single channel path for all agents (platform + external). `connect` is idempotent: pull bind credentials from the cws-core BFF with a one-shot token → probe the component → `zylos add` if missing / `zylos upgrade` if present → write creds + config → restart → verify → report the result. `disconnect` soft-disables (pm2 stop + `enabled:false`), keeping the component and credentials installed so reconnect is the same idempotent connect.
- **Connect-result callback wired to cws-core.** The connector now reports each terminal connect/disconnect outcome to `POST /connect/channel-bindings/{binding_id}/result` (via the cws-core BFF), echoing `request_id` so cws-connect can match it against the in-flight command (its authorization + idempotency check). This drives the binding `pending → connected/error` (and soft-delete on disconnect), replacing installed_channels polling. Best-effort: a report failure warns and never throws out of the WS dispatcher.

### Changed

- **Runtime-metrics reporter no longer sends `installed_channels`.** Channel state is now driven by the connect-result callback above, not by polling the runtime's installed channels.

### Notes

- Connect verification is currently a bounded pm2-`online` poll (process health only); a real IM-readiness signal (feishu websocket handshake marker) is tracked in zylos-openmax#34.

## [2.7.5] — 2026-07-09

### Changed

- **Runtime-metrics reporter now sends a single report to the primary (first-enabled) org instead of one per org.** The 60s reporter previously PUT the same payload once per active org; it now takes the first entry of the insertion-ordered active-org map (the primary org) and issues a single `PUT /agents/{member_id}/runtime-metrics`. If no org is configured, or the primary org has no `self.member_id`, it warns and skips gracefully without crashing the tick.

### Added

- **Added top-level `version` field to the runtime-metrics payload** carrying openmax's own package version (read once at module load, same pattern as auto-upgrade). A downstream service reads `body.version`.

## [2.7.4] — 2026-07-09

### Changed

- **Auto-upgrade checks are opt-in and no longer run on service restart.** Scheduled auto-upgrade now registers only when `autoUpgrade.enabled` is explicitly `true`; missing config defaults to disabled. When enabled, the first check waits for the full configured interval instead of firing shortly after process start/restart.

## [2.7.3] — 2026-07-09

### Added

- **Install IM channel components from cws-connect commands (external-agent channel dispatch, Phase 1: feishu).** openmax now handles `channel.*` commands relayed over cws-comm: it pulls the bind credentials from cws-core (BFF `GET /api/v1/connect/channel-bindings/{binding_id}/credential`) with a one-time `X-Channel-Bind-Token`, then installs / configures / starts the mapped zylos IM component (`zylos add` → write `.env` secrets + `config.json` → pm2 restart). Fire-and-forget off the WS dispatcher (never throws), bounded timeouts so a hung `zylos`/`pm2` can't stall heartbeats, and secret values are never logged (keys only). Phase 1 wires **feishu** only; other `channel_type`s are skipped with a warning. `metrics-reporter` additionally reports `installed_channels` (from `zylos list` + `pm2 jlist`) so cws-connect can reconcile channel-binding status. New `getForOrgWithHeaders` client helper attaches the one-shot bind token alongside the org JWT. (#27)

### Changed

- **Onboarding Lead 步③ — materialize artifacts + advance platform state (doc/behavior).** The Lead now proactively `project.create` + `issue.create` the user's first real Project/Issue once the user has stated a goal and agreed to a direction, instead of waiting for the user to explicitly say "create project" (surfaced in a live int onboarding test: the project was only created after the user manually asked). Added an explicit exception to the "never implicitly create a Project" guardrail for the onboarding first-task, and clarified that the *direction* (not the act of materializing it) is what stays the user's call. Also made explicit that when the 3-step blueprint completes the Lead must `issue.deliver` the **core onboarding Issue** itself (not just say "delivered" in the DM) and then request owner acceptance — otherwise the core Issue stays `in_progress` and the first-delivery datapoint never fires. Acceptance stays a genuine owner action (no self-accept). Docs only (SKILL.md); no runtime code change.

## [2.7.2] — 2026-07-08

### Changed

- Onboarding Lead 步① interaction guidelines (#23): the agent opener must not
  repeat the built-in welcome greeting (go straight into the interview);
  the three interview questions are asked one at a time (wait for each answer)
  and without numbering ("第 N 个问题"). Decided by the product owner after a
  live end-to-end onboarding test on cws-int (2026-07-08).

## [2.7.1] — 2026-07-08

### Fixed

- **fix(upgrade-executor): run main() under PM2 fork-mode wrapper**. PM2 fork mode starts apps through its ProcessContainer wrapper, which `require()`s the target script — so `require.main === module` was false under pm2 and the upgrader's `main()` never ran: the `zylos-openmax-upgrader` app sat online doing nothing forever. Observed on the mechanism's first live run (v2.6.0 → v2.7.0). The entry gate is now `shouldRunMain()`: direct CLI execution, or pm2-managed with `pm_exec_path` pointing at the executor itself; plain imports (unit tests, other modules) remain side-effect free. Verified end-to-end with a live v2.6.0 → v2.7.0 auto-upgrade (detect → snapshot → upgrade → restart → verify → self-clean, ~19s).


## [2.7.0] — 2026-07-08

### Added

- **feat(onboarding): boot-time online report for onboarding trigger**. On WebSocket open, the comm bridge now reports each org's agent member to cws-core via `POST /agents/{member_id}/online-report`, allowing cws-core to seed or resume the org-first-agent onboarding flow. The report is idempotent, isolated from messaging, and retries from reconnects and periodic sync until it succeeds.
- **feat(core-cli): onboarding session and funnel event commands**. Added `core.onboarding_session` for discovering an org's onboarding lifecycle record and `core.onboarding_event` for reporting self-reportable funnel milestones such as `d1_activation` and `d3_im_connected`.
- **docs(skill): Onboarding Lead flow**. Documented how an agent leading a new org's onboarding should recognize welcome DMs, resume from existing session structure, guide the first three onboarding steps, and avoid peripheral-task upsells.

### Fixed

- **fix(onboarding): fresh-install member_id re-resolution**. The online reporter now re-reads `self.member_id` from live config when the boot-captured org config is stale, so the first token exchange write-back can trigger online-report without requiring a service restart.
- **fix(onboarding): bounded retries and older-core compatibility**. The reporter skips with a warn-once path when cws-core lacks the online-report endpoint, retries transient failures from periodic sync, and deduplicates concurrent reporting attempts.

## [2.6.0] — 2026-07-08

### Added

- **feat(auto-upgrade): dedicated on-demand PM2 upgrader app**. Auto-upgrade now launches a sibling PM2 app, `zylos-openmax-upgrader`, instead of a detached child of the `zylos-openmax` service. The upgrader is parented to the PM2 daemon, survives `pm2 stop zylos-openmax` during `zylos upgrade openmax`, is not saved into the PM2 dump, and self-deletes after terminal completion.
- **feat(auto-upgrade): PM2 watchdog recovery for interrupted upgrades**. The upgrader runs with bounded PM2 autorestart. If it is killed mid-flight, the restarted instance detects a foreign running marker, marks the upgrade failed, ensures openmax is running, notifies the owner, and exits without re-running the upgrade.
- **feat(auto-upgrade): rollback snapshot and verification guardrails**. Before upgrading, the executor snapshots the installed skill directory to `runtime/rollback-snapshot`; failed post-upgrade verification restores that snapshot, restarts openmax, re-verifies, and reports whether rollback succeeded.

### Fixed

- **fix(auto-upgrade): prevent suicide upgrades and retry loops**. Service-side upgrade checks now start the PM2 upgrader asynchronously, preserve failed-version cooldown, require a real version change, and avoid blocking the comm-bridge event loop on PM2 calls.
- **fix(auto-upgrade): stale marker and zombie handling**. Running markers without a live upgrader are converted to failed after a start grace period; stopped/errored upgrader leftovers are cleaned; online-but-stale upgraders produce a one-time owner warning instead of being deleted.
- **fix(upgrade-executor): restore accuracy and bounded logs**. The executor uses array-argument process execution, atomic marker writes, version-aware interrupted-run handling, bounded log capture, and true replace-restore behavior during rollback.

## [2.5.2] — 2026-07-08

### Fixed

- **fix(metrics-reporter): authenticated dashboard state with automatic API key provisioning**. When zylos-dashboard requires auth and `metricsReport.dashboardApiKey` is missing or stale, the reporter now provisions a local `openmax-metrics` read API key through the dashboard CLI, persists it to config, exchanges it for a short-lived session token, and reports metrics in the same tick.
- **fix(metrics-reporter): dashboard API key rotate output parsing**. The dashboard CLI prints `Key:` for `generate` and `New key:` for `rotate`; the reporter now accepts both real output formats, so existing-key fleets recover through rotate instead of failing to parse the new key.
- **fix(metrics-reporter): prevent provisioning and auth retry loops**. Auto-provisioning is serialized across overlapping metrics ticks, runs at most once per process, and keeps the existing finite retry/warn-once behavior for expired tokens, invalid keys, missing dashboard CLI, and persistent 401 responses.

## [2.5.1] — 2026-07-07

### Fixed

- **fix: frontend_base_path default `/cws` → `/workspace`**. The code default in `config.js` and the fallback in `client.js` `frontendUrl()` still used the legacy `/cws` path. New installs without a config.json override would generate wrong browser links. Updated both to `/workspace` to match the current cws-fe basePath.
- **fix: post-upgrade migration for existing `/cws` configs**. Added a migration step in `post-upgrade.js` that auto-corrects `frontend_base_path: "/cws"` to `"/workspace"` during `zylos upgrade openmax`. Existing installs are fixed automatically on upgrade.
- **fix: hardcoded domain in `frontendUrl()` comment**. Replaced `cws-int.coco.xyz` with `{bff_url}` placeholder — the domain is resolved from config, not hardcoded.

## [2.5.0] — 2026-07-06

### Changed

- **feat(auto-upgrade): detached child process execution**. Re-enables self-upgrade with a safe execution model. When a new version is detected, openmax spawns a detached child process (`scripts/upgrade-executor.cjs`) that runs `zylos upgrade openmax --yes --mode overwrite`. The child is `detached: true` + `unref()`, so it survives the parent PM2 process being stopped by zylos upgrade. Post-upgrade verification checks the installed version and PM2 status match before reporting success. On failure: writes error details to the marker, then `pm2 restart zylos-openmax` as a safety net to ensure the old version comes back up. Owner DM notifications at three points: pre-upgrade ("upgrading now"), post-upgrade success, and post-upgrade failure with rollback details. Guard against concurrent upgrades via marker status check. Stale running markers (>10 min) are auto-resolved as failed.
- **GitHub API auth**: auto-upgrade now passes `GITHUB_TOKEN`/`GH_TOKEN` when available, raising the rate limit from 60/hr (unauthenticated) to 5000/hr.

### Fixed

- **fix(auto-upgrade): marker race between executor and restarted service**. `zylos upgrade` restarts the PM2 service mid-upgrade, so the restarted service's `notifyUpgradeComplete` was consuming the still-running marker before the executor could write the terminal result — reporting a successful upgrade as failed. `readAndClearMarker` now skips `running` markers (returns null, leaves file intact); the detached executor retains ownership of the marker lifecycle and writes `completed` or `failed` once it finishes.
- **fix(auto-upgrade): prevent failed upgrade retry loop**. When an upgrade failed, the service restarted, consumed the failed marker, and immediately retried the same version — creating an infinite restart→fail→retry loop. Added version-specific cooldown: failed target version is recorded in `upgrade-failed-version`; `checkForUpdates` skips that version until a newer release is available. Successful upgrades clear the record.

## [2.4.3] — 2026-07-06

### Fixed

- **fix(auto-upgrade): disable self-upgrade execution**. The auto-upgrade timer was calling `zylos upgrade openmax` from within the openmax process — a suicide upgrade that stops its own PM2 service mid-execution, leaving the service stopped and files potentially unupdated. Now the timer only detects new versions and notifies owners via DM with the manual upgrade command. The `notifyUpgradeComplete` startup hook is preserved for external upgrades that leave a marker.

## [2.4.2] — 2026-07-06

### Fixed

- **fix(skill): frontend URL basePath /cws → /workspace**. cws-fe migrated `DEFAULT_BASE_PATH` to `/workspace` (`apps/web/src/lib/base-path.ts`). Updated all frontend URL templates in SKILL.md and removed hardcoded test environment domain.

## [2.4.1] — 2026-07-03

### Fixed

- **fix(auto-upgrade): owner DM notification** — `notifyOwners` read `res?.data?.id` but POST /conversations/dm returns `{ conversation: { id } }`; fixed to `res?.conversation?.id`.
- **fix(auto-upgrade): runUpgrade flags** — added `--yes` (skip interactive confirmation in non-TTY) and `--mode overwrite` to the `zylos upgrade` invocation.

## [2.4.0] — 2026-07-02

### Added

- **feat(comm-bridge): cws-connect WS event handling**. Handles `connection.authorized`, `connection.revoked`, `connection.disconnected`, `connection.credential_updated`, and `connection.reauth_needed` system events. On authorization, acquires credentials from cws-core BFF and caches them locally at `runtime/credentials/{id}.json`. Revoke/disconnect clears the cache; credential_updated re-acquires. Events are filtered by agent member_id.
- **feat(cli): conn.js — Connection management CLI**. New CLI module (`src/cli/conn.js`) with 6 commands: `conn.list` (available connections), `conn.acquire` (credential acquisition), `conn.proxy` (proxy-mode request forwarding), `conn.status` (connection details), `conn.cached` (local credential cache), `conn.clear_cache` (cache cleanup).
- **docs: conn-operations.md** — Operation reference for the connection CLI, including credential modes (direct/proxy), WS event flow, and BFF endpoint mapping.

## [2.3.1] — 2026-07-02

### Fixed

- **fix(auto-upgrade): ZYLOS_BIN path resolution**. Hardcoded `~/zylos/zylos` path fails when zylos is installed via npm (nvm PATH). Now uses `process.env.ZYLOS_BIN || 'zylos'` for PATH-based lookup.
- **fix(metrics-reporter): field name mismatch with cws-core schema**. Renamed `mem_total` → `mem_total_bytes`, `mem_used` → `mem_used_bytes`, `disk_free` → `disk_free_bytes` to match cws-core's `reportRuntimeMetricsRequest` struct. Removed `reported_at` from PUT body (server-side field).

## [2.3.0] — 2026-07-02

### Added

- **feat(comm-bridge): runtime metrics reporting to cws-core**. Periodically reads agent runtime metrics (CPU, memory, disk, context, cost, state, model) from zylos-dashboard's `/api/state` and reports them to cws-core via `PUT /agents/{id}/runtime-metrics`. Registered as a 60s periodic task, configurable via `config.metricsReport`. Dashboard 404 is silently skipped (endpoint not yet deployed on cws-core).

## [2.2.0] — 2026-07-01

### Added

- **feat(tm): Issue 执行计划确认与交付反馈循环命令**。
  - 新增 `issue.submit_plan` / `issue.accept_plan` / `issue.resume`，对接 cws-core BFF 的 cws-work 内部计划确认流程。
  - SKILL 和 TM 参考文档改为文本卡片模拟路径：Lead 发计划/交付消息，人类回复接受后 Lead 用 `source:"text_card_proxy"` 代点；人类不接受时先对话澄清，再 `issue.resume` 回到执行中并重新计划。
- **Skill 强制：`dependsOn` 必须使用上游 Task 的 `task.id`**。实例化 Sub-task 时，下游 Task 的 `dependsOn` 要用先建出来的上游 Task 返回的 `task.id`（先建上游、拿到 id、再设下游）。调度中心的「依赖就绪」开工通知与 `task.start` 开工闸都按 task.id 匹配；用错 id 会让依赖边失效——下游 Task 永不被通知、过不了开工闸、无报错地永久卡在 assigned。动机：concurrent-roles 探针实测复现，并已在 cws-work 侧加 `CreateTask` 校验兜底（!87）。
- **Skill 行为护栏：绝不隐式创建 Project**。项目归属只能"选已有"或"用户明确要求时新建"——即便用户提到某个项目名而 bot 查不到同名项目，也禁止擅自建一个兜底，必须回过头问用户（指哪个已有项目，还是要新建）。`project.create` 仅在人类明确指示新建时才调。
- **Skill 行为护栏 #11/#12：激活即开工 + backlog 创建即澄清**。收到 `issue.activated`（owner 经 `issue.activate` 激活 backlog Issue）后，Lead **直接 `issue.start_execution` 开工**，不再回头问 owner「要不要开始 / 保持 backlog」。

### Changed

- **所有 Issue 计划统一落 Blueprint**：简单任务也先创建单 step Blueprint，`issue.submit_plan` 新流程要求传 `blueprintId`；Issue comment 记录人类看到的计划说明，Blueprint 作为计划事实源和未来 workflow 固化来源。
- `core.project_list` 默认按 `status=active` 过滤。按名称解析归属项目时不再匹配到已归档项目。
- **前端链接规则同步 cws-fe 融合页**：项目/Issue URL 从嵌套路径（`/projects/{id}`, `/projects/{id}/issues/{iid}`）改为 query 参数（`/projects?project={id}&issue={iid}`）。删除已移除的 `/tasks` 页面。旧路径自动重定向。

## [2.1.0] — 2026-07-01

### Added

- **feat(comm-bridge): auto-upgrade with owner notification** (`src/lib/auto-upgrade.js`)。comm-bridge.js 启动后定期（默认每 24 小时）通过 GitHub Releases API 检查 zylos-openmax 最新版本。发现新版本时自动执行 `zylos upgrade openmax`，升级完成 PM2 重启后通过 DM 通知 owner（包含版本号和 release notes 摘要）。
  - 首次检查延迟 60 秒（避免启动竞争）
  - 升级标记文件 `runtime/upgrade-marker.json` 跨重启传递版本信息
  - 通知通过 `POST /conversations/dm` 获取 owner DM 会话 + `scripts/send.js` 发送
  - 可通过 `config.json` 配置：`autoUpgrade.enabled`（默认 true）、`autoUpgrade.intervalHours`（默认 24）

### Changed

- **refactor(comm-bridge): TaskRegistry 统一管理定时任务** (`src/lib/task-registry.js`)。4 个应用级定时任务（typing-poll / frame-metrics / owner-config-sync / auto-upgrade）通过 `TaskRegistry` 集中注册、启动、停止。`shutdown()` 从 4 段清理代码简化为 `tasks.stopAll()` 一行。执行逻辑不变，`list()` 方法预留健康检查扩展。

## [2.0.1] — 2026-07-01

### Changed

- **docs(tm): 刷新 TM 依赖覆盖文档至 v0.7 合约** (PR #2)。Issue 状态更新为 `backlog/in_progress/pending_plan/delivered/accepted/terminated`；Task 状态新增 `assigned`；移除过时的 `claimable`/`agent_skills` 引用；新增 `include_archived`/`statuses` 参数；issueItem/taskItem schema 清理（移除 `mode`、`skill_tags`、`context_page_ids` 等已删字段）；TaskBoard 章节更新为已完全删除。
- **fix(tm): 移除 smoke 文档中已禁用的 archive/restore 流程** (PR #1)。

### Removed

- **删除 `SKILL-v2.md`** (PR #4)。根目录冗余的 SKILL 草稿文件，仅保留 `SKILL.md`。

## [1.0.66] — 2026-06-25

### Added

- **feat(tm): comment CLI 命令 + agent 间接力交付走 Task 评论**（落地 cws-work 设计 001 §3/§4）。
  - 新增 `comment.create {workType, workId, bodyMarkdown}` / `comment.get {id}` / `comment.list {workType, workId}`，对接 cws-core BFF `/comments`。
  - SKILL 硬规则：worker 把 task 流转到 done 前**必须**先 `comment.create` 写完成评论（自然语言写产出物地址）；下一棒收到「依赖已就绪」DM（正文点名上游 Task、payload 带 `upstreamTaskIds`）后**先** `task.get` + `comment.list` 读上游产出再 `task.start`。

### Changed

- **去掉已删除的结构化字段参数**（cws-work 已删字段）：`task.create` 移除 `skillTags` / `contextPageIds`；`issue.create` / `issue.update` 移除 `dueDate` / `contextPageIds` / `inputArtifactIds`；priority 改为可选（默认 medium）。上下文改由自然语言 description + task 评论承载。
- 移除幽灵参数 `descriptionFormat`：平台所有文本默认 markdown，不再记格式。

> 注：`references/tm-operations.md` 等共享参考文档由各服务团队维护，其中对已删参数的描述需相应服务团队同步更新。

## [1.0.65] — 2026-06-24

### Changed

- **fix(hooks): post-install 和 post-upgrade 从 API 拉真实 org_name**。安装和升级时自动调 `GET /api/v1/organizations/{org_id}` 获取组织真实名称，写回 `org_name`，无需依赖 `COCO_ORG_NAME` 环境变量。Best-effort：API 不通时跳过，不影响流程。

## [1.0.64] — 2026-06-24

### Changed

- **refactor(config): orgs key 使用完整 org_id，org_name 使用真实组织名**。
  - `post-install` 新建 org 时 key 从 `org-${id.slice(0,8)}` 改为完整 org_id UUID
  - `post-upgrade` 自动迁移旧 key（如 `org-019ea63a`、`coco-test2`）到完整 org_id
  - 消息头 `(org: X)` 已使用 `org_name` 原值，无拼接，不受影响
  - 完全向后兼容：旧 config 中的任何 key 格式在 runtime 中正常工作

## [1.0.63] — 2026-06-24

### Fixed

- **fix(comm-bridge): handleConfigUpdate 即时同步 + 错误日志修正**。收到 system 事件（group_mode_changed 等）更新本地 config 后，立即调 `syncConfigToComm()` 回报 cws-comm，不再只依赖 5 分钟定时兜底。同时将 `syncConfigToComm` 的 404 响应和 `makeOrgFrameDispatcher` 的 unknown frame type 从 `log()` 改为 `warn()`，确保异常写入 error.log。

## [1.0.62] — 2026-06-24

### Fixed

- **fix(comm-bridge): sync 游标修正 + dedup 加固 — 根治消息重放** (Issue #8ffdac40)。cws-comm 有两套独立 seq：per-conversation 消息 seq 和 per-user org-wide inbox seq。sync API 期望 inbox seq 但 openmax 一直存 per-conversation 的消息 seq 作为 `last_seq`，导致重启后游标指向错误位置，拉回大量已处理消息。改动：
  - **P0**: 新增 `sync_seq` 字段（inbox seq）替代 `last_seq`；`syncMissedEvents` 只从 sync response 的 `ev.seq` 更新游标，不再被实时 WS 消息的 per-conversation seq 污染；首次连接通过 `initSyncSeq` 初始化游标位置
  - **P1**: dedup 窗口 500→3000（覆盖 SYNC_MAX_EVENTS 的 1.5×）
  - **P2**: 新增 `ackSync` — sync 完成后向 cws-comm 确认已处理的最高 seq
  - **P3**: 移除 `createDeduper` 的 `ttlMs` 死参数；清理 `last_seq` 相关注释
  - 向后兼容：首次升级自动从 `last_seq` 迁移到 `sync_seq`

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
  Matches KB "CWS Issue 汇总 — 2026-06-09" #34 (GitLab openmax #81).
  The auto-bind path (first-ever DM under `owner` policy with no bound owner)
  is unchanged.

## [1.0.17] - 2026-06-11

### Changed
- **Reworked the skill-flow injection: moved from a leading `<openmax>`
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
- **Renamed the skill from `coco-agent` to `openmax`** for naming
  consistency — frontmatter `name`, and the per-message injected directive tag
  `<coco-agent>` → `<openmax>` (src/lib/message.js; directive body
  already referenced "openmax skill"). No code parses the tag literally,
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
  from env vars (borrowing the same env keys as `scripts/init-openmax.sh`:
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
  upgrading openmax on any bot auto-applies it, no per-bot instruction
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
  openmax → before handling a task, **must load and obey this skill** →
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
  `Error: Unexpected argument: openmax`.** The comm-bridge interface
  switched to named flags (`--channel` / `--endpoint` / `--content` /
  `--json`) and zylos-telegram / zylos-lark already use the new form;
  zylos-openmax never followed. The breakage was masked until
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
  your `~/zylos/components/openmax/config.json` already holds the
  unintended `agent.identity_id` + `api_key`. Two ways to recover:
  1. Delete config.json and re-run `zylos add openmax`. The BYO
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
  [ticket] / [ws]` prefixes; visible via `pm2 logs zylos-openmax`.

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
  `zylos-lark`), so `zylos add openmax` drives the install
  end-to-end instead of stopping after download + register:
  - `type: communication`
  - `lifecycle.npm: true` → triggers `npm install --omit=dev`
  - `lifecycle.service.{type, name, entry}` → registers
    `pm2 zylos-openmax` pointing at `src/comm-bridge.js`
  - `lifecycle.hooks.{post-install, post-upgrade, configure}` → wires
    the three hooks already in `hooks/`
  - `lifecycle.preserve: [config.json, logs/, runtime/]` → upgrade-safe
    fields
  - `lifecycle.data_dir` → declares the data root path explicitly
  - `upgrade.{repo, branch}` → `gitlab:openmax/zylos-openmax`
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
zylos add openmax --branch main
  → download from gitlab
  → npm install --omit=dev
  → prompt operator for 5 config fields
  → run hooks/configure.js (writes config.json via post-install)
  → run hooks/post-install.js again (idempotent no-op — api_key already
    set so registration is skipped)
  → start pm2 zylos-openmax
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
