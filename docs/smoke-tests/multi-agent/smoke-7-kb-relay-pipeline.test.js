#!/usr/bin/env node
/**
 * Smoke 7 (multi-agent, NL — v2 user-invisible) — KB relay pipeline.
 *
 * 3-step blueprint pipeline where KB pages are the contract between
 * agents. step1 LEAD writes page A. step2 WORKER reads A and produces
 * page B based on it. step3 LEAD reads A + B and produces page C.
 *
 * Verifies multi-step sequential handoff with KB as the data interface,
 * cross-actor read+write, and that step2 actually used step1's output
 * (not just hallucinated).
 *
 * Single user NL: only LEAD gets one natural-language instruction.
 *
 * Avoids `kb.pages` (broken on cws-int per cws-kb#199) — instead walks
 * `kb.tree_roots` to locate pages by title prefix.
 */

import {
  loadEnv, sendInstruction, waitForIssue,
  tm, listTasks, listAttempts, getWorkerJwt,
  countAgentMessagesBySender,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM7-${TS}`;
const TAG = `SmokeM7-${TS}`; // common prefix for all 3 KB pages
const STEP1_KEY = 'ALPHA-' + TS;  // canary string LEAD must embed in step1 page
const STEP1_BODY = `# 调研:三种内部协作模式简评

调研标记:${STEP1_KEY}

- 模式 A:同步会议(高 latency,高带宽)
- 模式 B:异步文档(低 latency,中带宽)
- 模式 C:广播频道(低 latency,低带宽)`;

const env = loadEnv();
log(`=== Smoke 7 multi-agent NL v2: KB relay pipeline (user-invisible) ===`);
log(`   TITLE = ${TITLE}, STEP1_KEY = ${STEP1_KEY}`);

const baselineBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => ({}));

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
建一个 heavy issue,标题严格写成 "${TITLE}",描述写 "smoke 7 验证三步 KB 接力(user-invisible)",priority=medium,你做 Lead。给它配一份 3 步的 blueprint:第 1 步「调研三种协作模式」、第 2 步「基于第 1 步的调研产出对比矩阵」(依赖第 1 步)、第 3 步「综合第 1+2 步输出最终建议」(依赖第 2 步)。蓝图提交评审 → 批准 → issue 推到 executing。

接下来全程自己来:

1. 第 1 步你自己接:建一个 KB page,标题严格写 "${TAG} step1 调研",正文必须**逐字照抄**下面这段内容(包括那个调研标记):

"""
${STEP1_BODY}
"""

做完 attempt + task done。

2. 第 2 步派给 agent-gavin3:让它先去 KB 里把刚才你写的那个 "${TAG} step1 调研" 页面打开读完,然后基于里面的内容,新建一个 KB 页面标题严格写 "${TAG} step2 对比矩阵",正文里**必须包含你 step1 里的"调研标记"原文**(就是 ${STEP1_KEY} 这串),证明它真的读到了 step1 的内容。然后整理一份三种模式的对比矩阵(自由发挥即可,markdown 表格也行)。做完跟你说一声。

3. 等 agent-gavin3 完成 step2 后,你自己接第 3 步:再建一个 KB 页面标题严格写 "${TAG} step3 最终建议",正文里**必须同时包含 ${STEP1_KEY} 和对 step2 矩阵的引用**(自由表达,提到"如对比矩阵所示"之类即可)。这是给项目的最终建议。做完 attempt + task done。

4. 把 issue 推到 delivered,然后 set_acceptance(accepted=true, source=explicit)。

全程不要回我消息,我从服务端状态确认。`, { to: 'lead' });

log('');
log('[Phase 2] 静默轮询直到 issue → accepted');
const final = await waitForIssue(env,
  i => i.title?.includes(TITLE),
  { targetStatus: 'accepted', actor: 'lead', label: 'v7-pipeline', maxWaitMs: 20 * 60 * 1000 });
const ISSUE = final.issue;

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

log(''); log('[Phase 3] 深度断言');

const finalIssue = await tm('issue.get', { id: ISSUE.id }, { actor: 'lead' }).then(r => r.data || r);
assertTrue(finalIssue.title?.includes(TITLE), '1. issue.title contains TITLE');
assertEq(finalIssue.status, 'accepted', '2. final issue.status=accepted');
assertEq(finalIssue.mode, 'heavy', '3. issue.mode=heavy');

// Tasks: should be 3 (one per blueprint step). step2 assigned to WORKER, step1+3 to LEAD.
const tasks = await listTasks(ISSUE.id, { actor: 'lead' });
assertEq(tasks.length, 3, `4. issue 有 3 个 task (got ${tasks.length})`);
const allDone = tasks.every(t => t.status === 'done');
assertTrue(allDone, '5. 全部 3 个 task status=done');
const workerTasks = tasks.filter(t => t.assignee_id === WORKER_MID);
const leadTasks   = tasks.filter(t => t.assignee_id === env.lead.agent_id);
assertEq(workerTasks.length, 1, `6. 恰好 1 个 task assignee === WORKER (got ${workerTasks.length})`);
assertEq(leadTasks.length,   2, `7. 恰好 2 个 task assignee === LEAD   (got ${leadTasks.length})`);

// KB page content verification via tree_roots (avoid kb.pages — broken).
// Find the 3 pages by title prefix, then verify cross-step content references.
async function findPageByTitle(actor, titleSubstr) {
  const r = await tm('kb.tree_roots', { kbId: env.default_kb_id || await resolveDefaultKbId(actor) }, { actor });
  const items = (r.data?.items) || r.data || r.items || (Array.isArray(r) ? r : []);
  const list = Array.isArray(items) ? items : (items.items || []);
  return list.find(n => n.node_type === 'page' && typeof n.name === 'string' && n.name.includes(titleSubstr)) || null;
}
async function resolveDefaultKbId(actor) {
  const r = await tm('kb.list', { limit: 50 }, { actor });
  const items = (r.data) || r.items || (Array.isArray(r) ? r : []);
  const list = Array.isArray(items) ? items : (items.items || []);
  const def = list.find(k => k.is_default === true && k.status === 'active');
  if (!def) throw new Error('no default active KB found');
  return def.id;
}
async function readPageContent(pageId, actor) {
  const r = await tm('kb.page_content', { pageId }, { actor });
  return r.body || r.data?.body || '';
}

const step1Node = await findPageByTitle('lead', `${TAG} step1`);
const step2Node = await findPageByTitle('lead', `${TAG} step2`);
const step3Node = await findPageByTitle('lead', `${TAG} step3`);
assertTrue(!!step1Node, '8. KB 里能找到 step1 page');
assertTrue(!!step2Node, '9. KB 里能找到 step2 page');
assertTrue(!!step3Node, '10. KB 里能找到 step3 page');

const step1Body = await readPageContent(step1Node.page_id, 'lead');
const step2Body = await readPageContent(step2Node.page_id, 'lead');
const step3Body = await readPageContent(step3Node.page_id, 'lead');

assertTrue(step1Body.includes(STEP1_KEY), '11. step1 page 正文包含调研标记(LEAD 照抄成功)');
assertTrue(step2Body.includes(STEP1_KEY),
  '12. step2 page 正文包含 step1 的调研标记(WORKER 真的读了 step1)');
assertTrue(step3Body.includes(STEP1_KEY),
  '13. step3 page 正文也保留了调研标记(LEAD 综合时引用了 step1)');

// Page authorship — step2 must be authored by WORKER, step1/3 by LEAD.
assertEq(step2Node.creator_id, WORKER_MID,
  '14. step2 KB node creator === WORKER (跨 actor KB 写入)');

// Bot-DM coordination evidence
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 1, `15a. LEAD sent ≥ 1 agent_text in bot DM (派 step2) (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `15b. WORKER sent ≥ 1 agent_text in bot DM (step2 done 确认) (got ${workerAdded})`);

summary('Smoke 7 multi-agent NL v2');
