/**
 * Runtime-metrics reporter — reads the local zylos-dashboard state and PUTs
 * it to cws-core (`PUT /api/v1/agents/{member_id}/runtime-metrics`) on a
 * periodic tick driven by src/comm-bridge.js.
 *
 * Dashboard auth: when zylos-dashboard has password auth enabled, all
 * `/api/*` routes return 401 unless authenticated. The reporter exchanges a
 * `zylos_ak_...` API key at `POST /api/auth/token` for a short-lived session
 * token (`zylos_st_...`), caches it until expiry (with a safety margin), and
 * attaches it to `/api/state`. A 401 from `/api/state` triggers one
 * re-exchange + one retry.
 *
 * Key auto-provisioning (zero operator action on upgrade): when the reporter
 * has no working key — none configured and the dashboard demands auth
 * (`/api/state` 401), or the exchange itself returns 401 (invalid key) — it
 * self-provisions via the dashboard's local CLI
 * (`api-key.js generate openmax-metrics read`, falling back to
 * `api-key.js rotate openmax-metrics` when the name already exists), parses
 * the `Key: zylos_ak_...` line from stdout, persists it into config.json
 * `metricsReport.dashboardApiKey` (via updateConfig, so the in-memory config
 * stays coherent), and proceeds with the normal exchange in the same tick.
 * A manually configured key is always tried first. Auto-provision runs at
 * most ONCE per process (success or fail — no rotate-loops); if the CLI is
 * missing/fails/unparseable, or a provisioned key is still rejected, the
 * reporter warns once and goes quiet until restart.
 *
 * Failures are never silent: an unavailable dashboard state is warned once
 * (same once-guard style as the runtime-metrics 404 skip), and a later
 * successful fetch re-arms the warning.
 *
 * Deps are injected so the logic is unit-testable without the comm-bridge
 * daemon or a live dashboard (see metrics-reporter.test.js).
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { putForOrg as realPutForOrg, apiPath as realApiPath } from './client.js';
import { updateConfig } from './config.js';

const HOME = process.env.HOME;
const DASHBOARD_CONFIG_PATH = path.join(HOME, 'zylos/components/dashboard/config.json');
const FETCH_TIMEOUT_MS = 5000;

// openmax's own package version, read once at module load (not per tick). Same
// pattern as auto-upgrade.js readPkgVersion(). Reported as a top-level `version`
// field in the runtime-metrics payload (a downstream service reads body.version).
const PKG_VERSION = (() => {
  try {
    return JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

// Dashboard-local API-key CLI (same machine/user — reads/writes the dashboard
// store directly, no HTTP auth involved). Overridable via the factory's
// `apiKeyCliPath` for tests / nonstandard layouts.
const DEFAULT_API_KEY_CLI = path.join(HOME, 'zylos/.claude/skills/dashboard/scripts/api-key.js');
const PROVISION_KEY_NAME = 'openmax-metrics';
const KEY_LINE_RE = /^(?:Key|New key): (zylos_ak_\S+)$/m;
const CLI_TIMEOUT_MS = 15_000;

const promisifiedExecFile = promisify(execFileCb);
const realExecFile = (file, args) => promisifiedExecFile(file, args, { timeout: CLI_TIMEOUT_MS });

// Default key persister — writes the provisioned key into openmax's own
// config.json via updateConfig so the in-memory config cache stays coherent.
function persistKeyToConfig(key) {
  updateConfig((cfg) => {
    cfg.metricsReport = cfg.metricsReport || {};
    cfg.metricsReport.dashboardApiKey = key;
  });
}

function getDashboardPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, 'utf8'));
    return cfg.port || 3470;
  } catch {
    return 3470;
  }
}

// IM channel components we report to cws-core. Deliberately excludes non-IM
// components (browser / openmax / dashboard / http / voice-asr / ...).
const IM_CHANNEL_COMPONENTS = new Set([
  'telegram', 'lark', 'feishu', 'dingtalk', 'wecom', 'slack', 'discord',
  'line', 'zalo', 'ms_teams', 'msteams', 'whatsapp', 'whatsapp_business',
]);

// Component name → channel_type reported upstream (identity for most).
function componentToChannelType(name) {
  if (name === 'msteams') return 'ms_teams';
  return name;
}

// Parse `zylos list` plain text (the CLI ignores --json). Lines look like:
//   "✓ lark (v0.3.5)" — pull the component name preceding " (vX.Y.Z)".
export function parseInstalledComponents(listStdout) {
  const names = [];
  for (const line of String(listStdout || '').split('\n')) {
    const m = /([a-z0-9_-]+)\s+\(v[0-9]/i.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

// Parse `pm2 jlist` → Map<serviceName, statusString>.
export function parsePm2Statuses(jlistStdout) {
  const map = new Map();
  try {
    const procs = JSON.parse(String(jlistStdout));
    if (Array.isArray(procs)) {
      for (const p of procs) map.set(p.name, p?.pm2_env?.status || 'stopped');
    }
  } catch { /* best-effort — no status */ }
  return map;
}

// Best-effort list of installed IM channels with their running status. Returns
// null when `zylos list` fails (caller then omits the field entirely so metrics
// reporting is never broken by this). pm2 status is a soft signal: if pm2 jlist
// is unavailable we still report the channel, defaulting to 'running' (it IS
// installed) rather than dropping it.
export async function deriveInstalledChannels({ execFile }) {
  let names;
  try {
    const { stdout } = await execFile('zylos', ['list']);
    names = parseInstalledComponents(stdout);
  } catch {
    return null;
  }
  const channels = names.filter((n) => IM_CHANNEL_COMPONENTS.has(n));
  if (channels.length === 0) return [];

  let statuses = new Map();
  try {
    const { stdout } = await execFile('pm2', ['jlist']);
    statuses = parsePm2Statuses(stdout);
  } catch { /* status best-effort */ }

  return channels.map((name) => {
    const st = statuses.get(`zylos-${name}`);
    // online → running; a known-but-not-online entry → stopped; unknown
    // (pm2 unavailable) → running fallback (the component is installed).
    const status = st === 'online' ? 'running' : (st ? 'stopped' : 'running');
    return { channel_type: componentToChannelType(name), status };
  });
}

function buildPayload(dashboard) {
  if (!dashboard) return null;
  const sys = dashboard.system_metrics || {};
  const rt = dashboard.runtime_info || {};
  return {
    version: PKG_VERSION,
    resources: {
      cpu_pct:   sys.cpu_pct ?? null,
      mem_pct:   sys.mem_pct ?? null,
      mem_total_bytes: sys.mem_total_bytes ?? null,
      mem_used_bytes:  sys.mem_used_bytes ?? null,
      disk_pct:        sys.disk_pct ?? null,
      disk_free_bytes: sys.disk_free_bytes ?? null,
    },
    runtime: {
      state:       dashboard.state ?? 'UNKNOWN',
      model_id:    rt.model_id ?? null,
      model:       rt.model ?? null,
      context_pct: dashboard.context_pct ?? null,
      effort:      rt.effort ?? null,
    },
    cost: {
      session: dashboard.session_cost ?? null,
      daily:   dashboard.daily_cost ?? null,
      weekly:  dashboard.weekly_cost ?? null,
    },
    rate_limit_pct: dashboard.rate_limit_pct ?? null,
  };
}

export function createMetricsReporter(activeOrgConfigs, {
  log,
  warn,
  dashboardApiKey = '',
  fetch = globalThis.fetch,
  now = Date.now,
  putForOrg = realPutForOrg,
  apiPath = realApiPath,
  execFile = realExecFile,
  fileExists = fs.existsSync,
  persistKey = persistKeyToConfig,
  apiKeyCliPath = DEFAULT_API_KEY_CLI,
} = {}) {
  let warnedEndpoint404 = false;     // cws-core runtime-metrics endpoint missing
  let warnedStateUnavailable = false; // dashboard state fetch failing — re-armed on success
  let apiKey = dashboardApiKey;       // may be replaced by an auto-provisioned key
  let provisionAttempted = false;     // auto-provision runs at most once per process
  let provisionPromise = null;        // serialize overlapping ticks onto one attempt
  let authQuiet = false;              // unrecoverable auth state — warned once, quiet until restart
  let cachedToken = null;             // { token, expiresAtMs }

  async function fetchWithTimeout(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // Exchange the API key for a session token. Returns:
  //   { token }             — success (token cached)
  //   { token: null }       — transient failure, retried next tick
  //   { invalidKey: true }  — 401, the key is invalid → auto-provision path
  async function exchangeToken(port) {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) return { invalidKey: true };
    if (!res.ok) return { token: null };
    const body = await res.json();
    const expiresAtMs = body.ttl_seconds != null
      ? now() + body.ttl_seconds * 1000
      : (body.expires_at ? Date.parse(body.expires_at) : now());
    cachedToken = { token: body.token, expiresAtMs };
    return { token: body.token };
  }

  async function runApiKeyCli(args) {
    const { stdout } = await execFile(process.execPath, [apiKeyCliPath, ...args]);
    return String(stdout);
  }

  // Generate (or rotate, when the name already exists) an API key via the
  // dashboard's local CLI and parse it from stdout. Throws on any failure
  // (CLI missing, non-zero exit, unparseable output).
  async function provisionKey() {
    if (!fileExists(apiKeyCliPath)) {
      throw new Error(`dashboard api-key CLI not found at ${apiKeyCliPath}`);
    }
    let stdout;
    try {
      stdout = await runApiKeyCli(['generate', PROVISION_KEY_NAME, 'read']);
    } catch (err) {
      const errText = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`;
      if (!/already exists/i.test(errText)) throw err;
      stdout = await runApiKeyCli(['rotate', PROVISION_KEY_NAME]);
    }
    const m = KEY_LINE_RE.exec(stdout);
    if (!m) throw new Error('could not parse api key from CLI output');
    return m[1];
  }

  // Make sure we have an auto-provisioned key to try. At most one provision
  // attempt per process (success or fail); any dead end here warns once and
  // silences the reporter until restart. Returns true when a fresh key was
  // provisioned and persisted.
  async function ensureProvisionedKey() {
    if (provisionPromise) return provisionPromise;
    if (provisionAttempted) {
      authQuiet = true;
      warn('dashboard api key rejected (401) after auto-provision — '
        + 'runtime-metrics not reported until restart');
      return false;
    }
    provisionAttempted = true;
    provisionPromise = (async () => {
      const key = await provisionKey();
      apiKey = key;
      persistKey(key);
      log?.(`dashboard api key auto-provisioned ("${PROVISION_KEY_NAME}") and saved to config`);
      return true;
    })();
    try {
      return await provisionPromise;
    } catch (err) {
      authQuiet = true;
      warn(`dashboard api key auto-provision failed (${err?.message || err}) — `
        + 'metrics reporting needs the dashboard component, or set '
        + 'metricsReport.dashboardApiKey manually; runtime-metrics not reported until restart');
      return false;
    } finally {
      provisionPromise = null;
    }
  }

  // Get a session token, auto-provisioning the key when there is none or the
  // current one is rejected. Returns the token string, or null to skip this
  // tick (transient exchange failures retry next tick; unrecoverable auth
  // states have warned once and set authQuiet).
  async function getToken(port) {
    if (cachedToken && cachedToken.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > now()) {
      return cachedToken.token;
    }
    cachedToken = null;
    if (!apiKey && !(await ensureProvisionedKey())) return null;
    let r = await exchangeToken(port);
    if (r.invalidKey) {
      if (!(await ensureProvisionedKey())) return null;
      r = await exchangeToken(port);
      if (r.invalidKey) {
        // The freshly provisioned key is rejected too — provisionAttempted is
        // already set, so this warns once and goes quiet.
        await ensureProvisionedKey();
        return null;
      }
    }
    return r.token;
  }

  function fetchState(port, token) {
    return fetchWithTimeout(`http://127.0.0.1:${port}/api/state`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  function warnStateUnavailable(reason) {
    if (warnedStateUnavailable) return;
    warnedStateUnavailable = true;
    warn(`dashboard state unavailable (${reason}) — runtime-metrics not reported; `
      + 'set metricsReport.dashboardApiKey if the dashboard has auth enabled');
  }

  async function fetchDashboardState() {
    if (authQuiet) return null; // warned once at the dead end — stay quiet
    const port = getDashboardPort();
    try {
      let token = null;
      if (apiKey) {
        token = await getToken(port);
        if (!token) return null;
      }
      let res = await fetchState(port, token);
      if (res.status === 401) {
        // With a key: session token expired/revoked server-side — re-exchange
        // once. Without one: the dashboard demands auth — auto-provision a key
        // (inside getToken). Either way, retry the state fetch once.
        cachedToken = null;
        token = await getToken(port);
        if (!token) return null;
        res = await fetchState(port, token);
      }
      if (!res.ok) {
        warnStateUnavailable(`http ${res.status}`);
        return null;
      }
      const state = await res.json();
      warnedStateUnavailable = false; // recovered — re-arm the once-guard
      return state;
    } catch (err) {
      warnStateUnavailable(err?.message || 'fetch failed');
      return null;
    }
  }

  return async function reportMetrics() {
    const dashboard = await fetchDashboardState();
    const payload = buildPayload(dashboard);
    if (!payload) return;

    // Best-effort: attach installed IM channels so cws-connect can reconcile
    // channel-binding status. Never let this break the metrics PUT.
    try {
      const channels = await deriveInstalledChannels({ execFile });
      if (channels) payload.installed_channels = channels;
    } catch (err) {
      warn(`installed_channels derivation failed: ${err?.message || err}`);
    }

    // Report to the PRIMARY org only (the first enabled org, i.e. the first
    // entry of the insertion-ordered Map) — a single PUT, not one per org.
    const [primary] = activeOrgConfigs;
    if (!primary) {
      warn('no active org configured — runtime-metrics not reported');
      return;
    }
    const [slug, orgConfig] = primary;
    const selfMemberId = orgConfig.self?.member_id;
    if (!selfMemberId) {
      warn(`[${slug}] primary org has no self.member_id — runtime-metrics not reported`);
      return;
    }
    try {
      await putForOrg(orgConfig.org_id, apiPath(`/agents/${selfMemberId}/runtime-metrics`), payload);
    } catch (err) {
      if (err.status === 404) {
        if (!warnedEndpoint404) {
          warn(`[${slug}] runtime-metrics endpoint not available (404), skipping`);
          warnedEndpoint404 = true;
        }
      } else {
        warn(`[${slug}] metrics report failed: ${err.message}`);
      }
    }
  };
}
