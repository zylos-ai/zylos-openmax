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
 * Architecture (per user clarification 2026-05-20):
 *   - ALL REST traffic goes through cws-core (BFF). cws-core internally
 *     forwards to backend services (cws-comm / cws-work / cws-kb / cws-as
 *     / ...) via gRPC. From the client's perspective there is exactly
 *     one REST base URL: cws-core.
 *   - WebSocket ALONE is direct to cws-comm. Connection is gated by a
 *     short-lived single-use ticket obtained from cws-core
 *     (POST /auth/ws-ticket). cws-comm validates the ticket via gRPC
 *     callback to cws-core (ConsumeWSTicket) at handshake time.
 *
 * Required at install time (post-install hook will prompt):
 *   - workspace_id          (X-Workspace-Id header on every request)
 *   - agent.api_key         (Bearer credential for cws-core REST + for
 *                            fetching the WS ticket)
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
    // REST base — cws-core (BFF). Used for /auth/* and /api/v1/*.
    core_url: 'http://127.0.0.1:8080',
    // WebSocket direct endpoint — cws-comm. May share host/port with
    // core_url in some deployments, or differ in dev.
    ws_url:  'ws://127.0.0.1:8080/ws',
    // ws-ticket path on cws-core (api-versioning.md §"Path Convention" D14).
    // TODO confirm with cws-core team — ws-ticket-handoff.md §3.1 had
    // an older spelling `/api/v1/ws/ticket`; the newer api-versioning
    // doc places it under /auth/*.
    ws_ticket_path: '/auth/ws-ticket',
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
