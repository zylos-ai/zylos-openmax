#!/usr/bin/env node
/**
 * Smoke 16 — Invitations(纯脚本驱动)
 *
 * 见 smoke-16-invitations.md spec。10 断言。
 * 自动 provision USER3 (gavin-test-004@example.com / TestPass123!)。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';

const execp = promisify(execFile);

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
process.env.COCO_AUTH_TOKEN = process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN;
process.env.COCO_RPC_LOG = process.env.COCO_RPC_LOG || '0';

const CORE_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/core.js');
async function core(cmd, params = {}) {
  const { stdout } = await execp('node', [CORE_CLI, cmd, JSON.stringify(params)],
    { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout);
  return r.data ?? r;
}
const unwrap = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

const apiBase  = process.env.COCO_API_URL.replace(/\/+$/, '');
const cfId     = process.env.CF_ACCESS_CLIENT_ID     || '';
const cfSecret = process.env.CF_ACCESS_CLIENT_SECRET || '';

function commonHeaders(token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cfId)     h['CF-Access-Client-Id']     = cfId;
  if (cfSecret) h['CF-Access-Client-Secret'] = cfSecret;
  return h;
}

const TS = Date.now();
const NS = `Smoke16-${TS}`;

log(`=== Smoke 16: Invitations ===  ns=${NS}`);

const me = await core('core.me');
const USER1_ORG_ID = me.org_id || me.orgId;
assertTrue(USER1_ORG_ID, `pre. USER1.org_id 拿到`);

// ---------------------------------------------------------------------------
// Phase 0 — provision USER3
// ---------------------------------------------------------------------------

log('[Phase 0] provision USER3');

const USER3_EMAIL = 'gavin-test-004@example.com';
const USER3_PASS  = 'TestPass123!';

const regRes = await fetch(`${apiBase}/auth/register`, {
  method: 'POST', headers: commonHeaders(),
  body: JSON.stringify({ email: USER3_EMAIL, password: USER3_PASS, display_name: 'GavinTest004' }),
});
assertTrue([200, 201, 409, 422].includes(regRes.status),
    `1. USER3 register 状态 ∈ {200,201,409,422} (got ${regRes.status})`);

// identity-only login
const lr = await fetch(`${apiBase}/auth/login`, {
  method: 'POST', headers: commonHeaders(),
  body: JSON.stringify({ email: USER3_EMAIL, password: USER3_PASS, token_delivery: 'body' }),
});
const lrBody = await lr.json();
const user3Token = (lrBody.data ?? lrBody).access_token || '';
assertTrue(user3Token, `2. USER3 identity login 拿到 access_token`);

const user3Claim = JSON.parse(Buffer.from(user3Token.split('.')[1], 'base64url').toString());
const USER3_IDENTITY_SUB = user3Claim.sub;
log(`   USER3 identity sub=${USER3_IDENTITY_SUB}`);

// ---------------------------------------------------------------------------
// Phase 1 — invitation_create
// ---------------------------------------------------------------------------

log('[Phase 1] invitation_create');

const inv = await core('core.invitation_create', {
  orgId:   USER1_ORG_ID,
  roleId:  'org-member',
  email:   USER3_EMAIL,
  message: `${NS} invite USER3`,
});
const invId = inv.id || inv.invitation_id;
assertTrue(invId && /^[0-9a-f-]{36}$/i.test(invId), `3. invitation_create 返 uuid id`);
assertTrue((inv.email || '').toLowerCase() === USER3_EMAIL.toLowerCase(),
    `4. invitation.email == USER3_EMAIL`);
log(`   invitationId=${invId}`);

// ---------------------------------------------------------------------------
// Phase 2 — invitation_list
// ---------------------------------------------------------------------------

log('[Phase 2] invitation_list');

const listed = unwrap(await core('core.invitation_list', { orgId: USER1_ORG_ID, limit: 50 }));
assertTrue(listed.some(i => (i.id || i.invitation_id) === invId),
    `5. invitation_list 含 invId (got ${listed.length} invites)`);

// ---------------------------------------------------------------------------
// Phase 3 — USER3 accept
// ---------------------------------------------------------------------------

log('[Phase 3] USER3 invitation_accept');

const acpRes = await fetch(`${apiBase}/api/v1/invitations/${invId}/accept`, {
  method: 'POST', headers: commonHeaders(user3Token), body: JSON.stringify({}),
});
if (!acpRes.ok) {
  const body = await acpRes.text();
  die(`6. invitation_accept HTTP ${acpRes.status}: ${body.slice(0,200)}`);
}
ok(`6. USER3 invitation_accept 2xx`);

// ---------------------------------------------------------------------------
// Phase 4 — member_list 含 USER3
// ---------------------------------------------------------------------------

log('[Phase 4] member_list 含 USER3');

await new Promise(r => setTimeout(r, 800)); // 给一点点时间让 member 表落地
const members = unwrap(await core('core.member_list', { limit: 100 }));
const user3Member = members.find(m =>
  (m.identity_id === USER3_IDENTITY_SUB) ||
  (m.user_id === USER3_IDENTITY_SUB) ||
  ((m.email || '').toLowerCase() === USER3_EMAIL.toLowerCase()));
assertTrue(user3Member, `7. member_list 含 USER3 member (looking up identity ${USER3_IDENTITY_SUB})`);

// ---------------------------------------------------------------------------
// Phase 5 — second invitation + revoke
// ---------------------------------------------------------------------------

log('[Phase 5] second invitation + revoke');

const fakeEmail = `smoke16-revoked-${TS}@example.com`;
const inv2 = await core('core.invitation_create', {
  orgId: USER1_ORG_ID, roleId: 'org-member', email: fakeEmail,
});
const inv2Id = inv2.id || inv2.invitation_id;
assertTrue(inv2Id, `8. 第二条 invitation_create 返 id`);

try {
  await core('core.invitation_revoke', { invitationId: inv2Id });
  ok(`9. invitation_revoke 返 2xx`);
} catch (e) {
  die(`9. invitation_revoke 抛错: ${e.message}`);
}

const listed2 = unwrap(await core('core.invitation_list', { orgId: USER1_ORG_ID, limit: 100 }));
const revoked = listed2.find(i => (i.id || i.invitation_id) === inv2Id);
const status  = (revoked && (revoked.status || revoked.state || '').toLowerCase()) || '';
assertTrue(['revoked', 'cancelled', 'canceled', 'expired'].includes(status),
    `10. revoke 后 invitation 状态 ∈ {revoked,cancelled,expired} (got "${status}")`);

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 16 PASS (10 / 10)`);
log(`   USER3 identity=${USER3_IDENTITY_SUB}`);
log(`   invitation accepted = ${invId}`);
log(`   invitation revoked  = ${inv2Id}  (status=${status})`);
