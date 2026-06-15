#!/usr/bin/env node
/**
 * Smoke 3 — Heavy 拒收 → reopened → 返工 → 再交付
 *
 * 见同目录 smoke-3-rejection-rework.md 完整 spec。
 *
 * 多阶段流程(不走 runSmokeCase 因为有两轮指令 + 中间 test client 操作):
 *   Phase 1: 发第一轮指令,等 issue.status = "delivered"
 *   Phase 2: test client tm('issue.set_acceptance', {accepted:false, ...})
 *   Phase 3: 验 tm('issue.transition', {targetStatus:"executing"}) 抛错
 *   Phase 4: rejected → reopened → executing
 *   Phase 5: 发第二轮指令(返工),等 issue.status = "accepted"
 *   Phase 6: 深度断言
 */

import {
  loadEnv, sendInstruction, waitForCompletion, tm,
  listTasks, listAttempts, listIssuesInProject,
  assertEq, assertTrue, log, warn, ok, die,
} from './lib/runner.js';

const TITLE = `Smoke3-${Date.now()}`;
const REJECTION_REASON = '访谈样本量不足,需要补充 3 个企业用户';

const instructionRound1 = `请帮我跑一个 smoke-3 测试的第一阶段。

要求:
1) 创建一个 heavy issue,标题严格 "${TITLE}",priority=high,
   leadAgentId 用你自己,description 写 "用户调研报告(将被故意拒收以验证返工流程)"。
2) blueprint.create 3 个 step:
   - s1 "设计访谈问卷"
   - s2 "执行用户访谈",depends_on s1
   - s3 "撰写调研报告",depends_on s2
3) issue.transition draft → executing。
4) 3 个 step 全部 Lead 自做(每个 task.create 带 assigneeId=自己):
   - 每个 task 走完 attempt.transition done + task.transition done。
5) issue.transition 到 delivered。
6) **不要**调 set_acceptance(等用户验收)。
7) 报每一步,结束打印 issueId / blueprintId / 3 个 taskId / 最终 status (应为 delivered)。`;

const instructionRound2 = `我刚才那个 ${TITLE} 的 issue 被拒收了,rejectionReason 是
"${REJECTION_REASON}"。
状态机现在应该是 rejected → reopened → executing(test client 已经
帮你把状态走过去了)。

请你接着:
1) 给这个 issue 新建一个 task 做返工,标题 "${TITLE} - 返工:补充企业用户访谈",
   **不要**挂任何 blueprintStepId(blueprintStepId 留空 / null),
   assigneeId 用你自己。
2) 走完 attempt → task done。
3) issue.transition 到 delivered。
4) set_acceptance(accepted=true, source=explicit) 闭环到 accepted。
5) 报每一步,结束打印 reworkTaskId / reworkAttemptId / 最终 status。

注意:不要重新建 blueprint;返工 task 是额外补充,不在原 blueprint 中。`;

const predicate = (i) => typeof i.title === 'string' && i.title.includes(TITLE);

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const env = loadEnv();
log('=== Smoke 3: Heavy 拒收 → reopened → 返工 → 再交付 ===');

// -- Phase 1 ---------------------------------------------------------------
log('[Phase 1] 发第一轮指令(创建 + 走到 delivered)');
await sendInstruction(env, instructionRound1);

log('[Phase 1] 等 issue 到 delivered');
const phase1 = await waitForCompletion(env, predicate, { targetStatus: 'delivered' });
const issueId = phase1.issue.id;
ok(`Phase 1 issueId = ${issueId}, status = "${phase1.issue.status}"`);

// 断言 1-5
assertEq(phase1.issue.mode,     'heavy', '1. issue.mode');
assertEq(phase1.issue.priority, 'high',  '2. issue.priority');
const traceP1 = phase1.statusTrace.map(s => s.status);
assertTrue(traceP1.includes('delivered'), `3. trace 含 delivered (got ${JSON.stringify(traceP1)})`);

const bpRespP1 = await tm('blueprint.get', { id: phase1.issue.current_blueprint_id, includeSteps: true });
const bpP1 = bpRespP1.data || bpRespP1;
assertEq((bpP1.steps || []).length, 3, '4. blueprint.steps 数');

const tasksP1 = await listTasks(issueId);
assertEq(tasksP1.length, 3, '5. Phase 1 末 task 数');

// -- Phase 2: test client 主动拒收 -----------------------------------------
log('[Phase 2] test client 主动拒收');
const rejectResp = await tm('issue.set_acceptance', {
  id: issueId, accepted: false, rejectionReason: REJECTION_REASON,
});
assertTrue(!rejectResp.error, `6. set_acceptance(accepted=false) 调用成功 (resp=${JSON.stringify(rejectResp).slice(0, 200)})`);

// 短暂 poll 等状态切到 rejected
let issueAfterReject = null;
for (let i = 0; i < 20; i++) {
  const issues = await listIssuesInProject(env.TEST_PROJECT_ID);
  const match = issues.find(predicate);
  if (match && match.status === 'rejected') { issueAfterReject = match; break; }
  await new Promise(r => setTimeout(r, 1500));
}
if (!issueAfterReject) {
  die('Phase 2 timeout — issue did not transition to "rejected" within 30s');
}
assertEq(issueAfterReject.status, 'rejected', '7. issue.status (rejected)');
// 8. 验 acceptance_source 仍为 "explicit" 或拒收原因留痕(看后端实现,松断言)
assertTrue(
  issueAfterReject.acceptance_source === 'explicit'
    || typeof issueAfterReject.rejection_reason === 'string'
    || typeof issueAfterReject.last_acceptance_reason === 'string',
  '8. issue.acceptance_source / rejection_reason 至少一个有值');

// -- Phase 3: 非法 transition 应当被拒 -------------------------------------
log('[Phase 3] 验证非法转移 rejected → executing 被拒');
let illegalTransitionRejected = false;
let phase3ErrInfo = '';
try {
  const r = await tm('issue.transition', { id: issueId, targetStatus: 'executing' });
  // tm.js 多数情况下 throw,但若返结构含 error 也算
  if (r && (r.error || r.code === 'ERROR' || r.success === false)) {
    illegalTransitionRejected = true;
    phase3ErrInfo = JSON.stringify(r).slice(0, 200);
  } else {
    phase3ErrInfo = `unexpected success: ${JSON.stringify(r).slice(0, 200)}`;
  }
} catch (e) {
  illegalTransitionRejected = true;
  phase3ErrInfo = e.message.slice(0, 200);
}
assertTrue(illegalTransitionRejected,
    `9. rejected → executing 应当被拒 (got: ${phase3ErrInfo})`);
ok(`   状态机正确拒绝: ${phase3ErrInfo}`);

// -- Phase 4: 合法 rejected → reopened → executing -------------------------
log('[Phase 4] 合法路径 rejected → reopened → executing');
await tm('issue.transition', { id: issueId, targetStatus: 'reopened' });
// poll until reopened
let afterReopened = null;
for (let i = 0; i < 10; i++) {
  const issues = await listIssuesInProject(env.TEST_PROJECT_ID);
  const m = issues.find(predicate);
  if (m && m.status === 'reopened') { afterReopened = m; break; }
  await new Promise(r => setTimeout(r, 1000));
}
if (!afterReopened) die('Phase 4 timeout — issue did not reach reopened');
assertEq(afterReopened.status, 'reopened', '10. issue.status (reopened)');

await tm('issue.transition', { id: issueId, targetStatus: 'executing' });
let afterExec = null;
for (let i = 0; i < 10; i++) {
  const issues = await listIssuesInProject(env.TEST_PROJECT_ID);
  const m = issues.find(predicate);
  if (m && m.status === 'executing') { afterExec = m; break; }
  await new Promise(r => setTimeout(r, 1000));
}
if (!afterExec) die('Phase 4 timeout — issue did not reach executing');
assertEq(afterExec.status, 'executing', '11. issue.status (executing)');

// -- Phase 5: 第二轮指令(返工 + 再交付)------------------------------------
log('[Phase 5] 发第二轮指令(返工 + 再交付)');
await sendInstruction(env, instructionRound2);

log('[Phase 5] 等 issue 到 accepted');
const phase5 = await waitForCompletion(env, predicate, { targetStatus: 'accepted' });
assertEq(phase5.issue.status, 'accepted', '12. issue 终态');

// -- Phase 6: 深度断言 -----------------------------------------------------
log('[Phase 6] 深度断言');
const tasksFinal = await listTasks(issueId);
assertTrue(tasksFinal.length >= 4,
    `13. 总 task 数 ≥ 4 (got ${tasksFinal.length})`);

const reworkTasks = tasksFinal.filter(t => t.blueprint_step_id === null || t.blueprint_step_id === undefined);
assertTrue(reworkTasks.length >= 1,
    `14. 存在 blueprint_step_id=null 的返工 task (got ${reworkTasks.length})`);
const reworkTask = reworkTasks[0];

const reworkAttempts = await listAttempts(reworkTask.id);
assertTrue(reworkAttempts.length >= 1, '15a. rework task 至少 1 个 attempt');
const reworkAttempt = reworkAttempts.find(a => a.status === 'done') || reworkAttempts[0];
assertEq(reworkAttempt.status, 'done', '15. rework task attempt.status');

log('');
log(`✅ Smoke 3 PASS`);
log(`   issueId      = ${issueId}`);
log(`   reworkTaskId = ${reworkTask.id}`);
log(`   duration     = ${((phase5.durationMs + phase1.durationMs)/1000).toFixed(1)}s (两阶段累计)`);
const fullTrace = [...phase1.statusTrace, { status: 'rejected' }, { status: 'reopened' }, { status: 'executing' }, ...phase5.statusTrace.filter(s => !['executing'].includes(s.status))];
log(`   trace        = ${fullTrace.map(s => s.status).join(' → ')}`);
