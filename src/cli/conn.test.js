import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildNeedsSelection, resolveInvokeEntry } from './conn.js';

// buildNeedsSelection / resolveInvokeEntry are pure (no network/config), so the
// three-branch resolution and the connectionId bypass are unit-testable here.
// conn.js guards main() behind an is-main check so importing it runs nothing.

// --- buildNeedsSelection: shape + i18n contract -----------------------------

test('buildNeedsSelection 结构：candidates(connection_id/display_name/status) + retry_hint', () => {
  const res = buildNeedsSelection('gmail', 'gmail/messages-list', [
    { id: 'c-8f2a', displayName: '工作邮箱', status: 'active' },
    { id: 'c-1b7d', displayName: '个人邮箱', status: 'active' },
  ]);
  assert.equal(res.needs_selection, true);
  assert.equal(res.reason, 'multiple_connections');
  assert.equal(res.app, 'gmail');
  assert.deepEqual(res.candidates, [
    { connection_id: 'c-8f2a', display_name: '工作邮箱', status: 'active' },
    { connection_id: 'c-1b7d', display_name: '个人邮箱', status: 'active' },
  ]);
  // retry_hint carries BOTH the connectionId placeholder and the same action.
  assert.match(res.retry_hint, /connectionId/);
  assert.match(res.retry_hint, /gmail\/messages-list/);
});

test('buildNeedsSelection: display_name 为空原样透传 null（消歧不依赖非空）', () => {
  const res = buildNeedsSelection('gmail', 'a', [{ id: 'c1', status: 'active' }]);
  assert.equal(res.candidates[0].display_name, null);
});

test('buildNeedsSelection: agent_instruction 语言中立，不写死中/英用户句', () => {
  const res = buildNeedsSelection('gmail', 'a', [{ id: 'c1', displayName: '工作邮箱', status: 'active' }]);
  const instr = res.agent_instruction;
  // Neutral English guidance that tells the agent to localize into the user's language.
  assert.match(instr, /USER'S language/);
  assert.match(instr, /display_name/);
  // Must NOT embed a ready-made user-facing sentence in either language.
  //  - no CJK characters anywhere in the instruction (no hardcoded Chinese)
  assert.doesNotMatch(instr, /[一-鿿]/);
  //  - not a hardcoded English question addressed to the user
  assert.doesNotMatch(instr, /which (account|connection) would you|please choose/i);
  // The whole response object likewise carries no hardcoded Chinese user句
  // outside of the pass-through display_name values.
  const withoutDisplayNames = JSON.stringify({ ...res, candidates: res.candidates.map((c) => ({ ...c, display_name: null })) });
  assert.doesNotMatch(withoutDisplayNames, /[一-鿿]/);
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
