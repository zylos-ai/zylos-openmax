#!/usr/bin/env node
/**
 * Smoke 3 (multi-agent, NL — v2 user-invisible) — cross-actor rework loop.
 *
 * See smoke-3-cross-actor-rework.md for full spec.
 *
 * Single user NL: instruct LEAD to drive the entire rework loop with
 * agent-gavin3 via their bot↔bot DM. user has no further involvement.
 *
 * Verifies: WORKER does v1 then a rework attempt #2 after LEAD's rejection,
 * both via bot DM. assignee stays WORKER throughout. Eventually issue
 * accepts.
 */

import {
  loadEnv, sendInstruction, waitForIssue,
  tm, listTasks, listAttempts, getWorkerJwt,
  countAgentMessagesBySender,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM3-${TS}`;
const KB_TITLE = `SmokeM3 W-${TS} v1`;

const env = loadEnv();
log(`=== Smoke 3 multi-agent NL v2: cross-actor rework (user-invisible) ===`);
log(`   TITLE = ${TITLE}`);

const baselineBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => ({}));

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
建一个 heavy issue 标题严格为 "${TITLE}",描述 "smoke 3 验证打回重做(user-invisible)",priority=medium,你做 Lead。给它配一份 1 步的 blueprint:这一步「调研 3 家竞品定价并给一份 markdown 总结」。蓝图提交评审 → 批准 → issue 推到 executing → 为这步开一个 task 不指定承接人。

接下来全程自己来,不要再来烦我:

1. 通知 agent-gavin3:让它认领这个 task,交一版**故意不完整**的 KB 页面("${KB_TITLE}",正文只覆盖 1 家竞品),然后把 attempt 和 task 都标完成。
2. 等 agent-gavin3 回复完成。
3. 你审阅这份交付:发现内容只覆盖 1 家不是 3 家。先把 issue 从 executing 推到 delivered(set_acceptance 必须先在 delivered 状态调用),再用 set_acceptance(accepted=false, source=explicit, rejection_reason="覆盖竞品不足,请补齐 3 家") 把 issue 打回到 rejected。
4. 通知 agent-gavin3 重做:让它开一个新 attempt,把 KB 页面内容更新成包含 3 家竞品(随便编内容也行),完成新 attempt 和 task。
5. 等 agent-gavin3 回复重做完成。
6. 现在 issue 在 rejected 状态,**状态机要求 rejected → reopened → executing**。所以先 transition issue 到 reopened,再 transition 到 executing,然后 transition 到 delivered,最后 set_acceptance(accepted=true, source=explicit) 闭环到 accepted。

全部完成后**不要**回我消息,我从服务端状态确认。`, { to: 'lead' });

log('');
log('[Phase 2] 静默轮询直到 issue → accepted');
const final = await waitForIssue(env,
  i => i.title?.includes(TITLE),
  { targetStatus: 'accepted', actor: 'lead', label: 'v2-rework', maxWaitMs: 20 * 60 * 1000 });
const ISSUE = final.issue;

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

log(''); log('[Phase 3] 深度断言');

const finalIssue = await tm('issue.get', { id: ISSUE.id }, { actor: 'lead' }).then(r => r.data || r);
assertTrue(finalIssue.title.includes(TITLE), '1. issue.title contains TITLE');

const tasks = await listTasks(ISSUE.id, { actor: 'lead' });
assertEq(tasks.length, 1, '2. task 在 issue 上只有 1 个(没多建)');
const T = tasks[0];
assertEq(T.assignee_id, WORKER_MID, '3. task.assignee_id === WORKER');

const attempts = (await listAttempts(T.id, { actor: 'lead' }))
  .sort((a,b) => (a.attempt_number ?? 0) - (b.attempt_number ?? 0));
assertEq(attempts.length, 2, '4. task 上有 2 个 attempt(rework loop)');
assertEq(attempts[0].assignee_id, WORKER_MID, '5. attempt #1 assignee === WORKER');
assertEq(attempts[1].assignee_id, WORKER_MID, '6. attempt #2 assignee === WORKER');
assertEq(attempts[0].status, 'done', '7. attempt #1 status=done');
assertEq(attempts[1].status, 'done', '8. attempt #2 status=done');
assertTrue((attempts[0].attempt_number ?? 0) < (attempts[1].attempt_number ?? 0),
  '9. attempt_number 递增');

assertEq(finalIssue.status, 'accepted', '10. final issue.status=accepted');

// Bot-DM coordination evidence
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 2, `11a. LEAD sent ≥ 2 agent_text in bot DM (claim + rework prompt) (got ${leadAdded})`);
assertTrue(workerAdded >= 2, `11b. WORKER replied ≥ 2 agent_text in bot DM (v1 done + rework done) (got ${workerAdded})`);

summary('Smoke 3 multi-agent NL v2');
