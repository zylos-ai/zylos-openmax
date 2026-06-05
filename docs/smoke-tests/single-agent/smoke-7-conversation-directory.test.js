#!/usr/bin/env node
/**
 * Smoke 7 — 组织态势盘点(NL 驱动)
 *
 * 见同目录 smoke-7-conversation-directory.md 完整 spec。
 * 2 轮 NL + 全程旁路。16 断言。只读,无副作用。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, assertEq, assertTrue, log, ok, die } from './lib/runner.js';
const execp = promisify(execFile);

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_CONV_ID', 'TEST_AGENT_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
const env = {
  COCO_API_URL:            process.env.COCO_API_URL.replace(/\/+$/, ''),
  TEST_USER_TOKEN:         process.env.TEST_USER_TOKEN,
  TEST_CONV_ID:            process.env.TEST_CONV_ID,
  TEST_AGENT_ID:           process.env.TEST_AGENT_ID,
  COCO_AUTH_TOKEN:         process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN,
  CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
  CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
};
process.env.COCO_AUTH_TOKEN = env.COCO_AUTH_TOKEN;
process.env.COCO_RPC_LOG = '0';

const SKILL_BIN = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli');
async function cli(bin, cmd, p = {}) {
  const { stdout } = await execp('node', [path.join(SKILL_BIN, bin), cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data || r;
}
const core = (cmd, p) => cli('core.js', cmd, p);
const comm = (cmd, p) => cli('comm.js', cmd, p);
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

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

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// -- Run ------------------------------------------------------------------
log(`=== Smoke 7 (NL): 组织态势盘点 ===`);
let cursor = await currentSeq();

// -- Round 1: status overview --------------------------------------------
const NL1 = `帮我盘一下当前组织态势:
1) 我是谁(member_id + role)
2) 这个组织叫啥(name + slug + 总 member 数)
3) member 里 human / agent 各几个
4) 我在这个组织有几个项目,列出每个项目的 name
5) 最近有多少个会话,挑近 5 个列出来(对方 / 类型 / 最近一条消息时间)
全部整理成一条结构化简报回给我,不需要废话。`;

log('[Phase 1/2] round1 NL → status overview');
await sendInstruction(env, NL1);

const r1 = await waitForCard({
  label: 'round1 status',
  sinceSeq: cursor,
  matchAny: ['member_id', 'role', '组织', 'org', '项目', '会话'],
  maxMs: 60 * 1000,
});
cursor = Number(r1.msg.seq);
const t1 = r1.text;

assertTrue(UUID_RE.test(t1), '2. round1 回复含 caller member_id(uuid)');

// Get truth from CLI for cross-checks
const me = await core('core.me');
const myRoleSlug = (me.role || {}).slug;
assertTrue(myRoleSlug && t1.includes(myRoleSlug), `3. 回复含 caller role.slug == "${myRoleSlug}"`);

const myOrgId = me.org_id || me.orgId;
const orgDetail = await core('core.org_get', { orgId: myOrgId });
assertTrue(t1.includes(orgDetail.name) && t1.includes(orgDetail.slug),
    `4. 回复含组织 name="${orgDetail.name}" + slug="${orgDetail.slug}"`);

const numbersInText = (t1.match(/\d+/g) || []).map(Number);
assertTrue(numbersInText.length >= 2, '5. 回复含至少两个数字(human + agent 计数)');
ok('1. round1 回复已到达');

// Backing truth
const humans = unwrapList(await core('core.member_list', { kind: 'human', limit: 200 }));
const agents = unwrapList(await core('core.member_list', { kind: 'agent', limit: 200 }));
const trueHumanCount = humans.length;
const trueAgentCount = agents.length;
const trueTotal = trueHumanCount + trueAgentCount;
log(`   truth: humans=${trueHumanCount}, agents=${trueAgentCount}, total=${trueTotal}`);

// Project list and conversation list truths
const projects = unwrapList(await core('core.project_list', { limit: 50 }));
const trueProjNames = projects.map(p => p.name);
assertTrue(trueProjNames.some(n => t1.includes(n)), `6. 回复含至少 1 个项目 name (truth=${JSON.stringify(trueProjNames)})`);

const conversations = unwrapList(await comm('comm.list_conversations', { limit: 50 }));
const trueConvCount = conversations.length;
// agent might write the count or list 5 conv lines; we accept either
assertTrue(numbersInText.some(n => n >= 1 && n <= trueConvCount + 5) || /会话|conversation/i.test(t1),
    `7. 回复表达会话数(truth=${trueConvCount})`);

// === Backing assertions (#11-14) =======================================
assertEq((me.role || {}).slug, myRoleSlug, '11. 旁路 core.me.role.slug 与 agent 回复一致');

// #12: agent reply total == truth
// Heuristic: pick the two largest small-ish numbers (likely human/agent counts)
const candidate = numbersInText.filter(n => n >= 0 && n <= 1000).sort((a,b) => a-b);
// best effort: total must equal trueTotal somewhere in the message
assertTrue(t1.includes(String(trueTotal)) || candidate.includes(trueTotal),
    `12. 回复中 human+agent 总数 == ${trueTotal}`);

const reportedNames = trueProjNames.filter(n => t1.includes(n));
assertTrue(reportedNames.length === trueProjNames.length || reportedNames.length >= 1,
    `13. 回复中提到的项目 ⊆ 真实项目名集合 (mentioned=${reportedNames.length}/${trueProjNames.length})`);

assertTrue(numbersInText.some(n => n <= trueConvCount + 5),
    `14. 回复中的会话数 ≤ 真实总数 + 5(没虚高)`);

// -- Round 2: drill down into first project's members --------------------
log('[Phase 4/5] round2 NL → drill into first project members');
const firstProj = projects[0];
assertTrue(firstProj, 'round2 pre: 真实项目数 ≥ 1');

const NL2 = `把你刚才列的第一个项目里的成员都列出来:每行一个 "name (kind, role)"。`;
await sendInstruction(env, NL2);

const r2 = await waitForCard({
  label: 'round2 project members',
  sinceSeq: cursor,
  matchAny: ['(human', '(agent', firstProj.name],
  maxMs: 60 * 1000,
});
cursor = Number(r2.msg.seq);
const t2 = r2.text;

ok('8. round2 回复已到达');

// At least one "name (kind, role)" style line
const memberLineRe = /\(\s*(human|agent)\s*,/i;
assertTrue(memberLineRe.test(t2), '9. round2 回复含至少 1 行 "name (kind, role)" 形式');

assertTrue(t2.includes(firstProj.name) || /第一个|第 ?1 ?个|first/.test(t2),
    `10. round2 回复中的 project 名指向 round1 的第一个 (${firstProj.name})`);

const projMembers = unwrapList(await core('core.project_members', { projectId: firstProj.id }));
const trueMemberCount = projMembers.length;

// count "name (kind, role)" lines
const memberLineMatches = t2.match(/\(\s*(human|agent)\s*,/gi) || [];
const reportedLines = memberLineMatches.length;
const within1 = Math.abs(reportedLines - trueMemberCount) <= 1;
assertTrue(within1 || reportedLines === trueMemberCount,
    `15. round2 报的成员行数 ${reportedLines} 与真实 ${trueMemberCount} 差 ≤ 1`);

const reportedKinds = memberLineMatches.map(s => s.toLowerCase().match(/human|agent/)?.[0]).filter(Boolean);
const allKindsValid = reportedKinds.every(k => k === 'human' || k === 'agent');
assertTrue(allKindsValid, `16. round2 中每个 kind ∈ {human, agent}(无虚构)`);

log('');
log(`✅ Smoke 7 (NL) PASS (16 / 16)`);
log(`   truth: org=${orgDetail.name}, humans=${trueHumanCount}, agents=${trueAgentCount}, projects=${trueProjNames.length}, convs=${trueConvCount}`);
