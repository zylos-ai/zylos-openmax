import assert from 'node:assert/strict';
import test from 'node:test';

import { threadRootOf, createContextRootFetcher, resolveContextParent } from './context-parent.js';
import { contextHeaderItems, formatContextElements } from './message-context.js';

// Which message a new message inherits metadata.context items from (OPENM-1351
// §4.B / §4.C), with fixtures in the shapes the bridge sees: get-message
// details ({ message: {...}, content, metadata }) and cws-core conversations
// (type DM | GROUP | STRAT, a STRAT's parent conversation in `parent_id`).

const WF = { type: 'workflow', source: 'app:wf', audience: 'agent', attrs: { 'workflow-id': 'wf-1', page: 'run' } };

function detail(id, conversationId, items = []) {
  return {
    message: { id, conversation_id: conversationId, sender_id: 'u-1', type: 'TEXT', content: `text of ${id}` },
    content: { content_type: 'text', body: { text: `text of ${id}` } },
    metadata: items.length ? { context: { items } } : {},
  };
}

// Fake fetchMessageDetail over a { convId: { msgId: detail } } store; counts calls.
function store(data) {
  const calls = [];
  const fetchMessage = async (orgId, convId, msgId) => {
    calls.push(`${convId}/${msgId}`);
    return data[convId]?.[msgId] ?? null;
  };
  return { fetchMessage, calls };
}

const ROOT = detail('root-1', 'grp-1', [WF]);
const NON_ROOT = detail('m-3', 'th-1');

async function resolve({ msg, conv, convType, data, roots, trusted = true }) {
  const s = data.fetchMessage ? data : store(data);
  const r = roots || createContextRootFetcher({ fetchMessage: s.fetchMessage });
  const out = await resolveContextParent({
    orgId: 'org-1', msg, conv, convType: convType ?? String(conv?.type || 'dm').toLowerCase(), trusted, roots: r, fetchMessage: s.fetchMessage,
  });
  return { ...out, calls: s.calls, roots: r, s };
}

test('STRAT thread conversation: inherits from the root in parent_id, not from the replied-to message', async () => {
  const msg = { id: 'm-5', conversation_id: 'th-1', parent_id: 'm-3', parent_message_id: 'root-1' };
  const conv = { id: 'th-1', type: 'STRAT', parent_id: 'grp-1' };
  const r = await resolve({ msg, conv, data: { 'grp-1': { 'root-1': ROOT }, 'th-1': { 'm-3': NON_ROOT } } });
  assert.equal(r.quoted, NON_ROOT); // <replying-to> still shows the message replied to
  assert.equal(r.contextParent, ROOT); // inheritance uses the thread root
  assert.deepEqual(r.calls, ['th-1/m-3', 'grp-1/root-1']); // parent conversation tried first for the root
  const out = formatContextElements(contextHeaderItems({ id: 'm-5' }, { trusted: true, parent: r.contextParent }).items);
  assert.equal(out, '<context type="workflow" source="parent:app:wf" source-verified="true" workflow-id="wf-1" page="run"/>');
});

test('STRAT conversation naming its parent as parent_conversation_id works too; type is case-insensitive', async () => {
  const msg = { id: 'm-5', conversation_id: 'th-1', parent_message_id: 'root-1' };
  const r = await resolve({ msg, conv: { type: 'strat', parent_conversation_id: 'grp-1' }, data: { 'grp-1': { 'root-1': ROOT } } });
  assert.equal(r.contextParent, ROOT);
});

test('frame names the main group (thread_id set): root fetched there, and the <replying-to> fetch is shared', async () => {
  const msg = { id: 'm-5', conversation_id: 'grp-1', thread_id: 'th-1', parent_message_id: 'root-1' };
  const r = await resolve({ msg, conv: { id: 'grp-1', type: 'GROUP' }, data: { 'grp-1': { 'root-1': ROOT } } });
  assert.equal(r.quoted, ROOT);
  assert.equal(r.contextParent, ROOT);
  assert.deepEqual(r.calls, ['grp-1/root-1']); // one fetch for both
});

test('the root is fetched once per thread: later messages hit the cache', async () => {
  const s = store({ 'grp-1': { 'root-1': ROOT }, 'th-1': { 'm-3': NON_ROOT } });
  const roots = createContextRootFetcher({ fetchMessage: s.fetchMessage });
  const conv = { type: 'STRAT', parent_id: 'grp-1' };
  for (const id of ['m-5', 'm-6', 'm-7']) {
    const r = await resolve({ msg: { id, conversation_id: 'th-1', parent_message_id: 'root-1' }, conv, data: s, roots });
    assert.equal(r.contextParent, ROOT);
  }
  assert.deepEqual(s.calls, ['grp-1/root-1']);
});

test('a missing root is negative-cached: one round of fetches, not one per message', async () => {
  const s = store({});
  const roots = createContextRootFetcher({ fetchMessage: s.fetchMessage });
  const conv = { type: 'STRAT', parent_id: 'grp-1' };
  for (const id of ['m-5', 'm-6', 'm-7']) {
    const r = await resolve({ msg: { id, conversation_id: 'th-1', parent_message_id: 'root-1' }, conv, data: s, roots });
    assert.equal(r.contextParent, undefined);
  }
  assert.deepEqual(s.calls, ['grp-1/root-1', 'th-1/root-1']);
});

test('the cache key includes the conversations; a root from another conversation is not taken', async () => {
  const s = store({ 'grp-1': { 'root-1': ROOT }, 'grp-2': { 'root-1': detail('root-1', 'grp-9') } });
  const roots = createContextRootFetcher({ fetchMessage: s.fetchMessage });
  const a = await roots.get('org-1', 'root-1', ['grp-1']);
  const b = await roots.get('org-1', 'root-1', ['grp-2']);
  assert.equal(a, ROOT);
  assert.equal(b, null); // grp-2 returned a message that says it lives in grp-9
  assert.deepEqual(s.calls, ['grp-1/root-1', 'grp-2/root-1']);
});

test('not a thread: a reply inherits from the replied-to message itself', async () => {
  const parent = detail('m-1', 'dm-1', [WF]);
  const r = await resolve({ msg: { id: 'm-2', conversation_id: 'dm-1', parent_id: 'm-1' }, conv: { type: 'DM' }, data: { 'dm-1': { 'm-1': parent } } });
  assert.equal(r.quoted, parent);
  assert.equal(r.contextParent, parent);
  assert.equal(threadRootOf({ id: 'm-2', conversation_id: 'dm-1', parent_id: 'm-1' }, { type: 'DM' }), null);
});

test('#373 reply topic without thread_id: the root comes from the platform subconversation key', async () => {
  const sub = { type: 'subconversation', source: 'platform', audience: 'agent', attrs: { key: 'message:root-1' } };
  const msg = { id: 'm-9', conversation_id: 'sub-1', metadata: { context: { items: [sub] } } };
  const conv = { id: 'sub-1', type: 'GROUP', parent_id: 'grp-1' };
  const r = await resolve({ msg, conv, data: { 'grp-1': { 'root-1': ROOT } } });
  assert.equal(r.contextParent, ROOT);
  // With the switch off the (platform-only) item is not used, so no root is guessed.
  assert.equal(threadRootOf(msg, conv, { trusted: false }), null);
});

test('a legacy "thread" conversation still skips the <replying-to> fetch but inherits from the root', async () => {
  const msg = { id: 'm-5', conversation_id: 'th-1', parent_message_id: 'root-1' };
  const r = await resolve({ msg, conv: { type: 'thread', parent_id: 'grp-1' }, convType: 'thread', data: { 'grp-1': { 'root-1': ROOT } } });
  assert.equal(r.quoted, null);
  assert.equal(r.contextParent, ROOT);
});
