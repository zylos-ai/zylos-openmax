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
 *   - `orgs.<slug>` is a user-chosen key (e.g. "team-alpha"). The slug has
 *     no meaning to cws-* services; only `orgs.<slug>.org_id` is the real
 *     COCO org UUID. Slugs make the config human-readable.
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
    bff_url: 'http://127.0.0.1:8080',          // cws-core REST + cws-comm IM REST
    ws_url:  'ws://127.0.0.1:8080/ws',         // cws-comm WebSocket
    kb_url:  '',                                // optional override; falls back to bff_url
    as_url:  '',                                // optional override; falls back to bff_url
    reconnect_max_delay: 30000,                 // WS exponential backoff cap, ms
    heartbeat_interval:  30000,                 // WS heartbeat interval, ms
    platform: 'server',
  },

  // Global agent identity — same api_key authenticates the agent across all
  // orgs it has joined. member_id within each org is per-org (see orgs.*).
  agent: {
    identity_id:  '',                           // returned by POST /auth/register/agent
    api_key:      '',                           // canonical store: ~/zylos/.env COCO_AUTH_TOKEN
    device_id:    '',                           // UUIDv4, generated at install time
    client_id:    '',                           // UUIDv4, generated at install time
    app_version:  '0.1.0',                      // sent as X-Client-Version
  },

  // Multi-org map. Empty by default — operator fills in (or post-install
  // bootstraps a placeholder org block). At runtime, comm-bridge opens one
  // WebSocket per enabled org.
  orgs: {
    // 'default': {
    //   enabled:      true,
    //   org_id:       '',          // COCO org UUID
    //   org_name:     '',          // display only
    //   member_id:    '',          // agent's member id within this org
    //   display_name: 'Zylos',
    //   owner: {
    //     bound:     false,
    //     member_id: '',
    //     name:      '',
    //   },
    //   access: {
    //     dmPolicy:    'owner',          // 'open' | 'allowlist' | 'owner'
    //     dmAllowFrom: [],
    //     groupPolicy: 'allowlist',      // 'open' | 'allowlist' | 'disabled'
    //     groups: {
    //       // '<conv-uuid>': {
    //       //   name:      '',
    //       //   mode:      'mention',   // 'mention' | 'smart'
    //       //   allowFrom: ['*'],
    //       // }
    //     },
    //   },
    // },
  },

  message: {
    context_messages: 10,
    dedup_ttl: 300000,
  },
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
 */
export function bindOwner(orgSlug, memberId, displayName) {
  if (!orgSlug || !memberId) return null;
  return updateConfig((cfg) => {
    const org = cfg.orgs?.[orgSlug];
    if (!org) return;
    if (org.owner?.bound) return;
    org.owner = {
      bound: true,
      member_id: memberId,
      name: displayName || '',
    };
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
