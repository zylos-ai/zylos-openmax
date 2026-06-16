# Smoke suite (deploy gate)

A small, **self-contained** set of end-to-end checks that run on every new
deployment to prove the core paths still work. Curated down from the full
suite per the 2026-06-08 decision.

| Aspect | This dir (`docs/smoke/`) | `docs/smoke-tests/` |
|---|---|---|
| Purpose | Deploy gate — run automatically after each new version | Integration coverage |
| When | Every deploy | On demand / CI |
| Setup | **None** — creds embedded, self-login | Needs `.env.smoke-*.local` + operator token |
| Size | 6 curated cases | full suite (single 0–18, multi 2–11) |

## The set (`smoke-set.json`)

Chosen to cover **multi-agent coordination + task-flow transitions + upload**:

| id | case | covers |
|---|---|---|
| single-8  | smoke-8-tm-metadata-edges      | TM metadata + edge transitions |
| single-10 | smoke-10-kb-instance-lifecycle | KB instance lifecycle |
| single-13 | smoke-13-comm-conversations    | Comm conversation lifecycle |
| multi-2   | smoke-2-heavy-multi-agent      | Heavy + blueprint + cross-actor worker claim + KB |
| multi-4   | smoke-4-kb-collaboration       | Cross-actor KB collaboration |
| multi-5   | smoke-5-as-file-handoff        | Cross-actor AS file hand-off (**upload**) |

Everything else stays under `docs/smoke-tests/` as integration tests.

## Config (`lib/smoke-config.js`)

Actors are **not** hardcoded:

- **LEAD = self** — whichever bot is told to run the smoke. Resolved from this
  runtime's config (`orgs.*.self`). Override: `SMOKE_LEAD_MEMBER_ID`.
- **WORKER (multi-agent) = caller-provided** — the user supplies the worker
  agent's api_key via `SMOKE_WORKER_API_KEY`; its member_id is derived from the
  issued JWT. Nothing about the worker is committed.
- **Conversations** (user↔lead / user↔worker / lead↔worker) are resolved
  dynamically via `create_dm` — no conversation ids baked in.
- **Users** (NL drivers, hardcoded test-org accounts): `gavin-test-002`
  (org-owner, default) / `gavin-test-005` (org-member). Pick via `SMOKE_USER`.
- **Org**: Coco Test Org2 (`019e8b9b…`), **project**: `ae5fa2ef…` (fe-teset).

> ⚠️ Only the two human test-user credentials are embedded (throwaway cws-int
> test-org accounts, confirmed OK by the owner). No agent credentials are
> committed — the worker key is supplied at run time.

## Run

```bash
# single-agent cases (LEAD=self, no worker needed)
node docs/smoke/run-smoke.js single-8 single-10 single-13

# all cases — multi-agent needs the worker agent's api_key
SMOKE_WORKER_API_KEY=cwsk_... node docs/smoke/run-smoke.js

# a single case directly
SMOKE_WORKER_API_KEY=cwsk_... node docs/smoke/smoke-5-as-file-handoff.test.js

# also report a C4 summary (comm-bridge sender)
SMOKE_NOTIFY="lark|<endpoint>" SMOKE_WORKER_API_KEY=cwsk_... node docs/smoke/run-smoke.js

# drive NL as the other user
SMOKE_USER=gavin-test-005 node docs/smoke/smoke-8-tm-metadata-edges.test.js
```

`run-smoke.js` exits non-zero if any case fails, so a deploy hook / CI step can
gate on it.

## Auto-run after deploy

`run-smoke.js` is the entry point a post-deploy step calls. Wiring options
(pick per ops preference):

- **post-upgrade hook** (`hooks/post-upgrade.js`): kick off `run-smoke.js` in
  the background after `zylos upgrade coco-workspace`, report the summary via C4.
- **scheduler task**: schedule a one-shot smoke run after a deploy event.

Note: multi-agent cases require the WORKER runtime (agent-gavin3) to be online.
