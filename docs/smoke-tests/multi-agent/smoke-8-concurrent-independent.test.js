#!/usr/bin/env node
/**
 * Smoke 8 (multi-agent, NL — v2 user-invisible) — concurrent independent work.
 *
 * User triggers TWO unrelated light issues in one NL. LEAD handles issue A
 * entirely solo. LEAD delegates step1 of issue B to WORKER. Both issues
 * proceed in parallel and finish independently.
 *
 * Verifies:
 * - state isolation: A's task never lands on WORKER; B's WORKER task
 *   never leaks into A
 * - token / JWT / actor context doesn't cross between issues
 * - both lifecycles reach accepted regardless of order
 *
 * Single user NL: only LEAD gets one natural-language instruction.
 */

import {
  loadEnv, sendInstruction, waitForIssue,
  tm, listTasks, listAttempts, getWorkerJwt,
  countAgentMessagesBySender, snapshotMaxSeq,
  assertEq, assertTrue, log, summary,
} from './lib/runner.js';

const TS = Date.now();
const TITLE_A = `SmokeM8A-${TS}`;
const TITLE_B = `SmokeM8B-${TS}`;

const env = loadEnv();
log(`=== Smoke 8 multi-agent NL v2: concurrent independent (user-invisible) ===`);
log(`   TITLE_A = ${TITLE_A}, TITLE_B = ${TITLE_B}`);

const baselineSeq = await snapshotMaxSeq(env, env.lead_worker.conv_id, { actor: 'worker' }).catch(() => 0);

log('');
log('[Phase 1] 给 LEAD 发唯一一条自然语言');
await sendInstruction(env, `\
我一次给你两件互不相关的活,你按下面方式各自推进:

【任务 A】开一个 light issue,标题严格写 "${TITLE_A}",描述 "smoke 8 A 路 — 单 agent 独立完成",priority=low,你做 Lead。这件事你**自己**接,自己派任务给自己,完成 attempt → task → done,issue 推到 delivered + 接受。**别让 agent-gavin3 碰这件**。

【任务 B】开一个 light issue,标题严格写 "${TITLE_B}",描述 "smoke 8 B 路 — 跨 agent 协作",priority=low,你做 Lead。给 agent-gavin3 派 1 个任务,内容是「写一句给团队的早安问候,不超过 20 字」。等它做完后,你把 issue 推到 delivered + 接受。

两路并行推进就行,先后顺序不限。两个 issue 最终都要在 accepted 状态。

全程不要回我消息,我从服务端状态确认。`, { to: 'lead' });

log('');
log('[Phase 2] 等两个 issue 同时 accepted');
const finalA = await waitForIssue(env,
  i => i.title?.includes(TITLE_A),
  { targetStatus: 'accepted', actor: 'lead', label: 'v8-A', maxWaitMs: 15 * 60 * 1000 });
const finalB = await waitForIssue(env,
  i => i.title?.includes(TITLE_B),
  { targetStatus: 'accepted', actor: 'lead', label: 'v8-B', maxWaitMs: 15 * 60 * 1000 });
const ISSUE_A = finalA.issue;
const ISSUE_B = finalB.issue;

const workerJwt = await getWorkerJwt(env);
const WORKER_MID = JSON.parse(Buffer.from(workerJwt.split('.')[1], 'base64url').toString()).member_id;

log(''); log('[Phase 3] 深度断言');

const issueA = await tm('issue.get', { id: ISSUE_A.id }, { actor: 'lead' }).then(r => r.data || r);
const issueB = await tm('issue.get', { id: ISSUE_B.id }, { actor: 'lead' }).then(r => r.data || r);
assertEq(issueA.status, 'accepted', '1. issue A status === accepted');
assertEq(issueB.status, 'accepted', '2. issue B status === accepted');
assertTrue(issueA.id !== issueB.id, '3. 两个 issue id 不同(确实建了 2 个 issue)');

// State isolation — A's tasks should NEVER touch WORKER, B's must include WORKER.
const tasksA = await listTasks(ISSUE_A.id, { actor: 'lead' });
const tasksB = await listTasks(ISSUE_B.id, { actor: 'lead' });
assertTrue(tasksA.length >= 1, `4. issue A 至少 1 个 task (got ${tasksA.length})`);
assertTrue(tasksB.length >= 1, `5. issue B 至少 1 个 task (got ${tasksB.length})`);

const aHasWorker = tasksA.some(t => t.assignee_id === WORKER_MID);
const bHasWorker = tasksB.some(t => t.assignee_id === WORKER_MID);
assertTrue(!aHasWorker, '6. issue A 的 task 没有任何一个 assignee=WORKER(隔离正确)');
assertTrue(bHasWorker,  '7. issue B 的 task 至少 1 个 assignee=WORKER(跨 agent 正确触发)');

const aAllDone = tasksA.every(t => t.status === 'done');
const bAllDone = tasksB.every(t => t.status === 'done');
assertTrue(aAllDone, '8. issue A 所有 task done');
assertTrue(bAllDone, '9. issue B 所有 task done');

// WORKER 视角:能看到 B 的 task 但不能看到 A(不一定能严格断言,因为 list 可能受 org 而非 task 过滤;主要靠上面 6 + 7 已经覆盖)
// Bot-DM coordination evidence — only B should have generated bot DM traffic.
const addedCounts = await countAgentMessagesBySender(env, env.lead_worker.conv_id, { actor: 'worker', afterSeq: baselineSeq });
const leadAdded   = addedCounts[env.lead.agent_id] || 0;
const workerAdded = addedCounts[WORKER_MID]        || 0;
assertTrue(leadAdded   >= 1, `10a. LEAD sent ≥ 1 agent_text in bot DM (B 派活) (got ${leadAdded})`);
assertTrue(workerAdded >= 1, `10b. WORKER sent ≥ 1 agent_text in bot DM (B 回报) (got ${workerAdded})`);

summary('Smoke 8 multi-agent NL v2');
