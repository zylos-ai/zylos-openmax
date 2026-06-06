#!/usr/bin/env node
/**
 * Smoke 4 (multi-agent, NL — v2 user-invisible) — cross-actor KB collaboration.
 *
 * Single user NL: LEAD creates initial page, then instructs agent-gavin3
 * via bot↔bot DM to append. User doesn't message worker directly.
 */

import {
  loadEnv, sendInstruction, tm, getWorkerJwt,
  countAgentMessagesBySender,
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
log(`=== Smoke 4 multi-agent NL v2: KB collab (user-invisible) ===`);

const baselineBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => ({}));

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

async function findPage(actor) {
  const roots = await tm('kb.tree_roots', {}, { actor, env })
    .then(r => Array.isArray(r) ? r : (r.data || r.roots || []));
  for (const root of roots) {
    const children = await tm('kb.list_children', { nodeId: root.id }, { actor, env })
      .then(r => Array.isArray(r) ? r : (r.data || r.children || []));
    const m = children.find(p => typeof p.title === 'string' && p.title.includes(PAGE_TITLE));
    if (m) return m;
  }
  return null;
}

const startedAt = Date.now();
const POLL_MS = 2000;
const MAX_WAIT = 15 * 60 * 1000;
let leadPage = null, revs = null;
while (Date.now() - startedAt < MAX_WAIT) {
  try {
    leadPage = leadPage || await findPage('lead');
    if (leadPage) {
      revs = await tm('kb.list_revisions', { pageId: leadPage.id }, { actor: 'lead' })
        .then(r => Array.isArray(r) ? r : (r.data || r.revisions || []));
      if (revs.length >= 2) { log(`  · page id=${leadPage.id}, revisions=${revs.length}`); break; }
    }
  } catch (e) { /* retry */ }
  await new Promise(r => setTimeout(r, POLL_MS));
}
if (!leadPage || !revs || revs.length < 2) {
  console.error(`✗ phase2: page or 2nd revision not appeared within ${MAX_WAIT}ms`);
  process.exit(1);
}

log(''); log('[Phase 3] 深度断言');

assertTrue(!!leadPage, '1. KB page exists');

const leadContent = await tm('kb.page_content_read', { pageId: leadPage.id }, { actor: 'lead' })
  .then(r => r.data?.content || r.content || '');
assertTrue(leadContent.includes('# 交付概览'), '2a. content contains lead heading');
assertTrue(leadContent.includes('Worker 补充'), '2b. content contains worker append');
assertTrue(revs.length >= 2, `3. revisions >= 2 (got ${revs.length})`);

const workerPage = await findPage('worker');
assertTrue(!!workerPage && workerPage.id === leadPage.id, '4. WORKER POV: same page id visible');

const workerContent = await tm('kb.page_content_read', { pageId: leadPage.id }, { actor: 'worker' })
  .then(r => r.data?.content || r.content || '');
assertEq(workerContent, leadContent, '5. WORKER POV content === LEAD POV (byte-identical)');

const sortedRevs = [...revs].sort((a,b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));
const lastCreator = sortedRevs[sortedRevs.length - 1].creator_member_id || sortedRevs[sortedRevs.length - 1].author_id || sortedRevs[sortedRevs.length - 1].created_by;
assertEq(lastCreator, WORKER_MID, '6. latest revision creator === WORKER');

// Bot-DM coordination evidence
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 1, `7a. LEAD sent ≥ 1 agent_text in bot DM (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `7b. WORKER replied ≥ 1 agent_text in bot DM (got ${workerAdded})`);

summary('Smoke 4 multi-agent NL v2');
