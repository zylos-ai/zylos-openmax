#!/usr/bin/env bash
# init-openmax.sh
# Reads env vars and writes ~/zylos/components/openmax/config.json.
# Reentrant: re-running with new env vars updates the matching fields
# without losing existing org blocks. Does not start the pm2 service —
# run `pm2 start <skill>/ecosystem.config.cjs` afterwards.
#
# Required env:
#   COCO_BFF_URL                 e.g. https://cws-int.coco.xyz
#
# Optional env (endpoints):
#   COCO_WS_URL                  e.g. wss://cws-int.coco.xyz/ws (derived from BFF if absent)
#
# Optional env (agent identity — BYO; all 3 or auto-register):
#   COCO_IDENTITY_ID             agent identity uuid
#   COCO_API_KEY                 cwsk_...
#   COCO_MEMBER_ID               agent's member_id in COCO_ORG_ID
#
# Optional env (org-1 seed; channel-auth proto-aligned):
#   COCO_ORG_ID                  e.g. 019e8b9b-...
#   COCO_ORG_NAME                display
#   COCO_OWNER_MEMBER_ID         human owner's member_id (pre-binds dmPolicy=owner)
#   COCO_OWNER_NAME              display
#   COCO_SELF_NAME               agent display name in this org
#
# Optional flags:
#   COCO_SKIP_REGISTER=1         skip auto-register even if BYO triplet incomplete
#                                (script exits 1 instead — useful in CI for fail-fast)

set -euo pipefail

# -------- Cloudflare Access service-token (from env, persisted to config) -----
# For Access-protected environments (e.g. cws-int.coco.xyz). Supply via env:
#   COCO_CF_ACCESS_CLIENT_ID, COCO_CF_ACCESS_CLIENT_SECRET
# These only let traffic through the Cloudflare Access gate; they are NOT an
# authentication credential against cws-core itself. Never hardcoded here —
# they get written into config.json (cf_access) for the runtime to read.
CF_ACCESS_CLIENT_ID="${COCO_CF_ACCESS_CLIENT_ID:-}"
CF_ACCESS_CLIENT_SECRET="${COCO_CF_ACCESS_CLIENT_SECRET:-}"

DATA_DIR="$HOME/zylos/components/openmax"
SKILL_DIR="$HOME/zylos/.claude/skills/openmax"
CONFIG="$DATA_DIR/config.json"
mkdir -p "$DATA_DIR"

# -------- prereqs --------
[[ -d "$SKILL_DIR" ]] || { echo "✗ skill not installed at $SKILL_DIR (install zylos-openmax first)"; exit 1; }
command -v node >/dev/null || { echo "✗ node not on PATH"; exit 1; }

# -------- required env --------
[[ -z "${COCO_BFF_URL:-}" ]] && { echo "✗ COCO_BFF_URL is required"; exit 1; }
BFF_URL="${COCO_BFF_URL%/}"
WS_URL="${COCO_WS_URL:-${BFF_URL/http/ws}/ws}"

# -------- derive / fetch agent identity --------
IDENTITY_ID="${COCO_IDENTITY_ID:-}"
API_KEY="${COCO_API_KEY:-}"
MEMBER_ID="${COCO_MEMBER_ID:-}"

# Idempotency: if config already has an api_key, never overwrite
EXISTING_API_KEY=""
if [[ -f "$CONFIG" ]]; then
  EXISTING_API_KEY="$(python3 -c "import json; print(json.load(open('$CONFIG'),strict=False).get('agent',{}).get('api_key',''))" 2>/dev/null || true)"
fi

if [[ -n "$EXISTING_API_KEY" ]]; then
  echo "[init] existing agent.api_key in config — keeping it (idempotent)"
  # Re-read all 3 fields from existing config so write-back is full
  EXISTING_IDENTITY="$(python3 -c "import json; print(json.load(open('$CONFIG'),strict=False).get('agent',{}).get('identity_id',''))" 2>/dev/null || true)"
  IDENTITY_ID="${IDENTITY_ID:-$EXISTING_IDENTITY}"
  API_KEY="$EXISTING_API_KEY"
elif [[ -n "$IDENTITY_ID" && -n "$API_KEY" && -n "$MEMBER_ID" ]]; then
  echo "[init] using BYO agent identity (identity_id + api_key + member_id from env)"
elif [[ "${COCO_SKIP_REGISTER:-0}" == "1" ]]; then
  echo "✗ partial / missing BYO identity and COCO_SKIP_REGISTER=1 — aborting"
  exit 1
else
  if [[ -n "$IDENTITY_ID$API_KEY$MEMBER_ID" ]]; then
    echo "[init] partial BYO env — falling back to auto-register"
  fi
  echo "[init] POST $BFF_URL/auth/register/agent (empty body)"
  REG_TMP="$(mktemp)"
  HTTP_CODE="$(curl -sS -o "$REG_TMP" -w '%{http_code}' \
    -X POST "$BFF_URL/auth/register/agent" \
    -H 'Content-Type: application/json' \
    -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
    -d '{}')" || HTTP_CODE="000"
  if [[ "$HTTP_CODE" != "200" && "$HTTP_CODE" != "201" ]]; then
    echo "✗ register failed (HTTP $HTTP_CODE): $(cat "$REG_TMP" | head -c 300)"
    rm -f "$REG_TMP"
    exit 1
  fi
  # `|| echo ""` guards against a malformed/empty register response — without it
  # python3 errors would propagate via set -e and kill the script silently before
  # the explicit "missing identity_id/api_key" error below could print.
  IDENTITY_ID="$(python3 -c "import json; d=json.load(open('$REG_TMP')); print((d.get('data') or d).get('identity_id',''))" 2>/dev/null || echo "")"
  API_KEY="$(python3 -c   "import json; d=json.load(open('$REG_TMP')); print((d.get('data') or d).get('api_key',''))"   2>/dev/null || echo "")"
  rm -f "$REG_TMP"
  [[ -z "$IDENTITY_ID" || -z "$API_KEY" ]] && { echo "✗ register: missing identity_id/api_key in response"; exit 1; }
  echo "[init] ✓ registered: identity_id=$IDENTITY_ID  api_key=(written to config)"
fi

# -------- write config.json (merge with existing) --------
echo "[init] writing $CONFIG"
python3 - "$CONFIG" "$BFF_URL" "$WS_URL" "$IDENTITY_ID" "$API_KEY" "$MEMBER_ID" \
                   "${COCO_ORG_ID:-}" "${COCO_ORG_NAME:-}" "${COCO_OWNER_MEMBER_ID:-}" \
                   "${COCO_OWNER_NAME:-}" "${COCO_SELF_NAME:-}" \
                   "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" <<'PY'
import json, sys, os, uuid

(p, bff, ws, ident, api_key, member_id,
 org_id, org_name, owner_mid, owner_name, self_name,
 cf_id, cf_secret) = sys.argv[1:14]

cfg = {}
if os.path.exists(p):
    try: cfg = json.load(open(p))
    except Exception: cfg = {}

cfg.setdefault("enabled", True)
cfg["server"] = {"bff_url": bff, "ws_url": ws}

# CF-Access service token (from env COCO_CF_ACCESS_CLIENT_ID/SECRET). Merge so a
# partial re-run doesn't wipe an existing value. Never hardcoded.
ca = cfg.setdefault("cf_access", {"client_id": "", "client_secret": ""})
if cf_id:     ca["client_id"]     = cf_id
if cf_secret: ca["client_secret"] = cf_secret

a = cfg.setdefault("agent", {})
if ident:   a["identity_id"] = ident
if api_key: a["api_key"]     = api_key
a.setdefault("device_id", str(uuid.uuid4()))
a.setdefault("app_version", "0.1.0")

orgs = cfg.setdefault("orgs", {})
if org_id:
    slug = f"org-{org_id[:8]}"
    # Merge into existing org block if present so re-running with partial env
    # doesn't wipe fields not in this invocation
    block = orgs.get(slug, {})
    block["enabled"] = True
    block["org_id"]   = org_id
    if org_name or "org_name" not in block:   block["org_name"]   = org_name or block.get("org_name", "")
    owner = block.setdefault("owner", {"member_id": "", "name": ""})
    if owner_mid:  owner["member_id"] = owner_mid
    if owner_name: owner["name"]      = owner_name
    me = block.setdefault("self", {"member_id": "", "name": ""})
    if member_id:  me["member_id"] = member_id
    if self_name:  me["name"]      = self_name
    block.setdefault("access", {"dmPolicy": "owner", "groupPolicy": "allowlist", "groups": {}})
    orgs[slug] = block
    print(f"  org seeded: {slug} (org_id={org_id})")

json.dump(cfg, open(p, "w"), indent=2)
os.chmod(p, 0o600)
print(f"  ✓ config.json written ({len(cfg.get('orgs', {}))} org block(s))")
PY

echo
echo "Done. Config written to $CONFIG"
echo "Start the service manually when ready:"
echo "  pm2 start $SKILL_DIR/ecosystem.config.cjs"
echo "  pm2 logs zylos-openmax --lines 30"
