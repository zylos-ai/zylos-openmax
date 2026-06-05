#!/usr/bin/env node
/**
 * Smoke 2 (multi-agent) — Heavy issue with cross-actor task claim.
 *
 * Spec: ./smoke-2-heavy-multi-agent.md
 * Design source: cws-deploy/docs/smoke-test-design.md § "Smoke 2: Heavy 多 Agent 编排"
 *
 * Unlike the single-agent smoke 2 (under ../single-agent/), this version
 * actually exercises two distinct member JWTs end-to-end:
 *
 *   - LEAD  = the test owner (env.TEST_USER_TOKEN, an org-owner human acting
 *             through the lead agent). Creates issue / blueprint /
 *             dispatches step 1 as a claimable task.
 *   - WORKER = a freshly-provisioned org-member with its own JWT. Claims and
 *             executes step 1.
 *
 * The interesting assertions are the cross-actor ones that the single-agent
 * version cannot verify:
 *
 *   - task created by LEAD has assignee_id = null + status = pending
 *   - WORKER's task.claim sets assignee_id to WORKER's member_id, NOT
 *     LEAD's member_id and NOT the lead agent's member_id
 *   - the auto-created attempt's assignee_id == WORKER's member_id
 *   - LEAD can still read + transition the task afterwards (visibility ok)
 *
 * Test client orchestrates everything via direct CLI/API calls — no NL, no
 * Claude runtime in the loop. The multi-agent smoke design is "verify the
 * server's authz + assignment semantics", not "re-validate agent NL".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loadEnv, bearerFetch, callApi, provisionMember,
  log, ok, warn, die, assertEq, assertTrue, assertNot, summary,
} from './lib/runner.js';
const execp = promisify(execFile);

const env = loadEnv();
const NS = `Smoke2MA-${Date.now()}`;
log(`=== Smoke 2 (multi-agent): Heavy + cross-actor Worker claim ===  ns=${NS}`);

// -----------------------------------------------------------------------------
// Phase 0 — Provision the WORKER
// -----------------------------------------------------------------------------
log('[Phase 0] Provision WORKER (fresh user → invite → accept → org-scoped login)');
const worker = await provisionMember(env, { rolePrefix: 'org-member', label: 'worker' });
ok(`worker provisioned  member_id=${worker.memberId}  email=${worker.email}`);

// Sanity: LEAD and WORKER are different members
const me = await callApi(env, 'GET', '/api/v1/me', { token: env.TEST_USER_TOKEN });
const leadMemberId = me.member_id;
assertNot(leadMemberId === worker.memberId,
    `0a. lead.member_id (${leadMemberId.slice(0,8)}) ≠ worker.member_id (${worker.memberId.slice(0,8)})`);

// -----------------------------------------------------------------------------
// Phase 1 — LEAD creates a heavy issue
// -----------------------------------------------------------------------------
log('[Phase 1] LEAD creates heavy issue');
const issue = await callApi(env, 'POST', `/api/v1/projects/${env.TEST_PROJECT_ID}/issues`, {
  token: env.TEST_USER_TOKEN,
  body: {
    title:         `${NS} 竞品定价分析`,
    description:   '对比 5 个竞品的定价层级,输出分析报告',
    mode:          'heavy',
    priority:      'medium',
    lead_agent_id: env.TEST_AGENT_ID,
  },
});
ok(`issue created  id=${issue.id}  status=${issue.status}`);
assertEq(issue.status, 'draft',                 '1. issue.status = draft');
assertEq(issue.mode,   'heavy',                 '2. issue.mode = heavy');
assertEq(issue.lead_agent_id, env.TEST_AGENT_ID,'3. issue.lead_agent_id = TEST_AGENT_ID');

// -----------------------------------------------------------------------------
// Phase 2 — LEAD creates a 3-step blueprint with DAG
// -----------------------------------------------------------------------------
log('[Phase 2] LEAD creates blueprint with 3 steps (DAG s1 → s2 → s3)');
const bp = await callApi(env, 'POST', `/api/v1/issues/${issue.id}/blueprints`, {
  token: env.TEST_USER_TOKEN,
  body: {
    steps: [
      { temp_id: 's1', description: `${NS} 采集 5 个竞品的定价页面数据` },
      { temp_id: 's2', description: `${NS} 建立定价对比模型`, depends_on_temp_ids: ['s1'] },
      { temp_id: 's3', description: `${NS} 撰写定价分析报告`, depends_on_temp_ids: ['s2'] },
    ],
  },
});
const bpFull = await callApi(env, 'GET', `/api/v1/blueprints/${bp.id}?include_steps=true`, {
  token: env.TEST_USER_TOKEN,
});
const steps = (bpFull.steps || []).sort((a, b) => a.sort_order - b.sort_order);
assertEq(steps.length, 3, '4. blueprint has 3 steps');
const [s1, s2, s3] = steps;
assertTrue((s2.depends_on || []).includes(s1.id), '5a. s2 depends_on s1');
assertTrue((s3.depends_on || []).includes(s2.id), '5b. s3 depends_on s2');

// -----------------------------------------------------------------------------
// Phase 3 — LEAD walks the issue past the approval gate (post-MR !118 path)
// -----------------------------------------------------------------------------
log('[Phase 3] LEAD submits blueprint for approval, then transitions to executing');
const submit = await callApi(env, 'POST', `/api/v1/blueprints/${bp.id}/submit-for-approval`, {
  token: env.TEST_USER_TOKEN, body: {},
});
const issueAfterSubmit = await callApi(env, 'GET', `/api/v1/issues/${issue.id}`, {
  token: env.TEST_USER_TOKEN,
});
assertEq(issueAfterSubmit.status, 'pending_approval', '6a. issue.status = pending_approval after submit');
assertEq(issueAfterSubmit.current_blueprint_id, bp.id, '6b. issue.current_blueprint_id is set');

await callApi(env, 'POST', `/api/v1/issues/${issue.id}/transition`, {
  token: env.TEST_USER_TOKEN, body: { target_status: 'approved' },
});
const issueAfterApproved = await callApi(env, 'POST', `/api/v1/issues/${issue.id}/transition`, {
  token: env.TEST_USER_TOKEN, body: { target_status: 'executing' },
});
assertEq(issueAfterApproved.status, 'executing', '7. issue.status = executing');

// -----------------------------------------------------------------------------
// Phase 4 — LEAD dispatches step 1 as an unassigned, claimable task
// -----------------------------------------------------------------------------
log('[Phase 4] LEAD creates step1 task with no assignee (Worker claim mode)');
const task1 = await callApi(env, 'POST',
  `/api/v1/projects/${env.TEST_PROJECT_ID}/issues/${issue.id}/tasks`, {
    token: env.TEST_USER_TOKEN,
    body: {
      title:             `${NS} step1`,
      description:       '由 Worker claim 执行',
      blueprint_step_id: s1.id,
      skill_tags:        ['research'],
    },
  });
ok(`step1 task created  id=${task1.id}  status=${task1.status}  assignee=${task1.assignee_id ?? 'null'}`);
assertEq(task1.status, 'pending', '8. unassigned task starts pending');
assertTrue(task1.assignee_id == null || task1.assignee_id === '',
    '9. unassigned task has no assignee_id');

// -----------------------------------------------------------------------------
// Phase 5 — WORKER claims the task (cross-actor)
// -----------------------------------------------------------------------------
log('[Phase 5] WORKER claims step1 using its own JWT');
const claim = await callApi(env, 'POST', `/api/v1/tasks/${task1.id}/claim`, {
  token: worker.jwt, body: {},
});
const claimedTask = claim.task || claim;
const claimedAttempt = claim.attempt;
ok(`worker claim result: task.status=${claimedTask.status}  task.assignee=${claimedTask.assignee_id?.slice(0,8)}  attempt.assignee=${claimedAttempt?.assignee_id?.slice(0,8)}`);
assertEq(claimedTask.status, 'running', '10. task.status = running after worker claim');
assertEq(claimedTask.assignee_id, worker.memberId,
    '11. task.assignee_id == WORKER.member_id (cross-actor assignment took)');
assertNot(claimedTask.assignee_id === leadMemberId,
    '11b. task.assignee_id ≠ LEAD.member_id');
assertNot(claimedTask.assignee_id === env.TEST_AGENT_ID,
    '11c. task.assignee_id ≠ lead AGENT.member_id (worker is the actor, not the lead agent)');
assertTrue(claimedAttempt && claimedAttempt.id, '12a. attempt auto-created');
assertEq(claimedAttempt?.assignee_id, worker.memberId,
    '12b. attempt.assignee_id == WORKER.member_id');
assertEq(claimedAttempt?.status, 'running', '12c. attempt.status = running');

// -----------------------------------------------------------------------------
// Phase 6 — WORKER completes step1 (attempt + task done)
// -----------------------------------------------------------------------------
log('[Phase 6] WORKER finishes step1');
const attDone = await callApi(env, 'POST', `/api/v1/attempts/${claimedAttempt.id}/transition`, {
  token: worker.jwt, body: { target_status: 'done' },
});
assertEq(attDone.status, 'done', '13. attempt.status = done after WORKER transitions');

const taskDone = await callApi(env, 'POST', `/api/v1/tasks/${task1.id}/transition`, {
  token: worker.jwt, body: { target_status: 'done' },
});
assertEq(taskDone.status, 'done', '14. task.status = done after WORKER transitions');

// Sanity: LEAD can still read the task and sees the worker's assignment
const task1AsLead = await callApi(env, 'GET', `/api/v1/tasks/${task1.id}`, {
  token: env.TEST_USER_TOKEN,
});
assertEq(task1AsLead.assignee_id, worker.memberId,
    '15. LEAD can read task1 and sees WORKER as assignee (visibility cross-actor)');

// -----------------------------------------------------------------------------
// Phase 7 — LEAD self-assigns steps 2 + 3
// -----------------------------------------------------------------------------
log('[Phase 7] LEAD self-assigns steps 2 + 3 (lead agent as assignee)');
for (const [n, step] of [[2, s2], [3, s3]]) {
  const t = await callApi(env, 'POST',
    `/api/v1/projects/${env.TEST_PROJECT_ID}/issues/${issue.id}/tasks`, {
      token: env.TEST_USER_TOKEN,
      body: {
        title:             `${NS} step${n}`,
        description:       'lead self',
        blueprint_step_id: step.id,
        assignee_id:       env.TEST_AGENT_ID,
      },
    });
  assertEq(t.status, 'running', `16.${n}a. step${n} task starts running (auto-claim from assignee_id)`);
  assertEq(t.assignee_id, env.TEST_AGENT_ID, `16.${n}b. step${n} task.assignee = lead AGENT`);

  // Find the auto-created attempt
  const attempts = await callApi(env, 'GET', `/api/v1/tasks/${t.id}/attempts`, {
    token: env.TEST_USER_TOKEN,
  });
  const att = Array.isArray(attempts) ? attempts[0] : (attempts.items?.[0]);
  assertTrue(att && att.id, `16.${n}c. step${n} attempt auto-created`);

  await callApi(env, 'POST', `/api/v1/attempts/${att.id}/transition`, {
    token: env.TEST_USER_TOKEN, body: { target_status: 'done' },
  });
  await callApi(env, 'POST', `/api/v1/tasks/${t.id}/transition`, {
    token: env.TEST_USER_TOKEN, body: { target_status: 'done' },
  });
  ok(`step${n} done`);
}

// -----------------------------------------------------------------------------
// Phase 8 — LEAD delivers + accepts
// -----------------------------------------------------------------------------
log('[Phase 8] LEAD delivers + accepts the issue');
const delivered = await callApi(env, 'POST', `/api/v1/issues/${issue.id}/transition`, {
  token: env.TEST_USER_TOKEN, body: { target_status: 'delivered' },
});
assertEq(delivered.status, 'delivered', '17. issue.status = delivered');

const accepted = await callApi(env, 'POST', `/api/v1/issues/${issue.id}/acceptance`, {
  token: env.TEST_USER_TOKEN, body: { accepted: true, source: 'explicit' },
});
assertEq(accepted.status, 'accepted', '18. issue.status = accepted');
assertEq(accepted.acceptance_source, 'explicit', '19. issue.acceptance_source = explicit');
assertEq(accepted.current_blueprint_id, bp.id, '20. issue.current_blueprint_id stays = bp.id');

summary('Smoke 2 (multi-agent)');
console.log(`   issue       = ${issue.id}`);
console.log(`   blueprint   = ${bp.id}    (3 steps, DAG s1 → s2 → s3)`);
console.log(`   worker      = ${worker.memberId}  (${worker.email})`);
console.log(`   step1 task  = ${task1.id}  (worker-claim, assignee=WORKER)`);
console.log(`   step2 + 3   = lead-self assignment`);
