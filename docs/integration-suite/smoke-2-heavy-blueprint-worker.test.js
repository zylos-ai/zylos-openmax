#!/usr/bin/env node
/**
 * Smoke 2 — Heavy + Blueprint + Worker claim + KB
 *
 * 见同目录 smoke-2-heavy-blueprint-worker.md 完整 spec。
 *
 * 20 条断言,覆盖 issue / blueprint / 3 tasks / 3 attempts / KB page + search。
 */

import {
  runSmokeCase, tm, listTasks, listAttempts,
  assertEq, assertTrue, assertIn, log,
} from './lib/runner.js';

const TITLE = `Smoke2-${Date.now()}`;

const instruction = `请帮我跑一个 smoke-2 测试 —— Heavy Blueprint + Worker claim + KB 集成。

要求:
1) 创建一个 heavy issue,标题严格 "${TITLE}",priority=medium,
   leadAgentId 用你自己,description 写 "竞品定价对比"。
2) 紧接着 blueprint.create,3 个 step:
   - s1 "采集 5 个竞品的定价页面数据"
   - s2 "建立定价对比模型",depends_on s1
   - s3 "撰写定价分析报告",depends_on s2
   用 blueprint.get 验证三个 step 都建上且依赖关系正确。
3) issue.transition 把 issue 推到 executing(跳过 review)。
4) Step 1 用 **Worker claim 模式**:
   - task.create,blueprintStepId=s1 的 id,**不指定 assigneeId**,
     skillTags=["research"],预期 task.status="pending"。
   - 然后立刻 task.list 自查(claimable:true + agentSkills:["research"]),
     确认该 task 在列表里。
   - 你自己 task.claim 这个 task(模拟 Worker 角色),预期 status="running",
     attempt 自动创建。
   - 然后你作为 Worker 跑业务:
     a. kb.tree_roots 拿根节点 rootId
     b. kb.page_create 在 rootId 下面建一个 page,title="${TITLE} - 数据采集"
     c. kb.page_content_write 写入一段 markdown(写一个简单的 table 即可,
        含 5 行竞品数据,自己编)
     d. kb.search 用关键词 "${TITLE}",sync=true,自检 page 被搜到
   - attempt.transition done + task.transition done。
5) Step 2 和 Step 3 用 **Lead 自做模式**:
   - task.create 各带 blueprintStepId=对应 step 的 id,
     **assigneeId 用你自己**,预期 task 直接 status="running"(自动 claim)。
   - 各自 attempt.transition done + task.transition done。
6) 全部 3 个 task 都 done 后,issue.transition 到 delivered。
7) set_acceptance(accepted=true, source=explicit) 闭环到 accepted。
8) 每一步用一行简要日志报。结束打印 issueId / blueprintId / 三个 taskId /
   三个 attemptId / pageId / 最终 status。`;

// ---------------------------------------------------------------------------
// KB helpers — we don't have kb.search in the shared runner, so call tm.js
// directly. The installed kb.js binary lives next to tm.js, default to the
// same skill copy.
// ---------------------------------------------------------------------------

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execp = promisify(execFile);

function resolveKbCli() {
  if (process.env.COCO_KB_CLI) return process.env.COCO_KB_CLI;
  const installed = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/kb.js');
  if (fs.existsSync(installed)) return installed;
  return path.resolve(path.dirname(import.meta.url.replace('file://','')), '../../../src/cli/kb.js');
}
async function kb(cmd, params = {}) {
  const KB = resolveKbCli();
  const { stdout } = await execp('node', [KB, cmd, JSON.stringify(params)], {
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

await runSmokeCase({
  name: 'Smoke 2: Heavy + Blueprint + Worker claim + KB',
  instruction,
  predicate: (i) => typeof i.title === 'string' && i.title.includes(TITLE),
  opts: { maxWaitMs: 10 * 60 * 1000 },
  assertions: async ({ env, issue, firstObservedStatus, statusTrace }) => {
    // ----- Issue (1-7) -----
    // 1. heavy 路径在 MR !118 之后是 draft → pending_approval →
    // executing(走 blueprint.submit_for_approval 把 issue.current_blueprint_id
    // 写进去,#6 那条断言才能过)。1s poll 抓得到哪个中间态都算合法。
    assertIn(firstObservedStatus, ['draft', 'pending_approval', 'executing'], '1.  firstObservedStatus (heavy 路径)');
    assertEq(issue.mode,             'heavy',             '2.  issue.mode');
    assertEq(issue.priority,         'medium',            '3.  issue.priority');
    assertEq(issue.status,           'accepted',          '4.  issue.status');
    assertEq(issue.lead_agent_id,    env.TEST_AGENT_ID,   '5.  issue.lead_agent_id');
    assertTrue(typeof issue.current_blueprint_id === 'string'
        && issue.current_blueprint_id.length > 0,
        '6.  issue.current_blueprint_id (non-null UUID)');
    assertEq(issue.acceptance_source, 'explicit',         '7.  issue.acceptance_source');

    // ----- Blueprint (8-9) -----
    const bpResp = await tm('blueprint.get', { id: issue.current_blueprint_id, includeSteps: true });
    const bp     = bpResp.data || bpResp;
    const steps  = bp.steps || [];
    assertEq(steps.length, 3, '8.  blueprint.steps 数');

    // Sort by sequence/created_at to identify s1/s2/s3 deterministically.
    // We can't assume a specific order; instead match by description hint.
    const findStep = (kw) => steps.find(s =>
        (s.description || '').includes(kw) || (s.title || '').includes(kw));
    const s1 = findStep('采集');
    const s2 = findStep('对比模型');
    const s3 = findStep('分析报告');
    assertTrue(s1 && s2 && s3, '9a. blueprint 3 个 step 都按描述找到');
    const s2Deps = (s2.depends_on_step_ids || s2.depends_on || []).map(String);
    const s3Deps = (s3.depends_on_step_ids || s3.depends_on || []).map(String);
    assertTrue(s2Deps.includes(String(s1.id)),
        `9b. s2.depends_on 含 s1.id (s2Deps=${JSON.stringify(s2Deps)})`);
    assertTrue(s3Deps.includes(String(s2.id)),
        `9c. s3.depends_on 含 s2.id (s3Deps=${JSON.stringify(s3Deps)})`);

    // ----- Tasks (10-15) -----
    const tasks = await listTasks(issue.id);
    assertEq(tasks.length, 3, '10. task 数');
    for (const t of tasks) {
      assertEq(t.status, 'done', `11. task[${t.id}].status`);
      assertTrue(typeof t.blueprint_step_id === 'string' && t.blueprint_step_id.length > 0,
          `12. task[${t.id}].blueprint_step_id (non-null)`);
    }
    // 1:1 mapping of task → step (each step covered exactly once)
    const stepIdsUsed = new Set(tasks.map(t => t.blueprint_step_id));
    assertEq(stepIdsUsed.size, 3, '15. task ↔ blueprint step 是 1:1');

    // Step-by-step assignee identification: which task targets which step.
    const taskFor = (step) => tasks.find(t => t.blueprint_step_id === step.id);
    const t1 = taskFor(s1);
    const t2 = taskFor(s2);
    const t3 = taskFor(s3);
    assertTrue(t1 && t2 && t3, '15b. 3 个 step 各自对应 task');
    assertEq(t1.assignee_id, env.TEST_AGENT_ID, '13. step1 task.assignee_id (Worker claim 自己)');
    assertEq(t2.assignee_id, env.TEST_AGENT_ID, '14a. step2 task.assignee_id (Lead 自做)');
    assertEq(t3.assignee_id, env.TEST_AGENT_ID, '14b. step3 task.assignee_id (Lead 自做)');

    // ----- Attempts (16-18) -----
    for (const t of tasks) {
      const atts = await listAttempts(t.id);
      assertEq(atts.length, 1, `16. task[${t.id}] attempt 数`);
      const a = atts[0];
      assertEq(a.status,         'done', `17. attempt[${a.id}].status`);
      assertEq(a.attempt_number, 1,      `18. attempt[${a.id}].attempt_number`);
    }

    // ----- KB (19-20) -----
    try {
      const searchResp = await kb('kb.search', { query: TITLE, sync: true });
      const hits = searchResp.data || searchResp.hits || searchResp.results || searchResp || [];
      const hitsArr = Array.isArray(hits) ? hits : (hits.items || []);
      assertTrue(hitsArr.length >= 1, `20. kb.search "${TITLE}" 至少 1 条命中 (got ${hitsArr.length})`);
      // From search result we can derive that there's at least one page with TITLE-containing title.
      // The hit structure varies; just check that title is included somewhere.
      const titlesInHits = hitsArr.map(h => h.title || h.page?.title || h.page_title || '').filter(Boolean);
      const matchingTitle = titlesInHits.find(t => t.includes(TITLE));
      assertTrue(matchingTitle, `19. 至少有一个 KB page title 含 "${TITLE}" (hits=${JSON.stringify(titlesInHits)})`);
    } catch (e) {
      // KB 集成是断言里最容易因为权限/环境跑挂的;打印失败但仍 process.exit(1)
      console.error(`✗ KB assertions failed: ${e.message}`);
      console.error(`  (如果是权限/超时问题,可以临时跳过 KB 断言验证其他维度;但默认要求过)`);
      process.exit(1);
    }

    log(`   blueprintId = ${issue.current_blueprint_id}`);
    log(`   taskIds     = [${tasks.map(t => t.id).join(', ')}]`);
    log(`   trace       = ${statusTrace.map(s => s.status).join(' → ')}`);
  },
});
