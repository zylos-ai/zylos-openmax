# Non-interactive install (image baking)

This document covers installing `zylos-coco-workspace` without a TTY —
e.g. inside a Dockerfile, a k8s init container, or any automated
provisioning pipeline.

The `hooks/post-install.js` script already detects `process.stdin.isTTY`
and skips all prompts when stdin is not a TTY. The skipped steps
(agent registration + initial org block) become the operator's
responsibility, performed either at image-build time or at first boot.

## What post-install does in non-TTY mode

1. Creates data directories under `~/zylos/components/coco-workspace/`:
   `logs/`, `media/`, `runtime/`, `runtime/tokens/`.
2. Seeds `~/zylos/components/coco-workspace/config.json` from
   `DEFAULT_CONFIG` (only if the file doesn't already exist).
3. Generates `agent.device_id` and `agent.client_id` (UUIDv4) if not
   already present.
4. Prints the manual steps the operator must perform before starting
   the service:
   - register the agent with cws-core and stash `api_key` in `.env`
   - add at least one org block under `orgs.<slug>` in `config.json`.

The hook is idempotent — re-running it on an already-provisioned host
is safe (no overwrite of existing values).

## Recipe A — bake skeleton, configure at runtime (recommended)

Best for general-purpose images that ship to many environments.

**At build time** (Dockerfile):

```dockerfile
RUN zylos install coco-workspace
# post-install runs without TTY → only creates dirs + skeleton config
# Result baked into the image:
#   ~/zylos/.claude/skills/coco-workspace/  (the package itself)
#   ~/zylos/components/coco-workspace/config.json  (skeleton)
```

**At runtime** (`docker run` / k8s `Deployment`):

Mount or write these two files before the service starts:

1. `~/zylos/.env` — must contain:

   ```bash
   COCO_AUTH_TOKEN=<api_key returned from /auth/register/agent>
   ```

   Recommended source: k8s `Secret` mounted as a file, or an env-var
   sidecar that writes the file on container start.

2. `~/zylos/components/coco-workspace/config.json` — fully populated.
   See [Minimal config.json](#minimal-configjson) below.

Then start the service:

```bash
pm2 start ~/zylos/.claude/skills/coco-workspace/ecosystem.config.cjs
```

## Recipe B — bake everything (single-tenant images)

Best when an image is dedicated to one org and the api_key is known
at build time.

**At build time:**

```dockerfile
RUN zylos install coco-workspace

# Pre-populate config.json
COPY config.json ~/zylos/components/coco-workspace/config.json

# Pre-populate .env (consider build-arg + multi-stage build to avoid
# leaking the api_key into image history)
RUN --mount=type=secret,id=coco_auth_token \
    echo "COCO_AUTH_TOKEN=$(cat /run/secrets/coco_auth_token)" >> ~/zylos/.env
```

Then the image starts with no runtime mounts required.

## Minimal config.json

The smallest config that boots a single-org agent (replace the four
`<...>` placeholders):

```json
{
  "enabled": true,
  "server": {
    "bff_url": "http://cws-core:8080",
    "ws_url":  "ws://cws-core:8080/ws"
  },
  "agent": {
    "identity_id": "<identity_id from /auth/register/agent>",
    "api_key": ""
  },
  "orgs": {
    "default": {
      "enabled": true,
      "org_id":   "<COCO org UUID>",
      "org_name": "<display only>",
      "self":  { "member_id": "<agent's member id in this org>", "name": "Zylos" },
      "owner": { "member_id": "", "name": "" },
      "access": {
        "dmPolicy":    "owner",
        "groupPolicy": "allowlist",
        "groups": {}
      }
    }
  }
}
```

Notes:

- `agent.api_key` is intentionally **left empty in config.json** — the
  canonical store is `~/zylos/.env` as `COCO_AUTH_TOKEN`. The runtime
  reads from .env first.
- `owner.member_id` empty == not yet bound. The next DM under
  `dmPolicy: "owner"` will auto-bind that sender as the owner and write
  the new owner block back to config.json.
- Add more orgs by copying the `orgs.default` block under a new slug
  (`orgs.team-alpha`, etc.). Each enabled org gets its own WebSocket
  connection.

## How to obtain `identity_id` + `api_key` at provisioning time

For Recipe A (configure at runtime) the operator typically runs this
once per agent identity, out-of-band:

```bash
curl -X POST "$BFF_URL/auth/register/agent" \
  -H 'Content-Type: application/json' \
  -d '{"username":"zylos-agent-prod-001","display_name":"Zylos Prod"}'

# →
# {"identity_id":"...","api_key":"sk-..."}
```

Stash `identity_id` in a config-management system (Vault / k8s
ConfigMap / SSM Parameter Store) and `api_key` in a secrets system
(Vault / k8s Secret / AWS Secrets Manager).

For Recipe B (bake everything) the same call happens during image
build; the api_key is mounted as a Docker build secret to avoid
landing in the image's layer history.

## Environment-variable overrides

The runtime honours these env vars (useful for k8s patches / dev
overrides without rewriting config.json):

| Variable               | Overrides                                | Notes                                      |
|------------------------|------------------------------------------|--------------------------------------------|
| `COCO_AUTH_TOKEN`      | `agent.api_key`                          | Canonical store for the api_key            |
| `COCO_API_URL`         | `server.bff_url`                         | cws-core REST base URL                     |
| `COCO_WS_URL`          | `server.ws_url`                          | cws-comm WebSocket URL                     |
| `COCO_API_PREFIX`      | `/api/v1`                                | API path prefix                            |
| `COCO_DEVICE_ID`       | `agent.device_id`                        | Sent as `X-Device-Id`                      |
| `COCO_CLIENT_VERSION`  | `agent.app_version`                      | Sent as `X-Client-Version`                 |
| `COCO_ORG_ID`          | default-org resolution for CLIs          | Used when more than one org is configured  |

`orgs.*` entries themselves have no env-var override — the orgs map
must be in `config.json`.

## Smoke-test checklist (post-boot)

1. `pm2 logs zylos-coco-workspace --lines 50` — confirm one
   `booting WS pool: N org(s) enabled` line and one `WS connected
   [<slug>]` per org.
2. `node ~/zylos/.claude/skills/coco-workspace/src/cli/core.js core.me '{}'`
   — should return the agent's identity record (validates auth).
3. Send a DM to the agent from the intended owner account; expect
   one `bind owner [<slug>] member_id=<id>` line in the logs and the
   owner block populated in `config.json`.
