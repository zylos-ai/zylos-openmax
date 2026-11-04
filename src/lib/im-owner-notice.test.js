import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractImOwnerNotice, isOwnerDmEndpoint, selectOwnerDm, refreshOwnerEndpoint,
  createDedup, handleImOwnerNotice, readCachedEndpoint, reportPath,
} from './im-owner-notice.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'im-owner-'));
const SE = { type: 'im_owner_notice', event_id: 'e1', kind: 'agent_cap_90', text: 'hello', report_token: 'tok' };

test('extractImOwnerNotice: content.metadata (WS frame) and nested detail shapes', () => {
  assert.deepEqual(extractImOwnerNotice({ content: { metadata: { systemEvent: SE } } }), SE);
  assert.deepEqual(extractImOwnerNotice({ message: { content: { metadata: { systemEvent: SE } } } }), SE);
  assert.equal(extractImOwnerNotice({ content: { metadata: { systemEvent: { type: 'other' } } } }), null);
  assert.equal(extractImOwnerNotice({ content: { body: { text: 'x' } } }), null);
});

test('isOwnerDmEndpoint: lark/feishu p2p only', () => {
  assert.equal(isOwnerDmEndpoint('lark', 'oc_1|type:p2p'), true);
  assert.equal(isOwnerDmEndpoint('feishu', 'oc_1|type:p2p|msg:om_1'), true);
  assert.equal(isOwnerDmEndpoint('lark', 'oc_1|type:group|root:om_1'), false);
  assert.equal(isOwnerDmEndpoint('lark', 'oc_1'), false);
  assert.equal(isOwnerDmEndpoint('lark', '|type:p2p'), false);
});

test('isOwnerDmEndpoint: undeterminable channels never cached', () => {
  for (const ch of ['telegram', 'dingtalk', 'whatsapp', 'wechat']) {
    assert.equal(isOwnerDmEndpoint(ch, '12345'), false);
    assert.equal(isOwnerDmEndpoint(ch, '12345|type:p2p'), false);
  }
});

test('selectOwnerDm: skips internal channels and groups, newest DM wins', () => {
  const rows = [
    { id: 9, channel: 'openmax', endpoint_id: 'x|type:p2p' },
    { id: 8, channel: 'scheduler', endpoint_id: 'x|type:p2p' },
    { id: 7, channel: 'system', endpoint_id: 'x|type:p2p' },
    { id: 6, channel: 'web-console', endpoint_id: 'x|type:p2p' },
    { id: 5, channel: 'shell', endpoint_id: 'x|type:p2p' },
    { id: 4, channel: 'lark', endpoint_id: 'oc_g|type:group' },
    { id: 3, channel: 'lark', endpoint_id: 'oc_new|type:p2p', timestamp: 't3' },
    { id: 2, channel: 'feishu', endpoint_id: 'oc_old|type:p2p', timestamp: 't2' },
  ];
  assert.deepEqual(selectOwnerDm(rows), { channel: 'lark', endpoint: 'oc_new|type:p2p', at: 't3', id: 3 });
  assert.equal(selectOwnerDm(rows.slice(0, 6)), null);
});

test('refreshOwnerEndpoint: persists hit; falls back to cache when C4 pruned', async () => {
  const dir = tmp();
  const cacheFile = path.join(dir, 'c.json');
  const hit = await refreshOwnerEndpoint({ cacheFile, readRows: async () => [{ channel: 'lark', endpoint_id: 'oc_a|type:p2p', timestamp: 't' }] });
  assert.equal(hit.endpoint, 'oc_a|type:p2p');
  assert.equal(readCachedEndpoint(cacheFile).endpoint, 'oc_a|type:p2p');
  const later = await refreshOwnerEndpoint({ cacheFile, readRows: async () => [] });
  assert.equal(later.endpoint, 'oc_a|type:p2p');
  assert.equal(await refreshOwnerEndpoint({ cacheFile: path.join(dir, 'none.json'), readRows: async () => [] }), null);
});

test('createDedup: persisted and bounded', () => {
  const file = path.join(tmp(), 'seen.json');
  const d = createDedup({ file, max: 3 });
  for (const id of ['a', 'b', 'c', 'd']) d.add(id);
  assert.equal(d.has('a'), false);
  assert.equal(d.has('d'), true);
  const d2 = createDedup({ file, max: 3 });
  assert.equal(d2.has('b'), true);
});

test('handleImOwnerNotice: sends and reports sent; duplicate is a no-op', async () => {
  const sends = []; const reports = [];
  const deps = {
    dedup: createDedup({ file: path.join(tmp(), 's.json') }),
    resolveEndpoint: async () => ({ channel: 'lark', endpoint: 'oc_a|type:p2p' }),
    send: async (...a) => { sends.push(a); return true; },
    report: async (b) => { reports.push(b); },
  };
  assert.equal(await handleImOwnerNotice(SE, deps), 'sent');
  assert.equal(await handleImOwnerNotice(SE, deps), 'duplicate');
  assert.deepEqual(sends, [['lark', 'oc_a|type:p2p', 'hello']]);
  assert.deepEqual(reports, [{ report_token: 'tok', event_id: 'e1', status: 'sent' }]);
});

test('handleImOwnerNotice: no cached address reports no_address without sending', async () => {
  const reports = []; let sent = false;
  const status = await handleImOwnerNotice(SE, {
    dedup: createDedup({ file: path.join(tmp(), 's.json') }),
    resolveEndpoint: async () => null,
    send: async () => { sent = true; return true; },
    report: async (b) => { reports.push(b); },
  });
  assert.equal(status, 'no_address');
  assert.equal(sent, false);
  assert.deepEqual(reports, [{ report_token: 'tok', event_id: 'e1', status: 'no_address' }]);
});

test('handleImOwnerNotice: send failure reports failed; report error only warns', async () => {
  const warns = [];
  const status = await handleImOwnerNotice(SE, {
    dedup: createDedup({ file: path.join(tmp(), 's.json') }),
    resolveEndpoint: async () => ({ channel: 'lark', endpoint: 'oc_a|type:p2p' }),
    send: async () => false,
    report: async () => { throw new Error('404'); },
    warn: (m) => warns.push(m),
  });
  assert.equal(status, 'failed');
  assert.ok(warns.some(w => w.includes('ReportImOwnerNotice failed')));
});

test('reportPath is self-scoped', () => {
  assert.equal(reportPath('m-1'), '/agents/m-1/im-owner-notice-reports');
});

test('comm-bridge intercepts im_owner_notice before the arrears gate and forwardToC4', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'comm-bridge.js'), 'utf8');
  const intercept = src.indexOf('const imNotice = extractImOwnerNotice(msg);');
  assert.ok(intercept > 0);
  const after = src.slice(intercept, src.indexOf('isOrgLLMSuspended(orgConfig)', intercept));
  assert.match(after, /processImOwnerNotice\(orgConfig, imNotice\);[\s\S]*return;/);
  assert.ok(!after.includes('forwardToC4('));
  const forward = src.indexOf('await forwardToC4(endpoint, run ?');
  assert.ok(forward > intercept);
});
