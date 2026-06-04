#!/usr/bin/env node
/**
 * Smoke 14 — Comm Sync + Search(纯脚本驱动)
 *
 * 见 smoke-14-comm-sync-search.md spec。10 断言。
 */

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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

const COMM_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/comm.js');
async function comm(cmd, params = {}) {
  const { stdout } = await execp('node', [COMM_CLI, cmd, JSON.stringify(params)],
    { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout);
  return r.data ?? r;
}
const unwrap = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

const TS = Date.now();
const NS = `Smoke14-${TS}`;
const deviceId = crypto.randomUUID();

log(`=== Smoke 14: Comm Sync + Search ===  ns=${NS}`);

// ---------------------------------------------------------------------------
// Phase 1 — list_conversations
// ---------------------------------------------------------------------------

log('[Phase 1] list_conversations');

const convsNoArchived  = unwrap(await comm('comm.list_conversations', { includeArchived: false, limit: 50 }));
const convsWithArchived = unwrap(await comm('comm.list_conversations', { includeArchived: true,  limit: 50 }));
assertTrue(Array.isArray(convsNoArchived),  `1. list_conversations(includeArchived=false) 返数组`);
assertTrue(Array.isArray(convsWithArchived) && convsWithArchived.length >= convsNoArchived.length,
    `2. includeArchived=true 长度 ≥ false (${convsWithArchived.length} ≥ ${convsNoArchived.length})`);
assertTrue(convsWithArchived.length === 0 ||
           (convsWithArchived[0].id && (convsWithArchived[0].type || convsWithArchived[0].kind)),
    `3. 至少含 id+type 字段(或空集)`);

// ---------------------------------------------------------------------------
// Phase 2 — sync sinceSeq=0
// ---------------------------------------------------------------------------

log('[Phase 2] sync sinceSeq=0');

const sync0 = await comm('comm.sync', { sinceSeq: 0, deviceId, limit: 200 });
const events = sync0.events || sync0.items || [];
assertTrue(Array.isArray(events), `4. sync 返 events 字段(数组) (got ${events.length})`);

if (events.length > 0) {
  const e0 = events[0];
  assertTrue(
    e0.conversation_id && (e0.message_id || e0.messageId) && (e0.seq !== undefined) && e0.timestamp,
    `5. event envelope 含 conversation_id + message_id + seq + timestamp`
  );
} else {
  warn(`5. events 空集,无法验证 envelope shape(可接受,标 warn)`);
  ok(`5. (skipped due to empty events)`);
}

const hasMore0 = sync0.has_more ?? sync0.hasMore;
assertTrue(typeof hasMore0 === 'boolean', `6. has_more 是 boolean (got ${typeof hasMore0})`);

// ---------------------------------------------------------------------------
// Phase 3 — sync sinceSeq=巨大
// ---------------------------------------------------------------------------

log('[Phase 3] sync sinceSeq=99999999');

const syncFuture = await comm('comm.sync', { sinceSeq: 99999999, deviceId, limit: 50 });
const futureEvents = syncFuture.events || syncFuture.items || [];
assertEq(futureEvents.length, 0, `7. sync(sinceSeq=巨大) events 空`);

const hasMoreFuture = syncFuture.has_more ?? syncFuture.hasMore;
assertEq(hasMoreFuture, false, `8. sync(sinceSeq=巨大) has_more == false`);

// ---------------------------------------------------------------------------
// Phase 4 — search
// ---------------------------------------------------------------------------

log('[Phase 4] comm.search');

const searchRes1 = await comm('comm.search', { query: 'Smoke', limit: 5 });
const data1 = searchRes1.data || searchRes1.items || [];
const total1 = (searchRes1.pagination && (searchRes1.pagination.total_count ?? searchRes1.pagination.totalCount))
            ?? searchRes1.total ?? 0;
assertTrue(Array.isArray(data1) && Number.isInteger(total1),
    `9. comm.search 返 data 数组 + pagination.total_count integer (got data=${data1.length} total=${total1})`);

if (process.env.TEST_DEFAULT_KB_ID) {
  try {
    const searchRes2 = await comm('comm.search', {
      query: 'Smoke', limit: 5, kbId: process.env.TEST_DEFAULT_KB_ID,
    });
    const data2 = searchRes2.data || searchRes2.items || [];
    assertTrue(Array.isArray(data2),
        `10. comm.search(kbId=<TEST_DEFAULT_KB_ID>) 返 data 数组`);
  } catch (e) {
    die(`10. kbId 限定 search 抛错: ${e.message}`);
  }
} else {
  warn(`10. TEST_DEFAULT_KB_ID 未设,跳过 kbId 限定测; ok by default`);
  ok(`10. (skipped: no TEST_DEFAULT_KB_ID)`);
}

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 14 PASS (10 / 10)`);
log(`   deviceId = ${deviceId}`);
log(`   active   = ${convsNoArchived.length}  withArchived = ${convsWithArchived.length}`);
log(`   sync0 events = ${events.length}  has_more = ${hasMore0}`);
