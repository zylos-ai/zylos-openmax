import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { handleConnectionEvent, acquireCredential, isEventForMe } from './connection-events.js';
import {
  upsertConnection, readIndex, indexPathForOrg, writeCatalog, readCatalog,
} from './connect-store.js';

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

// --- revoke/disconnect: orphaned action-catalog cleanup ---------------------
// The action-catalog is GLOBAL (app-keyed, shared across orgs/connections), so
// revoking a connection must drop the app's catalog ONLY when no remaining
// connection in ANY org still uses that app.

test('connection.revoked (last connection of the app): drops the orphaned catalog + clears index entry & credential', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const idxPath = indexPathForOrg('org-1', connectDir);
  // Seed the local index (application_id lives on the ENTRY, not the revoke event)
  // and a credential + the app's global catalog.
  upsertConnection({ connection_id: 'conn-1', application_id: 'app-1', application_slug: 'notion', status: 'active' }, idxPath);
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, 'conn-1.json'), JSON.stringify({ credential_mode: 'direct', access_token: 'tok' }));
  writeCatalog('app-1', [{ action: 'notion-pages/create' }], { dir: catalogDir });

  // Revoke event deliberately carries NO application_id → resolution must come
  // from the local index entry captured before removeConnection.
  const frame = { payload: { event: 'connection.revoked', data: { connection_id: 'conn-1' } } };
  await handleConnectionEvent(baseOrgConfig, frame, { connectDir, credentialsDir, catalogDir });

  assert.equal(readIndex(idxPath).connections['conn-1'], undefined, 'index entry must be removed');
  assert.ok(!fs.existsSync(path.join(credentialsDir, 'conn-1.json')), 'credential cache must be cleared');
  assert.equal(readCatalog('app-1', { dir: catalogDir }), null, 'orphaned catalog must be dropped');
});

test('connection.revoked (another connection of the SAME app remains in a DIFFERENT org): keeps the shared catalog', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const idxOrg1 = indexPathForOrg('org-1', connectDir);
  const idxOrg2 = indexPathForOrg('org-2', connectDir);
  // Same app (app-1) connected in two orgs. Revoke org-1's connection.
  upsertConnection({ connection_id: 'conn-A', application_id: 'app-1', application_slug: 'notion', status: 'active' }, idxOrg1);
  upsertConnection({ connection_id: 'conn-B', application_id: 'app-1', application_slug: 'notion', status: 'active' }, idxOrg2);
  writeCatalog('app-1', [{ action: 'notion-pages/create' }], { dir: catalogDir });

  const frame = { payload: { event: 'connection.disconnected', data: { connection_id: 'conn-A' } } };
  await handleConnectionEvent(baseOrgConfig, frame, { connectDir, credentialsDir, catalogDir });

  assert.equal(readIndex(idxOrg1).connections['conn-A'], undefined, 'revoked connection must be unindexed');
  assert.ok(readIndex(idxOrg2).connections['conn-B'], 'the other org’s connection must remain');
  assert.ok(readCatalog('app-1', { dir: catalogDir }), 'catalog must be KEPT while another org still uses the app');
});

test('connection.revoked (application_id unresolvable): no crash, catalog untouched, index/credential still cleared', async () => {
  const { connectDir, credentialsDir, catalogDir } = tmpDirs();
  const idxPath = indexPathForOrg('org-1', connectDir);
  // Index entry has NO applicationId (sparse event source) and the revoke event
  // carries none either → app cannot be resolved.
  upsertConnection({ connection_id: 'conn-x', provider: 'notion', status: 'active' }, idxPath);
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.writeFileSync(path.join(credentialsDir, 'conn-x.json'), JSON.stringify({ credential_mode: 'direct', access_token: 'tok' }));
  // An unrelated catalog that must remain untouched.
  writeCatalog('app-unrelated', [{ action: 'a' }], { dir: catalogDir });

  const warns = [];
  const frame = { payload: { event: 'connection.revoked', data: { connection_id: 'conn-x' } } };
  await assert.doesNotReject(
    handleConnectionEvent(baseOrgConfig, frame, { warn: (m) => warns.push(m), connectDir, credentialsDir, catalogDir }),
  );

  assert.equal(readIndex(idxPath).connections['conn-x'], undefined, 'index entry must still be removed');
  assert.ok(!fs.existsSync(path.join(credentialsDir, 'conn-x.json')), 'credential cache must still be cleared');
  assert.ok(readCatalog('app-unrelated', { dir: catalogDir }), 'no catalog may be dropped when the app is unresolvable');
  assert.ok(warns.some((m) => /application_id unresolved/.test(m)), 'should warn about the skipped catalog cleanup');
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
