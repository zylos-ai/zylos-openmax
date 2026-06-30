#!/usr/bin/env node
/**
 * Smoke 15 — 身份 / 角色 / Org Switch(NL 驱动)
 *
 * 见 smoke-15-identity-and-roles.md。1 轮 NL + 8 断言。
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
const NS = `Smoke15-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const CORE_CLI = path.join(os.homedir(), 'zylos/.claude/skills/openmax/src/cli/core.js');
async function core(cmd, p = {}) {
  const { stdout } = await execp('node', [CORE_CLI, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data ?? r;
}

function headers() {
  const h = { Authorization: `Bearer ${env.TEST_USER_TOKEN}`, 'Content-Type': 'application/json' };
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}
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

log(`=== Smoke 15 (NL): 身份 / 角色 / Org Switch ===  ${NS}`);
let cursor = await currentSeq();

const NL1 = `帮我盘一下我的身份和这个组织的角色情况:
1. 我是谁(返 member_id + role + display name + kind)
2. 这组织里有多少 member(列前 3 个的 name + kind),挑一个不是我的 member 去 get 一下,
   把那个 member 的字段告诉我
3. 这个 org 里有哪些角色可以分配(role_list,scope=org)
4. 把活跃 org 切到我当前这个 org(同 org 是 no-op,但需要走通 org_switch),
   切完再 me 一次确认 org_id 还是原来这个

整理成一条结构化简报。`;
await sendInstruction(env, NL1);

const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: ['member', '角色', 'role', 'org_id', 'kind'],
  maxMs: 120 * 1000,
});

const uuids = r1.text.match(new RegExp(UUID_RE.source, 'gi')) || [];
assertTrue(uuids.length >= 1, `1. round1 含 member_id (uuid)`);
assertTrue(/member|成员/.test(r1.text), `2. round1 含 member 列表 / 详情`);
assertTrue(/role|角色/i.test(r1.text), `3. round1 含 role / 角色`);
assertTrue(/切|switch|no-op|不变|相同/i.test(r1.text), `4. round1 含 切 / no-op 语义`);

// 旁路
const me = await core('core.me');
assertTrue((me.member_id || me.memberId) && (me.org_id || me.orgId),
    `5. core.me 返 member_id + org_id`);

const members = unwrapList(await core('core.member_list', { limit: 20 }));
assertTrue(members.length >= 1, `6. core.member_list ≥ 1`);

const roles = unwrapList(await core('core.role_list', { scope: 'org' }));
const slugs = roles.map(r => (r.slug || r.name || r.id || '').toLowerCase());
assertTrue(slugs.some(s => /owner|member|admin/.test(s)),
    `7. role_list 含 owner/member/admin (got ${slugs.slice(0,5).join(',')})`);

const meAfter = await core('core.me');
assertEq(meAfter.org_id || meAfter.orgId, me.org_id || me.orgId,
    `8. 切完后 core.me.org_id 不变`);

// 9. Direct backing call: org_switch must actually 200 with a fresh token
// envelope. Catches the silent-400 regression where the CLI sends no body
// (root-caused 2026-06-04) — that path leaves assertion 8 green because
// org_id "stayed the same" purely because nothing happened server-side.
const switched = await core('core.org_switch', { orgId: me.org_id || me.orgId });
assertTrue(
  (switched.org_id || switched.orgId) === (me.org_id || me.orgId) &&
  typeof (switched.access_token || switched.accessToken) === 'string' &&
  (switched.access_token || switched.accessToken).length > 0,
  `9. core.org_switch 真切:resp.org_id == 入参 + access_token 非空 string`,
);

log('');
log(`✅ Smoke 15 (NL) PASS (9 / 9)`);
log(`   member=${me.member_id || me.memberId} org=${me.org_id || me.orgId}`);
log(`   member_list=${members.length} role_list=${roles.length}`);
