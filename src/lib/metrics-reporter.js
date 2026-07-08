/**
 * Runtime-metrics reporter — reads the local zylos-dashboard state and PUTs
 * it to cws-core (`PUT /api/v1/agents/{member_id}/runtime-metrics`) on a
 * periodic tick driven by src/comm-bridge.js.
 *
 * Dashboard auth: when zylos-dashboard has password auth enabled, all
 * `/api/*` routes return 401 unless authenticated. Configure
 * `metricsReport.dashboardApiKey` (a `zylos_ak_...` API key) and the reporter
 * exchanges it at `POST /api/auth/token` for a short-lived session token
 * (`zylos_st_...`), caches it until expiry (with a safety margin), and
 * attaches it to `/api/state`. A 401 from `/api/state` triggers one
 * re-exchange + one retry; a 401 from the exchange itself means the key is
 * invalid — warned once, then no further exchange attempts until restart.
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
import { putForOrg as realPutForOrg, apiPath as realApiPath } from './client.js';

const HOME = process.env.HOME;
const DASHBOARD_CONFIG_PATH = path.join(HOME, 'zylos/components/dashboard/config.json');
const FETCH_TIMEOUT_MS = 5000;
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

function getDashboardPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, 'utf8'));
    return cfg.port || 3470;
  } catch {
    return 3470;
  }
}

function buildPayload(dashboard) {
  if (!dashboard) return null;
  const sys = dashboard.system_metrics || {};
  const rt = dashboard.runtime_info || {};
  return {
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
} = {}) {
  let warnedEndpoint404 = false;     // cws-core runtime-metrics endpoint missing
  let warnedStateUnavailable = false; // dashboard state fetch failing — re-armed on success
  let keyRejected = false;            // exchange 401 — permanent until restart
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

  // Exchange the API key for a session token. Returns the token string, or
  // null when the exchange failed (401 = invalid key → warn once and never
  // try again this process; other failures are transient, retried next tick).
  async function exchangeToken(port) {
    const res = await fetchWithTimeout(`http://127.0.0.1:${port}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${dashboardApiKey}` },
    });
    if (res.status === 401) {
      keyRejected = true;
      warn('dashboard api key rejected (401) — runtime-metrics not reported');
      return null;
    }
    if (!res.ok) return null;
    const body = await res.json();
    const expiresAtMs = body.ttl_seconds != null
      ? now() + body.ttl_seconds * 1000
      : (body.expires_at ? Date.parse(body.expires_at) : now());
    cachedToken = { token: body.token, expiresAtMs };
    return body.token;
  }

  async function getToken(port) {
    if (cachedToken && cachedToken.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > now()) {
      return cachedToken.token;
    }
    cachedToken = null;
    return exchangeToken(port);
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
    const port = getDashboardPort();
    try {
      let token = null;
      if (dashboardApiKey) {
        if (keyRejected) return null; // warned once at rejection time — stay quiet
        token = await getToken(port);
        if (!token) return null;
      }
      let res = await fetchState(port, token);
      if (res.status === 401 && dashboardApiKey && !keyRejected) {
        // Session token expired/revoked server-side — re-exchange once, retry once.
        cachedToken = null;
        token = await exchangeToken(port);
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

    for (const [slug, orgConfig] of activeOrgConfigs) {
      const selfMemberId = orgConfig.self?.member_id;
      if (!selfMemberId) continue;
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
    }
  };
}
