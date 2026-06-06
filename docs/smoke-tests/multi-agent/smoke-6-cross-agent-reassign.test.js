#!/usr/bin/env node
/**
 * Smoke 6 (multi-agent, NL — v2 user-invisible) — cross-agent task reassign.
 *
 * LEAD initially mis-delegates a task to WORKER. After WORKER signals via
 * bot DM that the task is better suited for LEAD, LEAD reassigns the task
 * to themselves and completes it. Verifies cross-agent reassign +
 * collaborative scope renegotiation through bot DM.
 *
 * Single user NL: only LEAD gets one natural-language instruction. After
 * that, LEAD and WORKER coordinate the reassignment entirely via their
 * bot↔bot DM. User has no further involvement.
 */

import {
  loadEnv, sendInstruction, waitForIssue,
  tm, listTasks, listAttempts, getWorkerJwt,
  countAgentMessagesBySender,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM6-${TS}`;

const env = loadEnv();
log(`=== Smoke 6 multi-agent NL v2: cross-agent reassign (user-invisible) ===`);
log(`   TITLE = ${TITLE}`);

const baselineBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => ({}));

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
开一个 light issue,标题严格写成 "${TITLE}",描述写 "smoke 6 验证跨 agent 任务转手",priority=low,你做 Lead。

然后做这件事:派一个任务给 agent-gavin3,内容是「校对一段中文翻译,把"我喜欢学习"翻成英文并给三种语气版本」。其实这种语言润色你自己更擅长,但你先按惯例派出去看看对方反应。

接下来跟 agent-gavin3 在你们 DM 里正常沟通,如果它觉得这事更适合你来,就把任务接回来由你完成。完成后走完整 attempt → task → done 流转,把 issue 推到 delivered 并最终接受。

全程不要回我消息,我从服务端状态确认。`, { to: 'lead' });

log('');
log('[Phase 2] 静默轮询直到 issue → accepted');
const final = await waitForIssue(env,
  i => i.title?.includes(TITLE),
  { targetStatus: 'accepted', actor: 'lead', label: 'v6-reassign', maxWaitMs: 15 * 60 * 1000 });
const ISSUE = final.issue;

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

log(''); log('[Phase 3] 深度断言');

const finalIssue = await tm('issue.get', { id: ISSUE.id }, { actor: 'lead' }).then(r => r.data || r);
assertTrue(finalIssue.title?.includes(TITLE), '1. issue.title contains TITLE');
assertEq(finalIssue.lead_agent_id, env.lead.agent_id, '2. issue.lead_agent_id === LEAD');
assertEq(finalIssue.status, 'accepted', '3. final issue.status=accepted');

const tasks = await listTasks(ISSUE.id, { actor: 'lead' });
assertTrue(tasks.length >= 1, `4. issue 上至少有 1 个 task (got ${tasks.length})`);
// The reassigned task is the one we care about. If multiple, pick the one
// whose final assignee is LEAD (the reassigned one).
const reassignedTask = tasks.find(t => t.assignee_id === env.lead.agent_id) || tasks[0];
assertEq(reassignedTask.assignee_id, env.lead.agent_id,
  '5. task.assignee_id 最终 === LEAD (已从 WORKER 转回)');
assertEq(reassignedTask.status, 'done', '6. task.status === done');

// Verify reassign actually happened: there should be evidence that WORKER
// touched this task at some point. We check via worker JWT visibility +
// at minimum one bot-DM exchange from worker.
const attempts = await listAttempts(reassignedTask.id, { actor: 'lead' });
assertTrue(attempts.length >= 1, `7. task 至少有 1 个 attempt (got ${attempts.length})`);
const finalAttempt = attempts.sort((a,b) => (b.attempt_number ?? 0) - (a.attempt_number ?? 0))[0];
assertEq(finalAttempt.assignee_id, env.lead.agent_id,
  '8. 最终 attempt assignee === LEAD (LEAD 自己做的)');
assertEq(finalAttempt.status, 'done', '9. 最终 attempt status === done');

// Bot-DM coordination evidence — both sides must have spoken about the handoff.
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 2, `10a. LEAD sent ≥ 2 agent_text in bot DM (派活 + 收回) (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `10b. WORKER sent ≥ 1 agent_text in bot DM (建议转手) (got ${workerAdded})`);

summary('Smoke 6 multi-agent NL v2');
