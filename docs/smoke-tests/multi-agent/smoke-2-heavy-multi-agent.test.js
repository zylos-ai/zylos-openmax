#!/usr/bin/env node
/**
 * Smoke 2 (multi-agent, NL) — Heavy + cross-actor Worker
 *
 * See same-directory smoke-2-heavy-multi-agent.md for full spec.
 *
 * Three NL turns to two agent runtimes:
 *   Phase 1: NL → LEAD   build heavy issue + 3-step blueprint, approve, exec, drop unassigned task
 *   Phase 2: NL → WORKER perceive claimable task, claim, write KB, complete
 *   Phase 3: NL → LEAD   finish step 2 + 3 yourself, deliver + accept
 *
 * Server-side polling verifies:
 *   - heavy + blueprint + approval lifecycle (assertions 1-7)
 *   - cross-actor assignee for step 1 (assertions 8-11)
 *   - LEAD self-assigned step 2 + 3 (12-13)
 *   - issue closure (14-15)
 *   - WORKER JWT can read step 1/2 + KB page (visibility, 16-18)
 *
 * Exits non-zero on any assertion failure or NL timeout.
 */

import {
  loadEnv, sendInstruction, waitForIssue, waitForTaskAssignee,
  tm, listTasks, listAttempts, getWorkerJwt,
  assertEq, assertTrue, assertNot, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM2-${TS}`;
const KB_PAGE_TITLE = `Smoke2 W-${TS} 调研结果`;

const env = loadEnv();

log(`=== Smoke 2 multi-agent NL: cross-actor heavy + worker ===`);
log(`   TITLE = ${TITLE}`);
log(`   LEAD   conv=${env.lead.conv_id}    agent=${env.lead.agent_id}`);
log(`   WORKER conv=${env.worker.conv_id}  (member_id from JWT)`);

// ============================================================================
// Phase 1 — NL → LEAD: build heavy + blueprint + approve + executing + step-1 task
// ============================================================================

log('');
log('[Phase 1] 给 LEAD 发自然语言 (排活)');
await sendInstruction(env, `\
建一个 heavy issue,标题严格写成 "${TITLE}",描述写 "smoke 2 cross-actor 测试 heavy + worker 协作",priority=medium,你做 Lead。然后给它做一份 3 步的 blueprint:第 1 步「调研竞品定价层级」、第 2 步「整理对比模型」(依赖第 1 步)、第 3 步「输出分析报告」(依赖第 2 步)。蓝图提交评审,然后批准它,把 issue 推到 executing。再为第 1 步生成一个 task,不要指定承接人 — 让别人来认领。

全部走完之后用一行把 issueId 告诉我。`, { to: 'lead' });

const phase1 = await waitForIssue(env,
  i => typeof i.title === 'string' && i.title.includes(TITLE),
  { targetStatus: 'executing', actor: 'lead', label: 'phase1-lead' });
const ISSUE = phase1.issue;
log(`Phase 1 done: issueId=${ISSUE.id}, statusTrace=${phase1.statusTrace.map(s => s.status).join(' → ')}`);

// ============================================================================
// Phase 2 — NL → WORKER: perceive + claim + KB write + complete
// ============================================================================

log('');
log('[Phase 2] 给 WORKER 发自然语言 (认领 + 干活)');
await sendInstruction(env, `\
看看现在你们 org 里有没有可以认领的 task,有就挑一个领走。领到之后做实际工作:在 KB 里建一篇标题为 "${KB_PAGE_TITLE}" 的页面,正文随便写几句调研结论。然后把这次尝试和任务都标完成。

做完之后,用一行告诉我 taskId。`, { to: 'worker' });

const workerJwt = await getWorkerJwt(env);
const workerJwtClaims = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString());
const WORKER_MID = workerJwtClaims.member_id;
log(`  · worker member_id (from JWT): ${WORKER_MID}`);

const step1Task = await waitForTaskAssignee(env, ISSUE.id,
  t => t.assignee_id === WORKER_MID && t.status === 'done',
  { actor: 'lead', label: 'phase2-worker-task-done' });
log(`Phase 2 done: step1 task ${step1Task.id} -> assignee=${step1Task.assignee_id} status=${step1Task.status}`);

// ============================================================================
// Phase 3 — NL → LEAD: finish step 2 + 3 + deliver + accept
// ============================================================================

log('');
log('[Phase 3] 给 LEAD 发自然语言 (收尾 step2/3 + 验收)');
await sendInstruction(env, `\
刚才那个标题为 "${TITLE}" 的 issue,第 2 步「整理对比模型」和第 3 步「输出分析报告」还没做。你自己来 —— 各自生成任务,自己承接,自己执行完整流转(尝试 → 任务 → 完成)。两步都干完之后,把 issue 推到 delivered,然后做最终验收(accepted=true,source=explicit)。

全部完成后用一行告诉我最终状态。`, { to: 'lead' });

const phase3 = await waitForIssue(env,
  i => i.id === ISSUE.id,
  { targetStatus: 'accepted', actor: 'lead', label: 'phase3-lead' });
log(`Phase 3 done: issue ${ISSUE.id} -> ${phase3.issue.status}, statusTrace=${phase3.statusTrace.map(s => s.status).join(' → ')}`);

// ============================================================================
// Assertions (18)
// ============================================================================

log('');
log('[Phase 4] 深度断言');

const finalIssue = await tm('issue.get', { id: ISSUE.id }, { actor: 'lead' }).then(r => r.data || r);

// 1-7: heavy + blueprint + approval lifecycle
assertTrue(typeof finalIssue.title === 'string' && finalIssue.title.includes(TITLE),
  `1. issue.title contains ${TITLE}`);
assertEq(finalIssue.mode,      'heavy',  '2. issue.mode');
assertEq(finalIssue.priority,  'medium', '3. issue.priority');
assertEq(finalIssue.lead_agent_id, env.lead.agent_id, '4. issue.lead_agent_id');
assertTrue(!!finalIssue.current_blueprint_id, '5. issue.current_blueprint_id 非空');

const bp = await tm('blueprint.get', { id: finalIssue.current_blueprint_id, includeSteps: true }, { actor: 'lead' })
  .then(r => r.data || r);
assertEq(bp.steps?.length, 3, '6a. blueprint steps.length === 3');
const stepByIdx = bp.steps.sort((a,b) => (a.order ?? 0) - (b.order ?? 0));
const [s1, s2, s3] = stepByIdx;
assertTrue(Array.isArray(s2.depends_on) && s2.depends_on.includes(s1.id), '6b. s2 depends_on s1');
assertTrue(Array.isArray(s3.depends_on) && s3.depends_on.includes(s2.id), '6c. s3 depends_on s2');

const traceStatuses = [...phase1.statusTrace, ...phase3.statusTrace].map(s => s.status);
assertTrue(traceStatuses.includes('pending_approval'), '7a. trace includes pending_approval');
assertTrue(traceStatuses.includes('approved') || traceStatuses.includes('executing'),
  '7b. trace includes approved or executing');

// 8-11: cross-actor step 1 assignee
const allTasks = await listTasks(ISSUE.id, { actor: 'lead' });
const step1 = allTasks.find(t => t.id === step1Task.id);
assertTrue(!!step1, '8a. step1 task exists in tasks list');
assertEq(step1.assignee_id, WORKER_MID, '8. step1 task.assignee_id === WORKER.member_id');
assertNot(step1.assignee_id === env.lead.agent_id, '9. step1 task.assignee_id !== LEAD.agent_id');

const step1Attempts = await listAttempts(step1.id, { actor: 'lead' });
assertEq(step1Attempts.length, 1, '10a. step1 has exactly 1 attempt');
assertEq(step1Attempts[0].assignee_id, WORKER_MID, '10b. step1 attempt.assignee_id === WORKER.member_id');
assertEq(step1.status,             'done', '11a. step1 task status');
assertEq(step1Attempts[0].status,  'done', '11b. step1 attempt status');

// 12-13: step 2/3 LEAD self-assign
const lateTasks = allTasks.filter(t => t.id !== step1.id);
assertTrue(lateTasks.length >= 2, `12a. step2+step3 tasks exist (got ${lateTasks.length})`);
for (const t of lateTasks.slice(0, 2)) {
  assertEq(t.assignee_id, env.lead.agent_id, `12b. ${t.title || t.id} assignee === LEAD`);
  assertEq(t.status, 'done', `13. ${t.title || t.id} status === done`);
}

// 14-15: closure
assertEq(phase3.issue.status, 'accepted', '14. final issue.status');
const tracePhase3 = phase3.statusTrace.map(s => s.status);
assertTrue(tracePhase3.includes('delivered'), '15a. phase3 trace includes delivered');
assertTrue(tracePhase3.includes('accepted'),  '15b. phase3 trace includes accepted');

// 16-18: WORKER visibility
const workerTasks = await listTasks(ISSUE.id, { actor: 'worker' });
const workerStep1Att = await listAttempts(step1.id, { actor: 'worker' });
assertEq(workerStep1Att[0]?.assignee_id, WORKER_MID, '16. WORKER POV: step1 attempt assignee 一致');
const step2 = lateTasks[0];
const workerStep2Att = await listAttempts(step2.id, { actor: 'worker' });
assertTrue(workerStep2Att.length >= 1, '17. WORKER POV: step2 attempt 可见(同 org)');

// 18: WORKER POV - KB page exists for this issue (the page worker wrote)
const kbPages = await tm('kb.list_pages_in_issue', { issueId: ISSUE.id }, { actor: 'worker' })
  .then(r => Array.isArray(r) ? r : (r.data || r.pages || []));
const matchingPage = kbPages.find(p => typeof p.title === 'string' && p.title.includes(KB_PAGE_TITLE));
assertTrue(!!matchingPage, `18. WORKER POV: KB page "${KB_PAGE_TITLE}" 可见 (got ${kbPages.length} pages)`);

summary('Smoke 2 multi-agent NL');
