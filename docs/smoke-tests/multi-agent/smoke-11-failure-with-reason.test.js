#!/usr/bin/env node
/**
 * Smoke 11 (multi-agent, NL — v2 user-invisible) — failure with reason.
 *
 * LEAD assigns WORKER a task that's intentionally impossible (requires
 * access WORKER doesn't have). WORKER attempts, recognizes it can't
 * complete, marks attempt failed with a non-empty failureReason, DMs LEAD
 * with explanation. LEAD acknowledges failure, marks task failed, pushes
 * issue → delivered + accepts (accepting the failure outcome).
 *
 * Verifies:
 * - failure path is wired (attempt.failed + failureReason persistence)
 * - cross-agent failure signal propagates via bot DM
 * - Issue can reach accepted with a failed task (per Lifecycle: tasks
 *   must be in terminal state — failed counts)
 *
 * Single user NL: only LEAD gets one natural-language instruction.
 */

import {
  loadEnv, sendInstruction, waitForIssue,
  tm, listTasks, listAttempts, getWorkerJwt,
  countAgentMessagesBySender, waitForBotDM,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM11-${TS}`;

const env = loadEnv();
log(`=== Smoke 11 multi-agent NL v2: failure with reason (user-invisible) ===`);
log(`   TITLE = ${TITLE}`);

const baselineBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => ({}));

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
开一个 light issue,标题严格写成 "${TITLE}",描述写 "smoke 11 验证任务失败带原因的跨 agent 流转",priority=low,你做 Lead。

派一个任务给 agent-gavin3,内容是「调用某个内部 SAP 财务系统的 API(host=sap-internal.coco.xyz,需要 SAP_API_KEY)拉一份这个月的应付账款明细,写到 KB 一个 page 里」。这件事 agent-gavin3 大概率没相关凭据/权限,做不了。

跟它沟通时这样说:**让它先认真试一下**(claim 任务、起 attempt),如果实在没法做到,就如实把这次 attempt 标 failed,带上 failure_reason(说明为啥做不到,比如"无 SAP_API_KEY"或"无法访问内部 host"),然后跟你在 DM 说一声为什么不行。

你这边收到失败汇报后:理解并接受这个失败(不是它的错),把这个 task 也标 failed,然后照样把 issue 推到 delivered,set_acceptance(accepted=true,source=explicit),把这件事闭环掉(算是有个明确的"我们暂时做不了"的答复)。

全程不要回我消息,我从服务端状态确认。`, { to: 'lead' });

log('');
log('[Phase 2] 静默轮询直到 issue → accepted');
const final = await waitForIssue(env,
  i => i.title?.includes(TITLE),
  { targetStatus: 'accepted', actor: 'lead', label: 'v11-failure', maxWaitMs: 15 * 60 * 1000 });
const ISSUE = final.issue;

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

// Close the race: WORKER marks attempt failed first, then DM-acks the
// failure ~1s later (and the LEAD closes the issue between those two,
// causing waitForIssue to exit before the DM arrives).
await waitForBotDM(env, env.lead_worker.conv_id, WORKER_MID,
  baselineBotMsgs[WORKER_MID] || 0, { actor: 'worker', maxWaitMs: 30_000, label: 'v11-worker-failure-ack' });

log(''); log('[Phase 3] 深度断言');

const finalIssue = await tm('issue.get', { id: ISSUE.id }, { actor: 'lead' }).then(r => r.data || r);
assertEq(finalIssue.status, 'accepted', '1. issue 最终 status === accepted(失败也算闭环)');
assertEq(finalIssue.acceptance_source, 'explicit', '2. acceptance_source === explicit');

const tasks = await listTasks(ISSUE.id, { actor: 'lead' });
assertTrue(tasks.length >= 1, `3. issue 至少 1 个 task (got ${tasks.length})`);
const workerTask = tasks.find(t => t.assignee_id === WORKER_MID);
assertTrue(!!workerTask, '4. 至少 1 个 task assignee=WORKER');
assertEq(workerTask.status, 'failed', '5. WORKER 的 task status === failed(不是 done,不是 cancelled)');

const attempts = await listAttempts(workerTask.id, { actor: 'lead' });
assertTrue(attempts.length >= 1, `6. task 至少 1 个 attempt (got ${attempts.length})`);
const lastAttempt = attempts.sort((a,b) => (b.attempt_number ?? 0) - (a.attempt_number ?? 0))[0];
assertEq(lastAttempt.status, 'failed', '7. 最后一个 attempt status === failed');
assertTrue(typeof lastAttempt.failure_reason === 'string' && lastAttempt.failure_reason.length > 0,
  `8. attempt.failure_reason 非空 (got "${lastAttempt.failure_reason ?? ''}")`);

// failure_reason 应该言之有物(超过 5 字),不是 "N/A" / "fail" 这种敷衍
assertTrue((lastAttempt.failure_reason || '').length >= 5,
  `9. failure_reason 至少 5 字(言之有物) (len=${(lastAttempt.failure_reason||'').length})`);

// Bot-DM coordination evidence — failure signal must surface through DM
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 1, `10a. LEAD sent ≥ 1 agent_text in bot DM (派活) (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `10b. WORKER sent ≥ 1 agent_text in bot DM (失败汇报) (got ${workerAdded})`);

summary('Smoke 11 multi-agent NL v2');
