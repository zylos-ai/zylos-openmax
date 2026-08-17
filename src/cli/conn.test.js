import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildNeedsSelection, buildCandidateLabels, resolveInvokeEntry } from './conn.js';

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
  assert.deepEqual(res.candidates, [
    { connection_id: 'c-8f2a', label: '工作邮箱', display_name: '工作邮箱', status: 'active' },
    { connection_id: 'c-1b7d', label: '个人邮箱', display_name: '个人邮箱', status: 'active' },
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
