#!/usr/bin/env node
/**
 * Smoke 4 (multi-agent, NL) — cross-actor KB collaboration.
 *
 * See smoke-4-kb-collaboration.md for full spec.
 *
 * 3 NL turns:
 *   1. LEAD   create KB page with initial content (delivery overview)
 *   2. WORKER find the page, append a section (don't replace lead's content)
 *   3. LEAD   confirm (assertion-side runs independent of lead's reply)
 *
 * Verifies cross-actor KB read/write + revision attribution.
 */

import {
  loadEnv, sendInstruction, tm, getWorkerJwt,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const PAGE_TITLE = `SmokeM4-${TS} 项目交付说明`;
const LEAD_BODY  = `# 交付概览
- 本次交付包含:模块 A、模块 B
- 交付时间:2026 Q3
- Lead:Zylos`;
const WORKER_APPEND = `## Worker 补充
- 模块 A 测试覆盖率:92%
- 模块 B 待办:压力测试`;

const env = loadEnv();
log(`=== Smoke 4 multi-agent NL: cross-actor KB collaboration ===`);
log(`   PAGE = ${PAGE_TITLE}`);

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

// Phase 1: LEAD writes
log(''); log('[Phase 1] LEAD 写初稿');
await sendInstruction(env, `\
在 KB 根目录下建一个标题为 "${PAGE_TITLE}" 的 page,正文严格写以下内容(整段照抄):

${LEAD_BODY}

写完之后用一行告诉我 page 的 id。`, { to: 'lead' });

// Poll until page exists
async function findPage(actor) {
  const roots = await tm('kb.tree_roots', {}, { actor, env })
    .then(r => Array.isArray(r) ? r : (r.data || r.roots || []));
  for (const root of roots) {
    const children = await tm('kb.list_children', { nodeId: root.id }, { actor, env })
      .then(r => Array.isArray(r) ? r : (r.data || r.children || []));
    const match = children.find(p => typeof p.title === 'string' && p.title.includes(PAGE_TITLE));
    if (match) return match;
  }
  return null;
}

async function waitForPage(actor, label, opts = {}) {
  const { maxWaitMs = 10 * 60 * 1000, pollMs = 1500 } = opts;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const p = await findPage(actor);
    if (p) { log(`  · [${label}] found page id=${p.id}`); return p; }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.error(`✗ ${label}: page "${PAGE_TITLE}" not found in ${maxWaitMs}ms`);
  process.exit(1);
}

const leadPage = await waitForPage('lead', 'phase1-lead-page');

// Phase 2: WORKER appends
log(''); log('[Phase 2] WORKER 追加');
await sendInstruction(env, `\
刚才 Lead 在 KB 里建了一个标题包含 "${PAGE_TITLE.split(' ')[0]}" 的 page,你找到它,在原内容下面追加以下两段(原文一字不动地保留):

${WORKER_APPEND}

用 KB 的页面更新机制写回,做完报一下 revision 数。`, { to: 'worker' });

// Wait until revisions >= 2
async function waitForRevisions(pageId, n, actor, label, opts = {}) {
  const { maxWaitMs = 10 * 60 * 1000, pollMs = 1500 } = opts;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const revs = await tm('kb.list_revisions', { pageId }, { actor, env })
        .then(r => Array.isArray(r) ? r : (r.data || r.revisions || []));
      if (revs.length >= n) { log(`  · [${label}] revisions=${revs.length}`); return revs; }
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.error(`✗ ${label}: revisions >= ${n} not reached in ${maxWaitMs}ms`);
  process.exit(1);
}

const revs = await waitForRevisions(leadPage.id, 2, 'lead', 'phase2-revisions');

// Phase 3 - LEAD confirm (optional; we don't gate on it)
log(''); log('[Phase 3] LEAD 核对 (NL only; 断言独立)');
await sendInstruction(env, `\
看看 "${PAGE_TITLE}" 这个 KB page,Worker 应该已经追加了内容。你确认一下两段内容(交付概览 + Worker 补充)都还在,并且 page 有 2 个修订版本。如果没问题在对话里说一声"已确认"。`, { to: 'lead' });

// Assertions
log(''); log('[Phase 4] 深度断言');

assertTrue(!!leadPage, '1. KB page exists');

const leadContent = await tm('kb.page_content_read', { pageId: leadPage.id }, { actor: 'lead' })
  .then(r => r.data?.content || r.content || '');
assertTrue(leadContent.includes('# 交付概览'), '2a. LEAD POV: content contains lead heading');
assertTrue(leadContent.includes('Worker 补充'), '2b. LEAD POV: content contains worker section');
assertTrue(revs.length >= 2, `3. LEAD POV: revisions >= 2 (got ${revs.length})`);

const workerPage = await findPage('worker');
assertTrue(!!workerPage, '4. WORKER POV: page visible');
assertEq(workerPage.id, leadPage.id, '4b. same page id under WORKER JWT');

const workerContent = await tm('kb.page_content_read', { pageId: leadPage.id }, { actor: 'worker' })
  .then(r => r.data?.content || r.content || '');
assertEq(workerContent, leadContent, '5. WORKER POV content === LEAD POV content (byte-for-byte)');

// Revision attribution (best-effort — schema may vary)
const sortedRevs = [...revs].sort((a,b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
const firstCreator = sortedRevs[0].creator_member_id || sortedRevs[0].author_id || sortedRevs[0].created_by;
const lastCreator  = sortedRevs[sortedRevs.length - 1].creator_member_id || sortedRevs[sortedRevs.length - 1].author_id || sortedRevs[sortedRevs.length - 1].created_by;
assertTrue(firstCreator !== lastCreator, '6+7. revision 1 creator !== revision N creator (cross-actor)');
assertEq(lastCreator, WORKER_MID, '7b. latest revision creator === WORKER.member_id');

const lastContent = sortedRevs[sortedRevs.length - 1].content || leadContent;
assertTrue(lastContent.includes('# 交付概览'), '8. latest revision still contains lead content');
assertTrue(lastContent.includes('Worker 补充'), '9. latest revision contains worker append');

// 10: no duplicate page
const allRoots = await tm('kb.tree_roots', {}, { actor: 'lead' })
  .then(r => Array.isArray(r) ? r : (r.data || r.roots || []));
let dupCount = 0;
for (const root of allRoots) {
  const children = await tm('kb.list_children', { nodeId: root.id }, { actor: 'lead' })
    .then(r => Array.isArray(r) ? r : (r.data || r.children || []));
  dupCount += children.filter(p => typeof p.title === 'string' && p.title.includes(`SmokeM4-${TS}`)).length;
}
assertEq(dupCount, 1, '10. only 1 page with SmokeM4-${TS} title (no duplicate)');

// 11+12 — implicit from 4/5 (visibility via tree was used to FIND the page in both actors).
assertTrue(true, '11+12. tree visibility verified via findPage() succeeding under both JWTs');

summary('Smoke 4 multi-agent NL');
