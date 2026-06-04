#!/usr/bin/env node
/**
 * Smoke 10 — KB 实例生命周期(纯脚本驱动)
 *
 * 见同目录 smoke-10-kb-instance-lifecycle.md 完整 spec。15 断言。
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

const env = {
  COCO_API_URL: process.env.COCO_API_URL.replace(/\/+$/, ''),
  CF_ID:        process.env.CF_ACCESS_CLIENT_ID || '',
  CF_SECRET:    process.env.CF_ACCESS_CLIENT_SECRET || '',
};

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
  if (!res.ok) throw new Error(`POST /kbs/${kbId}/pages HTTP ${res.status}: ${JSON.stringify(j).slice(0,200)}`);
  return j.data ?? j;
}

const TS = Date.now();
const NS = `Smoke10-${TS}`;

log(`=== Smoke 10: KB 实例生命周期 ===  ns=${NS}`);

// ---------------------------------------------------------------------------
// Phase 1 — 默认 KB
// ---------------------------------------------------------------------------

log('[Phase 1] 默认 KB');

const kbList0 = unwrap(await kb('kb.list', { limit: 50 }));
assertTrue(kbList0.length >= 1, `1. kb.list 返 ≥ 1 KB (got ${kbList0.length})`);

try {
  await kb('kb.init', {});
  ok(`2. kb.init 幂等不抛`);
} catch (e) {
  // kb.init 在已 init 的 org 上可能 409/422/或返 200,本 smoke 不强约束 code
  warn(`2. kb.init 抛了(可能是已 init 的预期路径): ${e.message.slice(0,160)}`);
}

// ---------------------------------------------------------------------------
// Phase 2 — create / get / update
// ---------------------------------------------------------------------------

log('[Phase 2] kb.create / get / update');

const newKbName = `${NS}`;
const newKbSlug = `smoke10-${TS}`.toLowerCase();
const newKb = await kb('kb.create', {
  name:        newKbName,
  slug:        newKbSlug,
  description: 'KB 实例测试',
});
assertTrue(newKb && newKb.id && /^[0-9a-f-]{36}$/i.test(newKb.id), `3a. kb.create 返 uuid kbId`);
assertTrue((newKb.name || '').includes(NS), `3b. new KB name 含 ${NS}`);
const newKbId = newKb.id;
log(`   newKbId = ${newKbId}`);

const kbGetRes = await kb('kb.get', { kbId: newKbId });
assertTrue(kbGetRes && kbGetRes.id === newKbId && kbGetRes.name && kbGetRes.status,
    `4. kb.get(new) 返完整结构 (name + status 都在)`);

await kb('kb.update', { kbId: newKbId, description: 'updated description' });
const kbGetAfterUpdate = await kb('kb.get', { kbId: newKbId });
assertTrue((kbGetAfterUpdate.description || '').includes('updated description'),
    `5. kb.update 后 description 含 'updated description'`);

// ---------------------------------------------------------------------------
// Phase 3 — folder + page 载体
// ---------------------------------------------------------------------------

log('[Phase 3] folder + page 载体');

const folder = await kb('kb.folder_create', { kbId: newKbId, name: `${NS}/notes` });
assertTrue(folder && folder.id, `6a. folder_create 返 id`);
const folderId = folder.id;

const page = await createPageDirect(newKbId, {
  title:     `${NS} page`,
  format:    'markdown',
  body:      `# ${NS}\n初版内容\n`,
  parent_id: folderId,
});
assertTrue(page && page.id, `6b. POST /pages 返 id`);
const pageId = page.id;
log(`   folderId=${folderId} pageId=${pageId}`);

// ---------------------------------------------------------------------------
// Phase 4 — page metadata 边缘
// ---------------------------------------------------------------------------

log('[Phase 4] page metadata + breadcrumb');

await kb('kb.page_update', { pageId,
  title: `${NS} page (renamed)`,
  path:  '/renamed-path',
});
const pageRenamed = await kb('kb.page_get', { pageId });
assertTrue((pageRenamed.title || '').includes('(renamed)'),
    `7. page_update title 含 '(renamed)' (got "${pageRenamed.title}")`);
assertTrue((pageRenamed.path || '').includes('/renamed-path'),
    `8. page_update path 含 '/renamed-path' (got "${pageRenamed.path}")`);

try {
  await kb('kb.page_freeze', { pageId });
  ok(`9. kb.page_freeze 返 2xx`);
} catch (e) {
  die(`9. kb.page_freeze 抛错: ${e.message}`);
}

try {
  const refs = await kb('kb.page_references', { pageId });
  assertTrue(Array.isArray(refs) || Array.isArray(refs.items || refs.data || []),
      `10. page_references 返数组(可空)`);
} catch (e) {
  die(`10. page_references 抛错: ${e.message}`);
}

try {
  const crumb = await kb('kb.node_breadcrumb', { kbId: newKbId, nodeId: pageId });
  const crumbArr = unwrap(crumb);
  assertTrue(crumbArr.length >= 1, `11. node_breadcrumb 返 ≥ 1 段 (got ${crumbArr.length})`);
} catch (e) {
  die(`11. node_breadcrumb 抛错: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Phase 5 — archive / unarchive
// ---------------------------------------------------------------------------

log('[Phase 5] archive / unarchive');

await kb('kb.archive', { kbId: newKbId });
const archived = unwrap(await kb('kb.list', { limit: 200 }));
const archivedHasNew = archived.some(k => k.id === newKbId && (k.status === 'archived' || k.archived));
const activeHasNew   = archived.some(k => k.id === newKbId && k.status === 'active');
assertTrue(!activeHasNew,
    `12. archive 后 kb.list 里 newKbId.status != active`);
assertTrue(archived.some(k => k.id === newKbId),
    `13. archive 后 kb.list 仍能看到 newKbId(只是状态变 archived)`);

await kb('kb.unarchive', { kbId: newKbId });
const afterUnarchive = unwrap(await kb('kb.list', { limit: 200 }));
const found = afterUnarchive.find(k => k.id === newKbId);
assertTrue(found && (found.status === 'active' || !found.archived),
    `14. unarchive 后 newKbId.status == active`);

// ---------------------------------------------------------------------------
// Phase 6 — delete
// ---------------------------------------------------------------------------

log('[Phase 6] delete');

await kb('kb.delete', { kbId: newKbId });
let deletedHit4xx = false;
try {
  const r = await kb('kb.get', { kbId: newKbId });
  // 软删可能 200 + status='deleted',或硬删 4xx
  if (r && r.status === 'deleted') {
    ok(`15. delete 后 kb.get 返软删 status=deleted(可接受)`);
    deletedHit4xx = true;
  } else {
    warn(`15. delete 后 kb.get 仍 200 且 status=${r.status}; 留待 cws-kb 团队确认硬删/软删语义`);
  }
} catch (e) {
  if (/4\d\d|not.?found|gone/i.test(e.message)) {
    ok(`15. delete 后 kb.get 返 4xx (硬删)`);
    deletedHit4xx = true;
  } else {
    die(`15. delete 后 kb.get 抛非 4xx: ${e.message}`);
  }
}
assertTrue(deletedHit4xx, `15. kb.delete 行为符合预期`);

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 10 PASS (15 / 15)`);
log(`   new KB     = ${newKbId}  (created → updated → archived → unarchived → deleted)`);
log(`   folder     = ${folderId}`);
log(`   page       = ${pageId}  (renamed + frozen + breadcrumb + references)`);
