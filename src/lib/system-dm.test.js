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
} from './system-dm.js';

const ORG = '019f6581-bd27-739e-aff1-4dd285e3324b';
const SELF = '019f0000-0000-7000-8000-000000000001';
const PEER = '019f0000-0000-7000-8000-000000000002';
const DM = '01a1fd4a-c051-7aad-84c6-1f966b4f14ee';

function deps(over = {}) {
  const calls = { createDm: [], remember: [], c4Send: [] };
  const d = {
    env: { HOME: '/h', ZYLOS_SESSION_GROUP: 'openmax:group-x', ZYLOS_RUN_ID: 'run-1', COCO_ORG_ID: 'other' },
    resolveOrgId: () => ORG,
    selfMemberId: () => SELF,
    createDm: async (orgId, peer) => { calls.createDm.push([orgId, peer]); return { conversation: { id: DM, type: 'DM' }, created: true }; },
    remember: (...a) => { calls.remember.push(a); },
    c4Send: async (endpoint, message, opts) => {
      calls.c4Send.push({ endpoint, message, env: opts.env });
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
  assert.equal('ZYLOS_RUN_ID' in sent.env, false);
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
  assert.equal(d.env.ZYLOS_SESSION_GROUP, 'openmax:group-x');
  assert.equal(d.env.COCO_ORG_ID, 'other');
});

test('invalid input, no org, or self → refused before any request', async () => {
  for (const [input, code, over] of [
    [{ memberId: 'not-a-uuid', message: 'x' }, 'INVALID_ARGS'],
    [{ memberId: PEER, message: '  \n' }, 'INVALID_ARGS'],
    [{ memberId: PEER, message: 'x' }, 'ORG_REQUIRED', { resolveOrgId: () => '' }],
    [{ memberId: SELF, message: 'x' }, 'SELF_DM'],
  ]) {
    const { d, calls } = deps(over);
    await assert.rejects(sendSystemDm(input, d), { code });
    assert.equal(calls.createDm.length, 0);
    assert.equal(calls.c4Send.length, 0);
  }
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

test('c4-send failure → SEND_FAILED with its output', async () => {
  for (const run of [
    { code: 1, stdout: '[C4] Failed to send message via openmax (exit code: 1)\n', stderr: '{"error":"HTTP 500"}\n' },
    { code: 0, stdout: '{"ok":false,"error":{"code":"X"}}\n', stderr: '' },
  ]) {
    const { d } = deps({ c4Send: async () => run });
    await assert.rejects(sendSystemDm({ memberId: PEER, message: 'x' }, d), (e) => {
      assert.equal(e.code, 'SEND_FAILED');
      assert.equal(e.conversation_id, DM);
      return true;
    });
  }
});

test('dmRecord reads both answer shapes; parseSendResult takes the last JSON object line', () => {
  assert.deepEqual(dmRecord({ conversation: { id: DM, type: 'DM' }, created: false }), { record: { id: DM, type: 'DM' }, created: false });
  assert.deepEqual(dmRecord({ data: { conversation: { id: DM } } }), { record: { id: DM }, created: false });
  assert.equal(dmRecord({ id: 'x' }), null);
  assert.equal(dmRecord(null), null);
  assert.deepEqual(parseSendResult('{"a":1}\n[C4] ok\n{"id":"9"}\n[x]'), { id: '9' });
  assert.equal(parseSendResult('[C4] Message sent via openmax\n'), null);
  assert.deepEqual(systemSendEnv({ A: '1', ZYLOS_SESSION_GROUP: 'g', ZYLOS_RUN_ID: 'r' }, ORG), { A: '1', COCO_ORG_ID: ORG });
});

test('runC4Send passes channel, endpoint and stdin body to the c4-send script with the given env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-system-dm-'));
  const script = path.join(dir, 'c4-send.js');
  fs.writeFileSync(script, `
let body = '';
process.stdin.on('data', (c) => { body += c; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ argv: process.argv.slice(2), body, group: process.env.ZYLOS_SESSION_GROUP ?? null }));
});
`);
  const env = systemSendEnv({ ...process.env, ZYLOS_SESSION_GROUP: 'openmax:group-x' }, ORG);
  const run = await runC4Send(`${DM}|type:dm`, 'line 1\nline 2', { env, script });
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(parseSendResult(run.stdout), { argv: ['openmax', `${DM}|type:dm`], body: 'line 1\nline 2', group: null });
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
