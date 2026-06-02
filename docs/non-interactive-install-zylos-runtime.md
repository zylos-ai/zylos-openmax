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
- `run_prepare_plan` → **runs the operator's plan commands** (the
  injection point for our config)
- `run_component_hooks "post-install"` → invokes
  `hooks/post-install.js`, which in non-TTY mode just seeds the
  skeleton `config.json` and generates UUIDs (no prompts).

The PM2 ecosystem config baked in by `generate-pm2-config.js` already
picks up `coco-workspace`'s comm-bridge service automatically — no
operator action needed to register it with PM2.

## Prepare-time: inject config via the operator plan

Two pieces have to be written into the volume before the first runtime
start, and both must come from the operator's prepare plan:

1. `/home/zylos/.env` — must contain `COCO_AUTH_TOKEN=<api_key>` (the
   agent's bearer token, returned by `POST /auth/register/agent` on
   cws-core).
2. `/home/zylos/components/coco-workspace/config.json` — populated with
   `server.*`, `agent.identity_id`, and at least one `orgs.<slug>`
   block.

The `run-prepare-plan.js` runner reads a JSON file at
`/etc/agent-runtime/prepare/plan.json` and executes its `commands[]`
array in order. Each command runs as `1000:1000` by default (via
`gosu`), with `HOME=/home/zylos` exported. Env vars are passed per
command.

### Worked example prepare plan

This plan registers the agent (if not already), then writes
`config.json` and `.env` in one shot. Drop it at
`/etc/agent-runtime/prepare/plan.json`:

```json
{
  "apiVersion": "zylos.dev/prepare-command/v1",
  "commands": [
    {
      "name": "persist-claude-credentials",
      "argv": ["node", "/opt/zylos-image/persist-claude-credentials.js"],
      "env": {
        "ANTHROPIC_API_KEY": "<from k8s secret>",
        "ANTHROPIC_BASE_URL": "<your Anthropic base, if proxied>"
      }
    },
    {
      "name": "init-coco-workspace",
      "argv": [
        "bash", "-eu", "-c",
        "set -euo pipefail; \
         ENV_FILE=\"$HOME/.env\"; \
         CONF_DIR=\"$HOME/components/coco-workspace\"; \
         mkdir -p \"$CONF_DIR\"; \
         touch \"$ENV_FILE\"; \
         grep -q '^COCO_AUTH_TOKEN=' \"$ENV_FILE\" || echo \"COCO_AUTH_TOKEN=$COCO_AUTH_TOKEN\" >> \"$ENV_FILE\"; \
         cat > \"$CONF_DIR/config.json\" <<JSON\n\
{\n\
  \"enabled\": true,\n\
  \"server\": { \"bff_url\": \"$BFF_URL\", \"ws_url\": \"$WS_URL\" },\n\
  \"agent\":  { \"identity_id\": \"$IDENTITY_ID\", \"api_key\": \"\" },\n\
  \"orgs\": {\n\
    \"default\": {\n\
      \"enabled\": true,\n\
      \"org_id\":   \"$ORG_ID\",\n\
      \"org_name\": \"$ORG_NAME\",\n\
      \"self\":  { \"member_id\": \"$SELF_MEMBER_ID\", \"name\": \"Zylos\" },\n\
      \"owner\": { \"member_id\": \"\", \"name\": \"\" },\n\
      \"access\": { \"dmPolicy\": \"owner\", \"groupPolicy\": \"allowlist\", \"groups\": {} }\n\
    }\n\
  }\n\
}\n\
JSON"
      ],
      "env": {
        "COCO_AUTH_TOKEN": "<from k8s secret>",
        "BFF_URL":         "http://cws-core:8080",
        "WS_URL":          "ws://cws-core:8080/ws",
        "IDENTITY_ID":     "<from /auth/register/agent>",
        "ORG_ID":          "<COCO org UUID>",
        "ORG_NAME":        "default",
        "SELF_MEMBER_ID":  "<agent's member id in this org>"
      }
    }
  ]
}
```

After this plan runs:

- `/home/zylos/.env` has `COCO_AUTH_TOKEN=...` (plus
  `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` if you kept the first
  command).
- `/home/zylos/components/coco-workspace/config.json` has a working
  single-org block.
- The post-install hook runs **after** these plan commands (see
  `materialize_volume` → `run_prepare_plan` → `run_component_hooks
  "post-install"`), so it sees the seeded config.json and only fills
  in missing UUID defaults — no destructive overwrite of the
  operator-supplied org.

### Notes on the example plan

- The inline `cat > config.json <<JSON ... JSON` block produces an
  exact, idempotent overwrite — re-running prepare in `ensure` /
  `repair` mode rewrites the file. The agent reads
  `config.json` on each handler call (hot-reload), so this is safe.
- `agent.api_key` stays empty in `config.json`; the canonical store
  is `.env`. The runtime reads `COCO_AUTH_TOKEN` from there.
- `owner.member_id` stays empty so that the next DM under
  `dmPolicy: "owner"` auto-binds the first sender as the owner. The
  bound owner is written back to `config.json` at runtime — that
  write happens under uid 1000, and `config.json` is **not** in the
  locked-files list, so this works under the locked-prepare regime.
- To pre-bind a specific owner (e.g. for an unattended fleet), set
  `owner.member_id` to the human owner's member id in the same JSON
  template.

### Optional: helper script in coco-workspace

If injecting JSON via inline bash gets unwieldy (more orgs, more
policy detail), we can add `scripts/persist-config.js` to
zylos-coco-workspace — analogous to the image's
`persist-claude-credentials.js`. It would read env vars
(`COCO_AUTH_TOKEN`, `BFF_URL`, etc., plus a `CWS_ORGS_JSON` blob) and
write `config.json` + upsert `.env`. The prepare plan command then
becomes a clean one-liner:

```json
{
  "name": "init-coco-workspace",
  "argv": ["node", "/home/zylos/.claude/skills/coco-workspace/scripts/persist-config.js"],
  "env": { "COCO_AUTH_TOKEN": "...", "BFF_URL": "...", "CWS_ORGS_JSON": "{...}" }
}
```

Not in scope for v1 — included here as a follow-up if the inline
approach proves brittle.

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

What the K8s operator must supply for each agent instance:

| Where | Field | Source |
|---|---|---|
| Image build args | `ZYLOS_BRANCH` | which zylos-core release to bake |
| Image build args | `CLAUDE_CODE_VERSION` | which Claude Code CLI version to bake |
| `components.lock.json` | `coco-workspace` entry + version | per-image release pinning |
| Prepare plan env (per pod) | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | k8s Secret |
| Prepare plan env (per pod) | `COCO_AUTH_TOKEN` | k8s Secret (from `/auth/register/agent`) |
| Prepare plan env (per pod) | `BFF_URL`, `WS_URL` | ConfigMap (per environment) |
| Prepare plan env (per pod) | `IDENTITY_ID`, `ORG_ID`, `SELF_MEMBER_ID` | k8s Secret / ConfigMap (per identity) |

Everything coco-workspace-internal — auto-bind logic, group access
policy, owner state — happens at runtime under uid 1000 and writes
back to `config.json` in the unlocked component data dir. No further
operator involvement required.
