#!/usr/bin/env node
/**
 * Smoke 2 (multi-agent, NL — v2 user-invisible)
 *
 * See smoke-2-heavy-multi-agent.md for full spec.
 *
 * v2 design: only **ONE** NL goes from user → LEAD. After that, LEAD
 * coordinates with WORKER via their bot↔bot DM (no further user touchpoint).
 * Test client only polls server state + inspects the bot DM at the end to
 * verify the cross-bot coordination actually happened.
 *
 *   1. user → LEAD: "build heavy issue X, blueprint, step1 unassigned,
 *      ping agent-gavin3 to claim, you do step2+3, deliver+accept."
 *   2. (autonomous) LEAD builds issue + blueprint + executing + step1 task
 *   3. (autonomous) LEAD → WORKER via bot DM
 *   4. (autonomous) WORKER claims + does KB write + completes
 *   5. (autonomous) WORKER → LEAD via bot DM (reports done)
 *   6. (autonomous) LEAD finishes step2/3 + delivers + accepts
 *   7. test polls issue → accepted, then asserts.
 */

import {
  loadEnv, sendInstruction, waitForIssue, waitForTaskAssignee,
  tm, listTasks, listAttempts, getWorkerJwt,
  countAgentMessagesBySender,
  assertEq, assertTrue, assertNot, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM2-${TS}`;
const KB_PAGE_TITLE = `Smoke2 W-${TS} 调研结果`;

const env = loadEnv();

log(`=== Smoke 2 multi-agent NL v2 (user-invisible cross-bot) ===`);
log(`   TITLE = ${TITLE}`);
log(`   LEAD         conv=${env.lead.conv_id}    agent=${env.lead.agent_id}`);
log(`   WORKER       conv=${env.worker.conv_id}  (member_id from JWT)`);
log(`   LEAD↔WORKER  conv=${env.lead_worker.conv_id}  (bot-to-bot DM)`);

// Snapshot bot-DM message count BEFORE the test so the assertion can measure
// what was added during this run (rather than absolute totals across history).
const baselineBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' })
  .catch(() => ({}));
log(`   baseline bot DM agent_text by sender: ${JSON.stringify(baselineBotMsgs)}`);

// ============================================================================
// The ONE NL message — user → LEAD. LEAD owns the rest.
// ============================================================================

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言 (从此 user 全程不感知)');
await sendInstruction(env, `\
建一个 heavy issue,标题严格写成 "${TITLE}",描述写 "smoke 2 cross-actor 测试 heavy + worker 协作(user-invisible)",priority=medium,你做 Lead。然后给它做一份 3 步的 blueprint:第 1 步「调研竞品定价层级」、第 2 步「整理对比模型」(依赖第 1 步)、第 3 步「输出分析报告」(依赖第 2 步)。蓝图提交评审,然后批准它,把 issue 推到 executing。

接下来按以下顺序由你自己完成,不要再来问我或汇报中间状态(我不在了):

1. 为第 1 步生成一个 task,不要指定承接人 — 等会儿让别人认领。
2. 通知 agent-gavin3 这个 bot:打开你跟它的 DM,在对话里告诉它 "${TITLE}" 这个 issue 的第 1 步有可领的任务,请它去认领并完成(包括把工作产出写到 KB 标题 "${KB_PAGE_TITLE}" 的页面里,然后把 attempt 和 task 都标完成)。
3. 等 agent-gavin3 在 DM 里回复你 "完成" 或类似确认。
4. 你自己来做第 2 步和第 3 步:各自建任务、自己承接、跑完整 attempt→task→done 流转。
5. 把 issue 推到 delivered,然后做最终验收(accepted=true,source=explicit)。

全部完成后**不需要**回 user 任何消息,我会从服务端状态确认。`, { to: 'lead' });

// ============================================================================
// Wait for the whole lifecycle to complete server-side.
// ============================================================================

log('');
log('[Phase 2] 静默轮询服务端状态,直到 issue → accepted');
const final = await waitForIssue(env,
  i => typeof i.title === 'string' && i.title.includes(TITLE),
  { targetStatus: 'accepted', actor: 'lead', label: 'v2-lifecycle', maxWaitMs: 15 * 60 * 1000 });
const ISSUE = final.issue;
log(`Lifecycle done: issue ${ISSUE.id} -> accepted, trace=${final.statusTrace.map(s => s.status).join(' → ')}`);

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

// ============================================================================
// Assertions (now with bot-DM coordination evidence on top of v1 set)
// ============================================================================

log('');
log('[Phase 3] 深度断言');

const finalIssue = await tm('issue.get', { id: ISSUE.id }, { actor: 'lead' }).then(r => r.data || r);

// 1-4: heavy + metadata
assertTrue(typeof finalIssue.title === 'string' && finalIssue.title.includes(TITLE),
  `1. issue.title contains ${TITLE}`);
assertEq(finalIssue.mode,      'heavy',  '2. issue.mode');
assertEq(finalIssue.priority,  'medium', '3. issue.priority');
assertEq(finalIssue.lead_agent_id, env.lead.agent_id, '4. issue.lead_agent_id');

// 5: blueprint exists with 3 steps + DAG
//    Note: current_blueprint_id may be null if submit-for-approval endpoint
//    is missing on the deployment (cws-int regression observed 2026-06-06).
//    Fall back to blueprint.list to find one by issue_id.
let bp = null;
if (finalIssue.current_blueprint_id) {
  bp = await tm('blueprint.get', { id: finalIssue.current_blueprint_id, includeSteps: true }, { actor: 'lead' })
    .then(r => r.data || r);
} else {
  const bps = await tm('blueprint.list', { issueId: finalIssue.id }, { actor: 'lead' })
    .then(r => Array.isArray(r) ? r : (r.data || []));
  if (bps[0]) {
    bp = await tm('blueprint.get', { id: bps[0].id, includeSteps: true }, { actor: 'lead' })
      .then(r => r.data || r);
  }
}
assertTrue(!!bp, '5a. some blueprint exists for the issue');
assertEq(bp?.steps?.length, 3, '5b. blueprint has 3 steps');
const stepByOrder = [...(bp?.steps || [])].sort((a,b) => (a.order ?? a.step_order ?? 0) - (b.order ?? b.step_order ?? 0));
const [s1, s2, s3] = stepByOrder;
assertTrue(Array.isArray(s2?.depends_on) && s2.depends_on.includes(s1?.id), '5c. s2 depends_on s1');
assertTrue(Array.isArray(s3?.depends_on) && s3.depends_on.includes(s2?.id), '5d. s3 depends_on s2');

// 6-9: cross-actor step 1 assignee (WORKER claimed)
const allTasks = await listTasks(ISSUE.id, { actor: 'lead' });
const step1 = allTasks.find(t => t.blueprint_step_id === s1?.id);
assertTrue(!!step1, '6. step1 task exists');
assertEq(step1.assignee_id, WORKER_MID, '7. step1 task.assignee_id === WORKER');
assertNot(step1.assignee_id === env.lead.agent_id, '8. step1 task.assignee_id !== LEAD');
const step1Atts = await listAttempts(step1.id, { actor: 'lead' });
assertTrue(step1Atts.length >= 1, '9a. step1 has at least 1 attempt');
assertEq(step1Atts[step1Atts.length - 1].assignee_id, WORKER_MID,
  '9b. latest step1 attempt assignee === WORKER');
assertEq(step1.status, 'done', '9c. step1 task.status = done');

// 10-11: LEAD self-assigned steps 2 + 3
const step2 = allTasks.find(t => t.blueprint_step_id === s2?.id);
const step3 = allTasks.find(t => t.blueprint_step_id === s3?.id);
assertTrue(!!step2 && !!step3, `10a. step2 + step3 tasks exist (got ${allTasks.length} total)`);
if (step2) assertEq(step2.assignee_id, env.lead.agent_id, '10b. step2 assignee === LEAD');
if (step3) assertEq(step3.assignee_id, env.lead.agent_id, '10c. step3 assignee === LEAD');
if (step2) assertEq(step2.status, 'done', '11a. step2 status = done');
if (step3) assertEq(step3.status, 'done', '11b. step3 status = done');

// 12: issue closure
assertEq(finalIssue.status, 'accepted', '12. issue.status = accepted');
assertTrue(final.statusTrace.some(s => s.status === 'executing'), '12b. trace passed through executing');

// 13: WORKER POV visibility
const workerStep1Att = await listAttempts(step1.id, { actor: 'worker' });
assertEq(workerStep1Att[workerStep1Att.length - 1]?.assignee_id, WORKER_MID,
  '13. WORKER POV: step1 attempt visible + assignee matches');

// 14: bot-to-bot DM coordination evidence (the v2 distinguishing assertion)
const finalBotMsgs = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker' });
log(`   final bot DM agent_text by sender: ${JSON.stringify(finalBotMsgs)}`);
const leadAdded   = (finalBotMsgs[env.lead.agent_id] || 0) - (baselineBotMsgs[env.lead.agent_id] || 0);
const workerAdded = (finalBotMsgs[WORKER_MID]        || 0) - (baselineBotMsgs[WORKER_MID]        || 0);
assertTrue(leadAdded   >= 1, `14a. LEAD sent ≥ 1 agent_text in bot DM during run (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `14b. WORKER replied ≥ 1 agent_text in bot DM during run (got ${workerAdded})`);

summary('Smoke 2 multi-agent NL v2');
