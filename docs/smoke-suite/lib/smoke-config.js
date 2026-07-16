// =============================================================================
//  Standalone smoke-suite configuration (self-contained for the user side).
// =============================================================================
//
// Curated SMOKE set — runs on every deploy to prove core cross-agent +
// task-flow + upload paths. Broader suite under ../smoke-tests/ is
// integration-only (on-demand / CI).
//
// Actors are NOT hardcoded:
//   • LEAD  = self — whichever bot is told to run the smoke. Resolved from
//     this runtime's config (orgs.*.self). Override: SMOKE_LEAD_MEMBER_ID.
//   • WORKER (multi-agent only) = caller-provided. The user supplies the
//     worker agent's api_key via SMOKE_WORKER_API_KEY; its member_id is
//     derived from the issued JWT. Nothing about the worker is committed.
//   • All conversations (user↔lead / user↔worker / lead↔worker) are resolved
//     dynamically via create_dm — no conversation ids baked in.
//
// Only the two human test USERS that drive the natural-language messages are
// embedded (throwaway staging test-org accounts — confirmed OK by the owner).
// No agent credentials are committed here.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';

// Smoke fixtures (CF-Access service token, test-user passwords, org/project)
// are NOT hardcoded in source. They live in a default config file at the same
// level as the runtime config.json:
//     ~/zylos/components/openmax/smoke-config.json
// (override the path with SMOKE_CONFIG_PATH). A committed template with the
// expected shape lives at docs/smoke/smoke-config.example.json. Individual
// fields can still be overridden by env (COCO_API_URL, CF_ACCESS_CLIENT_ID /
// CF_ACCESS_CLIENT_SECRET, SMOKE_ORG_ID, SMOKE_PROJECT_ID, SMOKE_USER).
const SMOKE_CONFIG_PATH = process.env.SMOKE_CONFIG_PATH
  || path.join(process.env.HOME || '', 'zylos/components/openmax/smoke-config.json');

function loadSmokeFile() {
  try { return JSON.parse(fs.readFileSync(SMOKE_CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}
const SMOKE = loadSmokeFile();

export const API_URL = process.env.COCO_API_URL || SMOKE.api_url || 'https://<your-bff-host>';

export const CF_ACCESS = {
  clientId:     process.env.CF_ACCESS_CLIENT_ID     || SMOKE.cf_access?.client_id     || '',
  clientSecret: process.env.CF_ACCESS_CLIENT_SECRET || SMOKE.cf_access?.client_secret || '',
};

export const ORG_ID     = process.env.SMOKE_ORG_ID     || SMOKE.org_id     || ''; // e.g. <test-org-id>
export const PROJECT_ID = process.env.SMOKE_PROJECT_ID || SMOKE.project_id || ''; // e.g. slug <test-project-id>

// Human test users that drive user→agent NL. Loaded from the smoke config file
// (test-org accounts). Pick via SMOKE_USER (default <test-user-a>).
export const USERS = SMOKE.users || {};
export const DEFAULT_USER = process.env.SMOKE_USER || SMOKE.default_user || '<test-user-a>';

// Password used to provision throwaway test accounts that a smoke registers on
// the fly (fixed-email accounts need a stable value). Sourced from env or the
// smoke config file — never a hardcoded literal in source.
export const PROVISION_PASSWORD = process.env.TEST_PASSWORD || SMOKE.provision_password || '';

function cfHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (CF_ACCESS.clientId)     h['CF-Access-Client-Id']     = CF_ACCESS.clientId;
  if (CF_ACCESS.clientSecret) h['CF-Access-Client-Secret'] = CF_ACCESS.clientSecret;
  return h;
}

function decodeJwt(tok) {
  try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString()); }
  catch { return {}; }
}

// Resolve "self" — the bot running this suite — from the openmax runtime
// config. This is the LEAD: whoever is told to run the smoke is lead.
export function resolveSelf() {
  if (process.env.SMOKE_LEAD_MEMBER_ID) return { name: 'self', member_id: process.env.SMOKE_LEAD_MEMBER_ID };
  try {
    const cfgPath = path.join(process.env.HOME || '', 'zylos/components/openmax/config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const orgs = cfg.orgs || {};
    const key = Object.keys(orgs).find(k => orgs[k]?.org_id === ORG_ID) || Object.keys(orgs)[0];
    const self = orgs[key]?.self;
    if (self?.member_id) return { name: self.name || 'self', member_id: self.member_id };
  } catch { /* fall through */ }
  return null;
}

// Log in as a human user and return an ORG-SCOPED JWT.
// /auth/login yields an identity-only token; refresh with org_id to scope it.
export async function login(userKey = DEFAULT_USER) {
  if (!USERS || Object.keys(USERS).length === 0) {
    throw new Error(`smoke-config: no test users configured — create ${SMOKE_CONFIG_PATH} `
      + `(see docs/smoke/smoke-config.example.json) or set SMOKE_CONFIG_PATH`);
  }
  const u = USERS[userKey];
  if (!u) throw new Error(`smoke-config: unknown user "${userKey}" (defined in ${SMOKE_CONFIG_PATH})`);
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST', headers: cfHeaders(),
    body: JSON.stringify({ email: u.email, password: u.password, token_delivery: 'body' }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`smoke-config: login ${u.email} failed (${res.status}): ${JSON.stringify(data)}`);
  const refresh = data?.data?.refresh_token || data?.refresh_token;
  const idToken = data?.data?.access_token || data?.access_token;
  if (!refresh) return idToken;
  const refRes = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST', headers: cfHeaders({ Authorization: `Bearer ${idToken}` }),
    body: JSON.stringify({ refresh_token: refresh, org_id: ORG_ID }),
  });
  const refData = await refRes.json().catch(() => ({}));
  if (!refRes.ok) throw new Error(`smoke-config: refresh ${u.email} failed (${refRes.status}): ${JSON.stringify(refData)}`);
  const token = refData?.data?.access_token || refData?.access_token;
  if (!token) throw new Error(`smoke-config: refresh ${u.email} returned no org-scoped token`);
  return token;
}

// Exchange a (caller-provided) agent api_key for an org-scoped JWT, and return
// both the token and the member_id from its claims.
export async function agentJwt(apiKey) {
  const idRes = await fetch(`${API_URL}/auth/agent/token`, { method: 'POST', headers: cfHeaders({ Authorization: apiKey }), body: '{}' });
  const idData = await idRes.json().catch(() => ({}));
  if (!idRes.ok) throw new Error(`smoke-config: agent/token failed (${idRes.status}): ${JSON.stringify(idData)}`);
  const idJwt = idData?.data?.access_token || idData?.access_token;
  const refresh = idData?.data?.refresh_token || idData?.refresh_token;
  const refRes = await fetch(`${API_URL}/auth/refresh`, {
    method: 'POST', headers: cfHeaders({ Authorization: `Bearer ${idJwt}` }),
    body: JSON.stringify({ refresh_token: refresh, org_id: ORG_ID }),
  });
  const refData = await refRes.json().catch(() => ({}));
  if (!refRes.ok) throw new Error(`smoke-config: worker refresh failed (${refRes.status}): ${JSON.stringify(refData)}`);
  const token = refData?.data?.access_token || refData?.access_token;
  if (!token) throw new Error('smoke-config: worker refresh returned no token');
  return { token, memberId: decodeJwt(token).member_id };
}

// Idempotently find/create a DM and return its conversation id.
export async function createDm(token, peerMemberId) {
  const res = await fetch(`${API_URL}/api/v1/conversations/dm`, {
    method: 'POST', headers: cfHeaders({ Authorization: `Bearer ${token}` }),
    body: JSON.stringify({ peer_member_id: peerMemberId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`smoke-config: create_dm peer=${peerMemberId} failed (${res.status}): ${JSON.stringify(data)}`);
  const id = data?.data?.conversation?.id || data?.conversation?.id;
  if (!id) throw new Error('smoke-config: create_dm returned no conversation id');
  return id;
}

// Populate process.env.TEST_* so the copied runners work unchanged.
//   opts.user        — NL-driving user key (default <test-user-a>)
//   opts.needWorker  — true for multi-agent cases
//   opts.workerApiKey — worker agent api_key (else SMOKE_WORKER_API_KEY)
export async function applyEnv(opts = {}) {
  const userKey = opts.user || process.env.SMOKE_USER || DEFAULT_USER;
  const userToken = await login(userKey);
  const lead = resolveSelf();
  if (!lead) throw new Error('smoke-config: cannot resolve self (lead). Set SMOKE_LEAD_MEMBER_ID.');

  const set = (k, v) => { process.env[k] = v; };
  set('COCO_API_URL', API_URL);
  if (!process.env.CF_ACCESS_CLIENT_ID)     set('CF_ACCESS_CLIENT_ID', CF_ACCESS.clientId);
  if (!process.env.CF_ACCESS_CLIENT_SECRET) set('CF_ACCESS_CLIENT_SECRET', CF_ACCESS.clientSecret);
  set('TEST_ORG_ID', ORG_ID);
  set('TEST_PROJECT_ID', PROJECT_ID);
  set('TEST_USER_TOKEN', userToken);
  set('COCO_AUTH_TOKEN', process.env.COCO_AUTH_TOKEN || userToken);

  // LEAD = self
  set('TEST_AGENT_ID', lead.member_id);
  set('TEST_CONV_ID', await createDm(userToken, lead.member_id)); // user↔lead

  // WORKER (multi-agent only) — caller-provided api_key.
  if (opts.needWorker) {
    const apiKey = opts.workerApiKey || process.env.SMOKE_WORKER_API_KEY;
    if (!apiKey) throw new Error('smoke-config: multi-agent smoke needs the worker agent\'s api_key — set SMOKE_WORKER_API_KEY=<cwsk_...>');
    const { token: workerToken, memberId: workerMemberId } = await agentJwt(apiKey);
    if (!workerMemberId) throw new Error('smoke-config: could not derive worker member_id from its JWT');
    set('TEST_WORKER_API_KEY', apiKey);
    set('TEST_WORKER_CONV_ID', await createDm(userToken, workerMemberId));    // user↔worker
    set('TEST_LEAD_WORKER_CONV_ID', await createDm(workerToken, lead.member_id)); // lead↔worker (as worker)
  }

  return { user: userKey, lead: lead.name, leadMember: lead.member_id, worker: opts.needWorker ? 'provided' : null };
}
