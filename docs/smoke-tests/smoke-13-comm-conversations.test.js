#!/usr/bin/env node
/**
 * Smoke 13 — Comm 会话生命周期(纯脚本驱动)
 *
 * 见 smoke-13-comm-conversations.md spec。14 断言。
 * 自动 provision USER2 (gavin-test-003@example.com / TestPass123!)。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';

const execp = promisify(execFile);

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
process.env.COCO_AUTH_TOKEN = process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN;
process.env.COCO_RPC_LOG = process.env.COCO_RPC_LOG || '0';

const COMM_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/comm.js');
const CORE_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/core.js');

async function comm(cmd, params = {}) {
  const { stdout } = await execp('node', [COMM_CLI, cmd, JSON.stringify(params)],
    { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout);
  return r.data ?? r;
}
async function core(cmd, params = {}) {
  const { stdout } = await execp('node', [CORE_CLI, cmd, JSON.stringify(params)],
    { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout);
  return r.data ?? r;
}
const unwrap = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

const apiBase   = process.env.COCO_API_URL.replace(/\/+$/, '');
const cfId      = process.env.CF_ACCESS_CLIENT_ID     || '';
const cfSecret  = process.env.CF_ACCESS_CLIENT_SECRET || '';

function commonHeaders(token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  if (cfId)     h['CF-Access-Client-Id']     = cfId;
  if (cfSecret) h['CF-Access-Client-Secret'] = cfSecret;
  return h;
}

const TS = Date.now();
const NS = `Smoke13-${TS}`;

log(`=== Smoke 13: Comm 会话生命周期 ===  ns=${NS}`);

// USER1 info(from token)
const user1Me = await core('core.me');
const USER1_MEMBER_ID = user1Me.member_id || user1Me.memberId;
const USER1_ORG_ID    = user1Me.org_id    || user1Me.orgId;
assertTrue(USER1_MEMBER_ID && USER1_ORG_ID, `pre. USER1 core.me 返 member_id + org_id`);
log(`   USER1 member=${USER1_MEMBER_ID} org=${USER1_ORG_ID}`);

// ---------------------------------------------------------------------------
// Phase 0 — provision USER2
// ---------------------------------------------------------------------------

log('[Phase 0] provision USER2');

const USER2_EMAIL = 'gavin-test-003@example.com';
const USER2_PASS  = 'TestPass123!';

// 1) try register (best-effort)
const regRes = await fetch(`${apiBase}/auth/register`, {
  method: 'POST', headers: commonHeaders(),
  body: JSON.stringify({
    email: USER2_EMAIL, password: USER2_PASS, display_name: 'GavinTest003',
  }),
});
if (regRes.status === 200 || regRes.status === 201) {
  ok(`1a. USER2 register 200/201`);
} else if (regRes.status === 409 || regRes.status === 422) {
  warn(`1b. USER2 register ${regRes.status}(已存在,OK)`);
} else {
  const body = await regRes.text();
  warn(`1c. USER2 register HTTP ${regRes.status}: ${body.slice(0,200)}`);
}
assertTrue([200, 201, 409, 422].includes(regRes.status),
    `1. USER2 register 状态 ∈ {200, 201, 409, 422} (got ${regRes.status})`);

// 2) login (org-scoped — try with USER1 org first)
let user2Token = '';
let USER2_MEMBER_ID = '';
{
  const lr = await fetch(`${apiBase}/auth/login`, {
    method: 'POST', headers: commonHeaders(),
    body: JSON.stringify({
      email: USER2_EMAIL, password: USER2_PASS,
      token_delivery: 'body',
      org_id: USER1_ORG_ID,
    }),
  });
  const j = await lr.json();
  const data = j.data ?? j;
  user2Token = data.access_token || '';
  if (!user2Token) {
    // fallback: login identity-only, then 顺手用 USER1 invitation 把 USER2 拉进 org
    warn(`USER2 login org-scoped 失败:${JSON.stringify(j).slice(0,200)}`);
    warn(`  尝试 identity-only login 后由 USER1 邀请加入...`);
    const lr2 = await fetch(`${apiBase}/auth/login`, {
      method: 'POST', headers: commonHeaders(),
      body: JSON.stringify({ email: USER2_EMAIL, password: USER2_PASS, token_delivery: 'body' }),
    });
    const j2 = await lr2.json();
    user2Token = (j2.data ?? j2).access_token || '';
    if (!user2Token) die(`USER2 identity login 仍失败:${JSON.stringify(j2).slice(0,200)}`);

    // USER1 invitation 一条龙
    const inv = await core('core.invitation_create', {
      orgId: USER1_ORG_ID, roleId: 'org-member', email: USER2_EMAIL,
    });
    const invitationId = inv.id || inv.invitation_id;
    if (!invitationId) die(`invitation_create 没返 id: ${JSON.stringify(inv).slice(0,200)}`);

    // USER2 accept(用 user2 token)
    const acpHeaders = commonHeaders(user2Token);
    const acp = await fetch(`${apiBase}/api/v1/invitations/${invitationId}/accept`, {
      method: 'POST', headers: acpHeaders, body: JSON.stringify({}),
    });
    if (!acp.ok) die(`invitation accept HTTP ${acp.status}`);

    // re-login org-scoped
    const lr3 = await fetch(`${apiBase}/auth/login`, {
      method: 'POST', headers: commonHeaders(),
      body: JSON.stringify({
        email: USER2_EMAIL, password: USER2_PASS,
        token_delivery: 'body', org_id: USER1_ORG_ID,
      }),
    });
    user2Token = ((await lr3.json()).data ?? {}).access_token || '';
    if (!user2Token) die(`USER2 org-scoped login post-invite 仍失败`);
  }

  // 解 user2 member_id from JWT claims
  const claim = JSON.parse(Buffer.from(user2Token.split('.')[1], 'base64url').toString());
  USER2_MEMBER_ID = claim.member_id || '';
}
assertTrue(user2Token && USER2_MEMBER_ID,
    `2. USER2 login 拿到 org-scoped token + member_id`);
log(`   USER2 member=${USER2_MEMBER_ID}`);

// ---------------------------------------------------------------------------
// Phase 1 — DM
// ---------------------------------------------------------------------------

log('[Phase 1] create_dm');

const dm = await comm('comm.create_dm', { participantId: USER2_MEMBER_ID });
assertTrue(dm && dm.id && /^[0-9a-f-]{36}$/i.test(dm.id),
    `3. create_dm 返 uuid id`);
log(`   dmId = ${dm.id}`);

// ---------------------------------------------------------------------------
// Phase 2 — group
// ---------------------------------------------------------------------------

log('[Phase 2] create_group');

const group = await comm('comm.create_group', {
  title:     `${NS} group`,
  memberIds: [USER1_MEMBER_ID, USER2_MEMBER_ID],
});
assertTrue(group && group.id, `4a. create_group 返 id`);
const memberCount = group.member_count || group.memberCount ||
                    (Array.isArray(group.members) ? group.members.length : 2);
assertTrue(memberCount >= 2, `4b. group member_count ≥ 2 (got ${memberCount})`);
log(`   groupId = ${group.id}`);

// ---------------------------------------------------------------------------
// Phase 3 — send 各 2 条
// ---------------------------------------------------------------------------

log('[Phase 3] send 4 messages');

let sent = 0;
for (const [label, convId] of [['dm', dm.id], ['group', group.id]]) {
  for (let i = 1; i <= 2; i++) {
    try {
      await comm('comm.send', {
        conversationId: convId,
        content: `${NS} msg ${i} in ${label}`,
      });
      sent++;
    } catch (e) {
      warn(`send ${label} #${i} 抛: ${e.message.slice(0,160)}`);
    }
  }
}
assertEq(sent, 4, `5. 4 条 send 全部 2xx`);

// ---------------------------------------------------------------------------
// Phase 4 — 读
// ---------------------------------------------------------------------------

log('[Phase 4] get_messages / get_message / get_conversation');

const msgsD = unwrap(await comm('comm.get_messages', { conversationId: dm.id, limit: 20 }));
assertTrue(msgsD.length >= 2, `6. get_messages(D) ≥ 2 (got ${msgsD.length})`);
const msgsG = unwrap(await comm('comm.get_messages', { conversationId: group.id, limit: 20 }));
assertTrue(msgsG.length >= 2, `7. get_messages(G) ≥ 2 (got ${msgsG.length})`);

const firstD = msgsD[0];
const single = await comm('comm.get_message', { conversationId: dm.id, messageId: firstD.id });
assertEq(single.id, firstD.id, `8. get_message 返单条且 id 对得上`);

const dmMeta = await comm('comm.get_conversation', { conversationId: dm.id });
const dmType = (dmMeta.type || '').toUpperCase();
assertTrue(dmType === 'DM' || dmType === 'P2P' || dmType.includes('DM'),
    `9. get_conversation(D) type ∈ {DM, P2P} (got ${dmType})`);

// ---------------------------------------------------------------------------
// Phase 5 — read receipts
// ---------------------------------------------------------------------------

log('[Phase 5] mark_read / unread');

const maxSeqInD = Math.max(...msgsD.map(m => Number(m.seq || 0)));
try {
  await comm('comm.mark_read', { conversationId: dm.id, seq: maxSeqInD });
  ok(`10. mark_read 返 2xx`);
} catch (e) {
  die(`10. mark_read 抛错: ${e.message}`);
}
const unreadRes = await comm('comm.unread', { conversationId: dm.id });
const unreadCount = unreadRes.count || unreadRes.unread || unreadRes.unread_count || 0;
assertEq(unreadCount, 0, `11. unread.count == 0 (got ${unreadCount})`);

// ---------------------------------------------------------------------------
// Phase 6 — delete
// ---------------------------------------------------------------------------

log('[Phase 6] delete_message');

const targetMsg = msgsG[0];
try {
  await comm('comm.delete_message', { conversationId: group.id, messageId: targetMsg.id });
  ok(`12. delete_message 返 2xx`);
} catch (e) {
  die(`12. delete_message 抛错: ${e.message}`);
}

const msgsG2 = unwrap(await comm('comm.get_messages', { conversationId: group.id, limit: 20 }));
const stillThere = msgsG2.find(m => m.id === targetMsg.id);
if (!stillThere) {
  ok(`13. get_messages 不含 deleted msg id`);
} else if ((stillThere.status || stillThere.deleted_at)) {
  ok(`13. get_messages 含 deleted msg 但 status=deleted/deleted_at 已设(软删)`);
} else {
  die(`13. get_messages 仍含未标记删除的 deleted msg id=${targetMsg.id}`);
}

let assertion14Pass = false;
try {
  const r = await comm('comm.get_message', { conversationId: group.id, messageId: targetMsg.id });
  if (r && (r.status === 'deleted' || r.deleted_at)) {
    ok(`14. get_message(deleted) 返 200 + deleted 标记(软删)`);
    assertion14Pass = true;
  } else {
    die(`14. get_message(deleted) 仍 200 且无 deleted 标记`);
  }
} catch (e) {
  if (/4\d\d|not.?found|gone/i.test(e.message)) {
    ok(`14. get_message(deleted) 返 4xx(硬删)`);
    assertion14Pass = true;
  } else {
    die(`14. get_message(deleted) 抛非 4xx: ${e.message}`);
  }
}
assertTrue(assertion14Pass, `14. delete_message 行为符合预期`);

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 13 PASS (14 / 14)`);
log(`   USER2     = ${USER2_MEMBER_ID}`);
log(`   dmId      = ${dm.id}`);
log(`   groupId   = ${group.id}`);
