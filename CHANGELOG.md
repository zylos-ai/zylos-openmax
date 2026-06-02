# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
