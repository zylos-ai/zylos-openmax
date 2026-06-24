/**
 * Configuration loader with hot-reload support.
 *
 * Schema (v0.4 — multi-org):
 *
 *   - One agent identity (`agent.identity_id`, `agent.api_key`) can be a
 *     member of multiple COCO orgs. Each enabled org gets its own WebSocket
 *     connection to cws-comm, its own access policy (lark-style dmPolicy /
 *     groupPolicy / per-group config), and its own owner auto-binding state.
 *
 *   - `server.*` holds the cws-core / cws-comm / cws-kb / cws-as endpoints
 *     and WS connection knobs.
 *
 *   - `orgs.<key>` is keyed by the full COCO org UUID (e.g.
 *     "019ea63a-c01b-7ca6-8463-e8d455bfd537"). Legacy configs may still
 *     use human-readable slugs (e.g. "org-019ea63a", "team-alpha");
 *     the runtime is key-agnostic — only `orgs.<key>.org_id` matters.
 *
 * Access control mirrors zylos-lark's model:
 *
 *   - dmPolicy: 'open' | 'allowlist' | 'owner'
 *       open      — anyone can DM
 *       allowlist — only members listed in dmAllowFrom
 *       owner     — only the bound owner (first DM auto-binds)
 *
 *   - groupPolicy: 'open' | 'allowlist' | 'disabled'
 *       open      — all groups handled
 *       allowlist — only groups listed in `groups` map
 *       disabled  — no group messages handled
 *
 *   - groups[convId].mode: 'mention' | 'smart'
 *       mention — only respond when @-mentioned
 *       smart   — respond to any message in the group
 *
 *   - groups[convId].allowFrom: ['*'] or [member_id, ...]
 *       ['*']   — all members allowed
 *       []      — empty == allow all (legacy lark compat)
 *       [ids]   — only listed members
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const CONFIG_PATH = path.join(HOME, 'zylos/components/coco-workspace/config.json');

export const DEFAULT_CONFIG = {
  enabled: true,

  server: {
    // The agent only talks to two surfaces:
    //   - cws-core REST     (also handles kb/as forwarding)  → bff_url
    //   - cws-comm WebSocket (long connection)               → ws_url
    //
    // Operational knobs (reconnect_max_delay, heartbeat_interval) are NOT
    // in DEFAULT_CONFIG — their defaults are hardcoded in src/comm-bridge.js
    // (DEFAULT_WS_RECONNECT_MAX_MS, DEFAULT_WS_HEARTBEAT_MS). Config may
    // override either. `platform` is no longer present (was never read).
    bff_url: 'http://127.0.0.1:8080',
    ws_url:  'ws://127.0.0.1:8080/ws',

    // Frontend base path — the SPA mount point on the same origin as bff_url.
    // Used by frontendUrl() to construct browser-navigable links. Override
    // when the deployment mounts cws-fe at a different path.
    frontend_base_path: '/cws',
  },

  // Cloudflare Access service-token headers, attached to every outbound REST
  // call and the WS handshake when present (gates traffic into Access-protected
  // environments like cws-int.coco.xyz). Empty by default — NOT a cws-core auth
  // credential. Populated into config.json at install time from operator-
  // supplied env (COCO_CF_ACCESS_CLIENT_ID / COCO_CF_ACCESS_CLIENT_SECRET).
  // When both are empty, no CF-Access headers are sent (direct/unprotected
  // environments). The secret lives only in config.json — never hardcoded in
  // source, never committed.
  cf_access: {
    client_id:     '',
    client_secret: '',
  },

  // Global agent identity — same api_key authenticates the agent across all
  // orgs it has joined. member_id within each org is per-org (see orgs.*).
  agent: {
    identity_id:  '',                           // returned by POST /auth/register/agent
    api_key:      '',                           // canonical store — populated by post-install hook
    device_id:    '',                           // UUIDv4, generated at install time
    app_version:  '0.1.0',                      // sent as X-Client-Version
  },

  // Multi-org map. Empty by default — operator fills in (or post-install
  // bootstraps a placeholder org block). At runtime, comm-bridge opens one
  // WebSocket per enabled org.
  //
  // The map key is the full COCO org UUID (matching `org_id`). Legacy
  // configs may use human-readable slugs; the runtime is key-agnostic.
  //
  // Per-org block:
  //   - `self`   : agent's own member identity within THIS org
  //                (member_id is per-org; the global agent identity is at
  //                top-level `agent.{identity_id, api_key}`).
  //   - `owner`  : the bound human owner for this org (set on first DM
  //                under dmPolicy=owner). An empty `owner.member_id`
  //                means "not yet bound" — the next sender auto-binds.
  //   - `access` : lark-style access policy.
  orgs: {
    // 'default': {
    //   enabled:  true,
    //   org_id:   '',                       // COCO org UUID
    //   org_name: '',                       // display only
    //   self:  { member_id: '', name: 'Zylos' },  // agent's member id + display name in this org
    //   owner: { member_id: '', name: '' },        // bound human owner (empty = unbound)
    //   access: {
    //     dmPolicy:    'owner',             // 'open' | 'allowlist' | 'owner'
    //     dmAllowFrom: [],
    //     groupPolicy: 'allowlist',         // 'open' | 'allowlist' | 'disabled'
    //     groups: {
    //       // '<conv-uuid>': {
    //       //   name:      '',
    //       //   mode:      'mention',      // 'mention' | 'smart'
    //       //   allowFrom: ['*'],
    //       // }
    //     },
    //   },
    // },
  },

  // `message.context_messages` / `message.dedup_ttl` / `message.dedup_max_entries`
  // are NOT in DEFAULT_CONFIG. Defaults are hardcoded in src/comm-bridge.js
  // (DEFAULT_CONTEXT_MESSAGES, DEFAULT_DEDUP_TTL_MS, DEFAULT_DEDUP_MAX_ENTRIES) —
  // aligned with zylos-lark's hardcoded constants. Config may supply a `message`
  // block to override any of these fields; if absent, the hardcoded defaults
  // apply. Keeping these out of DEFAULT_CONFIG means operator-edited config.json
  // files don't need to mention them at all.
  //
  // `message.enforceSkillFlow` (boolean, default TRUE) — when on, every inbound
  // envelope leads with a <coco-workspace> directive telling the agent to load
  // the coco-workspace skill and run its task flow before handling (enforcement
  // L1, see SKILL_FLOW_DIRECTIVE in src/lib/message.js). Set to false to suppress
  // the injected directive (e.g. a bot that never runs the coco-workspace skill).
};

let currentConfig = null;

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)
        && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  if (currentConfig) return currentConfig;

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    currentConfig = deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch {
    currentConfig = deepMerge(DEFAULT_CONFIG, {});
  }

  return currentConfig;
}

// =============================================================================
// Multi-org helpers
// =============================================================================

/**
 * Return [{ slug, ...orgConfig }] for every org with `enabled: true`.
 */
export function enabledOrgs() {
  const cfg = loadConfig();
  const out = [];
  for (const [slug, org] of Object.entries(cfg.orgs || {})) {
    if (org?.enabled === false) continue;
    if (!org?.org_id) continue;
    out.push({ slug, ...org });
  }
  return out;
}

/**
 * Find org config by its COCO org UUID. Returns { slug, ...orgConfig } or null.
 */
export function getOrgByOrgId(orgId) {
  if (!orgId) return null;
  const cfg = loadConfig();
  for (const [slug, org] of Object.entries(cfg.orgs || {})) {
    if (org?.org_id === orgId) return { slug, ...org };
  }
  return null;
}

/**
 * Default org resolver for callers (CLIs, REST clients) that don't pass an
 * explicit orgId: returns the single enabled org if there's exactly one,
 * otherwise null. Callers should fall back to COCO_ORG_ID env var or fail.
 */
export function resolveDefaultOrgId() {
  if (process.env.COCO_ORG_ID) return process.env.COCO_ORG_ID;
  const enabled = enabledOrgs();
  if (enabled.length === 1) return enabled[0].org_id;
  return '';
}

/**
 * Persist a config mutation to disk. Used by owner auto-bind, etc.
 * Read-modify-write with last-writer-wins. Bumps currentConfig cache.
 *
 * `mutate(config)` should modify `config` in place; the result is what gets
 * written. Returns the new config object.
 */
export function updateConfig(mutate) {
  const next = JSON.parse(JSON.stringify(loadConfig()));
  mutate(next);
  const tmp = `${CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  currentConfig = next;
  return next;
}

/**
 * Auto-bind the first DM sender as the owner of the given org. No-op if the
 * org already has an owner bound. Used when dmPolicy='owner' and an unbound
 * sender DMs the agent for the first time.
 *
 * "Bound" is now derived from `owner.member_id` being non-empty — there is
 * no separate `bound` flag in the schema.
 */
export function bindOwner(orgSlug, memberId, displayName) {
  if (!orgSlug || !memberId) return null;
  return updateConfig((cfg) => {
    const org = cfg.orgs?.[orgSlug];
    if (!org) return;
    if (org.owner?.member_id) return;
    org.owner = {
      member_id: memberId,
      name: displayName || '',
    };
  });
}

export function setOwner(orgSlug, memberId, displayName) {
  if (!orgSlug) return null;
  return updateConfig((cfg) => {
    const org = cfg.orgs?.[orgSlug];
    if (!org) return;
    org.owner = {
      member_id: memberId || '',
      name: displayName || '',
    };
  });
}

export function updateOwnerName(orgSlug, displayName) {
  if (!orgSlug || !displayName) return null;
  return updateConfig((cfg) => {
    const org = cfg.orgs?.[orgSlug];
    if (!org?.owner?.member_id) return;
    org.owner.name = displayName;
  });
}

// =============================================================================
// Hot-reload watcher
// =============================================================================

export function watchConfig(onChange) {
  let debounce = null;
  let watcher;
  try {
    watcher = fs.watch(CONFIG_PATH, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        currentConfig = null;
        const config = loadConfig();
        onChange?.(config);
      }, 100);
    });
  } catch (err) {
    console.warn(`[config] cannot watch ${CONFIG_PATH}: ${err.message} — hot reload disabled`);
    return () => {};
  }
  return () => {
    clearTimeout(debounce);
    watcher.close();
  };
}
