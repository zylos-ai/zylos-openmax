#!/usr/bin/env bash
# install-coco-workspace.sh
# Standalone installer for zylos-coco-workspace — does NOT depend on
# `zylos add` and does NOT modify the zylos-core package. Suitable for
# machines where the vanilla zylos npm install lacks gitlab: support.
#
# What it does:
#   1. Verifies prereqs (node, npm, pm2, git or curl, GITLAB_TOKEN).
#   2. Clones / downloads zylos-coco-workspace from git.coco.xyz.
#   3. Installs into ~/zylos/.claude/skills/coco-workspace/.
#   4. Runs `npm install --omit=dev`.
#   5. Creates data dir ~/zylos/components/coco-workspace/{logs,media,runtime/tokens}.
#   6. Registers the component in ~/zylos/.zylos/components.json so
#      `zylos list` / `zylos upgrade` recognize it.
#
# What it does NOT do (run init-coco-workspace.sh afterwards):
#   - Write config.json
#   - Register agent / seed orgs
#   - Start PM2 service
#
# Usage:
#   GITLAB_TOKEN=glpat-... ./install-coco-workspace.sh [--branch <name>] [--tag <ver>]
#
# Env:
#   GITLAB_TOKEN          required, PAT for git.coco.xyz (or ZYLOS_GITLAB_TOKEN)
#   ZYLOS_GITLAB_HOST     optional, defaults to git.coco.xyz
#   COCO_WS_REPO_PATH     optional, defaults to coco-workspace/zylos-coco-workspace
#   COCO_WS_BRANCH        optional alternative to --branch; defaults to "main"

set -euo pipefail

# -------- args --------
BRANCH=""
TAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) BRANCH="$2"; shift 2 ;;
    --tag)    TAG="$2"; shift 2 ;;
    *)        echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
[[ -z "$BRANCH" && -z "$TAG" ]] && BRANCH="${COCO_WS_BRANCH:-main}"

# -------- prereqs --------
echo "[1/6] checking prereqs"
for cmd in node npm pm2 git curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "  ✗ missing: $cmd"; exit 1; }
done
echo "  ✓ node $(node --version), npm $(npm --version), pm2 $(pm2 --version | head -1)"

GL_TOKEN="${GITLAB_TOKEN:-${ZYLOS_GITLAB_TOKEN:-}}"
if [[ -z "$GL_TOKEN" && -f ~/zylos/.env ]]; then
  GL_TOKEN="$(grep -E '^(GITLAB_TOKEN|ZYLOS_GITLAB_TOKEN)=' ~/zylos/.env | head -1 | cut -d= -f2-)"
fi
[[ -z "$GL_TOKEN" ]] && { echo "  ✗ GITLAB_TOKEN not set (env or ~/zylos/.env)"; exit 1; }
echo "  ✓ GITLAB_TOKEN found (len ${#GL_TOKEN})"

GL_HOST="${ZYLOS_GITLAB_HOST:-git.coco.xyz}"
REPO_PATH="${COCO_WS_REPO_PATH:-coco-workspace/zylos-coco-workspace}"

# -------- target dirs --------
SKILL_DIR="$HOME/zylos/.claude/skills/coco-workspace"
DATA_DIR="$HOME/zylos/components/coco-workspace"
mkdir -p "$(dirname "$SKILL_DIR")" "$DATA_DIR"

# -------- download --------
echo "[2/6] downloading $REPO_PATH @ ${BRANCH:-$TAG} from $GL_HOST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
REF="${BRANCH:-$TAG}"
ENCODED_REPO="$(python3 -c "import urllib.parse; print(urllib.parse.quote('$REPO_PATH', safe=''))")"
API_URL="https://${GL_HOST}/api/v4/projects/${ENCODED_REPO}/repository/archive.tar.gz?sha=${REF}"
curl -fsSL -H "PRIVATE-TOKEN: ${GL_TOKEN}" -o "$TMP/archive.tar.gz" "$API_URL" \
  || { echo "  ✗ download failed (check GITLAB_TOKEN scope + repo path)"; exit 1; }
echo "  ✓ tarball ($(du -h "$TMP/archive.tar.gz" | cut -f1))"

# -------- extract --------
echo "[3/6] extracting → $SKILL_DIR"
# GitLab archives extract to <project>-<sha>-<sha>/, find the top-level dir
EXTRACTED="$(mktemp -d)"
tar -xzf "$TMP/archive.tar.gz" -C "$EXTRACTED"
TOP="$(find "$EXTRACTED" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -z "$TOP" ]] && { echo "  ✗ no top-level dir in archive"; exit 1; }

# Preserve existing config files before overwriting
PRESERVE_LIST=()
if [[ -d "$SKILL_DIR" ]]; then
  echo "  (existing install detected — preserving config.json / logs / runtime via post-install hook semantics)"
  # We DON'T preserve here; config lives in DATA_DIR, not SKILL_DIR.
  # node_modules will be re-installed by npm anyway.
  rm -rf "$SKILL_DIR"
fi
mv "$TOP" "$SKILL_DIR"
rm -rf "$EXTRACTED"
echo "  ✓ skill files in place"

# Read version from package.json for the registry entry
VERSION="$(node -e "console.log(require('$SKILL_DIR/package.json').version)" 2>/dev/null || echo "0.0.0")"
echo "  package.json version = $VERSION"

# -------- npm install --------
echo "[4/6] npm install --omit=dev (in $SKILL_DIR)"
( cd "$SKILL_DIR" && npm install --omit=dev --silent ) || { echo "  ✗ npm install failed"; exit 1; }
echo "  ✓ deps installed"

# -------- data dirs --------
echo "[5/6] preparing data dirs under $DATA_DIR"
mkdir -p "$DATA_DIR"/{logs,media,runtime,runtime/tokens}
echo "  ✓ logs/ media/ runtime/ runtime/tokens/ ready"

# -------- register in components.json --------
echo "[6/6] registering in ~/zylos/.zylos/components.json"
mkdir -p ~/zylos/.zylos
COMP_REG="$HOME/zylos/.zylos/components.json"
python3 - "$COMP_REG" "$VERSION" "$SKILL_DIR" "$DATA_DIR" "$REPO_PATH" "$BRANCH" <<'PY'
import json, os, sys, datetime
reg_path, version, skill_dir, data_dir, repo_path, branch = sys.argv[1:7]
data = {}
if os.path.exists(reg_path):
    try: data = json.load(open(reg_path))
    except Exception: data = {}
entry = {
  "version": version,
  "repo": f"gitlab:{repo_path}",
  "type": "declarative",
  "isThirdParty": False,
  "installedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
  "skillDir": skill_dir,
  "dataDir": data_dir,
}
if branch:
    entry["branch"] = branch
data["coco-workspace"] = entry
json.dump(data, open(reg_path, 'w'), indent=2)
os.chmod(reg_path, 0o600)
print(f"  ✓ registered coco-workspace v{version}")
PY

echo
echo "Done. Next:"
echo "  1) Set env vars (COCO_BFF_URL is required, others optional)"
echo "  2) ./init-coco-workspace.sh   # writes config.json + starts pm2"
