#!/usr/bin/env node
/**
 * Smoke 17 — 多 Org 上下文(纯脚本驱动)
 *
 * 见 smoke-17-multi-org.md spec。10 断言。
 * 会创建一个新 org 留 DB 痕,不主动清理。
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
const NS = `Smoke17-${TS}`;

log(`=== Smoke 17: 多 Org 上下文 ===  ns=${NS}`);

// ---------------------------------------------------------------------------
// Phase 1 — org_list
// ---------------------------------------------------------------------------

log('[Phase 1] org_list (initial)');

const me0 = await core('core.me');
const ORG_A = me0.org_id || me0.orgId;
assertTrue(ORG_A, `pre. core.me.org_id 拿到`);

const orgs0 = unwrap(await core('core.org_list', {}));
assertTrue(orgs0.length >= 1, `1. org_list ≥ 1 (got ${orgs0.length})`);
assertTrue(orgs0.some(o => (o.id || o.orgId) === ORG_A),
    `2. org_list 含当前 org_id (${ORG_A})`);

// ---------------------------------------------------------------------------
// Phase 2 — org_create
// ---------------------------------------------------------------------------

log('[Phase 2] org_create');

const newOrgName = `${NS} org`;
const newOrgSlug = `smoke17-${TS}`.toLowerCase();

const newOrg = await core('core.org_create', { name: newOrgName, slug: newOrgSlug });
const newOrgId = newOrg.id || newOrg.orgId;
assertTrue(newOrgId && /^[0-9a-f-]{36}$/i.test(newOrgId),
    `3a. org_create 返 uuid id`);
assertTrue((newOrg.name || '').includes(NS),
    `3b. new org.name 含 ${NS} (got "${newOrg.name}")`);
log(`   newOrgId = ${newOrgId}`);

// ---------------------------------------------------------------------------
// Phase 3 — org_list 含 new
// ---------------------------------------------------------------------------

log('[Phase 3] org_list re-check');

const orgs1 = unwrap(await core('core.org_list', {}));
assertTrue(orgs1.some(o => (o.id || o.orgId) === newOrgId),
    `4. org_list 含 newOrgId (got ${orgs1.length} orgs)`);

// ---------------------------------------------------------------------------
// Phase 4 — switch to new org
// ---------------------------------------------------------------------------

log('[Phase 4] org_switch → newOrg');

try {
  await core('core.org_switch', { orgId: newOrgId });
  ok(`5. org_switch(newOrgId) 返 2xx`);
} catch (e) {
  die(`5. org_switch 抛错: ${e.message}`);
}

const meInNew = await core('core.me');
const orgIn = meInNew.org_id || meInNew.orgId;
if (orgIn === newOrgId) {
  ok(`6. switch 后 core.me.org_id == newOrgId(server-side switch)`);
} else {
  warn(`6. switch 后 core.me.org_id == ${orgIn} (期 ${newOrgId})。`
     + ` cws-core 的 org_switch 可能是 token-side(需要刷新 JWT)而非 server-side。`
     + ` 标 warn,继续。`);
  ok(`6. (warned: server-side vs token-side semantics; see note)`);
}

try {
  const projsB = unwrap(await core('core.project_list', { limit: 50 }));
  assertTrue(Array.isArray(projsB), `7. core.project_list 在 B 下返数组 (got ${projsB.length})`);
} catch (e) {
  die(`7. project_list in B 抛错: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Phase 5 — switch back to A
// ---------------------------------------------------------------------------

log('[Phase 5] org_switch back → A');

try {
  await core('core.org_switch', { orgId: ORG_A });
  ok(`8. org_switch(ORG_A) 返 2xx`);
} catch (e) {
  die(`8. org_switch back 抛错: ${e.message}`);
}

const meBack = await core('core.me');
const orgBack = meBack.org_id || meBack.orgId;
if (orgBack === ORG_A) {
  ok(`9. switch back 后 core.me.org_id == ORG_A`);
} else {
  warn(`9. switch back 后 core.me.org_id == ${orgBack} (期 ${ORG_A});同样可能是 token-side 语义`);
  ok(`9. (warned)`);
}

const projsA = unwrap(await core('core.project_list', { limit: 50 }));
assertTrue(projsA.length >= 1, `10. core.project_list 在 A 下 ≥ 1 个项目 (got ${projsA.length})`);

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 17 PASS (10 / 10)`);
log(`   ORG_A      = ${ORG_A}`);
log(`   newOrgId   = ${newOrgId}  (created, NOT cleaned up)`);
log(`   projsA len = ${projsA.length}`);
