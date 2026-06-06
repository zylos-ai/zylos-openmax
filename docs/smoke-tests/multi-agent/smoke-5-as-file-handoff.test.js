#!/usr/bin/env node
/**
 * Smoke 5 (multi-agent, NL — v2 user-invisible) — cross-actor AS file hand-off.
 *
 * Single user NL: LEAD uploads content as KB-mode artifact (which appears
 * as a KB file node), then asks agent-gavin3 via bot↔bot DM to fetch the
 * file and write its contents into a KB page. user has no further
 * involvement.
 *
 * NB: in this iteration we don't verify byte-level sha256 between AS upload
 * and AS download — that path is harder to drive cleanly through the public
 * CLI (as.upload takes a file path, as.download saves to tmp). We DO verify
 * that the resulting KB page's content matches the original AS_BODY,
 * which proves the file made it from LEAD → AS → WORKER → KB page intact.
 */

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

把这整段正文当一个文件保存到 artifact store(KB 模式上传:不带 conversationId,会同时在 KB 里建一个 file node),文件名 "${AS_FILENAME}",mediaType=file,contentType=text/markdown。

2. 文件保存好之后,通知 agent-gavin3 这个 bot:在你跟它的 DM 里告诉它有一个名字含 "smoke5-${TS}" 的 markdown 文件刚通过 AS 上传(也作为 KB file node 可见),请它把内容完整读出来(用 as.download 或者 kb.file_download),在 KB 里建一个标题为 "${KB_TITLE}" 的 page,正文 = 文件原文一字不改(不要加任何前后缀)。等 agent-gavin3 在 DM 里回复 "完成" 或类似确认。

完成后不要回我消息。`, { to: 'lead' });

log('');
log('[Phase 2] 静默轮询 KB page 出现 + 内容正确');

async function findPageByTitle(actor, titleSubstr) {
  const r = await tm('kb.pages', { limit: 100 }, { actor, env });
  const items = Array.isArray(r) ? r : (r.data || r.pages || r.items || []);
  const list = Array.isArray(items) ? items : (items.items || items.data || []);
  return list.find(p => typeof p.title === 'string' && p.title.includes(titleSubstr)) || null;
}

async function readPageContent(pageId, actor) {
  const r = await tm('kb.page_content', { pageId }, { actor, env });
  return (r.data?.content) || r.content || (r.data?.body) || r.body || '';
}

const startedAt = Date.now();
const POLL_MS = 2000;
const MAX_WAIT = 15 * 60 * 1000;
let workerPage = null, pageContent = '';
while (Date.now() - startedAt < MAX_WAIT) {
  try {
    workerPage = workerPage || await findPageByTitle('lead', KB_TITLE);
    if (workerPage) {
      pageContent = await readPageContent(workerPage.id, 'lead');
      if (pageContent && pageContent.includes('line3: gamma')) {
        log(`  · KB page id=${workerPage.id} content matched`);
        break;
      }
    }
  } catch (e) { /* retry */ }
  await new Promise(r => setTimeout(r, POLL_MS));
}
if (!workerPage || !pageContent.includes('line3: gamma')) {
  console.error(`✗ phase2: KB page "${KB_TITLE}" with full content not appeared within ${MAX_WAIT}ms`);
  console.error(`  have page=${!!workerPage}, has-line3=${pageContent.includes('line3: gamma')}, content len=${pageContent.length}`);
  process.exit(1);
}

log(''); log('[Phase 3] 深度断言');

assertTrue(!!workerPage, `1. KB page "${KB_TITLE}" exists`);
assertEq(pageContent.trim(), AS_BODY.trim(), '2. KB page content === AS body (byte-identical via cross-bot pipeline)');

// 3: WORKER POV — same page visible + same content
const workerPagePOV = await findPageByTitle('worker', KB_TITLE);
assertTrue(!!workerPagePOV && workerPagePOV.id === workerPage.id, '3a. WORKER POV: same page id visible');
const workerContent = await readPageContent(workerPage.id, 'worker');
assertEq(workerContent, pageContent, '3b. WORKER POV content === LEAD POV content (cross-actor visibility)');

// 4: page creator is WORKER (since WORKER built it, not LEAD)
const pageCreator = workerPage.creator_member_id || workerPage.creator_id || workerPage.created_by;
if (pageCreator) {
  assertEq(pageCreator, WORKER_MID, '4. KB page creator === WORKER (LEAD uploaded AS, WORKER wrote KB page)');
} else {
  log('   (page creator field not exposed by API — skipping assertion 4)');
}

// 5: Bot-DM coordination evidence
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 1, `5a. LEAD sent ≥ 1 agent_text in bot DM (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `5b. WORKER replied ≥ 1 agent_text in bot DM (got ${workerAdded})`);

summary('Smoke 5 multi-agent NL v2');
