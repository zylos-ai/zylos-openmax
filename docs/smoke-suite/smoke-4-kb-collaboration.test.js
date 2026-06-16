#!/usr/bin/env node
import './lib/bootstrap-multi.js';
/**
 * Smoke 4 (multi-agent, NL — v2 user-invisible) — cross-actor KB collaboration.
 *
 * Single user NL: LEAD creates initial page, then instructs agent-gavin3
 * via bot↔bot DM to append. User doesn't message worker directly.
 */

import {
  loadEnv, sendInstruction, tm, getWorkerJwt,
  countAgentMessagesBySender, snapshotMaxSeq, waitForBotDM,
  assertEq, assertTrue, log, summary,
} from './lib/runner-multi.js';

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
log(`=== Smoke 4 multi-agent NL v2: KB collab (user-invisible) ===`);

const baselineSeq = await snapshotMaxSeq(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => 0);

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
在 KB 根目录下建一个标题为 "${PAGE_TITLE}" 的 page,正文严格写以下内容(整段照抄,不要加任何前后缀):

${LEAD_BODY}

写完后**自主**完成下面这件事(不要再问我):

1. 通知 agent-gavin3 这个 bot:让它去找 KB 里这个标题为 "${PAGE_TITLE}" 的 page,在原内容下面追加以下两段(原文不能动):

${WORKER_APPEND}

2. 等 agent-gavin3 在你跟它的 DM 里回复 "已追加完成"。

完成后不要回我消息。`, { to: 'lead' });

log('');
log('[Phase 2] 静默轮询 KB page 直到出现 ≥ 2 revisions');

// kb.pages returns a flat list of all pages — filter by title prefix.
async function findPageByTitle(actor, titleSubstr) {
  const r = await tm('kb.pages', { limit: 100 }, { actor, env });
  const items = Array.isArray(r) ? r : (r.data || r.pages || []);
  const list = Array.isArray(items) ? items : (items.items || items.data || []);
  return list.find(p => typeof p.title === 'string' && p.title.includes(titleSubstr)) || null;
}

async function pageRevisionCount(pageId, actor) {
  const r = await tm('kb.page_revisions', { pageId }, { actor, env });
  const items = Array.isArray(r) ? r : (r.data || r.revisions || r.items || []);
  return Array.isArray(items) ? items.length : 0;
}

const startedAt = Date.now();
const POLL_MS = 2000;
const MAX_WAIT = 15 * 60 * 1000;
let leadPage = null, revCount = 0;
while (Date.now() - startedAt < MAX_WAIT) {
  try {
    leadPage = leadPage || await findPageByTitle('lead', PAGE_TITLE);
    if (leadPage) {
      revCount = await pageRevisionCount(leadPage.id, 'lead');
      if (revCount >= 2) { log(`  · page id=${leadPage.id}, revisions=${revCount}`); break; }
    }
  } catch (e) { /* retry */ }
  await new Promise(r => setTimeout(r, POLL_MS));
}
if (!leadPage || revCount < 2) {
  console.error(`✗ phase2: page or 2nd revision not appeared within ${MAX_WAIT}ms (have page=${!!leadPage}, revs=${revCount})`);
  process.exit(1);
}

// Close the race: WORKER writes the page revision THEN sends the bot-DM
// ack ~1s later. Wait briefly so Phase 3's DM-count assertion sees it.
await waitForBotDM(env, env.lead_worker.conv_id, WORKER_MID,
  0, { actor: 'worker', maxWaitMs: 30_000, label: 'v4-worker-ack', afterSeq: baselineSeq });

log(''); log('[Phase 3] 深度断言');

assertTrue(!!leadPage, '1. KB page exists');

const leadContentRaw = await tm('kb.page_content', { pageId: leadPage.id }, { actor: 'lead' });
const leadContent = (leadContentRaw.data?.content) || leadContentRaw.content || (leadContentRaw.data?.body) || leadContentRaw.body || '';
assertTrue(leadContent.includes('# 交付概览'), '2a. content contains lead heading');
assertTrue(leadContent.includes('Worker 补充'), '2b. content contains worker append');
assertTrue(revCount >= 2, `3. revisions >= 2 (got ${revCount})`);

const workerPage = await findPageByTitle('worker', PAGE_TITLE);
assertTrue(!!workerPage && workerPage.id === leadPage.id, '4. WORKER POV: same page id visible');

const workerContentRaw = await tm('kb.page_content', { pageId: leadPage.id }, { actor: 'worker' });
const workerContent = (workerContentRaw.data?.content) || workerContentRaw.content || (workerContentRaw.data?.body) || workerContentRaw.body || '';
assertEq(workerContent, leadContent, '5. WORKER POV content === LEAD POV (byte-identical)');

// Revision attribution check (best effort — schema may name fields differently)
const revsRaw = await tm('kb.page_revisions', { pageId: leadPage.id }, { actor: 'lead' });
const revs = Array.isArray(revsRaw) ? revsRaw : (revsRaw.data || revsRaw.revisions || revsRaw.items || []);
const sortedRevs = [...revs].sort((a,b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
const lastRev = sortedRevs[sortedRevs.length - 1];
const lastCreator = lastRev?.author_member_id || lastRev?.creator_member_id || lastRev?.created_by || lastRev?.author_id;
if (lastCreator) {
  assertEq(lastCreator, WORKER_MID, '6. latest revision creator === WORKER');
} else {
  log('   (revision creator field not exposed by API — skipping assertion 6)');
}

// Bot-DM coordination evidence
const addedCounts = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker', afterSeq: baselineSeq });
const leadAdded   = addedCounts[env.lead.agent_id] || 0;
const workerAdded = addedCounts[WORKER_MID]        || 0;
assertTrue(leadAdded   >= 1, `7a. LEAD sent ≥ 1 agent_text in bot DM (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `7b. WORKER replied ≥ 1 agent_text in bot DM (got ${workerAdded})`);

// ---- Cleanup ---------------------------------------------------------------
log('');
log('[Cleanup] 清理测试数据');
try {
  await tm('kb.page_delete', { pageId: leadPage.id }, { actor: 'lead' });
  ok(`cleanup: KB page ${leadPage.id} deleted`);
} catch (e) { log(`   ⚠ cleanup: KB page delete failed: ${e.message}`); }

summary('Smoke 4 multi-agent NL v2');
