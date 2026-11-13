# zylos-openmax

OpenMax integration plugin for [Zylos](https://git.coco.xyz/zylos-ai/zylos-core) agents.

Provides unified IM communication (WebSocket bridge), service CLIs (TM/KB/AS/Comm/Core/Channel/Usage), and Lead/Worker behavioral lifecycle via progressive skill loading.

## Quick Start

```bash
zylos install openmax
```

## Architecture

- **Communication Module** — PM2 service (`src/comm-bridge.js`), bridges WebSocket messages to C4
- **Service CLIs** — Stateless JSON in/out (`src/cli/{tm,kb,as,comm,core,channel}.js`)
- **Usage CLI** (built in since v2.26.0) — Organization usage queries with a dedicated `billing.usage.read` key and explicit cursor pagination (`src/cli/usage.js`); needs `COCO_API_URL` + `COCO_USAGE_API_KEY`, see [usage operations](references/usage-operations.md).
- **Skill Layer** — `SKILL.md` (L1+L2 always loaded) + `references/*.md` (L3 on demand)

## Development

```bash
npm install
npm start
```

Requires Node.js 20+.

## Readiness

Core 1.x readiness comes from the unauthenticated local Dashboard endpoint
`GET /api/health?probe=ready`. The port comes from the existing Dashboard
`components/dashboard/config.json` (default 3470). Core's installed package
version selects this source; Core 0.x retains the original monitor/session-file
checks. Unknown versions and unavailable/invalid probes report not ready instead
of falling back to obsolete files. Requests, including the response body, have
a five-second timeout.

HTTP 200 reports the existing `ready` stage, including multi-session instances
with no running sessions. HTTP 503 maps `supervisor_unavailable` to
`runtime_down` and single-mode `session_not_running` to `runtime_up`. The reported
readiness fields and existing report/trigger intervals are unchanged.

Onboarding additionally waits for the configured runtime's `auth_failed`, `down`
or `unavailable` health. Missing/unreadable health records or an unknown runtime
also wait, without asserting that login never occurred. The existing maximum
wait still permits reporting afterward; `ok`, `rate_limited` and `recovering`
release onboarding immediately. An explicitly absent single session does not
fail open. Multi mode needs no session belonging to the current launch. No new
configuration, watcher, cache or persistent state is added.

## License

UNLICENSED
