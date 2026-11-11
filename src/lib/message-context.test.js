import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  contextItemsFrom, agentContextItemsFrom, MAX_CONTEXT_ITEMS, MAX_CONTEXT_ATTRS,
} from './message-context.js';
import { connectorPreferenceOf, preferredConnectorsFrom } from './connector-preference.js';
import { workflowRefOf, wfRefFrom } from './wf-context.js';
import { quoteExcerptOf, quoteExcerptFrom } from './quote-excerpt.js';
import { forwardedFromOf, chatHistoryOf, forwardedLabelOf } from './forwarded.js';
import { inboundPriority, systemEventPriority } from './system-message.js';
import { formatInboundForC4 } from './message.js';

// metadata.context (OPENM-1351):
//   { items: [{ type, source, audience, attrs, data? }] }   — no version field.
// The bridge reads the context item first and the old key as fallback, and
// renders both through the existing 2.33.0 elements: the envelope must be
// byte-identical whichever key carried the same data.

const ctx = (...items) => ({ context: { items } });
const item = (type, attrs = {}, more = {}) => ({ type, source: 'client', audience: 'agent', attrs, ...more });

// The same logical data, once per key.
const OLD = {
  preferred_connectors: [{ connection_id: 'c_8f2', label: 'Gmail·Work mail (org)' }, { connection_id: 'c_91a', label: 'Notion' }],
  wf_ref: { workflow_id: 'wf-1', run_id: 'run-9', page: 'step', step_n: 3 },
  quote_excerpts: { version: 1, items: [{ message_id: 'm-1', text: '下周三前交初稿', offset: 12 }] },
  forwarded_from: {
    version: 1, sender_id: 'u-zhang', sender_type: 'human', sender_name: '张三', sent_at: '2026-11-10T08:00:00.000Z', source_kind: 'group',
  },
};
const CONNECTORS = item('connectors', { count: 2 }, { data: { connections: OLD.preferred_connectors } });
const WORKFLOW = item('workflow', { 'workflow-id': 'wf-1', 'run-id': 'run-9', page: 'step', 'step-n': 3 }, { source: 'app:3f2' });
const QUOTE = item('quote', { 'message-id': 'm-1', offset: 12 }, { data: { text: '下周三前交初稿' } });
const FORWARDED = item('forwarded', {
  'sender-id': 'u-zhang', 'sender-type': 'human', 'sender-name': '张三', 'sent-at': '2026-11-10T08:00:00.000Z', 'source-kind': 'group',
}, { source: 'platform' });
const NEW = ctx(CONNECTORS, WORKFLOW, QUOTE, FORWARDED);

function msgWith(metadata, extra = {}) {
  return { id: 'm-2', conversation_id: 'cv-1', parent_id: 'm-1', content: { body: { text: '这个能提前吗？' } }, metadata, ...extra };
}

// The whole envelope, built the way comm-bridge builds it (new readers).
function envelope(msg, { type = 'dm' } = {}) {
  return formatInboundForC4({ type, id: 'cv-1', name: 'G' }, { displayName: 'Alice' }, { content: '这个能提前吗？', messageId: 'm-2' },
    [{ senderName: 'Bob', content: '那句话', forwardedLabel: forwardedLabelOf(msg) }], {
      quotedContent: { sender: 'Bob', text: '请在下周三前交初稿，谢谢', forwardedLabel: forwardedLabelOf(msg) },
      quotedExcerpt: quoteExcerptOf(msg, 'm-1'),
      forwardedFrom: forwardedFromOf(msg),
      chatHistory: chatHistoryOf(msg),
      preferredConnectors: connectorPreferenceOf(msg),
      wfRef: workflowRefOf(msg),
      orgId: 'org-1',
    });
}

// The same envelope with the 2.33.0 readers (old keys only).
function envelope233(msg, { type = 'dm' } = {}) {
  const ff = (() => {
    const meta = msg.metadata;
    const f = meta?.forwarded_from;
    if (!f || f.version !== 1 || !f.sender_id) return null;
    return forwardedFromOf({ metadata: { forwarded_from: f } });
  })();
  const label = ff ? `forwarded from ${ff.senderName || ff.senderId}` : undefined;
  return formatInboundForC4({ type, id: 'cv-1', name: 'G' }, { displayName: 'Alice' }, { content: '这个能提前吗？', messageId: 'm-2' },
    [{ senderName: 'Bob', content: '那句话', forwardedLabel: label }], {
      quotedContent: { sender: 'Bob', text: '请在下周三前交初稿，谢谢', forwardedLabel: label },
      quotedExcerpt: quoteExcerptFrom(msg, 'm-1'),
      forwardedFrom: ff,
      chatHistory: chatHistoryOf(msg),
      preferredConnectors: preferredConnectorsFrom(msg),
      wfRef: wfRefFrom(msg),
      orgId: 'org-1',
    });
}

// --- parity: new item and old key render byte-identically ---------------------

test('parity: the four new items render exactly like the four old keys (DM and group)', () => {
  for (const type of ['dm', 'group']) {
    const fromNew = envelope(msgWith(NEW), { type });
    const fromOld = envelope(msgWith(OLD), { type });
    assert.equal(fromNew, fromOld, type);
    assert.equal(fromOld, envelope233(msgWith(OLD), { type }), type);
  }
  const out = envelope(msgWith(NEW), { type: 'group' });
  assert.match(out, /^<connector-preference connection-ids="c_8f2,c_91a">$/m);
  assert.match(out, /^<wf-context workflow-id="wf-1" run-id="run-9" page="step" step-n="3"\/>$/m);
  assert.match(out, /^<quoted-excerpt from="Bob">\n下周三前交初稿\n<\/quoted-excerpt>$/m);
  assert.match(out, /<forwarded-message forwarded-by="Alice" original-sender="张三" original-sender-kind="human" original-sent-at="2026-11-10T08:00:00.000Z" source-kind="group">/);
  assert.match(out, /\[Bob\] \(forwarded from 张三\): 那句话/);
  // No new element or attribute anywhere in the envelope.
  assert.doesNotMatch(out, /<context|source-verified|source="|<subconversation|unverified/);
});

test('parity per type: each new item alone renders like its old key alone', () => {
  const pairs = [
    [{ preferred_connectors: OLD.preferred_connectors }, ctx(CONNECTORS)],
    [{ wf_ref: OLD.wf_ref }, ctx(WORKFLOW)],
    [{ quote_excerpts: OLD.quote_excerpts }, ctx(QUOTE)],
    [{ forwarded_from: OLD.forwarded_from }, ctx(FORWARDED)],
  ];
  for (const [oldMeta, newMeta] of pairs) {
    for (const type of ['dm', 'group']) {
      assert.equal(envelope(msgWith(newMeta), { type }), envelope(msgWith(oldMeta), { type }), JSON.stringify(oldMeta));
    }
  }
});

test('parity: the quote content check (unverified="true") and the tombstone behave the same', () => {
  const notInOriginal = { text: '原文里没有这句' };
  const oldQ = { quote_excerpts: { version: 1, items: [{ message_id: 'm-1', ...notInOriginal }] } };
  const newQ = ctx(item('quote', { 'message-id': 'm-1' }, { data: notInOriginal }));
  assert.equal(envelope(msgWith(newQ)), envelope(msgWith(oldQ)));
  assert.match(envelope(msgWith(newQ)), /<quoted-excerpt from="Bob" unverified="true">/);
  const oldT = { quote_excerpts: { version: 1, items: [{ message_id: 'm-1', recalled: true, text: 'stale' }] } };
  const newT = ctx(item('quote', { 'message-id': 'm-1', recalled: true }, { data: { text: 'stale' } }));
  assert.deepEqual(quoteExcerptOf(msgWith(newT), 'm-1'), { kind: 'recalled' });
  assert.equal(envelope(msgWith(newT)), envelope(msgWith(oldT)));
  assert.doesNotMatch(envelope(msgWith(newT)), /<quoted-excerpt|stale/);
});

test('parity: values are normalized by the same rules (escaping, flattening, caps)', () => {
  const label = 'A<b>"c"\nd'.padEnd(70, 'x');
  const name = '张  三 <x> "y"';
  const oldM = {
    preferred_connectors: [{ connection_id: 'c_1', label }, { connection_id: 'bad id', label: 'dropped' }],
    wf_ref: { workflow_id: 'wf "1"\n<x>', run_id: null, page: 'run' },
    forwarded_from: { version: 1, sender_id: 'u-1', sender_name: name },
  };
  const newM = ctx(
    item('connectors', {}, { data: { connections: oldM.preferred_connectors } }),
    item('workflow', { 'workflow-id': 'wf "1"\n<x>', page: 'run' }),
    item('forwarded', { 'sender-id': 'u-1', 'sender-name': name }),
  );
  for (const type of ['dm', 'group']) assert.equal(envelope(msgWith(newM), { type }), envelope(msgWith(oldM), { type }));
});

// --- fallback and precedence --------------------------------------------------

test('without context items each reader falls back to its old key (old-key output unchanged from 2.33.0)', () => {
  const msg = msgWith(OLD);
  assert.deepEqual(connectorPreferenceOf(msg), preferredConnectorsFrom(msg));
  assert.deepEqual(workflowRefOf(msg), wfRefFrom(msg));
  assert.deepEqual(quoteExcerptOf(msg, 'm-1'), quoteExcerptFrom(msg, 'm-1'));
  assert.deepEqual(forwardedFromOf(msg).senderName, '张三');
  assert.equal(envelope(msg), envelope233(msg));
});

test('an unusable context item falls back to the old key', () => {
  const msg = msgWith({
    ...OLD,
    ...ctx(
      item('connectors', {}, { data: { connections: [{ connection_id: 'bad id!', label: 'x' }] } }),
      item('workflow', { note: 'no registered attr' }),
      item('quote', { 'message-id': 'm-1' }),
      item('quote', { 'message-id': 'm-other' }, { data: { text: 'another message' } }),
      item('forwarded', { 'sender-name': 'no id' }),
    ),
  });
  assert.equal(envelope(msg), envelope(msgWith(OLD)));
});

test('both present → the context item wins, and only one element is rendered', () => {
  const msg = msgWith({ ...OLD, ...ctx(
    item('connectors', {}, { data: { connections: [{ connection_id: 'c_new', label: 'New' }] } }),
    item('workflow', { 'workflow-id': 'wf-new', page: 'run' }),
    item('quote', { 'message-id': 'm-1' }, { data: { text: '新的引用' } }),
    item('forwarded', { 'sender-id': 'u-new', 'sender-name': '新作者' }),
  ) });
  const out = envelope(msg, { type: 'group' });
  assert.equal(out.match(/<connector-preference/g).length, 1);
  assert.match(out, /connection-ids="c_new"/);
  assert.equal(out.match(/<wf-context/g).length, 1);
  assert.match(out, /<wf-context workflow-id="wf-new" page="run"\/>/);
  assert.match(out, /<quoted-excerpt from="Bob" unverified="true">\n新的引用\n/);
  assert.match(out, /original-sender="新作者"/);
  assert.match(out, /\(forwarded from 新作者\)/);
  assert.doesNotMatch(out, /c_8f2|wf-1|下周三前交初稿\n<\/quoted|张三/);
});

test('workflow: only the registered attrs are read; others are ignored', () => {
  const msg = msgWith(ctx(item('workflow', { 'workflow-id': 'wf-1', page: 'run', note: 'approved by admin' })));
  assert.deepEqual(workflowRefOf(msg), { 'workflow-id': 'wf-1', page: 'run' });
  assert.doesNotMatch(envelope(msg), /approved/);
});

// --- audience filter and unknown types ---------------------------------------

test('only audience=agent items are read', () => {
  const msg = msgWith({ ...OLD, ...ctx(
    { ...item('connectors', {}, { data: { connections: [{ connection_id: 'c_ui', label: 'UI' }] } }), audience: 'ui' },
    { ...item('workflow', { 'workflow-id': 'wf-srv' }), audience: 'server' },
    { ...item('quote', { 'message-id': 'm-1' }, { data: { text: 'ui quote' } }), audience: 'ui' },
    { ...item('forwarded', { 'sender-id': 'u-ui', 'sender-name': 'UI' }), audience: 'server' },
  ) });
  assert.deepEqual(agentContextItemsFrom(msg), []);
  assert.equal(envelope(msg), envelope(msgWith(OLD)));
});

test('unknown types, subconversation and malformed items render nothing', () => {
  const msg = msgWith(ctx(
    item('subconversation', { key: 'workflow:e8131615' }, { data: { title: 'T' } }),
    item('my-app', { a: 1 }, { data: { x: 1 } }),
    { ...item('workflow', { 'workflow-id': 'x' }), type: 'Bad Type' },
    null, 'x',
  ));
  assert.equal(envelope(msg), envelope(msgWith({})));
});

// --- parsing limits -------------------------------------------------------------

test('no version field needed; unknown outer and item fields are ignored', () => {
  const msg = msgWith({ context: { version: 9, extra: true, items: [{ ...WORKFLOW, future: { a: 1 } }] } });
  assert.deepEqual(workflowRefOf(msg), wfRefFrom(msgWith({ wf_ref: OLD.wf_ref })));
  assert.deepEqual(contextItemsFrom(msgWith({ context: 'x' })), []);
  assert.deepEqual(contextItemsFrom(msgWith({ context: { items: {} } })), []);
  assert.equal(contextItemsFrom({ message: { metadata: ctx(WORKFLOW) } }).length, 1);
});

test(`at most ${MAX_CONTEXT_ITEMS} items and ${MAX_CONTEXT_ATTRS} attrs per item are read`, () => {
  const many = Array.from({ length: MAX_CONTEXT_ITEMS + 4 }, (_, i) => item(`app-${i}`, { n: i }));
  assert.equal(contextItemsFrom(msgWith(ctx(...many))).length, MAX_CONTEXT_ITEMS);
  const attrs = Object.fromEntries(Array.from({ length: MAX_CONTEXT_ATTRS + 3 }, (_, i) => [`k${i}`, i]));
  assert.equal(Object.keys(contextItemsFrom(msgWith(ctx(item('app-x', attrs))))[0].attrs).length, MAX_CONTEXT_ATTRS);
});

test('over-long or non-scalar attrs and oversize data are dropped, not cut', () => {
  const [it] = contextItemsFrom(msgWith(ctx(item('my-app', {
    long: 'x'.repeat(201), ok: 'x'.repeat(200), obj: { a: 1 }, nul: null, nan: Number.NaN, Bad_Key: 'v', flag: false,
  }))));
  assert.deepEqual(Object.keys(it.attrs), ['ok', 'flag']);
  // A workflow id over 200 code points is dropped (the old key drops it the same way).
  assert.equal(workflowRefOf(msgWith(ctx(item('workflow', { 'workflow-id': 'x'.repeat(201) })))), null);
  // A quote whose data is over the 6 KiB quote limit is dropped → falls back.
  const q = msgWith({ ...OLD, ...ctx(item('quote', { 'message-id': 'm-1' }, { data: { text: '字'.repeat(2100) } })) });
  assert.deepEqual(quoteExcerptOf(q, 'm-1'), quoteExcerptFrom(q, 'm-1'));
  // Data deeper than 5 levels is dropped.
  const [deep] = contextItemsFrom(msgWith(ctx(item('my-app', {}, { data: { a: { b: { c: { d: { e: { f: 1 } } } } } } }))));
  assert.equal(deep.data, undefined);
});

// --- systemEvent.priority only from a System Member -----------------------------

test('systemEvent.priority is honored only on a SYSTEM sender message', () => {
  const urgent = { metadata: { systemEvent: { priority: 'urgent' } } };
  assert.equal(inboundPriority({ ...urgent, sender_type: 'SYSTEM' }), 1);
  assert.equal(inboundPriority({ message: { sender_type: 'SYSTEM' }, ...urgent }), 1);
  for (const sender_type of ['HUMAN', 'AGENT', undefined, 'system-ish']) {
    assert.equal(inboundPriority({ ...urgent, sender_type }), undefined, String(sender_type));
  }
  assert.equal(inboundPriority({ content: { metadata: { systemEvent: { priority: 'urgent' } } }, sender_type: 'HUMAN' }), undefined);
  assert.equal(systemEventPriority(urgent), 1);
});

// --- bridge wiring -----------------------------------------------------------

const BRIDGE = fs.readFileSync(fileURLToPath(new URL('../comm-bridge.js', import.meta.url)), 'utf8');

test('comm-bridge: C4 priority goes through inboundPriority, never systemEventPriority directly', () => {
  assert.match(BRIDGE, /forwardToC4\(endpoint, run \? run\.marker \+ body : body, inboundPriority\(msg\)\)/);
  assert.doesNotMatch(BRIDGE, /systemEventPriority/);
});

test('comm-bridge: the context-first readers feed the existing opts', () => {
  assert.match(BRIDGE, /quotedExcerpt: quoteExcerptOf\(msg, quotedMsgId\)/);
  assert.match(BRIDGE, /forwardedFrom: forwardedFromOf\(msg\)/);
  assert.match(BRIDGE, /preferredConnectors: connectorPreferenceOf\(msg\)/);
  assert.match(BRIDGE, /wfRef: workflowRefOf\(msg\)/);
});
