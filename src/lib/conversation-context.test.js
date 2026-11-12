import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// group-history.js writes transcripts under HOME; point it at a throwaway dir
// before importing anything that loads it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-convctx-'));
process.env.HOME = tmpHome;
const { gatherRecentContext, rootMessageFirst, forgetRootMessage, messageDetailToContext } = await import('./conversation-context.js');
const { logAndRecord, ensureReplay, setLimits } = await import('./group-history.js');
const { subConversationOf } = await import('./subconversation.js');

// The context lines for <group-context> / <subconversation-context>: local
// history first, then one GET …/messages page (before_seq = the message's seq,
// limit = context_messages). A platform topic's root goes first, from the
// window or local history, never from an extra request.

let _n = 0;
const idOf = (seq) => `179500000000000${String(seq).padStart(4, '0')}`;
const newConv = () => `019f7000-0000-7000-8000-${String(++_n).padStart(12, '0')}`;

function apiMsg(seq, extra = {}) {
  return {
    id: idOf(seq), seq, sender_id: `m-${seq % 2 ? 'bob' : 'carol'}`,
    sender_display_name: seq % 2 ? 'Bob' : 'Carol', content: { body: { text: `api ${seq}` } }, ...extra,
  };
}

/** fetchRecent mock: answers from `pool` (seq-ascending), newest `limit` below `beforeSeq`; counts calls. */
function mockFetch(pool = []) {
  const calls = [];
  const fn = async (conversationId, beforeSeq, limit) => {
    calls.push({ conversationId, beforeSeq, limit });
    return pool.filter((m) => m.seq < beforeSeq).slice(-limit);
  };
  return { fn, calls };
}

const resolveName = async (id) => `name-of-${id}`;

function record(conv, seq, extra = {}) {
  ensureReplay(conv);
  logAndRecord(conv, {
    timestamp: '2026-11-12T00:00:00.000Z', message_id: idOf(seq), sender_id: 'm-alice',
    sender_name: 'Alice', text: `local ${seq}`, seq, parent_id: null, type: 'text', ...extra,
  });
}

async function gather(conv, { seq, messageId, baseLimit = 5, maxLimit = 15, fetch, parentId } = {}) {
  return gatherRecentContext({
    conversationId: conv, messageId: messageId ?? idOf(seq), seq, parentId,
    baseLimit, maxLimit, fetchRecent: fetch.fn, resolveName,
  });
}

test('T6: API path → one request with before_seq = msg.seq and limit = context_messages; lines oldest first', async () => {
  setLimits(5, 15);
  const conv = newConv();
  const pool = Array.from({ length: 20 }, (_, i) => apiMsg(i + 1));
  const fetch = mockFetch(pool);
  const { recent, source } = await gather(conv, { seq: 21, fetch });
  assert.equal(source, 'api');
  assert.deepEqual(fetch.calls, [{ conversationId: conv, beforeSeq: 21, limit: 5 }]);
  assert.equal(recent.length, 5);
  assert.deepEqual(recent.map((l) => l.content), ['api 16', 'api 17', 'api 18', 'api 19', 'api 20']);
  assert.deepEqual(recent[0], { senderName: 'Carol', senderId: 'm-carol', content: 'api 16', messageId: idOf(16) });
});

test('T6: the line count follows config (context_messages = 3)', async () => {
  setLimits(3, 15);
  const conv = newConv();
  const fetch = mockFetch(Array.from({ length: 10 }, (_, i) => apiMsg(i + 1)));
  const { recent } = await gather(conv, { seq: 11, baseLimit: 3, fetch });
  assert.equal(recent.length, 3);
  assert.deepEqual(fetch.calls.map((c) => c.limit), [3]);
  setLimits(5, 15);
});

test('T10: DM sub-conversation recorded locally → once N entries exist, no request at all', async () => {
  setLimits(5, 15);
  const conv = newConv();   // the DM sub-conversation's own id
  for (let s = 1; s <= 5; s++) record(conv, s);
  record(conv, 6);          // the current message (recorded before the gate)
  const fetch = mockFetch([apiMsg(1)]);
  const { recent, source } = await gather(conv, { seq: 6, fetch });
  assert.equal(source, 'local');
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(recent.map((l) => l.content), ['local 1', 'local 2', 'local 3', 'local 4', 'local 5']);
  assert.equal(recent.some((l) => l.messageId === idOf(6)), false, 'current message left out');
});

test('T10: thin local history (new sub-conversation) → one API page', async () => {
  const conv = newConv();
  record(conv, 1);
  record(conv, 2);
  const fetch = mockFetch([apiMsg(1)]);
  const { source } = await gather(conv, { seq: 2, fetch });
  assert.equal(source, 'api+local');
  assert.equal(fetch.calls.length, 1);
});

test('API failure ([] from fetchRecent) → no lines', async () => {
  const conv = newConv();
  const fetch = mockFetch([]);
  const { recent } = await gather(conv, { seq: 9, fetch });
  assert.deepEqual(recent, []);
});

// ── T4: root first (platform topic shown; any sub-conversation with a root id) ──

const ROOT_SEQ = 3;
const ROOT_ID = idOf(ROOT_SEQ);
const topicSub = subConversationOf({
  type: 'group', parent_conversation_id: '019f7000-0000-7000-8000-0000000000aa',
  context_owner_kind: 'platform', context_key: `message:${ROOT_ID}`,
});

/** The single-message read of the root in the parent: `detail` (a function of the call number allowed), counted. */
function rootFetcher(detail) {
  const calls = [];
  const fn = async (rootId) => {
    calls.push(rootId);
    return typeof detail === 'function' ? detail(calls.length) : detail;
  };
  return { fn, calls };
}

const rootDetail = (extra = {}) => ({
  message: { id: ROOT_ID, sender_id: 'm-dave', type: 'text', seq: 3, ...extra },
  content: { content_type: 'text', body: { text: 'should export ship next week?' }, attachments: [] },
});

test('T4: root in the middle of the API window → first line, once', async () => {
  const conv = newConv();
  const fetch = mockFetch(Array.from({ length: 6 }, (_, i) => apiMsg(i + 1)));
  const { recent } = await gather(conv, { seq: 7, fetch });
  assert.equal(recent[1].messageId, ROOT_ID);
  const root = rootFetcher(rootDetail());
  const out = await rootMessageFirst(recent, { conversationId: conv, rootMessageId: topicSub.rootMessageId, currentMessageId: idOf(7), resolveName, fetchRoot: root.fn });
  assert.equal(out[0].messageId, ROOT_ID);
  assert.equal(out.filter((l) => l.messageId === ROOT_ID).length, 1, 'no duplicate');
  assert.equal(out.length, recent.length);
  assert.equal(fetch.calls.length, 1);
  assert.equal(root.calls.length, 0, 'no root read when it is in the window');
});

test('T4: root cut by the line count but in local history → recovered from local, first', async () => {
  setLimits(5, 15);
  const conv = newConv();
  for (let s = 1; s <= 8; s++) record(conv, s);   // memory keeps up to 2×limit
  const fetch = mockFetch();
  const { recent, source } = await gather(conv, { seq: 9, messageId: idOf(9), fetch });
  assert.equal(source, 'local');
  assert.equal(recent.some((l) => l.messageId === ROOT_ID), false, 'root outside the 5-line window');
  const root = rootFetcher(rootDetail());
  const out = await rootMessageFirst(recent, { conversationId: conv, rootMessageId: ROOT_ID, currentMessageId: idOf(9), resolveName, fetchRoot: root.fn });
  assert.deepEqual(out[0], { senderName: 'Alice', senderId: 'm-alice', content: `local ${ROOT_SEQ}`, messageId: ROOT_ID });
  assert.deepEqual(out.slice(1), recent);
  assert.equal(fetch.calls.length, 0);
  assert.equal(root.calls.length, 0, 'local history first');
});

test('T4: root not in the topic (today: it lives in the parent) → read once from the parent, first line', async () => {
  const conv = newConv();
  const pool = Array.from({ length: 10 }, (_, i) => apiMsg(i + 10));   // root seq 3 not in the topic
  const fetch = mockFetch(pool);
  const a = await gather(conv, { seq: 20, fetch });
  const root = rootFetcher(rootDetail());
  const out = await rootMessageFirst(a.recent, { conversationId: conv, rootMessageId: ROOT_ID, currentMessageId: idOf(20), resolveName, fetchRoot: root.fn });
  assert.deepEqual(root.calls, [ROOT_ID]);
  assert.deepEqual(out[0], { senderName: 'name-of-m-dave', senderId: 'm-dave', content: 'should export ship next week?', messageId: ROOT_ID });
  assert.deepEqual(out.slice(1), a.recent);
  assert.equal(fetch.calls.length, 1, 'the window itself costs the same as without a root');
});

test('T4: the fetched root is cached per sub-conversation → the next message makes no extra request', async () => {
  const conv = newConv();
  const root = rootFetcher(rootDetail());
  const first = await rootMessageFirst([], { conversationId: conv, rootMessageId: ROOT_ID, currentMessageId: idOf(20), resolveName, fetchRoot: root.fn });
  const second = await rootMessageFirst([], { conversationId: conv, rootMessageId: ROOT_ID, currentMessageId: idOf(21), resolveName, fetchRoot: root.fn });
  assert.equal(root.calls.length, 1);
  assert.deepEqual(second, first);
  // Another sub-conversation with the same root reads it for itself.
  await rootMessageFirst([], { conversationId: newConv(), rootMessageId: ROOT_ID, resolveName, fetchRoot: root.fn });
  assert.equal(root.calls.length, 2);
});

test('T4: root read fails → no root line, the rest unchanged, and it is retried next message (not cached)', async () => {
  const conv = newConv();
  const recent = [{ senderName: 'Bob', senderId: 'm-bob', content: 'hi', messageId: idOf(10) }];
  const root = rootFetcher((n) => (n === 1 ? null : rootDetail()));
  const out = await rootMessageFirst(recent, { conversationId: conv, rootMessageId: ROOT_ID, resolveName, fetchRoot: root.fn });
  assert.equal(out, recent);
  const again = await rootMessageFirst(recent, { conversationId: conv, rootMessageId: ROOT_ID, resolveName, fetchRoot: root.fn });
  assert.equal(root.calls.length, 2);
  assert.equal(again[0].messageId, ROOT_ID);
});

test('T4: a recalled or deleted root renders nothing (and is not read again)', async () => {
  for (const gone of [{ recalled_by: 'm-dave' }, { deleted_at: 1795000000000 }]) {
    const conv = newConv();
    const root = rootFetcher(rootDetail(gone));
    const recent = [{ senderName: 'Bob', senderId: 'm-bob', content: 'hi', messageId: idOf(10) }];
    assert.equal(await rootMessageFirst(recent, { conversationId: conv, rootMessageId: ROOT_ID, resolveName, fetchRoot: root.fn }), recent);
    assert.equal(await rootMessageFirst(recent, { conversationId: conv, rootMessageId: ROOT_ID, resolveName, fetchRoot: root.fn }), recent);
    assert.equal(root.calls.length, 1);
  }
});

test('T4: a recall / edit of the root drops its cached line, so it is read again', async () => {
  const conv = newConv();
  const root = rootFetcher((n) => (n === 1 ? rootDetail() : rootDetail({ recalled_by: 'm-dave' })));
  assert.equal((await rootMessageFirst([], { conversationId: conv, rootMessageId: ROOT_ID, resolveName, fetchRoot: root.fn }))[0].messageId, ROOT_ID);
  forgetRootMessage(Number(ROOT_ID.slice(-6)));   // another id: kept
  await rootMessageFirst([], { conversationId: conv, rootMessageId: ROOT_ID, resolveName, fetchRoot: root.fn });
  assert.equal(root.calls.length, 1);
  forgetRootMessage(ROOT_ID);
  assert.deepEqual(await rootMessageFirst([], { conversationId: conv, rootMessageId: ROOT_ID, resolveName, fetchRoot: root.fn }), []);
  assert.equal(root.calls.length, 2);
});

test('root detail as a line: text escaped later by formatContextLine; attachments labelled; empty → none', async () => {
  const withFile = rootDetail();
  withFile.content.attachments = [{ artifact_id: 'a-1', file_name: 'spec.pdf' }];
  assert.equal((await messageDetailToContext(withFile, resolveName)).content, '[file: a-1 | spec.pdf] should export ship next week?');
  const empty = rootDetail();
  empty.content.body.text = '';
  assert.equal(await messageDetailToContext(empty, resolveName), null);
  assert.equal(await messageDetailToContext({ message: { type: 'chat_history', sender_id: 'm-x' } }, resolveName).then((l) => l.content), '[Forwarded conversation]');
});

test('T4: the current message is the root → not pinned', async () => {
  const conv = newConv();
  for (let s = 1; s <= 8; s++) record(conv, s);
  const { recent } = await gather(conv, { seq: ROOT_SEQ, messageId: ROOT_ID, fetch: mockFetch() });
  const root = rootFetcher(rootDetail());
  const out = await rootMessageFirst(recent, { conversationId: conv, rootMessageId: ROOT_ID, currentMessageId: ROOT_ID, resolveName, fetchRoot: root.fn });
  assert.deepEqual(out, recent);
  assert.equal(out.some((l) => l.messageId === ROOT_ID), false);
  assert.equal(root.calls.length, 0);
});

test('T5: app sub-conversation without root_message_id has no root id (its message:<id> key is not parsed) → just the last N lines', () => {
  const sub = subConversationOf({
    type: 'dm', parent_conversation_id: '019f7000-0000-7000-8000-0000000000aa',
    context_owner_kind: 'app', context_owner_app_id: 'app-1', context_key: `message:${ROOT_ID}`,
  });
  assert.equal(sub.rootMessageId, undefined);
});

test('app sub-conversation with root_message_id on its record → same rule: window, then local, then the parent', async () => {
  const sub = subConversationOf({
    type: 'dm', parent_conversation_id: '019f7000-0000-7000-8000-0000000000aa',
    context_owner_kind: 'app', context_owner_app_id: 'app-1', context_key: 'ticket:42', root_message_id: ROOT_ID,
  });
  assert.equal(sub.rootMessageId, ROOT_ID);

  // In the API window → moved first, once.
  const conv = newConv();
  const fetch = mockFetch(Array.from({ length: 6 }, (_, i) => apiMsg(i + 1)));
  const { recent } = await gather(conv, { seq: 7, fetch });
  const out = await rootMessageFirst(recent, { conversationId: conv, rootMessageId: sub.rootMessageId, currentMessageId: idOf(7), resolveName });
  assert.equal(out[0].messageId, ROOT_ID);
  assert.equal(out.filter((l) => l.messageId === ROOT_ID).length, 1);
  assert.equal(fetch.calls.length, 1);

  // Cut from the local window → recovered from local history, no request.
  const conv2 = newConv();
  for (let s = 1; s <= 8; s++) record(conv2, s);
  const fetch2 = mockFetch();
  const local = await gather(conv2, { seq: 9, fetch: fetch2 });
  const out2 = await rootMessageFirst(local.recent, { conversationId: conv2, rootMessageId: sub.rootMessageId, currentMessageId: idOf(9), resolveName });
  assert.equal(out2[0].messageId, ROOT_ID);
  assert.equal(out2.length, local.recent.length + 1);
  assert.equal(fetch2.calls.length, 0);

  // Nowhere local → read from the parent, first line.
  const root = rootFetcher(rootDetail());
  const out3 = await rootMessageFirst([], { conversationId: newConv(), rootMessageId: sub.rootMessageId, resolveName, fetchRoot: root.fn });
  assert.deepEqual(root.calls, [ROOT_ID]);
  assert.equal(out3[0].messageId, ROOT_ID);
});

test('local root line resolves a stored raw id to a name', async () => {
  const conv = newConv();
  record(conv, ROOT_SEQ, { sender_name: 'm-dave', sender_id: 'm-dave' });
  const out = await rootMessageFirst([], { conversationId: conv, rootMessageId: ROOT_ID, resolveName });
  assert.equal(out[0].senderName, 'name-of-m-dave');
});
