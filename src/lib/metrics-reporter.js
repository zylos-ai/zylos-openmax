import fs from 'fs';
import path from 'path';
import { putForOrg, apiPath } from './client.js';

const HOME = process.env.HOME;
const DASHBOARD_CONFIG_PATH = path.join(HOME, 'zylos/components/dashboard/config.json');
const FETCH_TIMEOUT_MS = 5000;

let _warnedEndpoint404 = false;

function getDashboardPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_PATH, 'utf8'));
    return cfg.port || 3470;
  } catch {
    return 3470;
  }
}

async function fetchDashboardState() {
  const port = getDashboardPort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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
      mem_total: sys.mem_total_bytes ?? null,
      mem_used:  sys.mem_used_bytes ?? null,
      disk_pct:  sys.disk_pct ?? null,
      disk_free: sys.disk_free_bytes ?? null,
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
    reported_at: new Date().toISOString(),
  };
}

export function createMetricsReporter(activeOrgConfigs, { log, warn }) {
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
          if (!_warnedEndpoint404) {
            warn(`[${slug}] runtime-metrics endpoint not available (404), skipping`);
            _warnedEndpoint404 = true;
          }
        } else {
          warn(`[${slug}] metrics report failed: ${err.message}`);
        }
      }
    }
  };
}
