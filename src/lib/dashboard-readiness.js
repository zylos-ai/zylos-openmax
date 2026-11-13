import { getDashboardPort } from './dashboard-address.js';

/** One request per existing readiness evaluation; no watcher or cached result. */
export async function readDashboardProbe({ fetch = globalThis.fetch, port = getDashboardPort(), timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health?probe=ready`, {
      signal: controller.signal, redirect: 'error',
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Availability follows the probe; onboarding policy uses only its health facts. */
export async function evaluateDashboardReadiness({ readProbe = readDashboardProbe, runtime = null } = {}) {
  const probe = await readProbe();
  const body = probe?.body;
  const health = body?.runtime_health?.[runtime];
  const detail = { source: 'dashboard', http_status: probe?.status ?? null,
    session_mode: body?.session_mode ?? null, runtime,
    health_source: health?.source ?? null, health: health?.health ?? null };
  const unavailable = () => ({ ready: false, reason: 'dashboard_unavailable', detail });
  if (probe?.status === 503 && body?.ready === false) {
    if (body.reason === 'supervisor_unavailable') return { ready: false, reason: body.reason, detail };
    if (body.reason === 'session_not_running' && body.session_mode === 'single') return { ready: false, reason: body.reason, detail };
    return unavailable();
  }
  if (probe?.status !== 200 || body?.ready !== true) return unavailable();
  // Missing/unreadable records do not establish whether login ever occurred.
  // Defer onboarding on unknown health, but retain the existing fail-open cap.
  const onboardingReason = health?.source === 'record' && ['ok', 'rate_limited', 'recovering'].includes(health.health)
    ? null
    : health?.source === 'record' && ['auth_failed', 'down', 'unavailable'].includes(health.health)
      ? `health_${health.health}` : 'health_unknown';
  return { ready: true, reason: 'ready', detail, ...(onboardingReason ? { onboardingReason } : {}) };
}
