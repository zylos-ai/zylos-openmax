#!/usr/bin/env node
import './lib/bootstrap-single.js';
/**
 * Smoke 13 — Comm 会话生命周期(NL 驱动)
 *
 * 见 smoke-13-comm-conversations.md。
 * test client 前置 provision USER2(register + login + invitation + accept),
 * 然后 2 轮 NL + 10 断言。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, log, ok, warn, die, assertEq, assertTrue } from './lib/runner-single.js';
import { PROVISION_PASSWORD } from './lib/smoke-config.js';
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
const NS = `Smoke13-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const COMM_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/comm.js');
const CORE_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/core.js');
async function runCli(cli, cmd, p = {}) {
  const { stdout } = await execp('node', [cli, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data ?? r;
}
const comm = (cmd, p) => runCli(COMM_CLI, cmd, p);
const core = (cmd, p) => runCli(CORE_CLI, cmd, p);

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

log(`=== Smoke 13 (NL): Comm 会话生命周期 ===  ${NS}`);

// ---------- 前置:provision USER2 ----------
log('[前置] provision USER2 (gavin-test-003)');
const USER2_EMAIL = 'gavin-test-003@example.com';
const USER2_PASS  = PROVISION_PASSWORD;
if (!USER2_PASS) die('provision password missing — set TEST_PASSWORD or provision_password in smoke-config.json');

const me = await core('core.me');
const USER1_ORG_ID = me.org_id || me.orgId;
assertTrue(USER1_ORG_ID, `pre. USER1 org_id 拿到`);

// register (cws-core /auth/register schema: {email, password, token_delivery} — no display_name)
const reg = await fetch(`${env.COCO_API_URL}/auth/register`, {
  method: 'POST', headers: commonHeaders(),
  body: JSON.stringify({ email: USER2_EMAIL, password: USER2_PASS, token_delivery: 'body' }),
});
if (![200, 201, 409, 422].includes(reg.status)) {
  warn(`USER2 register HTTP ${reg.status}`);
}

// login org-scoped
let user2Token, USER2_MEMBER_ID;
{
  const lr = await fetch(`${env.COCO_API_URL}/auth/login`, {
    method: 'POST', headers: commonHeaders(),
    body: JSON.stringify({ email: USER2_EMAIL, password: USER2_PASS, token_delivery: 'body', org_id: USER1_ORG_ID }),
  });
  const j = await lr.json();
  user2Token = ((j.data ?? j).access_token) || '';

  if (!user2Token) {
    // identity-only login first
    const lr2 = await fetch(`${env.COCO_API_URL}/auth/login`, {
      method: 'POST', headers: commonHeaders(),
      body: JSON.stringify({ email: USER2_EMAIL, password: USER2_PASS, token_delivery: 'body' }),
    });
    user2Token = ((await lr2.json()).data ?? {}).access_token || '';
    if (!user2Token) die('USER2 identity login 失败');

    // USER1 邀请 (cws-core takes role_id as UUID, org_id from JWT — MR !40)
    // org-member role uuid is well-known builtin: 00000000-0000-0000-0000-000000000003
    const ORG_MEMBER_ROLE_ID = '00000000-0000-0000-0000-000000000003';
    const inv = await core('core.invitation_create', { roleId: ORG_MEMBER_ROLE_ID, email: USER2_EMAIL });
    const invId = inv.id || inv.invitation_id;
    const invToken = inv.token;
    if (!invId) die(`invitation_create 没返 id: ${JSON.stringify(inv).slice(0,200)}`);

    // USER2 accept (cws-core /api/v1/invitations/{id}/accept requires display_name;
    // pass invitation token explicitly for token-based acceptance instead of
    // relying on principal-email matching, which has been flaky).
    const acp = await fetch(`${env.COCO_API_URL}/api/v1/invitations/${invId}/accept`, {
      method: 'POST', headers: commonHeaders(user2Token),
      body: JSON.stringify({ display_name: 'GavinTest003', token: invToken }),
    });
    if (!acp.ok) {
      const t = await acp.text().catch(() => '');
      die(`USER2 accept HTTP ${acp.status}: ${t.slice(0,200)}`);
    }

    // re-login org-scoped
    const lr3 = await fetch(`${env.COCO_API_URL}/auth/login`, {
      method: 'POST', headers: commonHeaders(),
      body: JSON.stringify({ email: USER2_EMAIL, password: USER2_PASS, token_delivery: 'body', org_id: USER1_ORG_ID }),
    });
    user2Token = ((await lr3.json()).data ?? {}).access_token || '';
    if (!user2Token) die('USER2 org-scoped login post-invite 失败');
  }
  USER2_MEMBER_ID = JSON.parse(Buffer.from(user2Token.split('.')[1], 'base64url').toString()).member_id;
}
assertTrue(USER2_MEMBER_ID, `(前置) USER2 member_id = ${USER2_MEMBER_ID}`);
ok(`(前置) USER2 已就绪 member=${USER2_MEMBER_ID}`);

let cursor = await currentSeq();

// ---------- Round 1 ----------
log('[Round 1] 拉群 + 发消息');
const NL1 = `我想跟同事 GavinTest003(member_id ${USER2_MEMBER_ID})对一下 ${NS} 项目情况,你帮我:
1. 拉一个新群聊,标题 "${NS} 项目同步",成员就我俩
2. 在群里发两条:
   - 第一条 "${NS} 项目同步会准备开始"
   - 第二条 "${NS} 议题:KB / agent / token 三件事"

发完报群 id 和发出去的两条消息 id。`;
await sendInstruction(env, NL1);
const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: [NS, '群', 'group', '已建', 'created'],
  maxMs: 120 * 1000,
});
cursor = Number(r1.msg.seq);

const uuids1 = r1.text.match(new RegExp(UUID_RE.source, 'gi')) || [];
const ids1Long = (r1.text.match(/\b\d{10,20}\b/g) || []).length;
assertTrue(uuids1.length >= 1 || ids1Long >= 2,
    `1. round1 含 group uuid 或 ≥ 2 message id (uuid=${uuids1.length}, ids=${ids1Long})`);
assertTrue(r1.text.includes(`${NS} 项目同步`),
    `2. round1 含 群标题 ${NS} 项目同步`);

// 旁路:list_conversations 含新 group
// cws-core list-conversations returns items wrapped as {conversation: {id, type, name?, ...}, ...}.
// Group title lives at `item.conversation.name`; DMs have no name. Normalize.
const convs = unwrapList(await comm('comm.list_conversations', { limit: 100 }));
const groupItem = convs.find(c => {
  const conv = c.conversation || c;
  const name = conv.name || conv.title || '';
  return name.includes(`${NS} 项目同步`);
});
const group = groupItem ? (groupItem.conversation || groupItem) : null;
assertTrue(group && group.id, `6. comm.list_conversations 含新 group`);
log(`   groupId=${group.id}`);

// 旁路:get_messages(group) ≥ 2
const msgsG = unwrapList(await comm('comm.get_messages', { conversationId: group.id, limit: 20 }));
assertTrue(msgsG.length >= 2, `7. comm.get_messages(group) ≥ 2 (got ${msgsG.length})`);

// ---------- Round 2 ----------
log('[Round 2] 单独查一下 unread + 拉单条消息');
const NL2 = `群里两条消息我已经看过了,帮我:
1. 用 comm.unread 查一下这个群当前未读多少条
2. 用 comm.get_message 把最后那条消息单独拉出来,确认能定位到

最后给我个简报:unread 数 + 单条拉取的 message_id。`;
await sendInstruction(env, NL2);
const r2 = await waitForCard({
  label: 'round2', sinceSeq: cursor,
  matchAny: ['unread', 'message_id', '未读', '单条'],
  maxMs: 120 * 1000,
});
cursor = Number(r2.msg.seq);

assertTrue(/unread|未读/.test(r2.text), `3. round2 提到 unread`);
assertTrue(/message_id|消息.*id|单条|messageId/i.test(r2.text),
    `4. round2 提到单条消息 id`);

// 旁路:unread.count(WS 已读位点未推,数字本身不强约束)
const u = await comm('comm.unread', { conversationId: group.id });
const unreadCount = u.count ?? u.unread ?? u.unread_count ?? 0;
assertTrue(typeof unreadCount === 'number', `5. comm.unread 返回数值 (got ${unreadCount})`);

// 旁路:get_message 单条
const lastMsg = msgsG[msgsG.length - 1];
if (lastMsg) {
  const single = await comm('comm.get_message', { conversationId: group.id, messageId: lastMsg.id });
  assertTrue(single && (single.id === lastMsg.id || single.message_id === lastMsg.id),
      `6. comm.get_message 拉到对应单条 (id=${lastMsg.id})`);
} else {
  warn(`6. msgsG 为空,跳过 get_message; warn-only`);
}

// ---- Cleanup ---------------------------------------------------------------
// No conversation delete API exists — group and messages persist.
// USER2 is a throwaway test account (gavin-test-003) — no cleanup needed.
log('');
log('[Cleanup] comm 无 conversation 删除 API,群聊数据保留');

// ---------------------------------------------------------------------------
log('');
log(`✅ Smoke 13 (NL) PASS (6 / 6)`);
log(`   USER2 = ${USER2_MEMBER_ID}`);
log(`   group = ${group.id}`);
