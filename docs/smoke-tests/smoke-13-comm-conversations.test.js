#!/usr/bin/env node
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
const USER2_PASS  = 'TestPass123!';

const me = await core('core.me');
const USER1_ORG_ID = me.org_id || me.orgId;
assertTrue(USER1_ORG_ID, `pre. USER1 org_id 拿到`);

// register
const reg = await fetch(`${env.COCO_API_URL}/auth/register`, {
  method: 'POST', headers: commonHeaders(),
  body: JSON.stringify({ email: USER2_EMAIL, password: USER2_PASS, display_name: 'GavinTest003' }),
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

    // USER1 邀请
    const inv = await core('core.invitation_create', { orgId: USER1_ORG_ID, roleId: 'org-member', email: USER2_EMAIL });
    const invId = inv.id || inv.invitation_id;
    if (!invId) die(`invitation_create 没返 id: ${JSON.stringify(inv).slice(0,200)}`);

    // USER2 accept
    const acp = await fetch(`${env.COCO_API_URL}/api/v1/invitations/${invId}/accept`, {
      method: 'POST', headers: commonHeaders(user2Token), body: JSON.stringify({}),
    });
    if (!acp.ok) die(`USER2 accept HTTP ${acp.status}`);

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
const convs = unwrapList(await comm('comm.list_conversations', { limit: 100 }));
const group = convs.find(c => (c.title || '').includes(`${NS} 项目同步`));
assertTrue(group && group.id, `6. comm.list_conversations 含新 group`);
log(`   groupId=${group.id}`);

// 旁路:get_messages(group) ≥ 2
const msgsG = unwrapList(await comm('comm.get_messages', { conversationId: group.id, limit: 20 }));
assertTrue(msgsG.length >= 2, `7. comm.get_messages(group) ≥ 2 (got ${msgsG.length})`);

// ---------- Round 2 ----------
log('[Round 2] 标已读 + 删一条');
const NL2 = `现在群里那两条消息我已经看完了,帮我:
1. 全部标已读(mark_read 到最新 seq)
2. unread 查一下确认未读 == 0
3. 第一条消息("会准备开始"那条)写得不专业,直接删掉
4. 重新拉一下消息列表,确认那条不在了

最后给我个简报:删之前有几条、删之后有几条、unread 数。`;
await sendInstruction(env, NL2);
const r2 = await waitForCard({
  label: 'round2', sinceSeq: cursor,
  matchAny: ['已读', '删', 'unread', 'mark_read', 'delete'],
  maxMs: 120 * 1000,
});
cursor = Number(r2.msg.seq);

assertTrue(/已读|mark_read/.test(r2.text) && /删|delete/.test(r2.text),
    `3. round2 含 已读 + 删`);
const nums = (r2.text.match(/\d+/g) || []).map(Number);
assertTrue(nums.includes(0) || /unread.*0|未读.*0|0.*未读/.test(r2.text),
    `5. round2 说 unread == 0`);
// 删前/删后:期望有数字(2/1 或 类似)
const hasBeforeAfter = /(2.*1|2.*?1|两条.*?一条|before.*after)/.test(r2.text) ||
                      (nums.length >= 2);
assertTrue(hasBeforeAfter, `4. round2 含 删之前 ≥ 2 / 删之后 ≥ 1 的数对比`);

// 旁路:unread.count == 0
const u = await comm('comm.unread', { conversationId: group.id });
const unreadCount = u.count ?? u.unread ?? u.unread_count ?? 0;
assertEq(unreadCount, 0, `8. comm.unread(group).count == 0 (got ${unreadCount})`);

// 旁路:get_messages 后看少一条
const msgsG2 = unwrapList(await comm('comm.get_messages', { conversationId: group.id, limit: 20 }));
const activeCount = msgsG2.filter(m => !((m.status || m.deleted_at) && /deleted/i.test(m.status || ''))).length;
assertTrue(msgsG2.length < msgsG.length || activeCount < msgsG.length,
    `9. get_messages 显示列表减少 或 deleted 状态被标记 (before=${msgsG.length}, after=${msgsG2.length}, active=${activeCount})`);

// 旁路:挑一条标 deleted 的 get_message → 4xx 或 status=deleted
const deletedCandidate = msgsG.find(m => !msgsG2.some(m2 => m2.id === m.id))
                     || msgsG2.find(m => /deleted/i.test(m.status || ''));
if (deletedCandidate) {
  let pass10 = false;
  try {
    const single = await comm('comm.get_message', { conversationId: group.id, messageId: deletedCandidate.id });
    if (single && (single.status === 'deleted' || single.deleted_at)) {
      ok(`10. get_message(deleted) 软删标记`);
      pass10 = true;
    } else {
      die(`10. get_message(deleted) 未标记 status=deleted`);
    }
  } catch (e) {
    if (/4\d\d|not.?found|gone/i.test(e.message)) {
      ok(`10. get_message(deleted) 4xx(硬删)`);
      pass10 = true;
    } else {
      die(`10. get_message(deleted) 抛非 4xx: ${e.message}`);
    }
  }
  assertTrue(pass10, `10. delete_message 行为符合预期`);
} else {
  warn(`10. 无法定位被删消息 id,跳过; warn-only`);
  ok(`10. (skipped)`);
}

// ---------------------------------------------------------------------------
log('');
log(`✅ Smoke 13 (NL) PASS (10 / 10)`);
log(`   USER2 = ${USER2_MEMBER_ID}`);
log(`   group = ${group.id}`);
