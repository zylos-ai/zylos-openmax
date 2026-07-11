/**
 * Self public base-URL resolution for the agent.
 *
 * Webhook-style channels (WhatsApp Business / LINE / Teams) need the agent to
 * know its OWN publicly-reachable base URL so it can construct callback/webhook
 * URLs. This module implements the two-tier resolution order (TM 79ad2910):
 *
 *   1. cws-core  — GET /api/v1/platform-agents/{identity_id}/domain returns the
 *      domain bound to this agent (`{full_domain, label, root_suffix}`).
 *      base_url = "https://" + full_domain.
 *   2. env       — if the agent has no bound domain (core 404), fall back to the
 *      AGENT_PUBLIC_BASE_URL environment variable.
 *
 * If neither yields a value → `{ ok:false, error }`.
 *
 * The reusable `resolveAgentBaseUrl()` takes injectable deps (get / apiPath /
 * env / config / identityId) so callers — the `core.agent_domain` CLI command,
 * future step-3 channel code, and unit tests — all share one resolution path
 * without hitting the network in tests.
 *
 * Note on env loading: this repo does NOT use dotenv anywhere — every module
 * (config.js, client.js, hooks/*) reads `process.env.*` directly and relies on
 * the Zylos runtime to have loaded ~/zylos/.env into the process environment
 * before the CLI runs. We follow that same convention here (read process.env
 * directly) rather than adding a dependency.
 */

import { get, apiPath } from './client.js';
import { loadConfig } from './config.js';

/** Trim whitespace and strip any trailing slashes so base_url never ends in "/". */
export function normalizeBaseUrl(u) {
  return String(u ?? '').trim().replace(/\/+$/, '');
}

/**
 * Resolve this agent's identity_id. Prefers config.json `agent.identity_id`
 * (the canonical global identity); falls back to cws-core `GET /me` which
 * returns `{ ..., identity_id }` when config is missing it.
 *
 * @param {object}   [deps]
 * @param {object}   [deps.config]     pre-loaded config (else loadConfig())
 * @param {Function} [deps.getFn]      get(path) → response (else client.get)
 * @param {Function} [deps.apiPathFn]  apiPath(p) → prefixed path (else client.apiPath)
 * @returns {Promise<string>}          identity_id, or '' if unresolvable
 */
export async function resolveAgentIdentityId(deps = {}) {
  const { config, getFn = get, apiPathFn = apiPath } = deps;
  const cfg = config || loadConfig();
  const fromCfg = cfg?.agent?.identity_id;
  if (fromCfg) return String(fromCfg);

  const me = await getFn(apiPathFn('/me'));
  return String(me?.identity_id || me?.identity?.id || '');
}

/**
 * Resolve the agent's public base URL via the two-tier order documented above.
 *
 * @param {object}   [deps]
 * @param {Function} [deps.getFn]      get(path) → response (else client.get)
 * @param {Function} [deps.apiPathFn]  apiPath(p) → prefixed path (else client.apiPath)
 * @param {object}   [deps.env]        env source (else process.env)
 * @param {object}   [deps.config]     pre-loaded config (else loadConfig())
 * @param {string}   [deps.identityId] skip identity resolution when provided
 * @returns {Promise<
 *   { ok:true,  source:'core', full_domain:string, label?:string, root_suffix?:string, base_url:string } |
 *   { ok:true,  source:'env',  base_url:string } |
 *   { ok:false, error:string }
 * >}
 */
export async function resolveAgentBaseUrl(deps = {}) {
  const {
    getFn = get,
    apiPathFn = apiPath,
    env = process.env,
    config,
  } = deps;

  // Tier 1 — cws-core bound domain.
  const identityId =
    deps.identityId || (await resolveAgentIdentityId({ config, getFn, apiPathFn }));

  if (identityId) {
    try {
      const domain = await getFn(apiPathFn(`/platform-agents/${identityId}/domain`));
      const fullDomain = domain?.full_domain;
      if (fullDomain) {
        return {
          ok: true,
          source: 'core',
          full_domain: fullDomain,
          label: domain.label,
          root_suffix: domain.root_suffix,
          base_url: normalizeBaseUrl(`https://${fullDomain}`),
        };
      }
      // A 200 without full_domain is treated like "no bound domain" → fall through.
    } catch (err) {
      // Only a 404 (no bound domain) falls through to the env tier. Any other
      // error (auth, 5xx, network) is a real failure and must propagate.
      if (err?.status !== 404) throw err;
    }
  }

  // Tier 2 — AGENT_PUBLIC_BASE_URL fallback.
  const envUrl = normalizeBaseUrl(env?.AGENT_PUBLIC_BASE_URL);
  if (envUrl) {
    return { ok: true, source: 'env', base_url: envUrl };
  }

  return { ok: false, error: 'no bound domain and AGENT_PUBLIC_BASE_URL unset' };
}
