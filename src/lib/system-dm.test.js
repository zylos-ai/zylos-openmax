/**
 * System private-chat exit (src/lib/system-dm.js, scripts/system-dm.js).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  sendSystemDm, systemSendEnv, dmRecord, parseSendResult, runC4Send,
  callerConversationId, appendAudit, auditFilePath,
} from './system-dm.js';

const ORG = '019f6581-bd27-739e-aff1-4dd285e3324b';
const SELF = '019f0000-0000-7000-8000-000000000001';
const PEER = '019f0000-0000-7000-8000-000000000002';
const DM = '01a1fd4a-c051-7aad-84c6-1f966b4f14ee';
const CALLER_CONV = '019f65bf-2246-737e-86f4-634781873117';
const OTHER_ORG = '019f0000-0000-7000-8000-0000000000aa';

function deps(over = {}) {
  const calls = { createDm: [], remember: [], c4Send: [], audit: [] };
  const d = {
    env: { HOME: '/h', ZYLOS_SESSION_GROUP: `openmax:group-${CALLER_CONV}`, ZYLOS_RUN_ID: 'run-1', ZYLOS_SYSTEM_SEND: '1', COCO_ORG_ID: ORG },
    resolveOrgId: () => { throw new Error('caller org should decide'); },
    lookupOrg: (conv) => (conv === CALLER_CONV ? ORG : ''),
    audit: (fields) => { calls.audit.push(fields); },
    selfMemberId: () => SELF,
    createDm: async (orgId, peer) => { calls.createDm.push([orgId, peer]); return { conversation: { id: DM, type: 'DM' }, created: true }; },
    remember: (...a) => { calls.remember.push(a); },
    c4Send: async (endpoint, message, opts) => {
      calls.c4Send.push({ endpoint, message, env: opts.env, auditLinesBefore: calls.audit.length });
      return { code: 0, stdout: '[rpc] → POST …\n{"ok":true,"chunks":1,"message_ids":["1790221101000"]}\n[C4] Message sent via openmax\n', stderr: '' };
    },
    ...over,
  };
  return { d, calls };
}

test('resolves the DM, sends via c4-send to <dm>|type:dm without session identity, returns the message id', async () => {
  const { d, calls } = deps();
  const out = await sendSystemDm({ memberId: PEER, message: 'Your report is ready' }, d);
  assert.deepEqual(calls.createDm, [[ORG, PEER]]);
  assert.deepEqual(calls.remember, [[DM, ORG, { type: 'DM' }]]);
  assert.equal(calls.c4Send.length, 1);
  const sent = calls.c4Send[0];
  assert.equal(sent.endpoint, `${DM}|type:dm`);
  assert.equal(sent.message, 'Your report is ready');
  assert.equal('ZYLOS_SESSION_GROUP' in sent.env, false);
  assert.equal('ZYLOS_SYSTEM_SEND' in sent.env, false);
  assert.equal(sent.env.ZYLOS_RUN_ID, 'run-1', 'kept: Core must not fall back to foreground-session.json');
  assert.equal(sent.env.COCO_ORG_ID, ORG);
  assert.equal(sent.env.HOME, '/h');
  assert.deepEqual(out, {
    ok: true, member_id: PEER, conversation_id: DM, created: true, message_id: '1790221101000',
    result: { ok: true, chunks: 1, message_ids: ['1790221101000'] },
  });
});

test('the caller env is not modified', async () => {
  const { d } = deps();
  await sendSystemDm({ memberId: PEER, message: 'x' }, d);
  assert.equal(d.env.ZYLOS_SESSION_GROUP, `openmax:group-${CALLER_CONV}`);
  assert.equal(d.env.ZYLOS_SYSTEM_SEND, '1');
  assert.equal(d.env.COCO_ORG_ID, ORG);
});

test('invalid input, no org, or self → refused before any request', async () => {
  for (const [input, code, over] of [
    [{ memberId: 'not-a-uuid', message: 'x' }, 'INVALID_ARGS'],
    [{ memberId: PEER, message: '  \n' }, 'INVALID_ARGS'],
    [{ memberId: PEER, message: 'x' }, 'ORG_REQUIRED', { resolveOrgId: () => '', lookupOrg: () => '' }],
    [{ memberId: SELF, message: 'x' }, 'SELF_DM'],
    [{ memberId: PEER, message: '[CARD]{"kind":"k","askedOf":"' + PEER + '","title":"t","options":[{"label":"a"},{"label":"b"}]}' }, 'QUESTION_CARD'],
    [{ memberId: PEER, message: '[CARD]{not json' }, 'INVALID_ARGS'],
  ]) {
    const { d, calls } = deps(over);
    await assert.rejects(sendSystemDm(input, d), { code });
    assert.equal(calls.createDm.length, 0);
    assert.equal(calls.c4Send.length, 0);
    assert.equal(calls.audit.length, 0);
  }
});

test('ORG_MISMATCH: COCO_ORG_ID disagrees with the org of the caller\'s OpenMax conversation → refused, nothing sent', async () => {
  const { d, calls } = deps();
  d.env = { ...d.env, COCO_ORG_ID: OTHER_ORG };
  await assert.rejects(sendSystemDm({ memberId: PEER, message: 'x' }, d), { code: 'ORG_MISMATCH' });
  assert.equal(calls.createDm.length, 0);
  assert.equal(calls.c4Send.length, 0);
});

test('org: the caller conversation\'s org is used without COCO_ORG_ID; outside OpenMax the default org', async () => {
  let { d, calls } = deps();
  d.env = { ...d.env }; delete d.env.COCO_ORG_ID;
  await sendSystemDm({ memberId: PEER, message: 'x' }, d);
  assert.deepEqual(calls.createDm, [[ORG, PEER]]);
  assert.equal(calls.c4Send[0].env.COCO_ORG_ID, ORG);

  ({ d, calls } = deps({ resolveOrgId: () => OTHER_ORG }));
  d.env = { HOME: '/h', ZYLOS_SESSION_GROUP: 'lark:chat-1' };
  await sendSystemDm({ memberId: PEER, message: 'x' }, d);
  assert.deepEqual(calls.createDm, [[OTHER_ORG, PEER]]);
});

test('audit: one line before the send (caller, target, conversation) and one after it with the message id', async () => {
  const { d, calls } = deps();
  await sendSystemDm({ memberId: PEER, message: 'secret text' }, d);
  assert.equal(calls.c4Send[0].auditLinesBefore, 1, 'attempt line is written before c4-send runs');
  const [attempt, result] = calls.audit;
  const trail = {
    caller_session_group: `openmax:group-${CALLER_CONV}`, caller_run_id: 'run-1', caller_member_id: SELF,
    caller_conversation_id: CALLER_CONV, target_member_id: PEER, org_id: ORG, conversation_id: DM,
  };
  assert.deepEqual({ ...attempt, audit_id: undefined }, { phase: 'attempt', audit_id: undefined, ...trail });
  assert.match(attempt.audit_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result, { phase: 'result', audit_id: attempt.audit_id, ...trail, outcome: 'sent', message_id: '1790221101000' });
  assert.equal(JSON.stringify(calls.audit).includes('secret text'), false);
});

test('audit file: appendAudit writes JSON lines to the component log (override for tests)', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-system-dm-audit-')), 'logs', 'system-dm-audit.jsonl');
  const now = new Date('2026-11-22T06:00:00Z');
  assert.equal(appendAudit({ phase: 'attempt', caller_session_group: '', target_member_id: PEER, bogus: 1 }, { file, now }), true);
  assert.equal(appendAudit({ phase: 'result', outcome: 'sent', message_id: '9' }, { file, now }), true);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines, [
    { ts: '2026-11-22T06:00:00.000Z', phase: 'attempt', caller_session_group: null, target_member_id: PEER },
    { ts: '2026-11-22T06:00:00.000Z', phase: 'result', outcome: 'sent', message_id: '9' },
  ]);
  assert.equal(auditFilePath({ HOME: '/home/a' }), '/home/a/zylos/components/openmax/logs/system-dm-audit.jsonl');
  assert.equal(auditFilePath({ HOME: '/home/a', OPENMAX_SYSTEM_DM_AUDIT_FILE: '/x.jsonl' }), '/x.jsonl');
});

test('callerConversationId reads only openmax dm/group/sub groups', () => {
  assert.equal(callerConversationId(`openmax:dm-${CALLER_CONV}`), CALLER_CONV);
  assert.equal(callerConversationId(`openmax:sub-${CALLER_CONV}`), CALLER_CONV);
  for (const g of [undefined, '', 'origin', 'lark:chat-1', `openmax:thread-${CALLER_CONV}`, `x:dm-${CALLER_CONV}`]) assert.equal(callerConversationId(g), '');
});

test('DM cannot be resolved → DM_RESOLVE_FAILED, nothing sent', async () => {
  for (const createDm of [
    async () => { throw Object.assign(new Error('HTTP 403'), { status: 403 }); },
    async () => ({ created: false }),
  ]) {
    const { d, calls } = deps({ createDm });
    await assert.rejects(sendSystemDm({ memberId: PEER, message: 'x' }, d), { code: 'DM_RESOLVE_FAILED' });
    assert.equal(calls.c4Send.length, 0);
  }
});

test('c4-send failure → SEND_FAILED with its output, audited as failed', async () => {
  for (const run of [
    { code: 1, stdout: '[C4] Failed to send message via openmax (exit code: 1)\n', stderr: '{"error":"HTTP 500"}\n' },
    { code: 0, stdout: '{"ok":false,"error":{"code":"X"}}\n', stderr: '' },
  ]) {
    const { d, calls } = deps({ c4Send: async () => run });
    await assert.rejects(sendSystemDm({ memberId: PEER, message: 'x' }, d), (e) => {
      assert.equal(e.code, 'SEND_FAILED');
      assert.equal(e.conversation_id, DM);
      return true;
    });
    assert.deepEqual(calls.audit.map((a) => [a.phase, a.outcome, a.error_code]), [['attempt', undefined, undefined], ['result', 'failed', 'SEND_FAILED']]);
  }
});

test('dmRecord reads both answer shapes; parseSendResult takes the last JSON object line', () => {
  assert.deepEqual(dmRecord({ conversation: { id: DM, type: 'DM' }, created: false }), { record: { id: DM, type: 'DM' }, created: false });
  assert.deepEqual(dmRecord({ data: { conversation: { id: DM } } }), { record: { id: DM }, created: false });
  assert.equal(dmRecord({ id: 'x' }), null);
  assert.equal(dmRecord(null), null);
  assert.deepEqual(parseSendResult('{"a":1}\n[C4] ok\n{"id":"9"}\n[x]'), { id: '9' });
  assert.equal(parseSendResult('[C4] Message sent via openmax\n'), null);
  assert.deepEqual(systemSendEnv({ A: '1', ZYLOS_SESSION_GROUP: 'g', ZYLOS_RUN_ID: 'r', ZYLOS_SYSTEM_SEND: '1' }, ORG), { A: '1', ZYLOS_RUN_ID: 'r', COCO_ORG_ID: ORG });
});

test('runC4Send passes channel, endpoint and stdin body to the c4-send script with the given env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-system-dm-'));
  const script = path.join(dir, 'c4-send.js');
  fs.writeFileSync(script, `
let body = '';
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ argv: process.argv.slice(2), body, group: process.env.ZYLOS_SESSION_GROUP ?? null, systemSend: process.env.ZYLOS_SYSTEM_SEND ?? null }));
});
`);
  const env = systemSendEnv({ ...process.env, ZYLOS_SESSION_GROUP: 'openmax:group-x', ZYLOS_SYSTEM_SEND: '1' }, ORG);
  const run = await runC4Send(`${DM}|type:dm`, 'line 1\nline 2', { env, script });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(parseSendResult(run.stdout), { argv: ['openmax', `${DM}|type:dm`], body: 'line 1\nline 2', group: null, systemSend: null });
});

test('scripts/system-dm.js: a bad member id → exit 1, nothing on stdout', () => {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/system-dm.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-system-dm-home-'));
  for (const args of [[], ['nope', 'hi']]) {
    const r = spawnSync(process.execPath, [script, ...args], {
      env: { ...process.env, HOME: home, COCO_API_URL: 'http://127.0.0.1:9', COCO_ORG_ID: '', COCO_RPC_LOG: '0' },
      input: '', encoding: 'utf8', timeout: 10000,
    });
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.length > 0);
  }
});
