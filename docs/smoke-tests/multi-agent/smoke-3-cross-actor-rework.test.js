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
  countAgentMessagesBySender, snapshotMaxSeq,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE = `SmokeM3-${TS}`;
const KB_TITLE = `SmokeM3 W-${TS} v1`;

const env = loadEnv();
log(`=== Smoke 3 multi-agent NL v2: cross-actor rework (user-invisible) ===`);
log(`   TITLE = ${TITLE}`);

const baselineSeq = await snapshotMaxSeq(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => 0);

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
建一个 heavy issue 标题严格为 "${TITLE}",描述 "smoke 3 验证打回重做(user-invisible)",priority=medium,你做 Lead。这个 issue 只有 1 个目标:调研 3 家竞品定价并产出一份 markdown 总结。给它做 1 步的 blueprint,然后正常推进到可以派活的阶段,派给 agent-gavin3 做(让它在 KB 建一个标题 "${KB_TITLE}" 的页面写产出)。

接下来全程自己来,不要再来烦我:

1. agent-gavin3 第一次会**故意只覆盖 1 家**(我提前跟它打过招呼了),你拿到交付后**自己评估** — 内容明显不够,你需要把它打回去让 worker 重做,理由按你判断填(比如"覆盖竞品不足")。
2. worker 收到打回信号后会开新尝试,把页面补到 3 家。等它做完。
3. 你最终接受这次重做后的成果,把整个 issue 走完闭环到验收通过。

具体怎么操作状态机由你决定 — 业务目标就是"打回 → 重做 → 通过"。

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
const addedCounts = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker', afterSeq: baselineSeq });
const leadAdded   = addedCounts[env.lead.agent_id] || 0;
const workerAdded = addedCounts[WORKER_MID]        || 0;
assertTrue(leadAdded   >= 2, `11a. LEAD sent ≥ 2 agent_text in bot DM (claim + rework prompt) (got ${leadAdded})`);
assertTrue(workerAdded >= 2, `11b. WORKER replied ≥ 2 agent_text in bot DM (v1 done + rework done) (got ${workerAdded})`);

summary('Smoke 3 multi-agent NL v2');
