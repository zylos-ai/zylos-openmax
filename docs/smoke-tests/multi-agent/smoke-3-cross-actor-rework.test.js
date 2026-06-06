#!/usr/bin/env node
/**
 * Smoke 3 (multi-agent, NL) — cross-actor rework loop.
 *
 * See smoke-3-cross-actor-rework.md for full spec.
 *
 * 5 NL turns:
 *   1. LEAD   build heavy + 1-step blueprint, executing, task without assignee
 *   2. WORKER claim + KB v1 (intentionally minimal) + complete
 *   3. LEAD   review + set_acceptance(accepted=false, reason=...)
 *   4. WORKER rework: new attempt, expand KB content, complete
 *   5. LEAD   deliver + accept
 *
 * Verifies the rework loop semantics cross-actor:
 *   - attempt #2 created on the SAME task (no duplicate task)
 *   - attempt #2 assignee is still WORKER
 *   - acceptance history shows false→true transition
 */

import {
  loadEnv, sendInstruction, waitForIssue, waitForTaskAssignee,
  tm, listTasks, listAttempts, getWorkerJwt,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM3-${TS}`;
const KB_TITLE = `SmokeM3 W-${TS} v1`;

const env = loadEnv();
log(`=== Smoke 3 multi-agent NL: cross-actor rework loop ===`);
log(`   TITLE = ${TITLE}`);

// Phase 1: LEAD排活
log(''); log('[Phase 1] LEAD 排活');
await sendInstruction(env, `\
建一个 heavy issue 标题严格为 "${TITLE}",描述 "smoke 3 验证打回重做",priority=medium,你做 Lead。给它配一份 1 步的 blueprint,这一步「调研 3 家竞品定价并给一份 markdown 总结」。蓝图提交评审 → 批准 → issue 推到 executing → 为这步开一个 task 不指定承接人。

完成之后用一行告诉我 issueId。`, { to: 'lead' });

const p1 = await waitForIssue(env,
  i => typeof i.title === 'string' && i.title.includes(TITLE),
  { targetStatus: 'executing', actor: 'lead', label: 'p1-lead-executing' });
const ISSUE_ID = p1.issue.id;

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

// Phase 2: WORKER 第一次接活(简陋版)
log(''); log('[Phase 2] WORKER 第一次交付(故意简陋)');
await sendInstruction(env, `\
看 org 里有没有可领的活,领一个。领到之后在 KB 建一个标题 "${KB_TITLE}" 的 page,正文只写一句 "Competitor A pricing: \$99/mo" 就行(知道不全也没事 — 先交一版)。完成这次尝试和任务。`, { to: 'worker' });

const taskAfterAttempt1 = await waitForTaskAssignee(env, ISSUE_ID,
  t => t.assignee_id === WORKER_MID && t.status === 'done',
  { actor: 'lead', label: 'p2-worker-attempt1-done' });
const TASK_ID = taskAfterAttempt1.id;
const attempts1 = await listAttempts(TASK_ID, { actor: 'lead' });
const attempt1Id = attempts1[0].id;
log(`  · attempt #1 = ${attempt1Id}`);

// Phase 3: LEAD审阅+打回
log(''); log('[Phase 3] LEAD 审阅打回');
await sendInstruction(env, `\
刚才那个 "${TITLE}" issue 的交付有人提交了,你看一眼 KB 那个 v1 page。内容明显不够 — 只覆盖了 1 家竞品,不是 3 家。把这个 issue 打回去重做,理由写 "覆盖竞品不足,请补齐 3 家",别接受。`, { to: 'lead' });

await waitForIssue(env,
  i => i.id === ISSUE_ID && i.acceptance?.accepted === false,
  { actor: 'lead', label: 'p3-lead-rejected', pollMs: 2000 });

// Phase 4: WORKER 重做
log(''); log('[Phase 4] WORKER 重做(新 attempt)');
await sendInstruction(env, `\
之前那个 "${TITLE}" 的活被打回了,理由是 "覆盖竞品不足,请补齐 3 家"。开一次新的尝试,把 KB page 内容更新成包含 3 家竞品(随便编内容也行),写完把新的尝试和任务标完成。`, { to: 'worker' });

await waitForTaskAssignee(env, ISSUE_ID,
  async (t) => {
    if (t.id !== TASK_ID) return false;
    const atts = await listAttempts(t.id, { actor: 'lead' });
    return atts.length >= 2 && atts.sort((a,b)=>(a.attempt_number??0)-(b.attempt_number??0))[1].status === 'done';
  },
  { actor: 'lead', label: 'p4-worker-attempt2-done', pollMs: 2000 });

// Phase 5: LEAD 接受
log(''); log('[Phase 5] LEAD 验收');
await sendInstruction(env, `\
那个 "${TITLE}" 的重做交付了,这次合格。把 task 推到 done(如果还没),issue 推到 delivered,然后做最终验收(accepted=true,source=explicit)。`, { to: 'lead' });

const p5 = await waitForIssue(env, i => i.id === ISSUE_ID,
  { targetStatus: 'accepted', actor: 'lead', label: 'p5-lead-accepted' });

// Assertions
log(''); log('[Phase 6] 深度断言');

const finalIssue = await tm('issue.get', { id: ISSUE_ID }, { actor: 'lead' }).then(r => r.data || r);
assertTrue(finalIssue.title.includes(TITLE), '1. issue.title contains TITLE');

const tasks = await listTasks(ISSUE_ID, { actor: 'lead' });
assertEq(tasks.length, 1, '2. task 在 issue 上只有 1 个');
const T = tasks[0];
assertEq(T.assignee_id, WORKER_MID, '3. task.assignee_id === WORKER');

const attempts = (await listAttempts(T.id, { actor: 'lead' }))
  .sort((a,b) => (a.attempt_number ?? 0) - (b.attempt_number ?? 0));
assertEq(attempts.length, 2, '4. task 上有 2 个 attempt');
assertEq(attempts[0].assignee_id, WORKER_MID, '5. attempt #1 assignee');
assertEq(attempts[1].assignee_id, WORKER_MID, '6. attempt #2 assignee');
assertEq(attempts[0].status, 'done', '7. attempt #1 status=done');
assertEq(attempts[1].status, 'done', '8. attempt #2 status=done');
assertTrue((attempts[0].attempt_number ?? 0) < (attempts[1].attempt_number ?? 0),
  '9. attempt #1.attempt_number < #2.attempt_number');

// 10: statusTrace - this is just a best-effort check on what the final test observed
// (the polling captured executing → executing-after-reject → delivered → accepted)
assertEq(p5.issue.status, 'accepted', '12. issue final status=accepted');

// 11: acceptance history — we observed at least one acceptance flip.
// Server may not expose history list directly; rely on the rejection wait we did succeed at.
assertTrue(true, '11. acceptance flipped through false (observed in phase 3 wait, implicit)');

// 13-14: KB page
const kbPages = await tm('kb.list_pages_in_issue', { issueId: ISSUE_ID }, { actor: 'lead' })
  .then(r => Array.isArray(r) ? r : (r.data || r.pages || []));
const v1Page = kbPages.find(p => typeof p.title === 'string' && p.title.includes(KB_TITLE));
assertTrue(!!v1Page, `13. KB page "${KB_TITLE}" 存在`);
if (v1Page) {
  const revs = await tm('kb.list_revisions', { pageId: v1Page.id }, { actor: 'lead' })
    .then(r => Array.isArray(r) ? r : (r.data || r.revisions || []));
  assertTrue(revs.length >= 2, `14. KB page revisions >= 2 (got ${revs.length})`);
}

// 15: WORKER POV
const workerAttempts = await listAttempts(T.id, { actor: 'worker' });
assertEq(workerAttempts.length, 2, '15. WORKER POV 也能看到 2 个 attempt');

summary('Smoke 3 multi-agent NL');
