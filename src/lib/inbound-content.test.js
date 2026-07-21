import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageHasUsableContent, resolveInboundContent } from './inbound-content.js';

// ---------------------------------------------------------------------------
// messageHasUsableContent — "usable" mirrors the forward path's extraction.
// ---------------------------------------------------------------------------

test('messageHasUsableContent: text in content.body.text is usable', () => {
  assert.equal(messageHasUsableContent({ content: { body: { text: 'hi' } } }), true);
});

test('messageHasUsableContent: string message.content is usable', () => {
  assert.equal(messageHasUsableContent({ message: { content: 'hello' } }), true);
});

test('messageHasUsableContent: media-only (attachments, no text) is usable', () => {
  assert.equal(
    messageHasUsableContent({ content: { body: { text: '' }, attachments: [{ artifact_id: 'a1' }] } }),
    true,
  );
});

test('messageHasUsableContent: legacy flat media_id is usable', () => {
  assert.equal(messageHasUsableContent({ content: { media_id: 'm1' } }), true);
});

test('messageHasUsableContent: null / metadata-only frame is NOT usable', () => {
  assert.equal(messageHasUsableContent(null), false);
  assert.equal(messageHasUsableContent({ id: '1', conversation_id: 'c', sender_id: 's' }), false);
});

test('messageHasUsableContent: whitespace-only text is NOT usable', () => {
  assert.equal(messageHasUsableContent({ content: { body: { text: '   ' } } }), false);
});

// ---------------------------------------------------------------------------
// resolveInboundContent — retry-once + realtime-vs-sync decision.
// ---------------------------------------------------------------------------

const noSleep = async () => {};
const realtimeFrame = { id: 'm1', conversation_id: 'c1', sender_id: 's1' };
const syncFrame = { id: 'm1', conversation_id: 'c1', seq: 42, _via: 'sync' };

test('(a) fetch fails once then succeeds on retry → status ok, forwarded normally', async () => {
  let calls = 0;
  const getDetail = async () => {
    calls += 1;
    if (calls === 1) return null;                     // first attempt fails
    return { content: { body: { text: 'the real body' } } }; // retry succeeds
  };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(calls, 2, 'exactly one retry (total 2 GETs)');
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts, 2);
  assert.equal(r.detail.content.body.text, 'the real body');
});

test('first attempt succeeds → no retry issued', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; return { content: { body: { text: 'ok' } } }; };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts, 1);
});

test('(b) fetch fails both times on a REALTIME frame → skip-empty + forceReconnect', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; return null; };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(calls, 2, 'first attempt + one retry');
  assert.equal(r.status, 'skip-empty', 'not forwarded');
  assert.equal(r.via, 'realtime');
  assert.equal(r.forceReconnect, true, 'realtime path forces a WS reconnect');
});

test('(c) fetch fails both times on a SYNC-replay frame → skip-empty, NO forceReconnect', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; return { content: { body: { text: '' } } }; };
  const r = await resolveInboundContent({ getDetail, notification: syncFrame, sleep: noSleep });
  assert.equal(calls, 2);
  assert.equal(r.status, 'skip-empty', 'not forwarded');
  assert.equal(r.via, 'sync');
  assert.equal(r.forceReconnect, false, 'sync path must NOT re-terminate the WS mid-sweep');
});

test('retries=0 disables the retry (single attempt only)', async () => {
  let calls = 0;
  const getDetail = async () => { calls += 1; return null; };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, retries: 0, sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(r.status, 'skip-empty');
});

test('a media-only detail on retry counts as usable (not over-narrowed to text)', async () => {
  let calls = 0;
  const getDetail = async () => {
    calls += 1;
    if (calls === 1) return null;
    return { content: { body: { text: '' }, attachments: [{ artifact_id: 'img1' }] } };
  };
  const r = await resolveInboundContent({ getDetail, notification: realtimeFrame, sleep: noSleep });
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts, 2);
});

test('delay is applied between attempts via injected sleep', async () => {
  const delays = [];
  const sleep = async (ms) => { delays.push(ms); };
  const getDetail = async () => null;
  await resolveInboundContent({ getDetail, notification: realtimeFrame, delayMs: 350, sleep });
  assert.deepEqual(delays, [350], 'one delay, before the single retry');
});
