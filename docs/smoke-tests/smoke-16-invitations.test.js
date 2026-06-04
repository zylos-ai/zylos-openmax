#!/usr/bin/env node
/**
 * Smoke 16 — Invitations(NL 驱动)
 *
 * 见 smoke-16-invitations.md。2 轮 NL + 8 断言。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';
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

const TS = Date.now();
const NS = `Smoke16-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const CORE_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/core.js');
async function core(cmd, p = {}) {
  const { stdout } = await execp('node', [CORE_CLI, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data ?? r;
}

function commonHeaders(token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}
function headers() { return commonHeaders(env.TEST_USER_TOKEN); }

async function listAgentMessagesAfter(seq) {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=50`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return unwrapList(await res.json()).filter(m => {
    const k = (m.sender_type || m.sender_kind || m.type || '').toUpperCase();
    return k.includes('AGENT');
  }).filter(m => Number(m.seq || 0) > seq).sort((a,b) => Number(a.seq) - Number(b.seq));
}
function extractText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (c.body && typeof c.body.text === 'string') return c.body.text;
  return '';
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
        if (matchAny.length === 0 || matchAny.some(p => text.includes(p))) return { msg: m, text };
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

log(`=== Smoke 16 (NL): Invitations ===  ${NS}`);

// ---------- 前置:provision USER3 identity-only ----------
log('[前置] provision USER3');
const USER3_EMAIL = 'gavin-test-004@example.com';
const USER3_PASS  = 'TestPass123!';
const me = await core('core.me');
const ORG_ID = me.org_id || me.orgId;

await fetch(`${env.COCO_API_URL}/auth/register`, {
  method: 'POST', headers: commonHeaders(),
  body: JSON.stringify({ email: USER3_EMAIL, password: USER3_PASS, display_name: 'GavinTest004' }),
});

const lr = await fetch(`${env.COCO_API_URL}/auth/login`, {
  method: 'POST', headers: commonHeaders(),
  body: JSON.stringify({ email: USER3_EMAIL, password: USER3_PASS, token_delivery: 'body' }),
});
const user3Token = ((await lr.json()).data ?? {}).access_token;
if (!user3Token) die('USER3 identity login 失败');
const USER3_SUB = JSON.parse(Buffer.from(user3Token.split('.')[1], 'base64url').toString()).sub;
log(`   USER3 identity sub=${USER3_SUB}`);

let cursor = await currentSeq();

// ---------- Round 1 ----------
log('[Round 1] 发邀请给 USER3');
const NL1 = `我想邀请一个新同事 ${USER3_EMAIL} 加入我们 org 当 org-member,
帮我发一条邀请,附言写 "${NS} 入组测试"。

发完报 invitation id。`;
await sendInstruction(env, NL1);
const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: ['invitation', '邀请', 'id'],
  maxMs: 120 * 1000,
});
cursor = Number(r1.msg.seq);

const uuids1 = r1.text.match(new RegExp(UUID_RE.source, 'gi')) || [];
assertTrue(uuids1.length >= 1, `1. round1 含 invitation id`);
assertTrue(/已发|已邀请|created|发送|sent/i.test(r1.text), `2. round1 含 已发 / created`);

// 旁路:invitation_list 含 USER3
const invList1 = unwrapList(await core('core.invitation_list', { orgId: ORG_ID, limit: 50 }));
const user3Inv = invList1.find(i =>
  ((i.email || '').toLowerCase() === USER3_EMAIL.toLowerCase()) &&
  (i.status || '').toLowerCase() === 'pending'
);
assertTrue(user3Inv && (user3Inv.id || user3Inv.invitation_id),
    `5. invitation_list 含 USER3 邀请 status=pending`);
const invId = user3Inv.id || user3Inv.invitation_id;

// USER3 accept
const acpRes = await fetch(`${env.COCO_API_URL}/api/v1/invitations/${invId}/accept`, {
  method: 'POST', headers: commonHeaders(user3Token), body: JSON.stringify({}),
});
assertTrue(acpRes.ok, `6. USER3 invitation_accept 返 2xx (got ${acpRes.status})`);
log(`   USER3 已 accept invitation ${invId}`);

await new Promise(r => setTimeout(r, 800));
const membersA = unwrapList(await core('core.member_list', { limit: 100 }));
const user3InOrg = membersA.find(m =>
  (m.identity_id === USER3_SUB) ||
  (m.user_id === USER3_SUB) ||
  ((m.email || '').toLowerCase() === USER3_EMAIL.toLowerCase())
);
assertTrue(user3InOrg, `7. core.member_list 现在含 USER3 (identity ${USER3_SUB})`);

// ---------- Round 2 ----------
log('[Round 2] 发错邀请 + 撤回');
const fakeEmail = `smoke16-revoked-${TS}@example.com`;
const NL2 = `顺便测一下撤回流程:再发一条邀请到一个写错的邮箱
"${fakeEmail}",同样 org-member 角色。
发完之后我立马反悔,把这条撤回(invitation_revoke)。

撤回完拉一下 invitation_list,告诉我刚才那条的状态变成什么了。`;
await sendInstruction(env, NL2);
const r2 = await waitForCard({
  label: 'round2', sinceSeq: cursor,
  matchAny: ['撤回', 'revoke', 'cancelled', 'revoked'],
  maxMs: 120 * 1000,
});

assertTrue(/撤回|revoke/i.test(r2.text), `3. round2 含 撤回`);
assertTrue(/revoked|cancelled|canceled|expired|已撤回/i.test(r2.text),
    `4. round2 含 revoked / cancelled / expired`);

// 旁路:list 找那条
const invList2 = unwrapList(await core('core.invitation_list', { orgId: ORG_ID, limit: 100 }));
const fakeInv = invList2.find(i =>
  ((i.email || '').toLowerCase() === fakeEmail.toLowerCase())
);
const fakeStatus = ((fakeInv && (fakeInv.status || fakeInv.state)) || '').toLowerCase();
assertTrue(['revoked', 'cancelled', 'canceled', 'expired'].includes(fakeStatus),
    `8. revoke 后 fake invitation status ∈ {revoked, cancelled, expired} (got "${fakeStatus}")`);

log('');
log(`✅ Smoke 16 (NL) PASS (8 / 8)`);
log(`   USER3 identity=${USER3_SUB}`);
log(`   accepted invitation = ${invId}`);
log(`   revoked invitation (fake email) status = ${fakeStatus}`);
