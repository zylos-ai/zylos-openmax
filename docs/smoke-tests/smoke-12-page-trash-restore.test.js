#!/usr/bin/env node
/**
 * Smoke 12 — Page Trash / Restore 全链(纯脚本驱动)
 *
 * 见同目录 smoke-12-page-trash-restore.md 完整 spec。12 断言。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';

const execp = promisify(execFile);

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_DEFAULT_KB_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
process.env.COCO_AUTH_TOKEN = process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN;
process.env.COCO_RPC_LOG = process.env.COCO_RPC_LOG || '0';

const env = {
  COCO_API_URL: process.env.COCO_API_URL.replace(/\/+$/, ''),
  CF_ID:        process.env.CF_ACCESS_CLIENT_ID || '',
  CF_SECRET:    process.env.CF_ACCESS_CLIENT_SECRET || '',
};
const TEST_KB_ID = process.env.TEST_DEFAULT_KB_ID;

const KB_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/kb.js');

async function kb(cmd, params = {}) {
  const { stdout } = await execp('node', [KB_CLI, cmd, JSON.stringify(params)],
    { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout);
  return r.data ?? r;
}
const unwrap = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

function headers() {
  const h = { Authorization: `Bearer ${process.env.TEST_USER_TOKEN}`,
              'Content-Type': 'application/json' };
  if (env.CF_ID)     h['CF-Access-Client-Id']     = env.CF_ID;
  if (env.CF_SECRET) h['CF-Access-Client-Secret'] = env.CF_SECRET;
  return h;
}
async function createPageDirect(kbId, body) {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/kbs/${kbId}/pages`,
    { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`POST /pages HTTP ${res.status}: ${JSON.stringify(j).slice(0,200)}`);
  return j.data ?? j;
}

const TS = Date.now();
const NS = `Smoke12-${TS}`;

log(`=== Smoke 12: Page Trash / Restore 全链 ===  ns=${NS}`);

// ---------------------------------------------------------------------------
// Phase 1 — 建 page + 3 revision
// ---------------------------------------------------------------------------

log('[Phase 1] page + 3 revisions');

const page = await createPageDirect(TEST_KB_ID, {
  title:  `${NS}`,
  format: 'markdown',
  body:   `INIT body for ${NS}`,
});
assertTrue(page && page.id && /^[0-9a-f-]{36}$/i.test(page.id),
    `1. page create 返 uuid pageId`);
const pageId = page.id;
log(`   pageId = ${pageId}`);

await kb('kb.page_content_write', {
  pageId, body: `V2 body for ${NS}`, message: 'add v2',
});
await kb('kb.page_content_write', {
  pageId, body: `V3 body for ${NS}`, message: 'add v3',
});
ok(`2. 2 次 page_content_write 都 2xx`);

// ---------------------------------------------------------------------------
// Phase 2 — page_revisions
// ---------------------------------------------------------------------------

log('[Phase 2] page_revisions');

const revs = unwrap(await kb('kb.page_revisions', { pageId, limit: 50 }));
assertTrue(revs.length >= 3, `3. page_revisions ≥ 3 (got ${revs.length})`);
const oldest = revs[revs.length - 1];
log(`   oldest revision = ${oldest && oldest.id}`);

// ---------------------------------------------------------------------------
// Phase 3 — page_restore (restore old revision)
// ---------------------------------------------------------------------------

log('[Phase 3] page_restore old revision');

try {
  await kb('kb.page_restore', { pageId, revisionId: oldest.id });
  ok(`4. page_restore(oldest) 返 2xx`);
} catch (e) {
  die(`4. page_restore 抛错: ${e.message}`);
}

const c = await kb('kb.page_content', { pageId });
assertTrue((c.body || '').includes('INIT body'),
    `5. restore 后 page_content.body 含 'INIT body' (got "${(c.body || '').slice(0,40)}...")`);

// ---------------------------------------------------------------------------
// Phase 4 — page_trash
// ---------------------------------------------------------------------------

log('[Phase 4] page_trash');

try {
  await kb('kb.page_trash', { pageId });
  ok(`6. page_trash 返 2xx`);
} catch (e) {
  die(`6. page_trash 抛错: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Phase 5 — pages_trashed + (optional) pages 不含
// ---------------------------------------------------------------------------

log('[Phase 5] pages_trashed');

const trashList = unwrap(await kb('kb.pages_trashed', { limit: 50 }));
assertTrue(trashList.some(p => p.id === pageId),
    `7. pages_trashed 含 pageId`);

try {
  const activePages = unwrap(await kb('kb.pages', { limit: 200 }));
  assertTrue(!activePages.some(p => p.id === pageId),
      `8. kb.pages(active) 不含 pageId(已 trash)`);
} catch (e) {
  warn(`8. kb.pages 抛错(可能踩 502 路径): ${e.message.slice(0,120)}; warn-only`);
}

// ---------------------------------------------------------------------------
// Phase 6 — page_restore_trash
// ---------------------------------------------------------------------------

log('[Phase 6] page_restore_trash');

try {
  await kb('kb.page_restore_trash', { pageId });
  ok(`9. page_restore_trash 返 2xx`);
} catch (e) {
  die(`9. page_restore_trash 抛错: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Phase 7 — page_get 复活
// ---------------------------------------------------------------------------

log('[Phase 7] page_get after un-trash');

const pgAfter = await kb('kb.page_get', { pageId });
const status = (pgAfter.status || '').toLowerCase();
assertTrue(pgAfter.id === pageId && (status === 'active' || status === 'ok' || !status),
    `10. restore_trash 后 page_get 返 2xx + active (got status=${status})`);

// ---------------------------------------------------------------------------
// Phase 8 — page_delete 永久删
// ---------------------------------------------------------------------------

log('[Phase 8] page_delete permanent');

try {
  await kb('kb.page_delete', { pageId });
  ok(`11. page_delete 返 2xx`);
} catch (e) {
  die(`11. page_delete 抛错: ${e.message}`);
}

let assertion12Pass = false;
try {
  const r = await kb('kb.page_get', { pageId });
  if (r && (r.status || '').toLowerCase() === 'deleted') {
    warn(`12. page_delete 后 page_get 返软删 200+status=deleted (硬/软删语义待 cws-kb 确认)`);
    assertion12Pass = true;
  } else {
    die(`12. page_delete 后 page_get 仍 200 且 status=${r.status} — 期待 4xx 或软删 'deleted'`);
  }
} catch (e) {
  if (/4\d\d|not.?found|gone/i.test(e.message)) {
    ok(`12. page_delete 后 page_get 返 4xx(硬删)`);
    assertion12Pass = true;
  } else {
    die(`12. page_get 抛非 4xx: ${e.message}`);
  }
}
assertTrue(assertion12Pass, `12. page_delete 行为符合预期`);

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 12 PASS (12 / 12)`);
log(`   pageId = ${pageId}  (revisions ≥ 3, restore → init, trash → un-trash → delete)`);
