import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isOwnerDmEndpoint, noticeFromSystemFrame, IM_OWNER_NOTICE_EVENT, IM_OWNER_NOTICE_TYPE, selectOwnerDm, refreshOwnerEndpoint,
  createDedup, handleImOwnerNotice, readCachedEndpoint, reportPath,
} from './im-owner-notice.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'im-owner-'));
const SE = { type: 'im_owner_notice', event_id: 'e1', kind: 'agent_cap_90', text: 'hello', report_token: 'tok' };

test('noticeFromSystemFrame: reads payload.data of the v2 system frame', () => {
  const data = { org_id: 'o', agent_member_id: 'a', event_id: 'e1', kind: 'agent_cap_90', text: 'hi', report_token: 't', occurred_at: '2026-11-04T00:00:00Z' };
  assert.deepEqual(noticeFromSystemFrame({ type: 'system', payload: { event: IM_OWNER_NOTICE_EVENT, data } }), data);
  assert.equal(noticeFromSystemFrame({ type: 'system', payload: { event: IM_OWNER_NOTICE_EVENT } }), null);
  assert.equal(noticeFromSystemFrame(null), null);
});

test('isOwnerDmEndpoint: type:p2p channels (lark/feishu/dingtalk/wecom/whatsapp)', () => {
  for (const ch of ['lark', 'feishu', 'dingtalk', 'wecom', 'whatsapp']) {
    assert.equal(isOwnerDmEndpoint(ch, 'id1|type:p2p'), true, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'id1|type:p2p|msg:m1'), true, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'id1|type:group|root:m1'), false, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'id1'), false, ch);
    assert.equal(isOwnerDmEndpoint(ch, '|type:p2p'), false, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'id1|type:dm'), false, ch);
  }
});

test('isOwnerDmEndpoint: exact type:dm token (slack/line/ms-teams/whatsapp-business)', () => {
  for (const ch of ['slack', 'line', 'ms-teams', 'whatsapp-business']) {
    assert.equal(isOwnerDmEndpoint(ch, 'D1|type:dm|msg:1.2'), true, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'D1|type:dm'), true, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'C1|type:group|msg:1'), false, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'C1|type:channel'), false, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'C1|type:dmx'), false, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'C1|type:p2p'), false, ch);
  }
});

test('isOwnerDmEndpoint: type:dm-pairing is always excluded', () => {
  for (const ch of ['slack', 'line', 'ms-teams', 'discord', 'zalo', 'lark']) {
    assert.equal(isOwnerDmEndpoint(ch, 'admin|type:dm-pairing', '[DISCORD DM] x'), false, ch);
    assert.equal(isOwnerDmEndpoint(ch, 'admin|type:dm-pairing|account:a|user:u', '[Zalo DM] x'), false, ch);
  }
});

test('isOwnerDmEndpoint: telegram private chat = positive integer first segment', () => {
  assert.equal(isOwnerDmEndpoint('telegram', '12345'), true);
  assert.equal(isOwnerDmEndpoint('telegram', '12345|msg:9|req:12345:9'), true);
  assert.equal(isOwnerDmEndpoint('telegram', '-100123|msg:9'), false);
  assert.equal(isOwnerDmEndpoint('telegram', '0'), false);
  assert.equal(isOwnerDmEndpoint('telegram', 'abc|msg:1'), false);
});

test('isOwnerDmEndpoint: wechat requires |to:', () => {
  assert.equal(isOwnerDmEndpoint('wechat', 'acct|to:wxid_1'), true);
  assert.equal(isOwnerDmEndpoint('wechat', 'acct'), false);
  assert.equal(isOwnerDmEndpoint('wechat', 'acct|to:'), false);
});

test('isOwnerDmEndpoint: discord/zalo by C4 content prefix', () => {
  assert.equal(isOwnerDmEndpoint('discord', 'chan1|msg:1', '[DISCORD DM] bob said:'), true);
  assert.equal(isOwnerDmEndpoint('discord', 'chan1|msg:1', '[DISCORD GROUP:x] bob said:'), false);
  assert.equal(isOwnerDmEndpoint('discord', 'chan1|msg:1'), false);
  assert.equal(isOwnerDmEndpoint('zalo', 'u1', '[Zalo DM] bob said: '), true);
  assert.equal(isOwnerDmEndpoint('zalo', 'g1', '[Zalo GROUP:g] bob said: '), false);
});

test('isOwnerDmEndpoint: unknown / internal channels never cached', () => {
  assert.equal(isOwnerDmEndpoint('signal', '123|type:dm'), false);
  for (const ch of ['openmax', 'scheduler', 'system', 'web-console', 'shell']) {
    assert.equal(isOwnerDmEndpoint(ch, '123|type:p2p'), false);
  }
});

test('selectOwnerDm + cache: discord hit keeps content prefix so cached entry validates', async () => {
  const hit = selectOwnerDm([{ id: 1, channel: 'discord', endpoint_id: 'c1|msg:1', content: '[DISCORD DM] bob', timestamp: 't' }]);
  assert.equal(hit.content, '[DISCORD DM]');
  const cacheFile = path.join(tmp(), 'c.json');
  await refreshOwnerEndpoint({ cacheFile, readRows: async () => [{ channel: 'zalo', endpoint_id: 'u1', content: '[Zalo DM] a', timestamp: 't' }] });
  assert.equal(readCachedEndpoint(cacheFile).endpoint, 'u1');
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

const BRIDGE_SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'comm-bridge.js'), 'utf8');

// comm-bridge self-executes on import, so evaluate classifySystemEvent's real
// source with its dependencies stubbed.
function loadClassify() {
  const start = BRIDGE_SRC.indexOf('function classifySystemEvent(eventName)');
  const end = BRIDGE_SRC.indexOf('\n}\n', start) + 2;
  const fnSrc = BRIDGE_SRC.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function('IM_OWNER_NOTICE_EVENT', 'IM_OWNER_NOTICE_TYPE', 'AGENT_DIAGNOSTICS_EVENT', 'CARD_RECORDED_EVENT', 'isChannelEvent',
    `${fnSrc}; return classifySystemEvent;`)(IM_OWNER_NOTICE_EVENT, IM_OWNER_NOTICE_TYPE, 'agent.diagnostics.command', 'card.interaction.recorded', (e) => e.startsWith('channel.'));
}

test('classifySystemEvent: agent.im_owner_notice -> im_owner_notice, matched before fallbacks', () => {
  const classify = loadClassify();
  assert.equal(IM_OWNER_NOTICE_EVENT, 'agent.im_owner_notice');
  assert.equal(classify('agent.im_owner_notice'), 'im_owner_notice');
  assert.equal(classify('AGENT.IM_OWNER_NOTICE'), 'im_owner_notice');
  assert.equal(classify('agent.config.updated'), 'config_update');
  assert.equal(classify('message.updated'), 'edit');
  const body = BRIDGE_SRC.slice(BRIDGE_SRC.indexOf('function classifySystemEvent('));
  assert.ok(body.indexOf('IM_OWNER_NOTICE_EVENT) return IM_OWNER_NOTICE_TYPE') < body.indexOf("e.includes('recall')"));
});

test('handleSystemEvent routes im_owner_notice to processImOwnerNotice before conversation/forward logic', () => {
  const fnStart = BRIDGE_SRC.indexOf('async function handleSystemEvent(orgConfig, frame)');
  const branch = BRIDGE_SRC.indexOf('if (kind === IM_OWNER_NOTICE_TYPE)', fnStart);
  assert.ok(branch > fnStart);
  const seg = BRIDGE_SRC.slice(branch, BRIDGE_SRC.indexOf('\n  }\n', branch));
  assert.match(seg, /noticeFromSystemFrame\(frame\)/);
  assert.match(seg, /await processImOwnerNotice\(orgConfig, notice\);\s*return;/);
  assert.ok(branch < BRIDGE_SRC.indexOf('missing conversation_id', fnStart));
  assert.ok(!seg.includes('isOrgLLMSuspended'), 'system frame path must not be arrears-gated');
  const sysHandler = BRIDGE_SRC.slice(fnStart, BRIDGE_SRC.indexOf('\n}\n', fnStart));
  assert.ok(!sysHandler.includes('isOrgLLMSuspended'));
});

test('v1 system-DM interception removed from the message path', () => {
  assert.ok(!BRIDGE_SRC.includes('extractImOwnerNotice'));
  assert.ok(!BRIDGE_SRC.includes('const imNotice ='));
});
