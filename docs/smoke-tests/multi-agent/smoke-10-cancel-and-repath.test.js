#!/usr/bin/env node
/**
 * Smoke 10 (multi-agent, NL — v2 user-invisible) — task cancel and re-path.
 *
 * LEAD creates a task assigned to WORKER. WORKER claims and runs. Before
 * WORKER finishes, LEAD changes the scope via bot DM and asks WORKER to
 * cancel current work and start fresh with a new scope. WORKER cancels
 * the attempt + task. LEAD then creates a new task with the new scope,
 * WORKER does it, lifecycle continues.
 *
 * Verifies:
 * - mid-flight cancellation path (attempt → cancelled, task → cancelled)
 * - cross-agent re-path coordination (bot DM-driven scope change)
 * - clean state after cancel: new task is independent, not a continuation
 *
 * Single user NL: only LEAD gets one natural-language instruction.
 */

import {
  loadEnv, sendInstruction, waitForIssue,
  tm, listTasks, listAttempts, getWorkerJwt,
  countAgentMessagesBySender,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM10-${TS}`;

const env = loadEnv();
log(`=== Smoke 10 multi-agent NL v2: cancel and re-path (user-invisible) ===`);
log(`   TITLE = ${TITLE}`);

const baselineBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => ({}));

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
开一个 light issue,标题严格写成 "${TITLE}",描述写 "smoke 10 验证任务中途取消 + 改向重派",priority=medium,你做 Lead。

按下面节奏推:

1. 派一个任务给 agent-gavin3,内容是「调研三家国内云厂商的对象存储定价,给一份 markdown 对比」。让它认领并开始干。
2. 等 agent-gavin3 在 DM 里告诉你它已经认领并开始之后,**马上**改主意:在 DM 里通知它"刚跟老板对了下,这块方向变了,刚才的调研不用做了,你把现在那个 attempt 和 task 都标 cancelled 处理掉,我下面派个新的过来"。让它执行取消。
3. 等 agent-gavin3 确认 attempt + task 都 cancelled 之后,你**新建一个 task** 派给它,内容是「拟一份给运营团队发送的"对象存储调研暂缓"的通知文案,中文,3 句话以内」。让它认领并完成。
4. 等新 task done,你把 issue 推到 delivered + 接受。

全程不要回我消息,我从服务端状态确认。`, { to: 'lead' });

log('');
log('[Phase 2] 静默轮询直到 issue → accepted');
const final = await waitForIssue(env,
  i => i.title?.includes(TITLE),
  { targetStatus: 'accepted', actor: 'lead', label: 'v10-cancel', maxWaitMs: 15 * 60 * 1000 });
const ISSUE = final.issue;

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

log(''); log('[Phase 3] 深度断言');

const finalIssue = await tm('issue.get', { id: ISSUE.id }, { actor: 'lead' }).then(r => r.data || r);
assertEq(finalIssue.status, 'accepted', '1. issue 最终 status === accepted');

const tasks = await listTasks(ISSUE.id, { actor: 'lead' });
assertEq(tasks.length, 2, `2. issue 上恰好 2 个 task (cancelled 1 + done 1) (got ${tasks.length})`);

const cancelled = tasks.filter(t => t.status === 'cancelled');
const done      = tasks.filter(t => t.status === 'done');
assertEq(cancelled.length, 1, `3. 恰好 1 个 task status=cancelled (got ${cancelled.length})`);
assertEq(done.length,      1, `4. 恰好 1 个 task status=done (got ${done.length})`);

assertEq(cancelled[0].assignee_id, WORKER_MID, '5. 被取消的 task assignee === WORKER');
assertEq(done[0].assignee_id,      WORKER_MID, '6. 完成的 task assignee === WORKER');
assertTrue(cancelled[0].id !== done[0].id, '7. 两个 task 是独立 record(不是同一个被改 status)');

// Cancelled task 的 attempt 也必须在终态(cancelled / failed),不能是 running
const cancelledAttempts = await listAttempts(cancelled[0].id, { actor: 'lead' });
assertTrue(cancelledAttempts.length >= 1, `8. 被取消 task 至少 1 个 attempt (got ${cancelledAttempts.length})`);
const terminalStates = ['cancelled', 'failed', 'done'];
const allTerminal = cancelledAttempts.every(a => terminalStates.includes(a.status));
assertTrue(allTerminal,
  `9. 被取消 task 的所有 attempt 都在终态 (statuses=${cancelledAttempts.map(a=>a.status).join(',')})`);
const cancelledHasCancelledAttempt = cancelledAttempts.some(a => a.status === 'cancelled');
assertTrue(cancelledHasCancelledAttempt,
  '10. 被取消 task 至少 1 个 attempt status=cancelled (中途真取消了,不是改完才发的)');

// Done task 的 attempt
const doneAttempts = await listAttempts(done[0].id, { actor: 'lead' });
assertTrue(doneAttempts.length >= 1, `11. 新 task 至少 1 个 attempt (got ${doneAttempts.length})`);
const lastDoneAttempt = doneAttempts.sort((a,b) => (b.attempt_number ?? 0) - (a.attempt_number ?? 0))[0];
assertEq(lastDoneAttempt.status, 'done', '12. 新 task 最终 attempt status === done');

// Bot-DM coordination evidence — multi-turn (派活 + 取消 + 重派 + 完成确认)
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 3, `13a. LEAD sent ≥ 3 agent_text in bot DM (派 + 取消 + 重派) (got ${leadAdded})`);
assertTrue(workerAdded >= 2, `13b. WORKER sent ≥ 2 agent_text in bot DM (开始 + 取消确认 + 完成) (got ${workerAdded})`);

summary('Smoke 10 multi-agent NL v2');
