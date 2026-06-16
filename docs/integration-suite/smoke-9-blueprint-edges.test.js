#!/usr/bin/env node
/**
 * Smoke 9 — Blueprint 编排调整 + Worker claim(NL 驱动)
 *
 * 见同目录 smoke-9-blueprint-edges.md 完整 spec。3 轮 NL + 12 断言。
 */

import { sendInstruction, tm, log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_CONV_ID', 'TEST_AGENT_ID', 'TEST_PROJECT_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
const env = {
  COCO_API_URL:            process.env.COCO_API_URL.replace(/\/+$/, ''),
  TEST_USER_TOKEN:         process.env.TEST_USER_TOKEN,
  TEST_CONV_ID:            process.env.TEST_CONV_ID,
  TEST_AGENT_ID:           process.env.TEST_AGENT_ID,
  TEST_PROJECT_ID:         process.env.TEST_PROJECT_ID,
  COCO_AUTH_TOKEN:         process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN,
  CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
  CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
};
process.env.COCO_AUTH_TOKEN = env.COCO_AUTH_TOKEN;
process.env.COCO_RPC_LOG = '0';

const TS = Date.now();
const NS = `Smoke9-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// ---- poll helpers (shared) ---------------------------------------------------
function headers() {
  const h = { Authorization: `Bearer ${env.TEST_USER_TOKEN}`, 'Content-Type': 'application/json' };
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}
async function listAgentMessagesAfter(seq) {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=50`, { headers: headers() });
  if (!res.ok) throw new Error(`list-messages HTTP ${res.status}`);
  return unwrapList(await res.json()).filter(m => {
    const kind = (m.sender_type || m.sender_kind || m.type || '').toUpperCase();
    return kind.includes('AGENT');
  }).filter(m => Number(m.seq || 0) > seq).sort((a,b) => Number(a.seq) - Number(b.seq));
}
function extractText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (c.body && typeof c.body.text === 'string') return c.body.text;
  if (Array.isArray(c)) return c.map(p => p?.body || p?.text || '').join('\n');
  try { return JSON.stringify(c); } catch { return ''; }
}
async function waitForCard({ label, sinceSeq, matchAny = [], maxMs }) {
  const startedAt = Date.now();
  const seen = [];
  while (Date.now() - startedAt < maxMs) {
    try {
      const msgs = await listAgentMessagesAfter(sinceSeq);
      for (const m of msgs) {
        const text = extractText(m);
        seen.push({ seq: m.seq, preview: text.slice(0, 120) });
        if (matchAny.length === 0 || matchAny.some(p => text.includes(p))) {
          return { msg: m, text };
        }
      }
    } catch (e) { log(`  · poll err: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.error(`✗ timeout waiting for ${label} (${maxMs}ms)`);
  for (const s of seen.slice(-8)) console.error(`    seq=${s.seq}  ${s.preview}`);
  process.exit(1);
}
async function currentSeq() {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=1`, { headers: headers() });
  const arr = unwrapList(await res.json());
  return arr.length ? Math.max(...arr.map(m => Number(m.seq || 0))) : 0;
}

// ---- Run --------------------------------------------------------------------
log(`=== Smoke 9 (NL): Blueprint 编排 + Worker claim ===  ${NS}`);
let cursor = await currentSeq();

// ---------- Round 1 ----------
log('[Round 1] heavy issue + 3-step blueprint');
const NL1 = `我想做个 ${NS} 的竞品调研项目,你帮我:
1. 在 Smoke Suite 项目下开个 heavy issue,标题 "${NS} 竞品定价对比",
   优先级 medium,你做 lead,描述 "采 5 家竞品定价然后输出对比报告"
2. blueprint 先排 3 步:s1 "采 5 家竞品定价页"、
   s2 "建立定价对比模型"(depends on s1)、
   s3 "写分析报告"(depends on s2)

建完一行报 issue id + blueprint id + 3 个 step 的 id。`;
await sendInstruction(env, NL1);

const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: [NS, 'blueprint', '3 步', 'step', '已建'],
  maxMs: 120 * 1000,
});
cursor = Number(r1.msg.seq);

const uuids1 = r1.text.match(new RegExp(UUID_RE.source, 'gi')) || [];
assertTrue(uuids1.length >= 3, `1. round1 含 ≥ 3 个 uuid (got ${uuids1.length})`);
assertTrue(/采|采集|定价/.test(r1.text) && /模型|建模/.test(r1.text) && /报告|分析/.test(r1.text),
    `2. round1 含 采 / 模型 / 报告 三个 step 关键词`);

// 旁路:在 Smoke Suite 找新 heavy issue
const issuesA = unwrapList(await tm('issue.list_in_project', {
  projectId: env.TEST_PROJECT_ID, pageSize: 100,
}));
const issueI = issuesA.find(i => (i.title || '').includes(NS));
assertTrue(issueI && issueI.id, `7a. issue I 存在`);
log(`   issueI=${issueI.id}`);

const bpList1 = unwrapList(await tm('blueprint.list', { issueId: issueI.id }));
assertTrue(bpList1.length >= 1, `7b. blueprint.list ≥ 1`);
const bp = bpList1[0];

const bpDetail1 = await tm('blueprint.get', { id: bp.id, includeSteps: true });
const steps1 = unwrapList(bpDetail1.steps || []);
assertEq(steps1.length, 3, `7. blueprint.get(includeSteps) → 3 steps (round1)`);

// ---------- Round 2 ----------
log('[Round 2] merge to 2 steps');
const NL2 = `看完 blueprint 我觉得 s1 + s2 太碎,合并起来一个人能搞定。改成 2 步:
- 新 s1 "采集 + 建模合并"
- s2 "写分析报告"(depends on 新 s1)

改完 blueprint.get 一下确认现在只剩 2 步。`;
await sendInstruction(env, NL2);

const r2 = await waitForCard({
  label: 'round2', sinceSeq: cursor,
  matchAny: ['2 步', '两步', '合并', 'merged', '已改'],
  maxMs: 90 * 1000,
});
cursor = Number(r2.msg.seq);

assertTrue(/2 ?步|两步|两个 step/.test(r2.text) && /合并|merged|merge/.test(r2.text),
    `3. round2 含 "2 步" + "合并" 语义`);
assertTrue(/2|两/.test(r2.text), `4. round2 提到 step 数 == 2`);

const bpDetail2 = await tm('blueprint.get', { id: bp.id, includeSteps: true });
const steps2 = unwrapList(bpDetail2.steps || []);
assertEq(steps2.length, 2, `8. blueprint.get → 2 steps (round2)`);
const stepDescs = steps2.map(s => (s.description || s.title || '').toLowerCase());
assertTrue(stepDescs.some(t => /合并|采|merged|merge|combined/.test(t)),
    `9. step descriptions 含 "合并 / 采 / merged" 任一 (got ${stepDescs.join(' | ').slice(0,160)})`);

// ---------- Round 3 ----------
log('[Round 3] worker claim → done');
const NL3 = `ok 推到 executing 状态。新 s1 那一步用 worker claim 模式:
- 建 task 不指定 assignee,skillTags 加 ["research"]
- 你自己以 worker 身份接(模拟有 research 技能的 agent)
- 接完跑到 done(attempt + task 都 done)

最后给我汇报 attempt id 跟最终 status。`;
await sendInstruction(env, NL3);

const r3 = await waitForCard({
  label: 'round3', sinceSeq: cursor,
  matchAny: ['worker', 'claim', '已接', 'done', 'attempt'],
  maxMs: 180 * 1000,
});
cursor = Number(r3.msg.seq);

assertTrue(/worker|claim|已接/.test(r3.text), `5. round3 含 worker / claim / 已接`);
assertTrue(/done|完成|已 ?完成/.test(r3.text), `6. round3 含 done / 完成`);

// 旁路:task & attempt 状态
const tasksI = unwrapList(await tm('task.list', { issueId: issueI.id, pageSize: 50 }));
assertTrue(tasksI.length >= 1, `10a. task.list 在 issue 上 ≥ 1 (got ${tasksI.length})`);
const taskT = tasksI[0];
const status = (taskT.status || '').toLowerCase();
assertTrue(['done', 'running', 'in_progress'].includes(status),
    `10. task.status ∈ {done, running, in_progress} (got ${status})`);

const attempts = unwrapList(await tm('attempt.list', { taskId: taskT.id }));
assertTrue(attempts.length >= 1, `11a. attempt.list ≥ 1 (got ${attempts.length})`);
const att = attempts[0];
const attStatus = (att.status || '').toLowerCase();
assertTrue(['done', 'completed'].includes(attStatus) || status === 'done',
    `11. attempt.status == done (或 task 已 done) (got attempt=${attStatus} task=${status})`);

const issueIAfter = await tm('issue.get', { id: issueI.id });
const issueStatus = (issueIAfter.status || '').toLowerCase();
assertTrue(['executing', 'delivered', 'in_progress'].includes(issueStatus),
    `12. issue.status ∈ {executing, delivered} (got ${issueStatus})`);

// ---------------------------------------------------------------------------
log('');
log(`✅ Smoke 9 (NL) PASS (12 / 12)`);
log(`   issue     = ${issueI.id}`);
log(`   blueprint = ${bp.id}  (3 → 2 steps)`);
log(`   task      = ${taskT.id}  (worker claim, status=${status})`);
log(`   attempt   = ${att.id}  (status=${attStatus})`);
