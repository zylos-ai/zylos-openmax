#!/usr/bin/env node
/**
 * Smoke 5 (multi-agent, NL — v2 user-invisible) — cross-actor AS file handoff.
 *
 * Single user NL: LEAD uploads + then asks agent-gavin3 via bot↔bot DM
 * to fetch + save into KB. user has no further involvement.
 */

import crypto from 'node:crypto';
import {
  loadEnv, sendInstruction, tm, getWorkerJwt,
  countAgentMessagesBySender,
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

const env = loadEnv();
log(`=== Smoke 5 multi-agent NL v2: AS file handoff (user-invisible) ===`);

const baselineBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => ({}));

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
你需要做这两件事(全程自己完成,不要中间问我):

1. 我给你一段内容,三引号之间是文件正文(不包含引号本身):
"""
${AS_BODY}
"""

把这整段正文当一个文件保存进 artifact store,文件名 "${AS_FILENAME}",mime 用 text/markdown。

2. 文件保存好之后,通知 agent-gavin3 这个 bot:在你跟它的 DM 里告诉它有一个名字含 "smoke5-${TS}" 的文件刚上传到 AS,请它把内容完整读出来,在 KB 里建一个标题为 "${KB_TITLE}" 的 page,正文 = 文件原文一字不改。等 agent-gavin3 回复 "完成" 或类似确认。

完成后不要回我消息。`, { to: 'lead' });

log('');
log('[Phase 2] 静默轮询 KB page 出现');

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

async function findArtifact(actor) {
  const list = await tm('as.list', {}, { actor, env })
    .then(r => Array.isArray(r) ? r : (r.data || r.artifacts || []));
  return list.find(a => (a.filename || a.name) === AS_FILENAME);
}

const startedAt = Date.now();
const MAX_WAIT = 15 * 60 * 1000;
let workerPage = null, leadArt = null;
while (Date.now() - startedAt < MAX_WAIT) {
  workerPage = workerPage || await findKbPageByTitle('lead', KB_TITLE).catch(() => null);
  leadArt    = leadArt    || await findArtifact('lead').catch(() => null);
  if (workerPage && leadArt) break;
  await new Promise(r => setTimeout(r, 2000));
}
if (!leadArt || !workerPage) {
  console.error(`✗ phase2: artifact (${!!leadArt}) or KB page (${!!workerPage}) not appeared within ${MAX_WAIT}ms`);
  process.exit(1);
}

log(''); log('[Phase 3] 深度断言');

assertTrue(!!leadArt, '1. AS artifact exists');
const leadBytes = await tm('as.download_bytes', { artifactId: leadArt.id }, { actor: 'lead' })
  .then(r => r.data?.bytes || r.bytes || r.content || '');
const leadBuf = Buffer.isBuffer(leadBytes) ? leadBytes
              : (typeof leadBytes === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(leadBytes) && leadBytes.length > 100)
                  ? Buffer.from(leadBytes, 'base64')
                  : Buffer.from(String(leadBytes), 'utf8');
const leadSha = crypto.createHash('sha256').update(leadBuf).digest('hex');
assertEq(leadSha, EXPECTED_SHA256, '2. LEAD download sha256 matches upload');

const workerArt = await findArtifact('worker');
assertTrue(!!workerArt && workerArt.id === leadArt.id, '3. WORKER POV: artifact visible');

const workerBytes = await tm('as.download_bytes', { artifactId: leadArt.id }, { actor: 'worker' })
  .then(r => r.data?.bytes || r.bytes || r.content || '');
const workerBuf = Buffer.isBuffer(workerBytes) ? workerBytes
                : (typeof workerBytes === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(workerBytes) && workerBytes.length > 100)
                    ? Buffer.from(workerBytes, 'base64')
                    : Buffer.from(String(workerBytes), 'utf8');
assertEq(crypto.createHash('sha256').update(workerBuf).digest('hex'), leadSha,
  '4. WORKER sha256 === LEAD sha256');

assertTrue(!!workerPage, `5. KB page "${KB_TITLE}" exists`);
const pageContent = await tm('kb.page_content_read', { pageId: workerPage.id }, { actor: 'lead' })
  .then(r => r.data?.content || r.content || '');
assertEq(pageContent.trim(), AS_BODY.trim(), '6. KB page content === artifact original');

const pageCreator = workerPage.creator_member_id || workerPage.creator_id || workerPage.created_by;
assertEq(pageCreator, WORKER_MID, '7. KB page creator === WORKER (LEAD uploaded, WORKER wrote page)');

// Bot-DM coordination evidence
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 1, `8a. LEAD sent ≥ 1 agent_text in bot DM (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `8b. WORKER replied ≥ 1 agent_text in bot DM (got ${workerAdded})`);

summary('Smoke 5 multi-agent NL v2');
