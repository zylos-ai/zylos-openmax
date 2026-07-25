import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_DIAGNOSTICS_EVENT,
  DIAGNOSTICS_SEND_PROBE,
  createDiagnosticsHandler,
} from './diagnostics.js';

function commandFrame(overrides = {}) {
  return {
    type: 'system',
    payload: {
      event: AGENT_DIAGNOSTICS_EVENT,
      data: {
        command_id: '019c1234-command',
        action: DIAGNOSTICS_SEND_PROBE,
        conversation_id: 'conv-1',
        probe_token: 'run_case_123',
        expires_at: '2026-07-25T12:00:30Z',
        ...overrides,
      },
    },
  };
}

test('send_probe uses the production message endpoint with fixed content', async () => {
  const calls = [];
  const handle = createDiagnosticsHandler({
    isEnabled: () => true,
    postForOrg: async (...args) => calls.push(args),
    apiPath: path => `/api/v1${path}`,
    now: () => Date.parse('2026-07-25T12:00:00Z'),
  });

  const result = await handle({ slug: 'test', org_id: 'org-1' }, commandFrame());

  assert.deepEqual(result, { accepted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'org-1');
  assert.equal(calls[0][1], '/api/v1/conversations/conv-1/messages');
  assert.equal(calls[0][2].content.body.text, '[workspace-diagnostics:run_case_123]');
  assert.equal(calls[0][2].type, 'AGENT_TEXT');
});

test('diagnostics is disabled by default and cannot carry arbitrary actions or text', async () => {
  let calls = 0;
  const make = enabled => createDiagnosticsHandler({
    isEnabled: () => enabled,
    postForOrg: async () => { calls += 1; },
    apiPath: path => path,
    now: () => Date.parse('2026-07-25T12:00:00Z'),
  });

  assert.equal((await make(false)({ slug: 'test', org_id: 'org-1' }, commandFrame())).reason, 'disabled');
  assert.equal((await make(true)({ slug: 'test', org_id: 'org-1' }, commandFrame({ action: 'diagnostics.http.request' }))).reason, 'unsupported_action');
  assert.equal((await make(true)({ slug: 'test', org_id: 'org-1' }, commandFrame({ probe_token: 'hello world' }))).reason, 'invalid_probe_token');
  assert.equal((await make(true)({ slug: 'test', org_id: 'org-1' }, commandFrame({ conversation_id: 'conv/../../admin' }))).reason, 'invalid_conversation_id');
  assert.equal((await make(true)({ slug: 'test', org_id: 'org-1' }, commandFrame({ conversation_id: 'conv?member=other' }))).reason, 'invalid_conversation_id');
  assert.equal((await make(true)({ slug: 'test', org_id: 'org-1' }, commandFrame({ expires_at: '2026-07-25T11:59:59Z' }))).reason, 'expired');
  assert.equal(calls, 0);
});

test('a command is idempotent and a failed attempt may be retried', async () => {
  let calls = 0;
  const handle = createDiagnosticsHandler({
    isEnabled: () => true,
    postForOrg: async () => { calls += 1; },
    apiPath: path => path,
    now: () => Date.parse('2026-07-25T12:00:00Z'),
  });
  await handle({ slug: 'test', org_id: 'org-1' }, commandFrame());
  const duplicate = await handle({ slug: 'test', org_id: 'org-1' }, commandFrame());
  assert.deepEqual(duplicate, { accepted: true, duplicate: true });
  assert.equal(calls, 1);

  let fail = true;
  const retryable = createDiagnosticsHandler({
    isEnabled: () => true,
    postForOrg: async () => { calls += 1; if (fail) { fail = false; throw new Error('network'); } },
    apiPath: path => path,
    now: () => Date.parse('2026-07-25T12:00:00Z'),
  });
  await assert.rejects(() => retryable({ slug: 'test', org_id: 'org-1' }, commandFrame()), /network/);
  assert.deepEqual(await retryable({ slug: 'test', org_id: 'org-1' }, commandFrame()), { accepted: true });
});
