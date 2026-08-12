import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleConnectionEvent, acquireCredential, isEventForMe } from './connection-events.js';

// Regression coverage for the 2026-08-04 security fix: cws-core no longer
// accepts a client-supplied agent_member_id, and its
// list-connect-available-connections route moved from
// /connect/agents/{agent_member_id}/connections to /connect/agents/me/connections.
// These tests assert on the ACTUAL calls made — the exact regression a prior
// review round flagged as missing (P2/P3 findings on PR #105 / cws-connect !67).

function tmpDirs() {
  return {
    connectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'connect-idx-')),
    credentialsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'connect-cred-')),
    catalogDir: fs.mkdtempSync(path.join(os.tmpdir(), 'connect-cat-')),
  };
}

function recordingHttp() {
  const calls = [];
  return {
    calls,
    get: async (orgId, urlPath) => { calls.push({ method: 'GET', orgId, path: urlPath }); return { connections: [] }; },
    post: async (orgId, urlPath) => { calls.push({ method: 'POST', orgId, path: urlPath }); return { credential_mode: 'direct', access_token: 'tok' }; },
  };
}

const baseOrgConfig = { slug: 'acme', org_id: 'org-1', self: { member_id: 'agent-self-1' } };

test('acquireCredential: never sends agent_member_id (query param removed by the 2026-08-04 fix)', async () => {
  const calls = [];
  const post = async (orgId, urlPath) => { calls.push({ orgId, path: urlPath }); return {}; };
  await acquireCredential('org-1', 'conn-1', { post });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/v1/connect/connections/conn-1/credential');
  assert.ok(!calls[0].path.includes('agent_member_id'), `path leaked agent_member_id: ${calls[0].path}`);
});

test('isEventForMe: no agent filter → for everyone; matching/mismatching agent_member_id', () => {
  assert.equal(isEventForMe({}, 'agent-1'), true);
  assert.equal(isEventForMe({ agent_member_id: 'agent-1' }, 'agent-1'), true);
  assert.equal(isEventForMe({ agent_member_id: 'agent-2' }, 'agent-1'), false);
  assert.equal(isEventForMe({ agent_member_ids: ['agent-1', 'agent-3'] }, 'agent-1'), true);
  assert.equal(isEventForMe({ agent_member_ids: ['agent-3'] }, 'agent-1'), false);
});

test('connection.authorized (direct mode): acquires credential + warms identity/catalog via the NEW endpoints only', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { calls, get, post } = recordingHttp();

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-1', provider: 'github', credential_mode: 'direct',
  } } };

  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir });

  const paths = calls.map((c) => c.path);
  // The credential acquire must hit the bare path — no agent_member_id query param.
  assert.ok(paths.includes('/api/v1/connect/connections/conn-1/credential'), `missing credential acquire call: ${JSON.stringify(paths)}`);
  // The identity/catalog warm must hit the NEW self-derived path, never the
  // old /connect/agents/{id}/connections shape.
  assert.ok(paths.includes('/api/v1/connect/agents/me/connections'), `missing warm-list call: ${JSON.stringify(paths)}`);
  for (const p of paths) {
    assert.ok(!p.includes('agent_member_id'), `a call leaked agent_member_id: ${p}`);
    assert.ok(!/\/connect\/agents\/[^/]+\/connections/.test(p) || p === '/api/v1/connect/agents/me/connections',
      `a call used the OLD agent-scoped path shape: ${p}`);
  }

  assert.ok(fs.existsSync(path.join(credentialsDir, 'conn-1.json')), 'direct credential was not cached locally');
});

test('connection.authorized (proxy mode): no credential acquire, but still warms identity/catalog via the NEW endpoint', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { calls, get, post } = recordingHttp();

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-2', provider: 'notion', credential_mode: 'proxy',
  } } };

  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir });

  const paths = calls.map((c) => c.path);
  assert.ok(!paths.some((p) => p.includes('/credential')), `proxy mode must never acquire a credential: ${JSON.stringify(paths)}`);
  assert.ok(paths.includes('/api/v1/connect/agents/me/connections'), `missing warm-list call: ${JSON.stringify(paths)}`);
  assert.ok(!fs.existsSync(path.join(credentialsDir, 'conn-2.json')), 'proxy mode must not cache a local credential file');
});

test('connection.credential_updated: re-acquires via the bare path when a cached credential already exists', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, 'conn-3.json'), JSON.stringify({ credential_mode: 'direct', access_token: 'old' }));

  const calls = [];
  const post = async (orgId, urlPath) => { calls.push({ orgId, path: urlPath }); return { credential_mode: 'direct', access_token: 'new' }; };
  const get = async () => { throw new Error('credential_updated must not call GET'); };

  const frame = { payload: { event: 'connection.credential_updated', data: { connection_id: 'conn-3', provider: 'github' } } };
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/v1/connect/connections/conn-3/credential');
  assert.ok(!calls[0].path.includes('agent_member_id'));
});

test('handleConnectionEvent: ignores events not addressed to this agent', async () => {
  const { get, post } = recordingHttp();
  const calls = [];
  const guardedGet = async (...a) => { calls.push(a); return get(...a); };
  const guardedPost = async (...a) => { calls.push(a); return post(...a); };

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-4', provider: 'github', credential_mode: 'direct', agent_member_id: 'someone-else',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, { get: guardedGet, post: guardedPost });
  assert.equal(calls.length, 0, 'an event addressed to a different agent must trigger no HTTP calls at all');
});

test('connection.authorized: notifies the agent session (so it learns it can act via conn.* without running conn.list)', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  const notes = [];
  const notify = (info) => notes.push(info);

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-9', provider: 'gmail', credential_mode: 'proxy',
  } } };
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notify });

  assert.equal(notes.length, 1, 'authorize must notify the agent exactly once');
  assert.equal(notes[0].connectionId, 'conn-9');
  assert.equal(notes[0].provider, 'gmail');
  assert.equal(notes[0].mode, 'proxy');
});

test('only connection.authorized notifies — revoked / disconnected / credential_updated / reauth_needed do NOT', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  const notes = [];
  const notify = (info) => notes.push(info);

  for (const event of [
    'connection.revoked', 'connection.disconnected',
    'connection.credential_updated', 'connection.reauth_needed',
  ]) {
    const frame = { payload: { event, data: { connection_id: 'conn-x', provider: 'gmail' } } };
    await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notify });
  }
  assert.equal(notes.length, 0, 'only connection.authorized should notify the agent session');
});

test('connection.authorized notify is best-effort: a throwing notify never breaks the handler', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const { get, post } = recordingHttp();
  const notify = () => { throw new Error('boom'); };

  const frame = { payload: { event: 'connection.authorized', data: {
    connection_id: 'conn-10', provider: 'gmail', credential_mode: 'proxy',
  } } };
  // Must resolve, not reject, despite the notify throwing.
  await handleConnectionEvent(baseOrgConfig, frame, { get, post, connectDir, credentialsDir, catalogDir, notify });
});
