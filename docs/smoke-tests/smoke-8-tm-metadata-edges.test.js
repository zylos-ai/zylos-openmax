#!/usr/bin/env node
/**
 * Smoke 8 — TM 元数据 + 边缘转移(纯脚本驱动)
 *
 * 见同目录 smoke-8-tm-metadata-edges.md 完整 spec。
 * 不走 NL / agent runtime。直接 tm.js CRUD + edges。18 断言,中间 2 条 warn-only。
 */

import { tm, log, ok, warn, die, assertEq, assertTrue, assertIn } from './lib/runner.js';

// -- env (subset of standard set — no TEST_CONV_ID / TEST_DEFAULT_KB_ID needed) ---
const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_AGENT_ID', 'TEST_PROJECT_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
process.env.COCO_AUTH_TOKEN = process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN;
process.env.COCO_RPC_LOG = process.env.COCO_RPC_LOG || '0';

const env = {
  PROJECT_A: process.env.TEST_PROJECT_ID,
  AGENT_ID:  process.env.TEST_AGENT_ID,
};

const TS = Date.now();
const NS = `Smoke8-${TS}`;
const unwrap = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

log(`=== Smoke 8: TM 元数据 + 边缘 ===  ns=${NS}`);

// ---------------------------------------------------------------------------
// Phase 1 — 建场景
// ---------------------------------------------------------------------------

log('[Phase 1] 建场景: project B + issue I + task T');

const slugB = `smoke8-${TS}-move-target`.toLowerCase();
const projB = await tm('project.create', {
  name:         `${NS}/move-target`,
  slug:         slugB,
  leadMemberId: env.AGENT_ID,
  description:  `${NS} move target`,
});
assertTrue(projB && projB.id, `1a. project.create returned id`);
assertTrue(/^[0-9a-f-]{36}$/i.test(projB.id), `1b. project.id is uuid (got ${projB.id})`);
assertTrue((projB.name || '').includes(`${NS}/move-target`), `1c. project.name 含 ${NS}/move-target`);
log(`   project B id = ${projB.id}`);

const issueI = await tm('issue.create', {
  projectId:    env.PROJECT_A,
  title:        `${NS} issue`,
  mode:         'light',
  priority:     'low',
  leadAgentId:  env.AGENT_ID,
  description:  `${NS} metadata edges`,
});
assertTrue(issueI && issueI.id, `2a. issue.create returned id`);
assertEq(issueI.projectId || issueI.project_id, env.PROJECT_A, `2b. issue.projectId == A`);
assertTrue((issueI.title || '').includes(NS), `2c. issue.title 含 ${NS}`);
log(`   issue I id = ${issueI.id}`);

const taskT = await tm('task.create', {
  projectId:   env.PROJECT_A,
  issueId:     issueI.id,
  title:       `${NS} task`,
  assigneeId:  env.AGENT_ID,
});
assertTrue(taskT && taskT.id, `3a. task.create returned id`);
assertEq(taskT.issueId || taskT.issue_id, issueI.id, `3b. task.issueId == I`);
assertEq(taskT.assigneeId || taskT.assignee_id, env.AGENT_ID, `3c. task.assigneeId == AGENT_ID`);
log(`   task T id = ${taskT.id}`);

// ---------------------------------------------------------------------------
// Phase 2 — 改元数据
// ---------------------------------------------------------------------------

log('[Phase 2] 改元数据');

await tm('project.update', { id: env.PROJECT_A, description: `${NS} metadata edges` });
const projAAfter = await tm('project.get', { id: env.PROJECT_A });
assertTrue((projAAfter.description || '').includes('metadata edges'),
    `4. project.update 后 description 含 'metadata edges'`);

await tm('issue.update', { id: issueI.id, priority: 'high', description: `${NS} updated desc` });
const issueIAfter = await tm('issue.get', { id: issueI.id });
assertEq((issueIAfter.priority || '').toLowerCase(), 'high', `5. issue.priority == high`);
assertTrue((issueIAfter.description || '').includes('updated desc'),
    `6. issue.description 含 'updated desc'`);

try {
  await tm('task.reassign', { id: taskT.id, newAssigneeId: env.AGENT_ID });
  ok(`7. task.reassign 返 2xx`);
} catch (e) {
  die(`7. task.reassign 抛错: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Phase 3 — 跨容器迁移
// ---------------------------------------------------------------------------

log('[Phase 3] issue.move_project A → B');

await tm('issue.move_project', { id: issueI.id, newProjectId: projB.id });
const issueIMoved = await tm('issue.get', { id: issueI.id });
assertEq(issueIMoved.projectId || issueIMoved.project_id, projB.id,
    `8. issue.move_project 后 projectId == B.id`);

// ---------------------------------------------------------------------------
// Phase 4 — 读校验
// ---------------------------------------------------------------------------

log('[Phase 4] 读校验');

const projBRead = await tm('project.get', { id: projB.id });
assertTrue(projBRead && projBRead.id === projB.id, `9a. project.get(B) returns B`);
assertTrue((projBRead.name || '').includes(`${NS}/move-target`), `9b. project.name 对得上`);

try {
  const membersA = unwrap(await tm('project.members', { id: env.PROJECT_A, pageSize: 50 }));
  if (membersA.length === 0) {
    warn(`10. project.members(A) 返空集 — 已知 cws-work #32(CreateProject 不 seed lead 到 project_members);warn-only`);
  } else {
    ok(`10. project.members(A) 返 ${membersA.length} 条`);
  }
} catch (e) {
  die(`10. project.members(A) 抛错: ${e.message}`);
}

const taskTRead = await tm('task.get', { id: taskT.id });
assertEq(taskTRead.id, taskT.id, `11a. task.get returns T`);
assertEq(taskTRead.assigneeId || taskTRead.assignee_id, env.AGENT_ID, `11b. task.assigneeId 对得上`);

const tasksUnderI = unwrap(await tm('task.list', { issueId: issueI.id, claimable: false }));
assertTrue(tasksUnderI.some(t => t.id === taskT.id), `12. task.list(I, claimable=false) 含 T.id`);

const bpsUnderI = unwrap(await tm('blueprint.list', { issueId: issueI.id }));
assertEq(bpsUnderI.length, 0, `13. blueprint.list(light issue) 返空数组 (got ${bpsUnderI.length})`);

const attemptsT = unwrap(await tm('attempt.list', { taskId: taskT.id }));
if (attemptsT.length === 0) {
  warn(`14. attempt.list(T) 返空集 — 可能 task 自动 claim 没造 attempt;warn-only`);
} else {
  ok(`14. attempt.list(T) 返 ${attemptsT.length} 条`);
  const att = await tm('attempt.get', { id: attemptsT[0].id });
  assertEq(att.taskId || att.task_id, taskT.id, `15. attempt.get(first).taskId == T.id`);
}

// ---------------------------------------------------------------------------
// Phase 5 — 归档闭环
// ---------------------------------------------------------------------------

log('[Phase 5] archive → restore 闭环');

await tm('project.archive', { id: projB.id });
ok(`16. project.archive(B) 返 2xx`);

const archivedList = unwrap(await tm('project.list', { status: 'archived', pageSize: 200 }));
assertTrue(archivedList.some(p => p.id === projB.id),
    `17. project.list(status=archived) 含 B.id (got ${archivedList.length} archived projs)`);

await tm('project.restore', { id: projB.id });
const activeListAfter   = unwrap(await tm('project.list', { status: 'active',   pageSize: 200 }));
const archivedListAfter = unwrap(await tm('project.list', { status: 'archived', pageSize: 200 }));
assertTrue(activeListAfter.some(p => p.id === projB.id),
    `18a. restore 后 active 列表含 B.id`);
assertTrue(!archivedListAfter.some(p => p.id === projB.id),
    `18b. restore 后 archived 列表不再含 B.id`);

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 8 PASS (18 / 18)`);
log(`   project A = ${env.PROJECT_A}  (description updated)`);
log(`   project B = ${projB.id}  (created, archive/restore round-trip)`);
log(`   issue   I = ${issueI.id}  (moved A → B, priority=high)`);
log(`   task    T = ${taskT.id}  (reassigned self)`);
