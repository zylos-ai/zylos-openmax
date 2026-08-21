import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildNeedsSelection, buildCandidateLabels, resolveInvokeEntry,
  planAppCreate, planAppUpdate, planAppDelete,
  planActionDefList, planActionDefCreate, planActionDefUpdate, planActionDefDelete,
  runAppImport,
} from './conn.js';

// buildNeedsSelection / buildCandidateLabels / resolveInvokeEntry are pure (no
// network/config), so the three-branch resolution, the connectionId bypass, and
// label disambiguation are unit-testable here. conn.js guards main() behind an
// is-main check so importing it runs nothing. The non-active guard lives in the
// conn.invoke handler, so it is exercised via subprocess (see bottom of file).

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));

// --- buildNeedsSelection: shape + i18n contract -----------------------------

test('buildNeedsSelection 结构：candidates(connection_id/label/display_name/status) + retry_hint', () => {
  const res = buildNeedsSelection('gmail', 'gmail/messages-list', [
    { id: 'c-8f2a', displayName: '工作邮箱', status: 'active' },
    { id: 'c-1b7d', displayName: '个人邮箱', status: 'active' },
  ]);
  assert.equal(res.needs_selection, true);
  assert.equal(res.reason, 'multiple_connections');
  assert.equal(res.app, 'gmail');
  // Deterministic order: neither has createdAt, so the id tiebreak applies —
  // 'c-1b7d' < 'c-8f2a' lexicographically, so it comes first regardless of the
  // input order (see the P2 order-invariance test below).
  assert.deepEqual(res.candidates, [
    { connection_id: 'c-1b7d', label: '个人邮箱', display_name: '个人邮箱', status: 'active' },
    { connection_id: 'c-8f2a', label: '工作邮箱', display_name: '工作邮箱', status: 'active' },
  ]);
  // retry_hint carries BOTH the connectionId placeholder and the same action.
  assert.match(res.retry_hint, /connectionId/);
  assert.match(res.retry_hint, /gmail\/messages-list/);
});

test('buildNeedsSelection: display_name 为空原样透传 null，但 label 仍非空且非 connection_id', () => {
  const res = buildNeedsSelection('gmail', 'a', [{ id: 'c1', name: 'Gmail', status: 'active' }]);
  assert.equal(res.candidates[0].display_name, null);
  assert.ok(res.candidates[0].label && res.candidates[0].label.length > 0);
  assert.notEqual(res.candidates[0].label, 'c1'); // never the raw id
});

test('buildNeedsSelection: agent_instruction 语言中立，不写死中/英用户句', () => {
  const res = buildNeedsSelection('gmail', 'a', [{ id: 'c1', displayName: '工作邮箱', status: 'active' }]);
  const instr = res.agent_instruction;
  // Neutral English guidance that tells the agent to localize into the user's language.
  assert.match(instr, /USER'S language/);
  assert.match(instr, /label/);            // refers to label, not connection_id
  assert.match(instr, /never the connection_id/);
  // Must NOT embed a ready-made user-facing sentence in either language.
  //  - no CJK characters anywhere in the instruction (no hardcoded Chinese)
  assert.doesNotMatch(instr, /[一-鿿]/);
  //  - not a hardcoded English question addressed to the user
  assert.doesNotMatch(instr, /which (account|connection) would you|please choose/i);
  // The whole response object carries no hardcoded Chinese OUTSIDE the pass-through
  // user-supplied values (display_name and the label derived from it).
  const scrubbed = JSON.stringify({
    ...res,
    candidates: res.candidates.map((c) => ({ ...c, display_name: null, label: null })),
  });
  assert.doesNotMatch(scrubbed, /[一-鿿]/);
});

// --- buildCandidateLabels: non-empty + unique in the tie cases (P1-1) --------

test('buildCandidateLabels: 两个都为 null display_name（无 createdAt）→ label 非空且互异，绝不用 connection_id', () => {
  const labels = buildCandidateLabels([
    { id: 'c-8f2a4e91', name: 'Gmail', displayName: null, status: 'active' },
    { id: 'c-1b7d0c33', name: 'Gmail', displayName: '',   status: 'active' },
  ]);
  assert.equal(labels.length, 2);
  labels.forEach((l) => assert.ok(l && l.trim().length > 0));       // non-empty
  assert.notEqual(labels[0], labels[1]);                            // distinct
  assert.ok(!labels.includes('c-8f2a4e91') && !labels.includes('c-1b7d0c33')); // not the id
});

test('buildCandidateLabels: 重复 display_name（无 createdAt）→ 以序号消歧，互异', () => {
  const labels = buildCandidateLabels([
    { id: 'c1', name: 'Gmail', displayName: '工作邮箱', status: 'active' },
    { id: 'c2', name: 'Gmail', displayName: '工作邮箱', status: 'active' },
  ]);
  labels.forEach((l) => assert.ok(l && l.trim().length > 0));
  assert.notEqual(labels[0], labels[1]);
  labels.forEach((l) => assert.match(l, /工作邮箱/)); // built from the shared display_name
});

test('buildCandidateLabels: 重复 display_name 但 createdAt 不同 → 用创建时间消歧，互异', () => {
  const labels = buildCandidateLabels([
    { id: 'c1', name: 'Gmail', displayName: '工作邮箱', createdAt: '2026-01-05T10:00:00Z', status: 'active' },
    { id: 'c2', name: 'Gmail', displayName: '工作邮箱', createdAt: '2026-02-01T08:30:00Z', status: 'active' },
  ]);
  assert.notEqual(labels[0], labels[1]);
  assert.match(labels[0], /2026-01-05/);
  assert.match(labels[1], /2026-02-01/);
});

test('buildCandidateLabels: 空名 + 相同创建日 → 退化到序号，仍互异', () => {
  const labels = buildCandidateLabels([
    { id: 'c1', name: 'Gmail', displayName: null, createdAt: '2026-01-05T10:00:00Z', status: 'active' },
    { id: 'c2', name: 'Gmail', displayName: null, createdAt: '2026-01-05T10:00:00Z', status: 'active' }, // same second
  ]);
  labels.forEach((l) => assert.ok(l && l.trim().length > 0));
  assert.notEqual(labels[0], labels[1]);
});

test('buildNeedsSelection through-labeling: 两个 null display_name → 每个 candidate.label 非空且互异', () => {
  const res = buildNeedsSelection('gmail', 'a', [
    { id: 'c1', name: 'Gmail', displayName: null, status: 'active' },
    { id: 'c2', name: 'Gmail', displayName: null, status: 'active' },
  ]);
  const [a, b] = res.candidates;
  assert.ok(a.label && b.label);
  assert.notEqual(a.label, b.label);
  assert.notEqual(a.label, a.connection_id);
  assert.notEqual(b.label, b.connection_id);
});

// --- P2 negative control: candidate label + position are order-invariant -----
//
// The reviewer's repro: the SAME set of same-app connections, fed in a different
// (server-incidental) order, must produce the SAME label for each connection id
// AND land each id at the SAME candidate position. Otherwise the "(1)/(2)"
// ordinal fallback and the candidates[] order tracked the input order, so the
// label the user just picked could map to a DIFFERENT account on retry.
//
// This test FAILS against the pre-fix index-based ordering (buildNeedsSelection
// used `candidates` as-is): reversing the input reverses positions and swaps the
// ordinals. It passes once candidates are sorted deterministically (created_at
// asc, id tiebreak) at the single assembly point.
test('buildNeedsSelection P2 负例：候选 label 与位置对输入顺序不变（乱序/反序结果一致）', () => {
  // Hard case: two nameless connections with MISSING createdAt (pure ordinal
  // path), two nameless with the SAME-SECOND createdAt (also ordinal path), plus
  // a named + a distinct-time one (the mix).
  const conns = [
    { id: 'c-eee', name: 'Gmail', displayName: '工作邮箱', createdAt: '2026-02-01T08:30:00Z', status: 'active' },
    { id: 'c-ccc', name: 'Gmail', displayName: null,       createdAt: '2026-01-05T10:00:00Z', status: 'active' },
    { id: 'c-ddd', name: 'Gmail', displayName: '',         createdAt: '2026-01-05T10:00:00Z', status: 'active' }, // same second
    { id: 'c-aaa', name: 'Gmail', displayName: null,       status: 'active' },                                    // missing createdAt
    { id: 'c-bbb', name: 'Gmail', displayName: '',         status: 'active' },                                    // missing createdAt
  ];

  const mapsFor = (list) => {
    const res = buildNeedsSelection('gmail', 'gmail/send', list);
    const idToLabel = new Map();
    const idToPos = new Map();
    res.candidates.forEach((c, i) => {
      idToLabel.set(c.connection_id, c.label);
      idToPos.set(c.connection_id, i);
    });
    return { res, idToLabel, idToPos };
  };

  const forward = mapsFor(conns);
  const reversed = mapsFor(conns.slice().reverse());
  const shuffled = mapsFor([conns[3], conns[0], conns[4], conns[2], conns[1]]);

  // Sanity: the ordinal fallback is actually exercised (labels aren't all unique
  // display_names), and every label is non-empty and never the raw id.
  forward.res.candidates.forEach((c) => {
    assert.ok(c.label && c.label.trim().length > 0);
    assert.notEqual(c.label, c.connection_id);
  });
  assert.ok(forward.res.candidates.some((c) => /\(\d+\)$/.test(c.label))); // ordinal path hit

  for (const id of conns.map((c) => c.id)) {
    // (a) same id → same label regardless of input order
    assert.equal(reversed.idToLabel.get(id), forward.idToLabel.get(id), `label for ${id} must be order-invariant`);
    assert.equal(shuffled.idToLabel.get(id), forward.idToLabel.get(id), `label for ${id} must be order-invariant`);
    // (b) same id → same candidate position regardless of input order
    assert.equal(reversed.idToPos.get(id), forward.idToPos.get(id), `position for ${id} must be order-invariant`);
    assert.equal(shuffled.idToPos.get(id), forward.idToPos.get(id), `position for ${id} must be order-invariant`);
  }
});

// --- resolveInvokeEntry: three-branch (0 / 1 / >1) --------------------------

function deps({ index = {}, actives = () => [], any = () => null } = {}) {
  let refreshed = 0;
  return {
    refreshed: () => refreshed,
    findActives: (app) => actives(app),
    findAny: (app) => any(app),
    readEntryById: (id) => index[id] || null,
    refresh: async () => { refreshed += 1; },
  };
}

test('resolveInvokeEntry: 0 active 先刷新，仍 0 → fall back 到 any（null → 调用方 404）', async () => {
  const d = deps({ actives: () => [], any: () => null });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'a' }, d);
  assert.equal(out.entry, null);
  assert.equal(d.refreshed(), 1); // refreshed once on empty
});

test('resolveInvokeEntry: 0 active 但有 needs_reauth → 返回该 entry（让调用方出重授权提示）', async () => {
  const reauth = { id: 'c1', slug: 'gmail', applicationId: 'app-1', status: 'needs_reauth' };
  const d = deps({ actives: () => [], any: () => reauth });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'a' }, d);
  assert.equal(out.entry, reauth);
  assert.equal(out.needsSelection, undefined);
});

test('resolveInvokeEntry: 恰好 1 active（带 applicationId）→ 直接用，不刷新', async () => {
  const e = { id: 'c1', slug: 'gmail', applicationId: 'app-1', status: 'active' };
  const d = deps({ actives: () => [e] });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'a' }, d);
  assert.equal(out.entry, e);
  assert.equal(out.needsSelection, undefined);
  assert.equal(d.refreshed(), 0);
});

test('resolveInvokeEntry: 1 active 但缺 applicationId → 刷新一次补全', async () => {
  const slugOnly = { id: 'c1', slug: 'gmail', applicationId: null, status: 'active' };
  const full = { id: 'c1', slug: 'gmail', applicationId: 'app-1', status: 'active' };
  let calls = 0;
  const d = deps({ actives: () => (calls++ === 0 ? [slugOnly] : [full]) });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'a' }, d);
  assert.equal(out.entry.applicationId, 'app-1');
  assert.equal(d.refreshed(), 1);
});

test('resolveInvokeEntry: >1 active → needs_selection（不静默取第一个）', async () => {
  const actives = [
    { id: 'c1', slug: 'gmail', applicationId: 'app-1', displayName: '工作邮箱', status: 'active' },
    { id: 'c2', slug: 'gmail', applicationId: 'app-1', displayName: '个人邮箱', status: 'active' },
  ];
  const d = deps({ actives: () => actives });
  const out = await resolveInvokeEntry({ app: 'gmail', action: 'gmail/send' }, d);
  assert.equal(out.entry, undefined);
  assert.equal(out.needsSelection.needs_selection, true);
  assert.equal(out.needsSelection.candidates.length, 2);
  assert.match(out.needsSelection.agent_instruction, /USER'S language/);
  // No hardcoded Chinese user-facing sentence in the instruction.
  assert.doesNotMatch(out.needsSelection.agent_instruction, /[一-鿿]/);
});

// --- resolveInvokeEntry: connectionId bypasses app-resolution ---------------

test('resolveInvokeEntry: 给 connectionId → 跳过 app 解析，直用该连接（不看 actives）', async () => {
  const chosen = { id: 'c2', slug: 'gmail', applicationId: 'app-1', displayName: '个人邮箱', status: 'active' };
  let activesCalled = 0;
  const d = deps({
    index: { c2: chosen },
    actives: () => { activesCalled++; return [{ id: 'c1' }, { id: 'c2' }]; },
  });
  const out = await resolveInvokeEntry({ connectionId: 'c2', action: 'a' }, d);
  assert.equal(out.entry, chosen);
  assert.equal(out.needsSelection, undefined);
  assert.equal(activesCalled, 0);   // resolution path never consulted
  assert.equal(d.refreshed(), 0);
});

test('resolveInvokeEntry: connectionId 本地未知 → 刷新一次后仍honored（构造最小 entry）', async () => {
  const store = {};
  let refreshedN = 0;
  const d = {
    findActives: () => { throw new Error('should not resolve by app'); },
    findAny: () => { throw new Error('should not resolve by app'); },
    readEntryById: (id) => store[id] || null,
    refresh: async () => { refreshedN += 1; },
  };
  const out = await resolveInvokeEntry({ connectionId: 'c-unknown', action: 'a' }, d);
  assert.equal(out.entry.id, 'c-unknown');
  assert.equal(out.entry.applicationId, null);
  assert.equal(refreshedN, 1);
});

// --- conn.invoke non-active guard (P1-2): rejected BEFORE credential work ----
//
// Exercised via subprocess (the guard lives in the conn.invoke handler). Each
// case must fail with the guard's actionable 409 error, NOT a
// network/credential error — proving the reject happens before credential
// resolution. COCO_AUTH_TOKEN short-circuits the JWT exchange; COCO_API_URL
// points at an unroutable port so any stray fetch would fail fast (and produce a
// DIFFERENT error the assertions would catch).

function setupHome({ orgId = 'org-1', connections = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-home-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  const connDir = path.join(compDir, 'runtime/connect');
  fs.mkdirSync(connDir, { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: { [orgId]: { enabled: true, org_id: orgId, self: { member_id: 'm-self' } } },
  }));
  fs.writeFileSync(path.join(connDir, `connections-index.${orgId}.json`), JSON.stringify({ connections }));
  return home;
}

function runConn(home, command, params, apiUrl = 'http://127.0.0.1:1') {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: apiUrl,
        COCO_AUTH_TOKEN: 'test-token', // skip JWT exchange
        COCO_RPC_LOG: '0',
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('conn.invoke guard: explicit connectionId → needs_reauth 连接凭证解析前被拒（重授权提示）', async () => {
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'needs_reauth' },
  } });
  const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' });
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 409);
  assert.match(err.error, /re-authorization|重新授权/);
});

test('conn.invoke guard: explicit connectionId → expired 连接被拒（通用可操作错误）', async () => {
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'expired' },
  } });
  const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' });
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 409);
  assert.match(err.error, /not usable \(status: expired\)/);
});

test('conn.invoke guard: explicit connectionId → revoked 连接被拒', async () => {
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'revoked' },
  } });
  const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' });
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 409);
  assert.match(err.error, /not usable \(status: revoked\)/);
});

test('conn.invoke guard (app path): list 返回 error+needs_reauth → 刷新规范化为 needs_reauth 并在凭证前被拒', async () => {
  const home = setupHome({ connections: {} }); // empty → forces a refresh from the list
  const server = createServer((req, res) => {
    if (req.url.includes('/connect/agents/me/connections')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // cws-connect can express reauth-required as status:"error" + needs_reauth:true.
      res.end(JSON.stringify({
        data: [{ id: 'c1', application_id: 'app-1', application_slug: 'gmail', application_name: 'Gmail', status: 'error', needs_reauth: true }],
        request_id: 'r1',
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stderr } = await runConn(home, 'conn.invoke', { app: 'gmail', action: 'gmail/send' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 409);
    assert.match(err.error, /re-authorization|重新授权/); // normalized to needs_reauth, guarded
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- conn.invoke direct-only: non-direct connections are unsupported ---------
//
// Direct-only runtime (proxy deprecated/removed): invoking a connection whose
// acquired credential_mode is not `direct` must fail with an explicit
// "unsupported" error and must NEVER silently fall back to the server-side proxy
// execute endpoint. Exercised via subprocess with a local server that answers the
// credential-acquire with a legacy proxy credential and records every path hit.

test('conn.invoke direct-only: a non-direct (legacy proxy) connection → explicit unsupported error, NEVER a proxy execute call', async () => {
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'active' },
  } });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/connections/c1/credential')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // cws-connect returns a legacy proxy credential (no local access_token).
      res.end(JSON.stringify({ data: { credential_mode: 'proxy', proxy_ref: 'pr-1' }, request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /unsupported/i);
    assert.match(err.error, /not a direct connection|proxy.*deprecated|deprecated\/removed/i);
    // The critical direct-only guarantee: NEVER a silent fall-back to the
    // server-side proxy execute (or proxy) endpoint.
    assert.ok(!seen.some((u) => u.includes('/actions/execute')), `must not call proxy execute: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((u) => u.includes('/proxy')), `must not call the proxy endpoint: ${JSON.stringify(seen)}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('conn.invoke direct-only: a direct connection takes the DIRECT path (local egress), NOT the unsupported-proxy branch', async () => {
  // A direct credential routes into the DIRECT branch, which fetches the local
  // catalog (GET /connect/applications/<appId>/actions) to assemble the request.
  // The catalog-endpoint hit proves the direct path was taken; the proxy branch
  // would instead POST /connections/<id>/actions/execute (never reached). We
  // serve an empty catalog so it stops at "unknown action" — a direct-path
  // outcome, distinctly NOT the unsupported-proxy error.
  const home = setupHome({ connections: {
    c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'active' },
  } });
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes('/connect/connections/c1/credential')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { credential_mode: 'direct', access_token: 'tok' }, request_id: 'r1' }));
      return;
    }
    if (req.url.includes('/connect/applications/app-1/actions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [], request_id: 'r2' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stderr } = await runConn(home, 'conn.invoke', { connectionId: 'c1', action: 'gmail/send' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    // The direct path's own downstream error — NOT the unsupported-proxy branch.
    assert.match(err.error, /unknown action|not in local catalog/);
    assert.doesNotMatch(err.error, /proxy|unsupported/i);
    // Direct path proof: the local catalog was fetched, and the proxy execute
    // endpoint was NEVER called.
    assert.ok(seen.some((u) => u.includes('/connect/applications/app-1/actions')), `direct path must fetch the local catalog: ${JSON.stringify(seen)}`);
    assert.ok(!seen.some((u) => u.includes('/actions/execute')), `direct path must not call proxy execute: ${JSON.stringify(seen)}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- conn.proxy / conn.execute: direct-only tombstones ----------------------
//
// The two proxy verbs are removed (proxy deprecated/removed). They must throw an
// explicit unsupported/deprecated error pointing to conn.invoke — never make a
// proxy/execute network call. COCO_API_URL defaults to an unroutable port, so a
// clean deprecated message also proves no network happened.

for (const command of ['conn.proxy', 'conn.execute']) {
  test(`${command} tombstone: direct-only → 400 unsupported/deprecated, points to conn.invoke`, async () => {
    const home = setupHome({ connections: {
      c1: { id: 'c1', applicationId: 'app-1', slug: 'gmail', name: 'Gmail', status: 'active' },
    } });
    const { code, stderr } = await runConn(home, command, { connectionId: 'c1', action: 'toolkit/act', url: 'https://example.test' });
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /unsupported|deprecated|removed/i);
    assert.match(err.error, /conn\.invoke/);
  });
}

// ============================================================================
//  Custom-connector management: pure request planners
// ============================================================================
//
// planApp* / planActionDef* are pure (no network/config — only apiPath + isUuid),
// so required-param validation, method+path building, and the security invariant
// (org_id / oauth_callback_url never placed in the body) are unit-testable here.

const APP_UUID = '11111111-1111-1111-1111-111111111111';
const ACTION_UUID = '22222222-2222-2222-2222-222222222222';

// --- planAppCreate ----------------------------------------------------------

test('planAppCreate: 缺 slug/display_name/provider_type → 400', () => {
  assert.throws(() => planAppCreate({ display_name: 'X', provider_type: 'api_key' }), (e) => e.status === 400 && /slug/.test(e.message));
  assert.throws(() => planAppCreate({ slug: 'x', provider_type: 'api_key' }), (e) => e.status === 400 && /display_name/.test(e.message));
  assert.throws(() => planAppCreate({ slug: 'x', display_name: 'X' }), (e) => e.status === 400 && /provider_type/.test(e.message));
});

test('planAppCreate: POST /connect/applications，body 走 allowlist 且不含 org_id/oauth_callback_url', () => {
  const plan = planAppCreate({
    slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
    api_key_location: 'header', api_key_header_name: 'X-Api-Key',
    visibility: 'org', credential_source: 'custom', category: 'crm', tags: ['a', 'b'],
    // Forbidden / server-derived — must NOT appear in the body:
    org_id: 'evil-org', oauth_callback_url: 'https://evil/cb',
    // Unknown key — allowlist drops it too:
    bogus: 'nope',
  });
  assert.equal(plan.method, 'POST');
  assert.match(plan.path, /\/connect\/applications$/);
  assert.equal(plan.body.slug, 'acme');
  assert.equal(plan.body.display_name, 'Acme');
  assert.equal(plan.body.provider_type, 'api_key');
  assert.equal(plan.body.api_key_header_name, 'X-Api-Key');
  assert.deepEqual(plan.body.tags, ['a', 'b']);
  assert.equal(plan.body.org_id, undefined);
  assert.equal(plan.body.oauth_callback_url, undefined);
  assert.equal(plan.body.bogus, undefined);
});

// credential_mode is NOT a create field: cws-connect forces `direct` for custom
// connectors server-side (proxy is deprecated), so the CLI must never forward it
// on create — even if the caller passes one. Applies to BOTH custom and managed,
// and to the import path (runAppImport builds its app body via planAppCreate).

test('planAppCreate: custom + caller-sent credential_mode → 不落 body（服务端定夺 direct）', () => {
  const plan = planAppCreate({
    slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
    credential_source: 'custom', credential_mode: 'proxy', // must be dropped
  });
  assert.equal(plan.body.credential_source, 'custom');
  assert.equal(plan.body.credential_mode, undefined);
});

test('planAppCreate: custom 无 credential_mode → 依旧不出现在 body', () => {
  const plan = planAppCreate({
    slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
    credential_source: 'custom',
  });
  assert.equal(plan.body.credential_mode, undefined);
});

test('planAppCreate: managed 也不转发 credential_mode（create 路径统一不接受）', () => {
  const plan = planAppCreate({
    slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
    credential_source: 'managed', credential_mode: 'direct',
  });
  assert.equal(plan.body.credential_source, 'managed');
  assert.equal(plan.body.credential_mode, undefined);
});

test('runAppImport: app body 不转发 credential_mode（走 planAppCreate allowlist）', async () => {
  const appBodies = [];
  await runAppImport(
    {
      application: {
        slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
        credential_source: 'custom', credential_mode: 'proxy',
      },
      actions: [],
    },
    {
      createApp: async (body) => { appBodies.push(body); return { id: APP_UUID }; },
      createActionDef: async () => ({ id: 'a' }),
    },
  );
  assert.equal(appBodies[0].credential_source, 'custom');
  assert.equal(appBodies[0].credential_mode, undefined); // server forces direct on create
});

// --- planAppUpdate ----------------------------------------------------------

test('planAppUpdate: 缺 applicationId / 非 UUID → 400', () => {
  assert.throws(() => planAppUpdate({ display_name: 'X' }), (e) => e.status === 400 && /applicationId is required/.test(e.message));
  assert.throws(() => planAppUpdate({ applicationId: 'not-a-uuid', display_name: 'X' }), (e) => e.status === 400 && /UUID/.test(e.message));
});

test('planAppUpdate: 无可更新字段 → 400', () => {
  assert.throws(() => planAppUpdate({ applicationId: APP_UUID }), (e) => e.status === 400 && /no updatable fields/.test(e.message));
});

test('planAppUpdate: PATCH，忽略 slug/provider_type/org_id/oauth_callback_url', () => {
  const plan = planAppUpdate({
    applicationId: APP_UUID, display_name: 'New', category: 'ops', is_enabled: false,
    slug: 'changed', provider_type: 'oauth2', org_id: 'evil', oauth_callback_url: 'https://evil/cb',
  });
  assert.equal(plan.method, 'PATCH');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}$`));
  assert.equal(plan.body.display_name, 'New');
  assert.equal(plan.body.category, 'ops');
  assert.equal(plan.body.is_enabled, false);
  assert.equal(plan.body.slug, undefined);
  assert.equal(plan.body.provider_type, undefined);
  assert.equal(plan.body.org_id, undefined);
  assert.equal(plan.body.oauth_callback_url, undefined);
});

// --- planAppDelete ----------------------------------------------------------

test('planAppDelete: DELETE /connect/applications/{id}；非 UUID → 400', () => {
  assert.throws(() => planAppDelete({}), (e) => e.status === 400);
  assert.throws(() => planAppDelete({ applicationId: 'x' }), (e) => e.status === 400 && /UUID/.test(e.message));
  const plan = planAppDelete({ applicationId: APP_UUID });
  assert.equal(plan.method, 'DELETE');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}$`));
});

// --- planActionDefList ------------------------------------------------------

test('planActionDefList: GET .../action-defs；缺/非 UUID applicationId → 400', () => {
  assert.throws(() => planActionDefList({}), (e) => e.status === 400);
  assert.throws(() => planActionDefList({ applicationId: 'x' }), (e) => e.status === 400 && /UUID/.test(e.message));
  const plan = planActionDefList({ applicationId: APP_UUID });
  assert.equal(plan.method, 'GET');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}/action-defs$`));
});

// --- planActionDefCreate ----------------------------------------------------

test('planActionDefCreate: 缺 name/method/url_template → 400', () => {
  assert.throws(() => planActionDefCreate({ applicationId: APP_UUID, method: 'GET', url_template: 'u' }), (e) => e.status === 400 && /name/.test(e.message));
  assert.throws(() => planActionDefCreate({ applicationId: APP_UUID, name: 't/a', url_template: 'u' }), (e) => e.status === 400 && /method/.test(e.message));
  assert.throws(() => planActionDefCreate({ applicationId: APP_UUID, name: 't/a', method: 'GET' }), (e) => e.status === 400 && /url_template/.test(e.message));
});

test('planActionDefCreate: POST .../action-defs，body allowlist（含 headers/encoding/input_schema）', () => {
  const plan = planActionDefCreate({
    applicationId: APP_UUID,
    name: 'repos/list', method: 'GET', url_template: '{base_url}/repos',
    headers: { 'X-Trace': '1' }, encoding: 'form',
    input_schema: '{"type":"object","properties":{},"additionalProperties":false}',
    org_id: 'evil', bogus: 'nope',
  });
  assert.equal(plan.method, 'POST');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}/action-defs$`));
  assert.equal(plan.body.name, 'repos/list');
  assert.equal(plan.body.method, 'GET');
  assert.equal(plan.body.url_template, '{base_url}/repos');
  assert.deepEqual(plan.body.headers, { 'X-Trace': '1' });
  assert.equal(plan.body.encoding, 'form');
  assert.ok(plan.body.input_schema.includes('additionalProperties'));
  assert.equal(plan.body.org_id, undefined);
  assert.equal(plan.body.bogus, undefined);
});

test('planActionDefCreate: headers.Authorization 禁止（大小写不敏感）→ 400', () => {
  for (const key of ['Authorization', 'authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN']) {
    assert.throws(
      () => planActionDefCreate({ applicationId: APP_UUID, name: 't/a', method: 'GET', url_template: 'u', headers: { [key]: 'Bearer x' } }),
      (e) => e.status === 400 && /headers\.Authorization is forbidden/.test(e.message),
      `expected rejection for header key ${key}`,
    );
  }
  // A benign header alongside is irrelevant — the Authorization key still trips.
  assert.throws(
    () => planActionDefCreate({ applicationId: APP_UUID, name: 't/a', method: 'GET', url_template: 'u', headers: { 'X-Trace': '1', authorization: 'Bearer x' } }),
    (e) => e.status === 400 && /Authorization is forbidden/.test(e.message),
  );
  // Non-Authorization headers pass through untouched.
  const plan = planActionDefCreate({ applicationId: APP_UUID, name: 't/a', method: 'GET', url_template: 'u', headers: { 'X-Trace': '1' } });
  assert.deepEqual(plan.body.headers, { 'X-Trace': '1' });
});

// --- planActionDefUpdate ----------------------------------------------------

test('planActionDefUpdate: 缺/非 UUID actionId → 400；无字段 → 400', () => {
  assert.throws(() => planActionDefUpdate({ applicationId: APP_UUID, method: 'GET' }), (e) => e.status === 400 && /actionId is required/.test(e.message));
  assert.throws(() => planActionDefUpdate({ applicationId: APP_UUID, actionId: 'x', method: 'GET' }), (e) => e.status === 400 && /UUID/.test(e.message));
  assert.throws(() => planActionDefUpdate({ applicationId: APP_UUID, actionId: ACTION_UUID }), (e) => e.status === 400 && /no updatable fields/.test(e.message));
});

test('planActionDefUpdate: PATCH .../action-defs/{action_id}', () => {
  const plan = planActionDefUpdate({ applicationId: APP_UUID, actionId: ACTION_UUID, method: 'POST', encoding: '' });
  assert.equal(plan.method, 'PATCH');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}/action-defs/${ACTION_UUID}$`));
  assert.equal(plan.body.method, 'POST');
  assert.equal(plan.body.encoding, '');
});

test('planActionDefUpdate: headers.Authorization 禁止（大小写不敏感）→ 400', () => {
  for (const key of ['Authorization', 'authorization', 'AUTHORIZATION']) {
    assert.throws(
      () => planActionDefUpdate({ applicationId: APP_UUID, actionId: ACTION_UUID, headers: { [key]: 'Bearer x' } }),
      (e) => e.status === 400 && /headers\.Authorization is forbidden/.test(e.message),
      `expected rejection for header key ${key}`,
    );
  }
  // headers alone (non-Authorization) is a valid updatable field.
  const plan = planActionDefUpdate({ applicationId: APP_UUID, actionId: ACTION_UUID, headers: { 'X-Trace': '1' } });
  assert.deepEqual(plan.body.headers, { 'X-Trace': '1' });
});

// --- planActionDefDelete ----------------------------------------------------

test('planActionDefDelete: DELETE .../action-defs/{action_id}；两个 id 都需 UUID', () => {
  assert.throws(() => planActionDefDelete({ applicationId: APP_UUID }), (e) => e.status === 400 && /actionId/.test(e.message));
  const plan = planActionDefDelete({ applicationId: APP_UUID, actionId: ACTION_UUID });
  assert.equal(plan.method, 'DELETE');
  assert.match(plan.path, new RegExp(`/connect/applications/${APP_UUID}/action-defs/${ACTION_UUID}$`));
});

// ============================================================================
//  runAppImport: injectable bulk create (app + loop action-defs)
// ============================================================================

test('runAppImport: 缺 application 对象 → 400（无网络）', async () => {
  await assert.rejects(
    () => runAppImport({ actions: [] }, { createApp: async () => { throw new Error('should not call'); }, createActionDef: async () => {} }),
    (e) => e.status === 400 && /application object is required/.test(e.message),
  );
});

test('runAppImport: app body 无效（缺 slug）→ 400 且不发起任何创建', async () => {
  let createAppCalls = 0;
  await assert.rejects(
    () => runAppImport(
      { application: { display_name: 'X', provider_type: 'api_key' }, actions: [] },
      { createApp: async () => { createAppCalls += 1; return { id: APP_UUID }; }, createActionDef: async () => {} },
    ),
    (e) => e.status === 400 && /slug/.test(e.message),
  );
  assert.equal(createAppCalls, 0);
});

test('runAppImport: 成功创建 app 再逐个创建 action-def；org_id/oauth_callback_url 不落入任何 body', async () => {
  const appBodies = [];
  const actionBodies = [];
  const out = await runAppImport(
    {
      application: {
        slug: 'acme', display_name: 'Acme', provider_type: 'api_key',
        org_id: 'evil', oauth_callback_url: 'https://evil/cb',
      },
      actions: [
        { name: 'repos/list', method: 'GET', url_template: '{base_url}/repos', org_id: 'evil' },
        { name: 'repos/get', method: 'GET', url_template: '{base_url}/repos/{id}' },
      ],
    },
    {
      createApp: async (body) => { appBodies.push(body); return { id: APP_UUID, slug: body.slug }; },
      createActionDef: async (appId, body) => { actionBodies.push({ appId, body }); return { id: `${ACTION_UUID}-${actionBodies.length}` }; },
    },
  );
  assert.equal(out.applicationId, APP_UUID);
  assert.equal(out.actions_total, 2);
  assert.equal(out.actions_created, 2);
  assert.equal(out.actions_failed, 0);
  assert.equal(out.results.length, 2);
  assert.ok(out.results.every((r) => r.ok === true));
  // app body scrubbed
  assert.equal(appBodies[0].org_id, undefined);
  assert.equal(appBodies[0].oauth_callback_url, undefined);
  assert.equal(appBodies[0].slug, 'acme');
  // every action-def created under the returned application id, org_id scrubbed
  assert.ok(actionBodies.every((a) => a.appId === APP_UUID));
  assert.equal(actionBodies[0].body.org_id, undefined);
  assert.equal(actionBodies[0].body.name, 'repos/list');
});

test('runAppImport: 某个 action-def 失败 → 部分成功报告（不中断其余）', async () => {
  const out = await runAppImport(
    {
      application: { slug: 'acme', display_name: 'Acme', provider_type: 'api_key' },
      actions: [
        { name: 'ok/one', method: 'GET', url_template: '{base_url}/a' },
        { name: 'bad/two', method: 'GET' }, // missing url_template → local 400, never sent
        { name: 'ok/three', method: 'GET', url_template: '{base_url}/c' },
      ],
    },
    {
      createApp: async () => ({ id: APP_UUID }),
      createActionDef: async (_appId, body) => {
        if (body.name === 'ok/three') { const e = new Error('boom'); e.status = 500; throw e; }
        return { id: 'a-ok' };
      },
    },
  );
  assert.equal(out.actions_total, 3);
  assert.equal(out.actions_created, 1);
  assert.equal(out.actions_failed, 2);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[1].status, 400); // local validation failure (url_template)
  assert.equal(out.results[2].ok, false);
  assert.equal(out.results[2].status, 500); // server failure surfaced
});

test('runAppImport: action-def 带 Authorization 头 → 本地拒绝为该 action 的失败（不创建该行）', async () => {
  const actionBodies = [];
  const out = await runAppImport(
    {
      application: { slug: 'acme', display_name: 'Acme', provider_type: 'api_key' },
      actions: [
        { name: 'ok/one', method: 'GET', url_template: '{base_url}/a' },
        { name: 'bad/auth', method: 'GET', url_template: '{base_url}/b', headers: { Authorization: 'Bearer leaked' } },
        { name: 'bad/auth-lower', method: 'GET', url_template: '{base_url}/c', headers: { authorization: 'Bearer leaked' } },
      ],
    },
    {
      createApp: async () => ({ id: APP_UUID }),
      createActionDef: async (_appId, body) => { actionBodies.push(body); return { id: 'a-ok' }; },
    },
  );
  assert.equal(out.actions_total, 3);
  assert.equal(out.actions_created, 1);
  assert.equal(out.actions_failed, 2);
  assert.equal(out.results[1].ok, false);
  assert.equal(out.results[1].status, 400);
  assert.match(out.results[1].error, /Authorization is forbidden/);
  assert.equal(out.results[2].ok, false);
  assert.equal(out.results[2].status, 400);
  // The offending rows were never sent to createActionDef — only the clean one.
  assert.equal(actionBodies.length, 1);
  assert.equal(actionBodies[0].name, 'ok/one');
});

test('runAppImport: app 创建未返回 id → 502', async () => {
  await assert.rejects(
    () => runAppImport(
      { application: { slug: 'acme', display_name: 'Acme', provider_type: 'api_key' }, actions: [] },
      { createApp: async () => ({}), createActionDef: async () => {} },
    ),
    (e) => e.status === 502,
  );
});

// ============================================================================
//  conn.app_create end-to-end (subprocess): server captures method/path/body
// ============================================================================
//
// Strongest proof that org_id / oauth_callback_url never reach the wire body:
// run the real CLI against a local server and inspect the received request.

test('conn.app_create (subprocess): POST /connect/applications；服务端收到的 body 不含 org_id/oauth_callback_url', async () => {
  const home = setupHome({ orgId: 'org-1' });
  const seen = {};
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url.includes('/connect/applications')) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        seen.method = req.method;
        seen.url = req.url;
        try { seen.body = JSON.parse(body); } catch { seen.body = body; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: APP_UUID, slug: 'acme', source: 'custom' }, request_id: 'r1' }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConn(home, 'conn.app_create', {
      slug: 'acme', display_name: 'Acme', provider_type: 'api_key', category: 'crm',
      // `org` selects the operating org; `org_id`/`oauth_callback_url` are
      // forbidden body fields the allowlist must drop.
      org: 'org-1', org_id: 'evil-org', oauth_callback_url: 'https://evil/cb',
    }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0, `expected success, got: ${stdout}`);
    assert.equal(seen.method, 'POST');
    assert.match(seen.url, /\/connect\/applications$/);
    assert.equal(seen.body.slug, 'acme');
    assert.equal(seen.body.category, 'crm');
    assert.equal(seen.body.org_id, undefined);
    assert.equal(seen.body.oauth_callback_url, undefined);
    assert.equal(seen.body.org, undefined);
    // The returned application item is echoed as the result.
    const out = JSON.parse(stdout);
    assert.equal(out.id, APP_UUID);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
