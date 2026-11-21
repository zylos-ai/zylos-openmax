import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// group-history.js writes transcripts under HOME; point it at a throwaway dir
// before importing anything that loads it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-convctx-'));
process.env.HOME = tmpHome;
const { gatherRecentContext, recordSentMessage, historyEntryOf } = await import('./conversation-context.js');
const { logAndRecord, ensureReplay, setLimits, getHistory } = await import('./group-history.js');

// The context lines for <group-context> / <subconversation-context>: local
// history first, then one GET …/messages page (before_seq = the message's seq,
// limit = context_messages).

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

test('API path → one request with before_seq = msg.seq and limit = context_messages; lines oldest first', async () => {
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

test('the line count follows config (context_messages = 3)', async () => {
  setLimits(3, 15);
  const conv = newConv();
  const fetch = mockFetch(Array.from({ length: 10 }, (_, i) => apiMsg(i + 1)));
  const { recent } = await gather(conv, { seq: 11, baseLimit: 3, fetch });
  assert.equal(recent.length, 3);
  assert.deepEqual(fetch.calls.map((c) => c.limit), [3]);
  setLimits(5, 15);
});

test('DM sub-conversation recorded locally → once N entries exist, no request at all', async () => {
  setLimits(5, 15);
  const conv = newConv();   // the DM sub-conversation's own id
  for (let s = 1; s <= 5; s++) record(conv, s);
  record(conv, 6);          // the current message (recorded before the gate)
  const fetch = mockFetch([apiMsg(1)]);
  const { recent, source } = await gather(conv, { seq: 6, fetch });
  assert.equal(source, 'local');
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(recent.map((l) => l.content), ['local 1', 'local 2', 'local 3', 'local 4', 'local 5']);
  assert.equal(recent.some((l) => l.content === 'local 6'), false, 'current message left out');
});

test('thin local history (new sub-conversation) → one API page', async () => {
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

test('sub-conversation lines are just the recent N, oldest first: no reordering, no extra request', async () => {
  // A message early in the conversation stays where it is; nothing is read
  // beyond the one window page.
  const conv = newConv();
  const fetch = mockFetch(Array.from({ length: 6 }, (_, i) => apiMsg(i + 1)));
  const { recent } = await gather(conv, { seq: 7, fetch });
  assert.deepEqual(recent.map((l) => l.content), ['api 2', 'api 3', 'api 4', 'api 5', 'api 6']);
  assert.equal(fetch.calls.length, 1);
});

test('a local entry stored with a raw id as its name gets a resolved name', async () => {
  setLimits(5, 15);
  const conv = newConv();
  for (let s = 1; s <= 5; s++) record(conv, s, { sender_name: 'm-dave', sender_id: 'm-dave' });
  record(conv, 6);
  const { recent } = await gather(conv, { seq: 6, fetch: mockFetch() });
  assert.equal(recent[0].senderName, 'name-of-m-dave');
});

// ── the Agent's own replies (cws-comm does not echo them back) ───────────

/** The get-message response for a reply this Agent sent. */
function sentDetail(seq, text = `agent ${seq}`) {
  return {
    message: { id: idOf(seq), seq, sender_id: 'm-agent', type: 'agent_text', content: text },
    content: { content_type: 'text', body: { text }, attachments: [] },
  };
}

async function recordSent(conv, seq, { detail = sentDetail(seq), calls = [] } = {}) {
  return recordSentMessage({
    conversationId: conv, messageId: idOf(seq),
    fetchDetail: async () => { calls.push(seq); return detail; },
    resolveName: async (id) => (id === 'm-agent' ? 'Nova' : null),
  });
}

test('local history: the Agent\'s own latest reply is in the next message\'s context', async () => {
  setLimits(5, 15);
  const conv = newConv();
  for (let s = 1; s <= 5; s++) record(conv, s);
  assert.equal(await recordSent(conv, 6), true);   // the Agent answered message 5
  record(conv, 7);                                  // the next inbound message
  const { recent, source } = await gather(conv, { seq: 7, fetch: mockFetch() });
  assert.equal(source, 'local');
  assert.deepEqual(recent.map((l) => l.content), ['local 2', 'local 3', 'local 4', 'local 5', 'agent 6']);
  assert.deepEqual(recent.at(-1), { senderName: 'Nova', senderId: 'm-agent', content: 'agent 6', messageId: idOf(6) });
});

test('a reply recorded after the next inbound message still sorts by seq', async () => {
  setLimits(5, 15);
  const conv = newConv();
  for (let s = 1; s <= 5; s++) record(conv, s);
  record(conv, 7);
  await recordSent(conv, 6);
  record(conv, 8);
  const { recent } = await gather(conv, { seq: 8, fetch: mockFetch() });
  assert.deepEqual(recent.map((l) => l.content), ['local 3', 'local 4', 'local 5', 'agent 6', 'local 7']);
});

test('no local history kept for the conversation (plain DM) → nothing fetched, nothing recorded', async () => {
  const conv = newConv();
  const calls = [];
  assert.equal(await recordSent(conv, 1, { calls }), false);
  assert.deepEqual(calls, []);
  assert.equal(getHistory(conv), null);
});

test('the reply could not be fetched → nothing recorded', async () => {
  const conv = newConv();
  record(conv, 1);
  assert.equal(await recordSent(conv, 2, { detail: null }), false);
  assert.deepEqual(getHistory(conv).map((e) => e.message_id), [idOf(1)]);
});

test('a reply recorded twice (poll and inbound flush) is one entry', async () => {
  const conv = newConv();
  record(conv, 1);
  await recordSent(conv, 2);
  await recordSent(conv, 2);
  assert.deepEqual(getHistory(conv).map((e) => e.message_id), [idOf(1), idOf(2)]);
});

test('historyEntryOf: an inbound frame + get-message detail → the entry the bridge always recorded', () => {
  const msg = {
    id: 1795, conversation_id: 'c', sender_id: 'm-bob', seq: '42', type: 'IMAGE', parent_message_id: '1790',
    message: { id: 1795, seq: 42, sender_id: 'm-bob', type: 'image', parent_id: '1790' },
    content: { body: { text: 'look' }, attachments: [{ artifact_id: 'a1', file_name: 'x.png' }] },
  };
  assert.deepEqual(historyEntryOf(msg, 'Bob', 'T'), {
    timestamp: 'T', message_id: 1795, sender_id: 'm-bob', sender_name: 'Bob',
    text: '[image: a1 | x.png] look', seq: 42, parent_id: '1790', type: 'image',
  });
});
