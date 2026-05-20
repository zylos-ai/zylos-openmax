/**
 * Configuration loader with hot-reload support.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const CONFIG_PATH = path.join(HOME, 'zylos/components/coco-workspace/config.json');

/**
 * Default configuration.
 *
 * Architecture (cws-comm api-usage-guide §1 + §6, agent integration):
 *   - REST IM endpoints (POST /api/v1/messages etc.) hit cws-comm directly
 *     with `Authorization: Bearer <api_key>` + `X-Workspace-Id`.
 *   - Non-IM REST (KB/AS/TM/Core directory queries) hit the cws-fe Gateway
 *     under /api/gateway/v1/*; same Bearer + workspace header.
 *   - WebSocket is direct to cws-comm. Per api-usage-guide §6, the WS
 *     upgrade carries `Authorization: Bearer <api_key>` directly; no
 *     ticket pre-fetch is needed. The first `connect` frame echoes the
 *     api_key as `token` (along with client_id, device_id, last_seq).
 *   - Server replies with `connect_response` carrying a `session_token`.
 *     We persist it for diagnostics but keep using api_key on reconnect
 *     (api_key is long-lived; session_token would also work but adds
 *     no value for a server-side agent).
 *
 * Required at install time (post-install hook will prompt):
 *   - workspace_id          (X-Workspace-Id header on every request)
 *   - agent.api_key         (Bearer credential for both REST and WS upgrade;
 *                            post-install writes it to ~/zylos/.env as
 *                            COCO_AUTH_TOKEN, not into this file)
 *
 * Generated at install time:
 *   - device_id, client_id  (UUIDv4, persisted across restarts)
 */
export const DEFAULT_CONFIG = {
  enabled: true,
  workspace_id: '',
  device_id: '',
  client_id: '',
  app_version: '0.1.0',
  comm: {
    // REST base — cws-comm direct for IM, cws-fe Gateway for the rest.
    // Both are reached via this URL (they share host/port in production).
    core_url: 'http://127.0.0.1:8080',
    // WebSocket direct endpoint — cws-comm. Auth: Bearer api_key header
    // on upgrade (api-usage-guide §1.步骤一 / §6.步骤一). No ws-ticket.
    ws_url:  'ws://127.0.0.1:8080/ws',
    reconnect_max_delay: 30000,
    heartbeat_interval: 30000,
    platform: 'server',
  },
  agent: {
    id: '',
    participant_id: '',
    api_key: '',
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
    // File may not exist yet (e.g. before post-install). The bridge can
    // still run on DEFAULT_CONFIG; we just skip hot-reload until the
    // operator creates the file and restarts the service.
    console.warn(`[config] cannot watch ${CONFIG_PATH}: ${err.message} — hot reload disabled`);
    return () => {};
  }
  return () => {
    clearTimeout(debounce);
    watcher.close();
  };
}
