#!/usr/bin/env node
/**
 * Smoke 15 — Identity + Role + Org Switch(纯脚本驱动)
 *
 * 见 smoke-15-identity-and-roles.md spec。10 断言。
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

const TS = Date.now();
const NS = `Smoke15-${TS}`;

log(`=== Smoke 15: Identity + Role + Org Switch ===  ns=${NS}`);

// ---------------------------------------------------------------------------
// Phase 1 — core.me
// ---------------------------------------------------------------------------

log('[Phase 1] core.me');

const me = await core('core.me');
const selfMemberId = me.member_id || me.memberId;
const selfOrgId    = me.org_id    || me.orgId;
assertTrue(selfMemberId && selfOrgId, `1. core.me 返 member_id + org_id`);
log(`   self member=${selfMemberId} org=${selfOrgId}`);

// ---------------------------------------------------------------------------
// Phase 2 — member_list
// ---------------------------------------------------------------------------

log('[Phase 2] member_list');

const members = unwrap(await core('core.member_list', { limit: 50 }));
assertTrue(members.length >= 1, `2. member_list ≥ 1 (got ${members.length})`);

// ---------------------------------------------------------------------------
// Phase 3 — member_get
// ---------------------------------------------------------------------------

log('[Phase 3] member_get(self)');

const selfFetched = await core('core.member_get', { memberId: selfMemberId });
assertEq(selfFetched.id || selfFetched.memberId, selfMemberId,
    `3. member_get(self.member_id) id 对得上`);
assertTrue((selfFetched.kind || selfFetched.type) && (selfFetched.status !== undefined),
    `4. member 含 kind + status`);

const others = members.filter(m => (m.id || m.memberId) !== selfMemberId);
if (others.length > 0) {
  const other = others[0];
  const otherFetched = await core('core.member_get', { memberId: other.id || other.memberId });
  assertEq(otherFetched.id || otherFetched.memberId, other.id || other.memberId,
      `5. member_get(other) 返 2xx + id 对得上`);
} else {
  warn(`5. member_list 里没有 other(只有 self),跳过`);
  ok(`5. (skipped: no other members)`);
}

// ---------------------------------------------------------------------------
// Phase 4 — role_list
// ---------------------------------------------------------------------------

log('[Phase 4] role_list');

const roles = unwrap(await core('core.role_list', { scope: 'org' }));
assertTrue(roles.length >= 1, `6. role_list ≥ 1 (got ${roles.length})`);
const r0 = roles[0];
assertTrue(r0 && (r0.id || r0.slug || r0.name) && (r0.scope !== undefined || r0.kind !== undefined),
    `7. role 含 id/slug/name + scope/kind`);
const roleSlugs = roles.map(r => (r.slug || r.name || r.id || '').toLowerCase());
assertTrue(roleSlugs.some(s => s.includes('owner') || s.includes('member') || s.includes('admin')),
    `8. role 列表含 owner/member/admin 任一 (got ${roleSlugs.join(',').slice(0,160)})`);

// ---------------------------------------------------------------------------
// Phase 5 — org_switch (no-op same-org)
// ---------------------------------------------------------------------------

log('[Phase 5] org_switch (no-op)');

try {
  await core('core.org_switch', { orgId: selfOrgId });
  ok(`9. org_switch(self org) 返 2xx`);
} catch (e) {
  die(`9. org_switch 抛错: ${e.message}`);
}

const meAfter = await core('core.me');
const orgAfter = meAfter.org_id || meAfter.orgId;
assertEq(orgAfter, selfOrgId, `10. switch 后 core.me.org_id 不变`);

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 15 PASS (10 / 10)`);
log(`   self member=${selfMemberId} org=${selfOrgId}`);
log(`   member_list=${members.length}  role_list=${roles.length}`);
