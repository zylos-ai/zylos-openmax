# Non-interactive install — `cws-zylos-runtime` image

Companion doc to [non-interactive-install.md](./non-interactive-install.md).
That doc covers generic Docker / k8s. This one covers the specific
`zylos-runtime` image at
`coco-workspace/cws-zylos-runtime:images/zylos-runtime` (branch
`mr2-zylos-runtime-repo`), which has its own contract with the
Kubernetes operator and a different on-disk layout from the standard
`~/zylos/*` path.

## What this image is

A `node:22-slim`-based agent runtime that bakes Zylos plus a pinned
component set into one image. Notable contents:

- Globally installed `zylos-core` (pinned via `ZYLOS_BRANCH` build arg)
  and `@anthropic-ai/claude-code` (pinned via `CLAUDE_CODE_VERSION`).
- PM2 + `pm2-logrotate` preconfigured.
- Components listed in `components.lock.json` (currently `hxa-connect`,
  `dashboard`) pre-installed under `/opt/zylos-image/.claude/skills/`.
- An entrypoint that runs as one of two modes: `prepare` (root) or
  `runtime` (uid 1000 `zylos`).

The runtime volume root is **`/home/zylos`**, not `~/zylos`. The image
sets `HOME=ZYLOS_DIR=ZYLOS_VOLUME_ROOT=/home/zylos` for every command.
Anything coco-workspace's code computes from `process.env.HOME` will
resolve under `/home/zylos`, which is the K8s PVC mount.

## Two-phase contract

The image is designed for the operator to drive via a Kubernetes pattern
where prepare and runtime are separate phases:

| Phase | When | UID | Reads | Writes |
|---|---|---|---|---|
| **prepare** | once on fresh PVC, plus `ensure`/`upgrade`/`repair`/`retry` modes | root (drops to 1000 for plan commands via `gosu`) | `/opt/zylos-image/*` + `/etc/agent-runtime/prepare/plan.json` | materializes image content + runs operator's prepare plan + writes `/home/zylos/.zylos-control/initialized.json` marker, then locks critical files | 
| **runtime** | every pod start | uid 1000 `zylos` | marker + `/home/zylos/.env` + `pm2/ecosystem.config.cjs` | starts PM2 + a tmux `claude` session |

Important consequences for non-interactive install:

1. The operator never registers an agent or fills in policy by hand —
   that has to happen during prepare via the **prepare plan**.
2. Anything that needs root (chown, locked files) belongs in the
   image's `materialize_volume`; anything operator-supplied belongs in
   the prepare plan and runs as `1000:1000` by `gosu`.
3. After prepare finishes, several files become `chmod 444` and locked
   under the root-owned `/home/zylos/.zylos-control/`. Runtime cannot
   re-mutate them. coco-workspace's `config.json` is **not** in that
   locked set, so the agent can still hot-reload its own policy at
   runtime.

## Where coco-workspace fits

coco-workspace is a Zylos **component** (skill), the same shape as
`hxa-connect` or `dashboard`. It belongs in `components.lock.json` so
the image can install it at build time, place its code under
`/opt/zylos-image/.claude/skills/coco-workspace/`, run its post-install
hook during prepare, and pick it up via the auto-generated
`pm2/ecosystem.config.cjs`.

### Build-time: add to `components.lock.json`

Edit `images/zylos-runtime/components.lock.json` in `cws-zylos-runtime`
and add:

```json
{
  "name": "coco-workspace",
  "version": "<release-tag>",
  "repo": "<github_org>/zylos-coco-workspace"
}
```

⚠ **GitHub-only source caveat.** The current
`scripts/install-component.sh` pulls components with:

```bash
curl -sfL https://github.com/$repo/archive/refs/tags/v$version.tar.gz
```

zylos-coco-workspace lives on **GitLab** (`git.coco.xyz`), not GitHub.
Three workable paths:

1. **Mirror to GitHub** under a dedicated org (e.g. `coco-workspace-ai`)
   and reference that mirror in `repo`. Cleanest for shipping —
   `install-component.sh` works unchanged.
2. **Patch `install-component.sh`** to dispatch on a `source` field in
   the lockfile entry (`source: "gitlab"` → fetch via the GitLab API
   tarball endpoint with a token). Requires a one-line spec change.
3. **Bake from a local copy** instead of curling: add a build-arg-driven
   `git clone` step in the Dockerfile for coco-workspace specifically.
   Pragmatic for a transitional release.

Option 1 is the lowest-risk pick if a public mirror is acceptable.
Option 2 is the correct long-term answer.

### What happens after the build step lands

Once `components.lock.json` has a `coco-workspace` entry and the build
succeeds, the image contains:

```
/opt/zylos-image/
├─ .claude/skills/coco-workspace/      # code (skill dir)
├─ components/coco-workspace/logs/     # data dir (created empty by install-component.sh)
└─ .zylos/components.json              # registry entry written by write-components-json.js
```

During prepare, `entrypoint.sh` calls:

- `sync_code` → copies the skill dir into `/home/zylos/.claude/skills/coco-workspace/`
- `ensure_data_dirs` → creates `/home/zylos/components/coco-workspace/logs/`
- `run_prepare_plan` → **runs the operator's plan commands** — this is
  where coco-workspace's own `hooks/post-install.js` runs under the
  env-driven contract described below
- `run_component_hooks "post-install"` → would normally re-run the
  hook, but under our env-driven design the hook is idempotent: it
  sees `config.agent.api_key` already populated by the prepare plan
  step and short-circuits to a no-op

The PM2 ecosystem config baked in by `generate-pm2-config.js` already
picks up `coco-workspace`'s comm-bridge service automatically — no
operator action needed to register it with PM2.

## Prepare-time: env-driven bootstrap

There is **one** file to land on the volume before runtime starts:
`/home/zylos/components/coco-workspace/config.json`. The agent token
(`agent.api_key`) lives **inside this file** — there is no `.env`
file to write, no separate Kubernetes Secret to mount, no out-of-band
agent-registration step.

The operator drives this via a single prepare-plan command that
invokes coco-workspace's own `hooks/post-install.js`. The hook reads
env vars from `process.env`, calls `POST /auth/register/agent` to
exchange a one-time ticket for an api_key + identity_id, and writes
the full `config.json` (including the api_key, the server URLs, and
the org block).

### Required env vars on the prepare-plan command

| Variable | Purpose |
|---|---|
| `COCO_BFF_URL` | cws-core REST base, e.g. `http://cws-core:8080` |
| `COCO_WS_URL` | cws-comm WebSocket, e.g. `ws://cws-core:8080/ws` (defaults to `bff_url` with `http→ws` if absent) |
| `COCO_AGENT_TICKET` | one-time registration ticket (consumed by `/auth/register/agent`) |
| `COCO_AGENT_NAME` | display name for this agent identity |
| `COCO_ORG_ID` | the COCO org UUID this agent serves |
| `COCO_SELF_MEMBER_ID` | agent's `member_id` within that org |

### Optional env vars

| Variable | Default | Purpose |
|---|---|---|
| `COCO_ORG_NAME` | `default` | display name for the org block |
| `COCO_ORG_SLUG` | derived from `COCO_ORG_NAME` | config-key slug under `orgs.{}` |
| `COCO_DM_POLICY` | `owner` | initial DM access policy |
| `COCO_GROUP_POLICY` | `allowlist` | initial group access policy |

### Worked example prepare plan

Drop this at `/etc/agent-runtime/prepare/plan.json`:

```json
{
  "apiVersion": "zylos.dev/prepare-command/v1",
  "commands": [
    {
      "name": "persist-claude-credentials",
      "argv": ["node", "/opt/zylos-image/persist-claude-credentials.js"],
      "env": {
        "ANTHROPIC_API_KEY":  "<from prepare job input>",
        "ANTHROPIC_BASE_URL": "<your Anthropic base, if proxied>"
      }
    },
    {
      "name": "init-coco-workspace",
      "argv": ["node", "/home/zylos/.claude/skills/coco-workspace/hooks/post-install.js"],
      "env": {
        "COCO_BFF_URL":         "http://cws-core:8080",
        "COCO_WS_URL":          "ws://cws-core:8080/ws",
        "COCO_AGENT_TICKET":    "<one-time ticket from prepare job input>",
        "COCO_AGENT_NAME":      "<agent display name>",
        "COCO_ORG_ID":          "<COCO org UUID>",
        "COCO_SELF_MEMBER_ID":  "<agent's member id in this org>",
        "COCO_ORG_NAME":        "default"
      },
      "runAs": "1000:1000"
    }
  ]
}
```

After this plan runs:

- `/home/zylos/components/coco-workspace/config.json` contains:
  - `server.bff_url`, `server.ws_url`
  - `agent.identity_id` (returned by `/auth/register/agent`)
  - `agent.api_key` (returned by `/auth/register/agent`)
  - `orgs.<slug>` with `org_id`, `self.member_id`, `owner`, `access`
- The one-time ticket has been consumed; subsequent prepare runs (in
  `ensure` / `repair` mode) skip registration because the hook sees
  `agent.api_key` already populated.

### What the hook does (for reference)

1. Reads the required env vars; if any are missing, exits 1.
2. If `config.agent.api_key` is already set → no-op (idempotent).
3. Otherwise: `POST {COCO_BFF_URL}/auth/register/agent` with
   `{username, display_name, ticket}` → returns `{identity_id, api_key}`.
4. Writes `config.json` with the full populated shape.
5. The hook does NOT touch `~/.env` or any other file outside the
   component data dir.

### Notes

- `owner.member_id` is seeded empty so that the next DM under
  `dmPolicy: "owner"` auto-binds the first sender as the owner. The
  bound owner is written back to `config.json` at runtime — that
  write happens under uid 1000, and `config.json` is **not** in the
  locked-files list, so it works under the locked-prepare regime.
- To pre-bind a specific owner (e.g. for an unattended fleet), edit
  `config.json` post-prepare and set `owner.member_id` directly. A
  future env var (`COCO_OWNER_MEMBER_ID`) can short-circuit the
  auto-bind if the use case becomes common.
- Multi-org: the current contract seeds **one** org. To add more,
  copy the resulting `orgs.<slug>` block under a new key in
  `config.json` (manual edit). A future `COCO_ORGS_JSON` env var
  would allow seeding multiple orgs from a single plan command.

## Runtime-time: nothing to do

`entrypoint.sh runtime` discovers `coco-workspace` automatically via
the baked-in `pm2/ecosystem.config.cjs` (generated at build by
`generate-pm2-config.js` from the component lockfile). The service
starts as part of `pm2 start ecosystem.config.cjs`.

Verify a running pod with:

```bash
kubectl exec -it <pod> -- pm2 logs zylos-coco-workspace --lines 50
```

The first ~10 log lines should show:

```
[zylos:runtime] ...
booting WS pool: 1 org(s) enabled
WS connected [default] org=<UUID> seq=0
```

If you see `agent.api_key not configured` or `no org enabled`, the
prepare plan did not run or did not produce the expected files —
re-run prepare with `ZYLOS_INIT_MODE=repair` and re-check.

## Smoke-test inside the pod

```bash
# Identity + auth sanity
node /home/zylos/.claude/skills/coco-workspace/src/cli/core.js core.me '{}'

# Open conversations (should match cws-core's view)
node /home/zylos/.claude/skills/coco-workspace/src/cli/comm.js comm.list_conversations '{}'

# Optional: confirm the bound-owner flow by DMing the agent from the
# intended owner account and watching one `bind owner [default]
# member_id=...` line appear in PM2 logs.
```

## Summary of operator inputs

What needs to be supplied per agent instance. The K8s operator does
not manage Secrets or ConfigMaps for coco-workspace — the prepare-job
forwards user-supplied values as `command.env` entries on the prepare
plan, which `run-prepare-plan.js` passes verbatim to `spawnSync`.

| Where | Field | Notes |
|---|---|---|
| Image build args | `ZYLOS_BRANCH` | which zylos-core release to bake |
| Image build args | `CLAUDE_CODE_VERSION` | which Claude Code CLI version to bake |
| `components.lock.json` | `coco-workspace` entry + version | per-image release pinning |
| Prepare plan `command.env` | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | Claude credentials (consumed by `persist-claude-credentials.js`) |
| Prepare plan `command.env` | `COCO_BFF_URL`, `COCO_WS_URL` | cws-core / cws-comm endpoints |
| Prepare plan `command.env` | `COCO_AGENT_TICKET` | one-time registration ticket (consumed once, then `agent.api_key` is in `config.json`) |
| Prepare plan `command.env` | `COCO_AGENT_NAME` | agent display name |
| Prepare plan `command.env` | `COCO_ORG_ID`, `COCO_SELF_MEMBER_ID` | the org this agent serves + its member id there |

Everything coco-workspace-internal — auto-bind logic, group access
policy, owner state — happens at runtime under uid 1000 and writes
back to `config.json` in the unlocked component data dir. No further
operator involvement required after the first successful prepare.
