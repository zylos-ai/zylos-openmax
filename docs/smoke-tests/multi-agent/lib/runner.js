// Multi-agent smoke runner — minimal helpers for tests where the test client
// directly orchestrates multiple actors (Lead / Worker / etc.) over their own
// JWTs. No NL / no agent runtime in the loop; the value of these smokes is
// verifying that cws-core's authz + assignment logic correctly distinguishes
// callers by member_id, not in re-validating the agent's NL reasoning.
//
// (The single-agent suite under ../single-agent/lib/runner.js is NL-driven by
// design and shares neither this file's actor-bootstrap helpers nor its
// JWT-juggling fetch wrapper.)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const execp = promisify(execFile);

// =============================================================================
//  env / config
// =============================================================================

export function loadEnv() {
  const required = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_ORG_ID',
                    'TEST_PROJECT_ID', 'TEST_AGENT_ID'];
  for (const k of required) {
    if (!process.env[k]) die(`Missing required env: ${k}`);
  }
  return {
    COCO_API_URL:    process.env.COCO_API_URL.replace(/\/+$/, ''),
    TEST_USER_TOKEN: process.env.TEST_USER_TOKEN,
    TEST_ORG_ID:     process.env.TEST_ORG_ID,
    TEST_PROJECT_ID: process.env.TEST_PROJECT_ID,
    TEST_AGENT_ID:   process.env.TEST_AGENT_ID,
    CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
  };
}

function cfHeaders(env) {
  const h = {};
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}

// =============================================================================
//  bearer fetch — accepts a per-call token so the same env can wear multiple
//  actor JWTs back-to-back in a single test.
// =============================================================================

export async function bearerFetch(env, method, pathOrUrl, { token, body } = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${env.COCO_API_URL}${pathOrUrl}`;
  const headers = { 'Content-Type': 'application/json', ...cfHeaders(env) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json body */ }
  return { status: res.status, ok: res.ok, text, json };
}

// helper that throws on non-2xx with a clear message
export async function callApi(env, method, path, opts = {}) {
  const r = await bearerFetch(env, method, path, opts);
  if (!r.ok) {
    die(`${method} ${path} → HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  }
  return r.json?.data ?? r.json;
}

// =============================================================================
//  actor bootstrap — register → invite → accept → org-scoped re-login.
// =============================================================================

/**
 * Provision a fresh test user, invite them into env.TEST_ORG_ID, accept the
 * invitation, then re-login to mint an org-scoped JWT. Returns
 * `{ email, password, identityId, memberId, jwt, displayName }`.
 *
 * Idempotent on the smoke-suite side: each test pass uses a fresh
 * timestamped email so re-runs don't collide.
 */
export async function provisionMember(env, { rolePrefix = 'org-member', label = 'worker' } = {}) {
  const ts = Date.now();
  const email = `smoke-${label}-${ts}@example.com`;
  const password = 'WorkerPass123!';
  const displayName = `smoke-${label}-${ts}`;

  // 1. register — issues an identity JWT (no org context yet)
  const reg = await bearerFetch(env, 'POST', '/auth/register', {
    body: { email, password, token_delivery: 'body' },
  });
  if (!reg.ok) die(`provision register failed: HTTP ${reg.status}: ${reg.text.slice(0, 200)}`);
  const identityToken = reg.json?.data?.access_token;
  const identityId    = reg.json?.data?.identity_id || extractSubFromJwt(identityToken);
  if (!identityToken) die('register: no access_token');

  // 2. resolve role id (built-in slug → uuid)
  const roles = await callApi(env, 'GET', '/api/v1/roles', { token: env.TEST_USER_TOKEN });
  const role  = (roles || []).find(r => r.slug === rolePrefix);
  if (!role) die(`role with slug ${rolePrefix} not found`);

  // 3. org-owner sends invitation
  const inv = await callApi(env, 'POST', '/api/v1/invitations', {
    token: env.TEST_USER_TOKEN,
    body:  { role_id: role.role_id, email, message: `multi-agent smoke ${label}` },
  });
  const invitationId = inv.invitation_id;
  const invToken     = inv.token;
  if (!invitationId || !invToken) die(`invitation create returned no id/token: ${JSON.stringify(inv)}`);

  // 4. new user accepts (using their identity JWT)
  const acc = await callApi(env, 'POST', `/api/v1/invitations/${invitationId}/accept`, {
    token: identityToken,
    body:  { token: invToken, display_name: displayName },
  });
  const memberId = acc.member_id;
  if (!memberId) die(`invitation accept returned no member_id: ${JSON.stringify(acc)}`);

  // 5. re-login with org_id to get an org-scoped JWT
  const login = await bearerFetch(env, 'POST', '/auth/login', {
    body: { email, password, org_id: env.TEST_ORG_ID, token_delivery: 'body' },
  });
  if (!login.ok) die(`org-scoped login failed: HTTP ${login.status}: ${login.text.slice(0, 200)}`);
  const jwt = login.json?.data?.access_token;
  if (!jwt) die('org-scoped login: no access_token');

  return { email, password, identityId, memberId, jwt, displayName };
}

function extractSubFromJwt(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] + '===', 'base64url').toString());
    return payload.sub || '';
  } catch { return ''; }
}

// =============================================================================
//  assertions + logging
// =============================================================================

const T0 = Date.now();
const ts = () => new Date().toISOString();
let _passed = 0, _failed = 0;
export function log(msg)  { console.log(`[${ts()}] ${msg}`); }
export function ok(msg)   { _passed++; console.log(`[${ts()}]   ✓ ${msg}`); }
export function warn(msg) { console.log(`[${ts()}]   ! ${msg}`); }
export function die(msg)  { _failed++; console.error(`[${ts()}]   ✗ ${msg}`); process.exit(1); }
export function assertEq(actual, expected, label) {
  if (actual === expected) ok(`${label} = ${JSON.stringify(actual)}`);
  else die(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
export function assertTrue(cond, label) {
  if (cond) ok(label);
  else die(label);
}
export function assertNot(cond, label) {
  if (!cond) ok(label);
  else die(label);
}
export function summary(name) {
  const dur = ((Date.now() - T0) / 1000).toFixed(1);
  if (_failed === 0) {
    console.log(`\n[${ts()}] ✅ ${name} PASS (${_passed} / ${_passed} in ${dur}s)`);
  } else {
    console.log(`\n[${ts()}] ✗ ${name} FAIL (${_failed} of ${_passed + _failed} in ${dur}s)`);
    process.exit(1);
  }
}
