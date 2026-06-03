#!/usr/bin/env node
/**
 * Smoke 1 — Light 单 Agent 全生命周期(基线)
 *
 * 见同目录 smoke-1-light-single-agent.md 完整 spec。
 *
 * 这个脚本是该 spec 的可执行实现。它:
 *   Phase 1: 发一条指令到 TEST_CONV_ID
 *   Phase 2: 轮询 issue list 直到 title=TITLE 的 issue status=accepted
 *   Phase 3: 拉 issue / tasks / attempts,跑 14 条断言
 *
 * 任意断言失败 → process.exit(1)。
 */

import {
  runSmokeCase, tm, listTasks, listAttempts,
  assertEq, assertTrue, log,
} from './lib/runner.js';

const TITLE = `Smoke1-${Date.now()}`;

const instruction = `请帮我跑一个 smoke-1 测试。

要求:
- 创建一个 light issue,标题严格写成 "${TITLE}"(完全照抄不要改),
  priority=low,leadAgentId 用你自己。
- 给这个 issue 自建一个 task,assigneeId 用你自己(Lead 自做)。
- 走完 attempt → task → issue 整条状态流转,attempt 和 task 都
  transition 到 done,issue 先 transition 到 delivered。
- 最后调 set_acceptance(accepted=true, source=explicit) 把 issue
  闭环到 accepted。
- 每一步执行完用一行简要日志告诉我,全部完成后给我返回
  issueId / taskId / attemptId 三个 id 和最终 status。
- 不要建 blueprint,不要用 task.claim,按 light 模式走 Lead 自做最
  简路径。`;

await runSmokeCase({
  name: 'Smoke 1: Light 单 Agent 全生命周期',
  instruction,
  predicate: (i) => typeof i.title === 'string' && i.title.includes(TITLE),
  assertions: async ({ env, issue, firstObservedStatus }) => {
    // 1. Light mode 跳过 draft —— 我们第一次观测到的状态应该是 executing
    //    (注意:如果 agent 跑得飞快,poll 3s 可能错过 draft,但 light 路径
    //     设计上根本不进 draft;这条断言用 firstObservedStatus 而不是 trace
    //     首元素,效果一样)
    assertEq(firstObservedStatus, 'executing', '1. firstObservedStatus (light 跳过 draft)');

    // 2-7. Issue 字段
    assertEq(issue.mode,                  'light',          '2. issue.mode');
    assertEq(issue.priority,              'low',            '3. issue.priority');
    assertEq(issue.status,                'accepted',       '4. issue.status');
    assertEq(issue.lead_agent_id,         env.TEST_AGENT_ID,'5. issue.lead_agent_id');
    assertEq(issue.current_blueprint_id,  null,             '6. issue.current_blueprint_id');
    assertEq(issue.acceptance_source,     'explicit',       '7. issue.acceptance_source');

    // 8-11. Task
    const tasks = await listTasks(issue.id);
    assertEq(tasks.length, 1, '8. task 数');
    const task = tasks[0];
    assertEq(task.status,             'done',           '9.  task.status');
    assertEq(task.assignee_id,        env.TEST_AGENT_ID,'10. task.assignee_id');
    assertEq(task.blueprint_step_id,  null,             '11. task.blueprint_step_id');

    // 12-14. Attempt
    const attempts = await listAttempts(task.id);
    assertEq(attempts.length, 1, '12. attempt 数');
    const attempt = attempts[0];
    assertEq(attempt.status,         'done', '13. attempt.status');
    assertEq(attempt.attempt_number, 1,      '14. attempt.attempt_number');

    log(`   taskId    = ${task.id}`);
    log(`   attemptId = ${attempt.id}`);
  },
});
