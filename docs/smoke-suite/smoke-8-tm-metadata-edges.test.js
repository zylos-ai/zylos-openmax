#!/usr/bin/env node
import './lib/bootstrap-single.js';
/**
 * Smoke 8 — TM 元数据 + 边缘转移(NL 驱动)
 *
 * 见同目录 smoke-8-tm-metadata-edges.md 完整 spec。3 轮 NL + 14 断言。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, tm, log, ok, warn, die, assertEq, assertTrue } from './lib/runner-single.js';
const execp = promisify(execFile);

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
const NS = `Smoke8-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// ---- agent message poll(与 Smoke 5/6 同款) ---------------------------------

function headers() {
  const h = { Authorization: `Bearer ${env.TEST_USER_TOKEN}`, 'Content-Type': 'application/json' };
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}
async function listAgentMessagesAfter(seq) {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=50`, { headers: headers() });
  if (!res.ok) throw new Error(`list-messages HTTP ${res.status}`);
  const body = await res.json();
  const msgs = unwrapList(body).filter(m => {
    const kind = (m.sender_type || m.sender_kind || m.type || '').toUpperCase();
    return kind.includes('AGENT');
  });
  return msgs.filter(m => Number(m.seq || 0) > seq).sort((a,b) => Number(a.seq) - Number(b.seq));
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

log(`=== Smoke 8 (NL): TM 元数据 + 边缘 ===  ${NS}`);
let cursor = await currentSeq();

// ---------- Round 1 ----------
log('[Round 1] 建临时项目 + issue + task');
const NL1 = `我准备做个 ${NS} 的小实验,你帮我:
1. 新建一个项目叫 "${NS}/move-target",描述写"挪过来的临时实验"
2. 在我们 Smoke Suite 项目里建一个 light issue,标题就叫 "${NS} 实验任务",
   优先级 low,你做 lead,描述写"先放着,后面要挪走"
3. 在那个 issue 下建一个 task 直接分配给你自己

建完用一行报给我 project id、issue id、task id。`;
await sendInstruction(env, NL1);

const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: [NS, '项目 id', 'project id', '已建', 'pageId'],
  maxMs: 120 * 1000,
});
cursor = Number(r1.msg.seq);

// 卡片体断言:含至少 1 个 uuid
const uuids = (r1.text.match(new RegExp(UUID_RE.source, 'gi')) || []);
assertTrue(uuids.length >= 1, `1. round1 回复含至少 1 个 uuid (got ${uuids.length})`);
assertTrue(/已建|建好|建完|建立|创建/.test(r1.text), `2. round1 表达"已建"语义`);

// 旁路:project B by name + issue in A + task in I
const allProjs = unwrapList(await tm('project.list', { pageSize: 100 }));
const projB = allProjs.find(p => (p.name || '').includes(`${NS}/move-target`));
assertTrue(projB && projB.id, `8. project B (${NS}/move-target) 存在`);
log(`   projB.id=${projB.id}`);

const issuesA = unwrapList(await tm('issue.list_in_project', {
  projectId: env.TEST_PROJECT_ID, pageSize: 100,
}));
const issueI = issuesA.find(i => (i.title || '').includes(NS));
assertTrue(issueI && issueI.id, `9a. issue I 在 Smoke Suite 项目里`);
log(`   issueI.id=${issueI.id}`);
assertEq(issueI.projectId || issueI.project_id, env.TEST_PROJECT_ID, `9b. issue.projectId == A (round1)`);

// ---------- Round 2 ----------
log('[Round 2] 改 issue 元数据 + 跨项目挪');
const NL2 = `那个 ${NS} 实验任务,情况变了:
- 优先级提到 high
- 描述改成 "紧急,优先级临时拉高"
- 整个挪到刚才那个 "${NS}/move-target" 项目下面

挪完跟我确认下 issue 现在所属项目。`;
await sendInstruction(env, NL2);

const r2 = await waitForCard({
  label: 'round2', sinceSeq: cursor,
  matchAny: [`${NS}/move-target`, 'high', '已挪', '已迁移', '挪到', '迁'],
  maxMs: 90 * 1000,
});
cursor = Number(r2.msg.seq);

assertTrue(/high|High|HIGH/.test(r2.text), `3a. round2 回复含 high`);
assertTrue(/挪|迁/.test(r2.text), `3b. round2 回复含 挪/迁 语义`);
assertTrue(r2.text.includes(`${NS}/move-target`), `4. round2 回复含目标项目名`);

// 旁路:issue I 现在 priority=high + description 含 "紧急" + projectId == B
const issueIAfter = await tm('issue.get', { id: issueI.id });
assertEq((issueIAfter.priority || '').toLowerCase(), 'high', `10a. issue.priority == high`);
assertTrue((issueIAfter.description || '').includes('紧急'),
    `10b. issue.description 含 '紧急'`);
assertEq(issueIAfter.projectId || issueIAfter.project_id, projB.id,
    `11. issue 已挪到 B (projectId == ${projB.id})`);

// ---------- Round 3 ----------
log('[Round 3] 改主项目元数据 + 看人 + 归档闭环');
const NL3 = `顺手再做几件:
1. 我们 Smoke Suite 这个项目的描述改成 "${NS} metadata edges round"
2. 列一下 Smoke Suite 这个项目里现在都有哪些 member(顺带说一下你是不是 lead)
3. "${NS}/move-target" 这个项目实验差不多了,先归档掉
4. 哎,等等,我还想再用一下,**立马**给我恢复回来

每一步一行简短日志。`;
await sendInstruction(env, NL3);

const r3 = await waitForCard({
  label: 'round3', sinceSeq: cursor,
  matchAny: ['描述', '归档', '恢复', 'member', '已改', 'archive', 'restore'],
  maxMs: 120 * 1000,
});
cursor = Number(r3.msg.seq);

assertTrue(/member|成员/.test(r3.text), `5a. round3 回复含 member/成员 语义`);
assertTrue(/归档|archive/i.test(r3.text), `5b. round3 回复含 归档`);
assertTrue(/恢复|restore/i.test(r3.text), `5c. round3 回复含 恢复`);
assertTrue(/描述|description/i.test(r3.text), `6. round3 回复表达描述已改`);
assertTrue(/active|恢复|可用/.test(r3.text), `7. round3 回复表达 B 已恢复 active`);

// 旁路:project A description 含 metadata edges
const projAAfter = await tm('project.get', { id: env.TEST_PROJECT_ID });
assertTrue((projAAfter.description || '').includes('metadata edges'),
    `12. project A description 含 'metadata edges' (got "${(projAAfter.description||'').slice(0,80)}")`);

// 旁路:project B status active(归档后已恢复)
const projBAfter = await tm('project.get', { id: projB.id });
const projBStatus = (projBAfter.status || '').toLowerCase();
assertTrue(projBStatus === 'active' || !projBAfter.archived,
    `13. project B status == active(已恢复) (got "${projBStatus}")`);

// 旁路:project.members 路径调通(warn-only on empty)
try {
  const members = unwrapList(await tm('project.members', { id: env.TEST_PROJECT_ID, pageSize: 50 }));
  if (members.length === 0) {
    warn(`14. project.members(A) 返空 — cws-work #32 已知,warn-only`);
  } else {
    ok(`14. project.members(A) 返 ${members.length} 条`);
  }
} catch (e) {
  die(`14. project.members(A) 抛错: ${e.message}`);
}

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 8 (NL) PASS (14 / 14)`);
log(`   project A   = ${env.TEST_PROJECT_ID} (description updated)`);
log(`   project B   = ${projB.id} (created, archive→restore round-trip)`);
log(`   issue   I   = ${issueI.id} (moved A→B, priority=high)`);

// ---- Cleanup ---------------------------------------------------------------
log('');
log('[Cleanup] 清理测试数据');
try {
  await tm('issue.archive', { id: issueI.id });
  ok(`cleanup: issue ${issueI.id} archived`);
} catch (e) { warn(`cleanup: issue archive failed: ${e.message}`); }
try {
  await tm('project.archive', { id: projB.id });
  ok(`cleanup: project ${projB.id} archived`);
} catch (e) { warn(`cleanup: project archive failed: ${e.message}`); }
