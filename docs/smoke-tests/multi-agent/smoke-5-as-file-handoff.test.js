#!/usr/bin/env node
/**
 * Smoke 5 (multi-agent, NL) — cross-actor AS file hand-off.
 *
 * See smoke-5-as-file-handoff.md for full spec.
 *
 * 3 NL turns:
 *   1. LEAD   upload bytes into AS with known filename + mime
 *   2. WORKER find the artifact, download, write content into a KB page
 *   3. LEAD   confirm
 *
 * Verifies AS cross-actor visibility + sha256 byte integrity + KB-from-AS pipeline.
 */

import crypto from 'node:crypto';
import {
  loadEnv, sendInstruction, tm, getWorkerJwt,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const AS_FILENAME = `smoke5-${TS}.md`;
const AS_BODY     = `# smoke-5 cross-actor 文件交付测试 ${TS}
line1: alpha
line2: beta
line3: gamma`;
const KB_TITLE    = `Smoke5 W-${TS} 引用文件内容`;
const EXPECTED_SHA256 = crypto.createHash('sha256').update(AS_BODY).digest('hex');
const EXPECTED_LEN    = Buffer.byteLength(AS_BODY);

const env = loadEnv();
log(`=== Smoke 5 multi-agent NL: cross-actor AS file hand-off ===`);
log(`   filename = ${AS_FILENAME}`);
log(`   expected sha256 = ${EXPECTED_SHA256}`);

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

// Phase 1 - LEAD uploads
log(''); log('[Phase 1] LEAD 上传 artifact');
await sendInstruction(env, `\
我给你一段内容,三引号之间是文件正文(不包含引号本身):
"""
${AS_BODY}
"""

把这整段正文当一个文件保存进 artifact store,文件名 "${AS_FILENAME}",mime 用 text/markdown。保存完之后告诉我 artifact id。`, { to: 'lead' });

async function findArtifact(actor) {
  const list = await tm('as.list', {}, { actor, env })
    .then(r => Array.isArray(r) ? r : (r.data || r.artifacts || []));
  return list.find(a => typeof a.filename === 'string' && a.filename === AS_FILENAME)
      || list.find(a => typeof a.name === 'string'     && a.name     === AS_FILENAME);
}

async function waitForArtifact(actor, label, opts = {}) {
  const { maxWaitMs = 10 * 60 * 1000, pollMs = 1500 } = opts;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const a = await findArtifact(actor);
    if (a) { log(`  · [${label}] artifact id=${a.id} size=${a.size ?? '?'} mime=${a.mime ?? a.content_type ?? '?'}`); return a; }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.error(`✗ ${label}: artifact "${AS_FILENAME}" not found in ${maxWaitMs}ms`);
  process.exit(1);
}

const leadArt = await waitForArtifact('lead', 'phase1-lead-artifact');

// Phase 2 - WORKER downloads + writes KB
log(''); log('[Phase 2] WORKER 下载 + 写 KB');
await sendInstruction(env, `\
Lead 刚在 artifact store 里上传了一个名字含 "smoke5-${TS}" 的 markdown 文件,你找到它,把里面的文字内容完整读出来,然后在 KB 建一个标题为 "${KB_TITLE}" 的 page,正文 = 文件原文(一字不改,不要加任何前后缀)。`, { to: 'worker' });

async function findKbPageByTitle(actor, titleSubstr) {
  const roots = await tm('kb.tree_roots', {}, { actor, env })
    .then(r => Array.isArray(r) ? r : (r.data || r.roots || []));
  for (const root of roots) {
    const children = await tm('kb.list_children', { nodeId: root.id }, { actor, env })
      .then(r => Array.isArray(r) ? r : (r.data || r.children || []));
    const m = children.find(p => typeof p.title === 'string' && p.title.includes(titleSubstr));
    if (m) return m;
  }
  return null;
}

async function waitForKbPage(actor, titleSubstr, label, opts = {}) {
  const { maxWaitMs = 10 * 60 * 1000, pollMs = 1500 } = opts;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const p = await findKbPageByTitle(actor, titleSubstr);
    if (p) { log(`  · [${label}] page id=${p.id}`); return p; }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.error(`✗ ${label}: KB page "${titleSubstr}" not found in ${maxWaitMs}ms`);
  process.exit(1);
}

const workerPage = await waitForKbPage('lead', KB_TITLE, 'phase2-worker-kb');

// Phase 3 - LEAD confirms (NL only)
log(''); log('[Phase 3] LEAD 核验 (NL only; 断言独立)');
await sendInstruction(env, `\
看一下 Worker 刚才写的 "${KB_TITLE}" KB page,里面应该原封不动是你之前上传的 ${AS_FILENAME} 的内容。一致就回 "已核验"。`, { to: 'lead' });

// Assertions
log(''); log('[Phase 4] 深度断言');

assertTrue(!!leadArt, `1. artifact "${AS_FILENAME}" 存在`);
const leadArtCreator = leadArt.creator_member_id || leadArt.creator_id || leadArt.created_by;
assertTrue(leadArtCreator !== WORKER_MID, '2. artifact creator !== WORKER (i.e. it was LEAD)');

const leadBytes = await tm('as.download_bytes', { artifactId: leadArt.id }, { actor: 'lead' })
  .then(r => r.data?.bytes || r.bytes || r.content || '');
const leadBuf = Buffer.isBuffer(leadBytes) ? leadBytes
              : (typeof leadBytes === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(leadBytes) && leadBytes.length > 100)
                  ? Buffer.from(leadBytes, 'base64')
                  : Buffer.from(String(leadBytes), 'utf8');
const leadSha = crypto.createHash('sha256').update(leadBuf).digest('hex');
assertEq(leadSha, EXPECTED_SHA256, '3. LEAD download sha256 matches upload');

const workerArt = await findArtifact('worker');
assertTrue(!!workerArt, '4. WORKER POV: artifact visible');
assertEq(workerArt.id, leadArt.id, '4b. same artifact id under WORKER JWT');

const workerBytes = await tm('as.download_bytes', { artifactId: leadArt.id }, { actor: 'worker' })
  .then(r => r.data?.bytes || r.bytes || r.content || '');
const workerBuf = Buffer.isBuffer(workerBytes) ? workerBytes
                : (typeof workerBytes === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(workerBytes) && workerBytes.length > 100)
                    ? Buffer.from(workerBytes, 'base64')
                    : Buffer.from(String(workerBytes), 'utf8');
const workerSha = crypto.createHash('sha256').update(workerBuf).digest('hex');
assertEq(workerSha, leadSha, '5. WORKER download sha256 === LEAD download sha256');

assertTrue(['text/markdown', 'text/x-markdown', 'text/plain'].includes(leadArt.mime || leadArt.content_type || ''),
  `6. artifact mime is markdown-ish (got "${leadArt.mime || leadArt.content_type}")`);
assertEq(leadArt.size, EXPECTED_LEN, `7. artifact size === ${EXPECTED_LEN}`);

assertTrue(!!workerPage, `8. KB page "${KB_TITLE}" 存在`);

const pageContent = await tm('kb.page_content_read', { pageId: workerPage.id }, { actor: 'lead' })
  .then(r => r.data?.content || r.content || '');
assertEq(pageContent.trim(), AS_BODY.trim(), '9. KB page content === artifact original (LEAD POV)');

const pageContentWorker = await tm('kb.page_content_read', { pageId: workerPage.id }, { actor: 'worker' })
  .then(r => r.data?.content || r.content || '');
assertEq(pageContentWorker, pageContent, '10. WORKER POV page content === LEAD POV page content');

const revs = await tm('kb.list_revisions', { pageId: workerPage.id }, { actor: 'lead' })
  .then(r => Array.isArray(r) ? r : (r.data || r.revisions || []));
assertEq(revs.length, 1, `11. KB page revisions === 1 (got ${revs.length})`);

const pageCreator = workerPage.creator_member_id || workerPage.creator_id || workerPage.created_by;
assertTrue(pageCreator !== leadArtCreator, '12. KB page creator !== artifact creator');

summary('Smoke 5 multi-agent NL');
