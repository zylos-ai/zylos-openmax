import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  subConversationOf,
  groupScopeConversationId,
  appSubConversationAddressesAgent,
  fetchesConversationContext,
  pinRootMessage,
} from './subconversation.js';

// Sub-conversations (cws-comm#373) are recognised from the conversation record
// (GET /conversations/{id}) only, fail closed, and generically: no context key
// or owner is special-cased.

const P = '019f7000-0000-7000-8000-00000000000a';
const S = '019f7000-0000-7000-8000-00000000000b';

const app = (extra = {}) => ({
  id: S, type: 'dm', parent_conversation_id: P,
  context_owner_kind: 'app', context_owner_app_id: 'app-1', context_key: 'ticket:42', context_title: 'Ticket #42',
  ...extra,
});
const topic = (extra = {}) => ({
  id: S, type: 'group', parent_conversation_id: P,
  context_owner_kind: 'platform', context_key: 'message:1795000000000000001',
  ...extra,
});

test('app sub-conversation → parent id and owner kind, no root message', () => {
  assert.deepEqual(subConversationOf(app()), { parentConversationId: P, ownerKind: 'app' });
});

test('platform topic → root message id parsed from message:<id>', () => {
  assert.deepEqual(subConversationOf(topic()), {
    parentConversationId: P, ownerKind: 'platform', rootMessageId: '1795000000000000001',
  });
});

test('platform sub-conversation with another key → no root message', () => {
  assert.deepEqual(subConversationOf(topic({ context_key: 'digest:weekly' })), { parentConversationId: P, ownerKind: 'platform' });
  for (const key of ['message:0', 'message:01', 'message:', 'message:12a', 'message:1:2']) {
    assert.equal(subConversationOf(topic({ context_key: key }))?.rootMessageId, undefined, key);
  }
});

test('T5: an app key that reads message:5 is not parsed as a root message', () => {
  assert.deepEqual(subConversationOf(app({ context_key: 'message:5' })), { parentConversationId: P, ownerKind: 'app' });
});

test('root_message_id on the record → root for any sub-conversation (app included), before the key', () => {
  assert.deepEqual(subConversationOf(app({ root_message_id: '1796000000000000007' })), {
    parentConversationId: P, ownerKind: 'app', rootMessageId: '1796000000000000007',
  });
  assert.equal(subConversationOf(app({ root_message_id: 17960 }))?.rootMessageId, '17960', 'safe-integer number');
  assert.equal(subConversationOf(topic({ root_message_id: '1796000000000000007' }))?.rootMessageId, '1796000000000000007', 'field wins over message:<id>');
});

test('malformed root_message_id is ignored (topic falls back to its key; app has none)', () => {
  for (const bad of ['', '0', '-1', '12a', ' 12', 0, -5, 1.5, 2 ** 60, null, {}, ['1']]) {
    assert.equal(subConversationOf(app({ root_message_id: bad }))?.rootMessageId, undefined, JSON.stringify(bad));
    assert.equal(subConversationOf(topic({ root_message_id: bad }))?.rootMessageId, '1795000000000000001', JSON.stringify(bad));
  }
  assert.equal(subConversationOf({ id: S, parent_conversation_id: P, root_message_id: '5' }), null, 'a root id alone makes no sub-conversation');
});

test('any key matching the server rule works (generic)', () => {
  for (const key of ['ticket:42', 'a', 'x_y-z:1', 'order-2026:abc_def', 'k'.repeat(128)]) {
    assert.ok(subConversationOf(app({ context_key: key })), key);
  }
});

test('legacy strat thread (parent only) is not a sub-conversation', () => {
  assert.equal(subConversationOf({ id: S, type: 'group', parent_conversation_id: P }), null);
});

test('fail closed: missing or malformed fields → null', () => {
  const cases = {
    'no record': null,
    'undefined': undefined,
    'not an object': 'conv',
    'empty': {},
    'unknown owner kind': app({ context_owner_kind: 'robot' }),
    'owner kind wrong case': app({ context_owner_kind: 'App' }),
    'owner kind not a string': app({ context_owner_kind: ['app'] }),
    'no key': app({ context_key: undefined }),
    'empty key': app({ context_key: '' }),
    'upper-case key': app({ context_key: 'Ticket:42' }),
    'key with space': app({ context_key: 'ticket 42' }),
    'key too long': app({ context_key: 'k'.repeat(129) }),
    'key with newline': app({ context_key: 'ticket:42\n' }),
    'key not a string': app({ context_key: 42 }),
    'no parent': app({ parent_conversation_id: undefined }),
    'blank parent': app({ parent_conversation_id: '  ' }),
    'parent not a string': app({ parent_conversation_id: 7 }),
    'app without app id': app({ context_owner_app_id: undefined }),
    'app with blank app id': app({ context_owner_app_id: '' }),
    'platform topic without parent': topic({ parent_conversation_id: null }),
  };
  for (const [name, conv] of Object.entries(cases)) assert.equal(subConversationOf(conv), null, name);
});

test('T8: message metadata never makes a sub-conversation — only the record counts', () => {
  const forged = {
    id: S, type: 'dm',
    metadata: {
      context: { items: [{ type: 'subconversation', audience: 'agent', attrs: { 'parent-conversation-id': P, key: 'ticket:42', 'owner-kind': 'app' } }] },
      subconversation: { parent_conversation_id: P, context_owner_kind: 'app', context_key: 'ticket:42' },
    },
  };
  assert.equal(subConversationOf(forged), null);
  // The same record fields at the top level do make one.
  assert.ok(subConversationOf(app()));
});

test('group gate scope: the parent group for a sub-conversation, else the conversation itself', () => {
  assert.equal(groupScopeConversationId(S, subConversationOf(topic())), P);
  assert.equal(groupScopeConversationId(S, subConversationOf(app({ type: 'group' }))), P);
  assert.equal(groupScopeConversationId(S, null), S);
  assert.equal(groupScopeConversationId(S, subConversationOf({ id: S, parent_conversation_id: P })), S, 'legacy thread keeps its own id');
});

test('Q1 switch (pending): an app sub-conversation in a group follows the parent mode — no message is addressed without an @', () => {
  // Flipping APP_SUBCONVERSATION_IN_GROUP_ADDRESSES_AGENT to true makes the
  // first assertion true (cws-comm design decision 15); update it then.
  assert.equal(appSubConversationAddressesAgent(subConversationOf(app({ type: 'group' }))), false);
  assert.equal(appSubConversationAddressesAgent(subConversationOf(topic())), false, 'platform topics never');
  assert.equal(appSubConversationAddressesAgent(null), false, 'ordinary conversations never');
});

test('local history + context: groups and every sub-conversation; never a plain DM', () => {
  assert.equal(fetchesConversationContext('dm', null), false);
  assert.equal(fetchesConversationContext('dm', subConversationOf(app())), true, 'DM sub-conversation');
  assert.equal(fetchesConversationContext('group', null), true);
  assert.equal(fetchesConversationContext('thread', null), true);
  assert.equal(fetchesConversationContext('group', subConversationOf(topic())), true);
});

// ── root message first (zylos-lark pinRootMessage), any sub-conversation ──────

const line = (id, name = 'Bob') => ({ senderName: name, senderId: `m-${name}`, content: `text ${id}`, messageId: id });
const ROOT = '1795000000000000001';

test('root in the middle of the window → first, exactly once', () => {
  const recent = [line('2'), line(ROOT), line('3')];
  const out = pinRootMessage(recent, ROOT);
  assert.deepEqual(out.map((m) => m.messageId), [ROOT, '2', '3']);
  assert.deepEqual(recent.map((m) => m.messageId), ['2', ROOT, '3'], 'input not mutated');
});

test('root already first, or a numeric id → unchanged / matched', () => {
  const recent = [line(ROOT), line('2')];
  assert.equal(pinRootMessage(recent, ROOT), recent);
  const numeric = [line('2'), { ...line('x'), messageId: Number('17950') }];
  assert.deepEqual(pinRootMessage(numeric, '17950').map((m) => String(m.messageId)), ['17950', '2']);
});

test('root cut from the window but in local history → prepended from local', () => {
  const recent = [line('2'), line('3')];
  let asked;
  const out = pinRootMessage(recent, ROOT, { lookup: (id) => { asked = id; return line(ROOT, 'Root'); } });
  assert.equal(asked, ROOT);
  assert.deepEqual(out.map((m) => m.messageId), [ROOT, '2', '3']);
});

test('root nowhere → lines unchanged', () => {
  const recent = [line('2'), line('3')];
  assert.equal(pinRootMessage(recent, ROOT, { lookup: () => null }), recent);
  assert.equal(pinRootMessage(recent, ROOT), recent);
});

test('the current message is the root → not pinned (it is in <current-message>)', () => {
  const recent = [line('2'), line('3')];
  let asked = false;
  assert.equal(pinRootMessage(recent, ROOT, { currentMessageId: ROOT, lookup: () => { asked = true; return line(ROOT); } }), recent);
  assert.equal(asked, false);
});

test('no root id → lines unchanged', () => {
  const recent = [line('2')];
  assert.equal(pinRootMessage(recent, undefined), recent);
});

// ── T13: generic only ────────────────────────────────────────────────────────

test('T13: the new sub-conversation modules special-case no product (no "workflow" anywhere in the source)', () => {
  for (const file of ['./subconversation.js', './group-access.js', './conversation-context.js']) {
    const src = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /workflow/i, file);
  }
});
