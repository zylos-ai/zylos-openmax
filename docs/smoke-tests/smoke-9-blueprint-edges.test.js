#!/usr/bin/env node
/**
 * Smoke 9 — Blueprint 工作流边缘(纯脚本驱动)
 *
 * 见同目录 smoke-9-blueprint-edges.md 完整 spec。15 断言。
 */

import { tm, log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_AGENT_ID', 'TEST_PROJECT_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
process.env.COCO_AUTH_TOKEN = process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN;
process.env.COCO_RPC_LOG = process.env.COCO_RPC_LOG || '0';

const env = {
  PROJECT_ID: process.env.TEST_PROJECT_ID,
  AGENT_ID:   process.env.TEST_AGENT_ID,
};

const TS = Date.now();
const NS = `Smoke9-${TS}`;
const unwrap = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

log(`=== Smoke 9: Blueprint 工作流边缘 ===  ns=${NS}`);

// ---------------------------------------------------------------------------
// Phase 1 — 起 heavy issue + 初版 3-step blueprint
// ---------------------------------------------------------------------------

log('[Phase 1] heavy issue + 3-step blueprint');

const issue = await tm('issue.create', {
  projectId:   env.PROJECT_ID,
  title:       `${NS} heavy`,
  mode:        'heavy',
  priority:    'medium',
  leadAgentId: env.AGENT_ID,
  description: `${NS} blueprint edges`,
});
assertTrue(issue && issue.id, `1. issue.create heavy 返 id`);
log(`   issue id = ${issue.id}`);

const bp = await tm('blueprint.create', {
  issueId:       issue.id,
  authorAgentId: env.AGENT_ID,
  steps: [
    { title: 'collect', description: '采 5 个对手定价' },
    { title: 'model',   description: '建对比模型' },
    { title: 'writeup', description: '写分析报告' },
  ],
});
assertTrue(bp && bp.id, `2a. blueprint.create 返 id`);
const bpStepsInit = unwrap(bp.steps || []);
assertEq(bpStepsInit.length, 3, `2b. blueprint.create 返 3 个 step`);

const bpFull = await tm('blueprint.get', { id: bp.id, includeSteps: true });
const bpFullSteps = unwrap(bpFull.steps || []);
assertEq(bpFullSteps.length, 3, `3. blueprint.get(includeSteps=true) steps.length == 3`);

// ---------------------------------------------------------------------------
// Phase 2 — set_steps 整组替换
// ---------------------------------------------------------------------------

log('[Phase 2] blueprint.set_steps → 2 steps');

try {
  await tm('blueprint.set_steps', {
    blueprintId: bp.id,
    steps: [
      { title: 'merged_research', description: '采 + 建模合并' },
      { title: 'writeup',         description: '写报告' },
    ],
  });
  ok(`4. blueprint.set_steps 返 2xx`);
} catch (e) {
  die(`4. blueprint.set_steps 抛错: ${e.message}`);
}

const bpAfter = await tm('blueprint.get', { id: bp.id, includeSteps: true });
const bpAfterSteps = unwrap(bpAfter.steps || []);
assertEq(bpAfterSteps.length, 2, `5. set_steps 后 blueprint.get steps.length == 2`);
const titles = bpAfterSteps.map(s => (s.title || '').toLowerCase());
assertTrue(titles.includes('merged_research') && titles.includes('writeup'),
    `6. 新 step titles 含 'merged_research' + 'writeup'  (got ${titles.join(',')})`);
const newS1 = bpAfterSteps.find(s => (s.title || '').toLowerCase() === 'merged_research');

// ---------------------------------------------------------------------------
// Phase 3 — issue.transition → executing
// ---------------------------------------------------------------------------

log('[Phase 3] issue → executing');

try {
  await tm('issue.transition', { id: issue.id, targetStatus: 'executing' });
  ok(`7. issue.transition → executing 返 2xx`);
} catch (e) {
  die(`7. issue.transition 抛错: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Phase 4 — task.create no assignee + skillTags
// ---------------------------------------------------------------------------

log('[Phase 4] task.create no assignee + skillTags=[research]');

const taskParams = {
  projectId:  env.PROJECT_ID,
  issueId:    issue.id,
  title:      `${NS} claim task`,
  skillTags:  ['research'],
};
if (newS1 && newS1.id) taskParams.blueprintStepId = newS1.id;

const task = await tm('task.create', taskParams);
assertTrue(task && task.id, `8a. task.create 返 id`);
assertEq((task.status || '').toLowerCase(), 'pending',
    `8b. task.status == pending (got ${task.status})`);
log(`   task id = ${task.id}`);

// ---------------------------------------------------------------------------
// Phase 5 — task.list with worker filter
// ---------------------------------------------------------------------------

log('[Phase 5] task.list 用 worker filter');

const claimableList = unwrap(await tm('task.list', {
  issueId: issue.id,
  claimable: true,
  agentSkills: ['research'],
}));
assertTrue(claimableList.some(t => t.id === task.id),
    `9. task.list(claimable=true, agentSkills=['research']) 含 T.id (got ${claimableList.length})`);

const unrelatedList = unwrap(await tm('task.list', {
  issueId: issue.id,
  claimable: true,
  agentSkills: ['unrelated-skill'],
}));
assertTrue(!unrelatedList.some(t => t.id === task.id),
    `10. task.list(claimable=true, agentSkills=['unrelated-skill']) 不含 T.id`);

// ---------------------------------------------------------------------------
// Phase 6 — claim + attempt chain
// ---------------------------------------------------------------------------

log('[Phase 6] claim + attempt');

const claimed = await tm('task.claim', { id: task.id });
const claimedStatus = (claimed.status || '').toLowerCase();
assertTrue(['running', 'in_progress', 'assigned'].includes(claimedStatus),
    `11. task.claim 后 status ∈ {running, in_progress, assigned}  (got ${claimedStatus})`);

const attempts = unwrap(await tm('attempt.list', { taskId: task.id }));
assertTrue(attempts.length >= 1, `12. attempt.list ≥ 1 (got ${attempts.length})`);

let firstAttemptId = null;
if (attempts.length >= 1) {
  firstAttemptId = attempts[0].id;
  const att = await tm('attempt.get', { id: firstAttemptId });
  assertEq(att.taskId || att.task_id, task.id, `13. attempt.get(first).taskId == T.id`);
} else {
  die('13. 没法测 attempt.get,attempts 空');
}

// ---------------------------------------------------------------------------
// Phase 7 — attempt + task done
// ---------------------------------------------------------------------------

log('[Phase 7] attempt + task transition done');

let phase7Errors = 0;
try {
  await tm('attempt.transition', { id: firstAttemptId, targetStatus: 'done' });
} catch (e) {
  phase7Errors++; warn(`attempt.transition done 抛: ${e.message}`);
}
try {
  await tm('task.transition', { id: task.id, targetStatus: 'done' });
} catch (e) {
  phase7Errors++; warn(`task.transition done 抛: ${e.message}`);
}
assertEq(phase7Errors, 0, `14. attempt.transition + task.transition done 链都 2xx`);

// ---------------------------------------------------------------------------
// Phase 8 — blueprint.list 校验
// ---------------------------------------------------------------------------

log('[Phase 8] blueprint.list 校验');

const bpList = unwrap(await tm('blueprint.list', { issueId: issue.id }));
assertTrue(bpList.length >= 1, `15. blueprint.list ≥ 1 active blueprint (got ${bpList.length})`);

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 9 PASS (15 / 15)`);
log(`   issue       = ${issue.id}`);
log(`   blueprint   = ${bp.id}  (3 steps → set_steps → 2 steps)`);
log(`   task        = ${task.id}  (claimable, skillTags=[research], claimed)`);
log(`   firstAttempt= ${firstAttemptId}`);
