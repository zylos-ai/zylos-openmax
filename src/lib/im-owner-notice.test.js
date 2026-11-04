import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isOwnerDmEndpoint, noticeFromSystemFrame, IM_OWNER_NOTICE_EVENT, IM_OWNER_NOTICE_TYPE, selectOwnerDm, refreshOwnerEndpoint,
  createDedup, handleImOwnerNotice, readCachedEndpoint, isOwnerAttributed, stripMessageParams,
  readC4InboundRows, _resetC4ReadWarning,
} from './im-owner-notice.js';
import { classifySystemEvent, routeImOwnerNotice } from './system-event-routing.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'im-owner-'));
const CFG = {
  lark: { owner: { bound: true, user_id: 'uo', open_id: 'ou_o' } }, feishu: { owner: { bound: true, user_id: 'uo', open_id: 'ou_o' } },
  slack: { owner: { bound: true, user_id: 'UO' } },
  discord: { owner: 'd1' }, zalo: { owner: { user_id: 'u1' } },
};
const cfgs = (ch) => CFG[ch] || null;
const jsonl = (...rows) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
/** Component dir with message logs as each channel component writes them. */
function componentsWithLogs({ lark = [], feishu = [], slack = {}, discord = {} } = {}) {
  const dir = tmp();
  const put = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, text); };
  for (const [ch, entries] of [['lark', lark], ['feishu', feishu]]) {
    for (const e of entries) put(`${ch}/logs/${e.user_id}.log`, jsonl(e));
  }
  for (const [chat, entries] of Object.entries(slack)) put(`slack/logs/${chat}.log`, jsonl(...entries));
  for (const [chat, entries] of Object.entries(discord)) put(`discord/logs/dm/${chat}.jsonl`, jsonl(...entries));
  return dir;
}
const OWNER_LOGS = () => componentsWithLogs({
  lark: [{ message_id: 'om_new', user_id: 'uo', open_id: 'ou_o' }, { message_id: 'om_a', user_id: 'uo', open_id: 'ou_o' }],
  feishu: [{ message_id: 'om_old', user_id: 'uo', open_id: 'ou_o' }],
  discord: { c1: [{ direction: 'in', userId: 'd1', messageId: '1' }] },
});
const SE = { type: 'im_owner_notice', event_id: 'e1', kind: 'agent_cap_90', text: 'hello', report_token: 'ignored' };

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
  const componentsDir = OWNER_LOGS();
  const hit = selectOwnerDm([{ id: 1, channel: 'discord', endpoint_id: 'c1|msg:1|req:c1:1', content: '[DISCORD DM] bob', timestamp: 't' }], cfgs, { componentsDir });
  assert.equal(hit.content, '[DISCORD DM]');
  assert.equal(hit.endpoint, 'c1');
  assert.equal(hit.source, 'c1|msg:1|req:c1:1');
  const cacheFile = path.join(tmp(), 'c.json');
  await refreshOwnerEndpoint({ cacheFile, readRows: async () => [{ channel: 'zalo', endpoint_id: 'u1', content: '[Zalo DM] a', timestamp: 't' }], loadConfig: cfgs });
  assert.equal(readCachedEndpoint(cacheFile, cfgs).endpoint, 'u1');
});

test('selectOwnerDm: skips internal channels and groups, newest DM wins', () => {
  const rows = [
    { id: 9, channel: 'openmax', endpoint_id: 'x|type:p2p' },
    { id: 8, channel: 'scheduler', endpoint_id: 'x|type:p2p' },
    { id: 7, channel: 'system', endpoint_id: 'x|type:p2p' },
    { id: 6, channel: 'web-console', endpoint_id: 'x|type:p2p' },
    { id: 5, channel: 'shell', endpoint_id: 'x|type:p2p' },
    { id: 4, channel: 'lark', endpoint_id: 'oc_g|type:group' },
    { id: 3, channel: 'lark', endpoint_id: 'oc_new|type:p2p|msg:om_new', timestamp: 't3' },
    { id: 2, channel: 'feishu', endpoint_id: 'oc_old|type:p2p|msg:om_old', timestamp: 't2' },
  ];
  const componentsDir = OWNER_LOGS();
  assert.deepEqual(selectOwnerDm(rows, cfgs, { componentsDir }),
    { channel: 'lark', source: 'oc_new|type:p2p|msg:om_new', endpoint: 'oc_new|type:p2p', at: 't3', id: 3 });
  assert.equal(selectOwnerDm(rows.slice(0, 6), cfgs, { componentsDir }), null);
});

test('refreshOwnerEndpoint: persists hit; falls back to cache when C4 pruned', async () => {
  const dir = tmp();
  const cacheFile = path.join(dir, 'c.json');
  const componentsDir = OWNER_LOGS();
  const hit = await refreshOwnerEndpoint({ cacheFile, componentsDir, readRows: async () => [{ channel: 'lark', endpoint_id: 'oc_a|type:p2p|msg:om_a', timestamp: 't' }], loadConfig: cfgs });
  assert.equal(hit.endpoint, 'oc_a|type:p2p');
  assert.equal(readCachedEndpoint(cacheFile, cfgs, { componentsDir }).endpoint, 'oc_a|type:p2p');
  const later = await refreshOwnerEndpoint({ cacheFile, componentsDir, readRows: async () => [], loadConfig: cfgs });
  assert.equal(later.endpoint, 'oc_a|type:p2p');
  assert.equal(await refreshOwnerEndpoint({ cacheFile: path.join(dir, 'none.json'), componentsDir, readRows: async () => [], loadConfig: cfgs }), null);
});

test('isOwnerAttributed: peer id in endpoint must equal bound owner', () => {
  const cases = [
    ['telegram', { owner: { chat_id: '777' } }, '777|msg:1', '888|msg:1'],
    ['dingtalk', { owner: { staff_id: 's1' } }, 's1|type:p2p|msg:m', 's2|type:p2p|msg:m'],
    ['wecom', { owner: { user_id: 'w1' } }, 'w1|type:p2p|msg:m', 'w2|type:p2p|msg:m'],
    ['zalo', { owner: { user_id: 'z1' } }, 'z1|msg:1|req:x', 'z2|msg:1|req:x'],
    ['whatsapp-business', { owner: { bound: true, wa_id: '8613' } }, '8613|type:dm|msg:w', '8614|type:dm|msg:w'],
    ['whatsapp', { owner: { bound: true, jid: '8613:5@s.whatsapp.net' } }, '8613@s.whatsapp.net|type:p2p|msg:1', '8614@s.whatsapp.net|type:p2p|msg:1'],
    ['line', { owner: { bound: true, userId: 'U1' } }, 'U1|type:dm|account:default|user:U1', 'U2|type:dm|account:default|user:U2'],
    ['ms-teams', { owner: { bound: true, aadObjectId: 'a1' } }, 'conv|type:dm|user:a1|msg:x', 'conv|type:dm|user:a2|msg:x'],
  ];
  for (const [ch, cfg, owner, other] of cases) {
    assert.equal(isOwnerAttributed(ch, owner, cfg), true, `${ch} owner`);
    assert.equal(isOwnerAttributed(ch, other, cfg), false, `${ch} non-owner`);
    assert.equal(isOwnerAttributed(ch, owner, { owner: {} }), false, `${ch} unbound`);
    assert.equal(isOwnerAttributed(ch, owner, null), false, `${ch} no config`);
  }
});

test('isOwnerAttributed: lark/feishu need the owner as sender of the msg in the component log', () => {
  for (const ch of ['lark', 'feishu']) {
    const componentsDir = componentsWithLogs({ [ch]: [
      { message_id: 'om_o', user_id: 'uo', open_id: 'ou_o' },
      { message_id: 'om_s', user_id: 'stranger', open_id: 'ou_s' },
    ] });
    const cfg = { owner: { bound: true, user_id: 'uo', open_id: 'ou_o' } };
    const opts = { componentsDir };
    assert.equal(isOwnerAttributed(ch, 'oc_1|type:p2p|msg:om_o', cfg, opts), true, `${ch} owner`);
    assert.equal(isOwnerAttributed(ch, 'oc_2|type:p2p|msg:om_s', cfg, opts), false, `${ch} stranger`);
    assert.equal(isOwnerAttributed(ch, 'oc_1|type:p2p', cfg, opts), false, `${ch} no msg id (legacy row)`);
    assert.equal(isOwnerAttributed(ch, 'oc_1|type:p2p|msg:om_x', cfg, opts), false, `${ch} not in log`);
    assert.equal(isOwnerAttributed(ch, 'oc_1|type:p2p|msg:om_o', { owner: { bound: false, user_id: 'uo' } }, opts), false, `${ch} unbound`);
    // dmPolicy / legacy whitelist are irrelevant: evidence decides.
    assert.equal(isOwnerAttributed(ch, 'oc_2|type:p2p|msg:om_s', { ...cfg, whitelist: { enabled: false } }, opts), false);
    assert.equal(isOwnerAttributed(ch, 'oc_1|type:p2p|msg:om_o', { ...cfg, dmPolicy: 'open' }, opts), true);
    // Previous owner's DM after rebinding is not attributed to the new owner.
    assert.equal(isOwnerAttributed(ch, 'oc_1|type:p2p|msg:om_o', { owner: { bound: true, user_id: 'stranger', open_id: 'ou_s' } }, opts), false);
  }
});

test('isOwnerAttributed: slack/discord need the owner as sender of the msg in the component log', () => {
  const componentsDir = componentsWithLogs({
    slack: { D1: [{ from: 'o', userId: 'UO', ts: '1.1' }], D2: [{ from: 's', userId: 'US', ts: '2.2' }] },
    discord: { c1: [{ direction: 'in', userId: 'd1', messageId: '11' }], c2: [{ direction: 'in', userId: 'd2', messageId: '22' }, { direction: 'out', userId: 'd1', messageId: '23' }] },
  });
  const opts = { componentsDir };
  const slack = { owner: { bound: true, user_id: 'UO' } };
  assert.equal(isOwnerAttributed('slack', 'D1|type:dm|msg:1.1', slack, opts), true);
  assert.equal(isOwnerAttributed('slack', 'D2|type:dm|msg:2.2', slack, opts), false);
  assert.equal(isOwnerAttributed('slack', 'D1|type:dm', slack, opts), false);
  assert.equal(isOwnerAttributed('slack', 'D1|type:dm|msg:1.1', { owner: { bound: false } }, opts), false);
  assert.equal(isOwnerAttributed('discord', 'c1|msg:11|req:c1:11', { owner: 'd1' }, opts), true);
  assert.equal(isOwnerAttributed('discord', 'c2|msg:22', { owner: 'd1' }, opts), false);
  assert.equal(isOwnerAttributed('discord', 'c2|msg:23', { owner: 'd1' }, opts), false, 'outgoing entry is not evidence');
  assert.equal(isOwnerAttributed('discord', 'c1|msg:11', {}, opts), false);
});

test('selectOwnerDm (review repro): legacy whitelist config + newer stranger DM picks the owner DM', () => {
  const componentsDir = componentsWithLogs({ feishu: [
    { message_id: 'om1', user_id: 'uo', open_id: 'ou_o' }, { message_id: 'om2', user_id: 'stranger', open_id: 'ou_s' },
  ] });
  const load = () => ({ owner: { bound: true, user_id: 'uo', open_id: 'ou_o' }, whitelist: { enabled: false } });
  const rows = [
    { id: 2, channel: 'feishu', endpoint_id: 'oc_stranger_chat|type:p2p|msg:om2', timestamp: 't2' },
    { id: 1, channel: 'feishu', endpoint_id: 'oc_owner_chat|type:p2p|msg:om1', timestamp: 't1' },
  ];
  assert.equal(selectOwnerDm(rows, load, { componentsDir }).endpoint, 'oc_owner_chat|type:p2p');
  assert.equal(selectOwnerDm(rows.slice(0, 1), load, { componentsDir }), null);
});

test('isOwnerAttributed: wechat (no owner) only with a single-user allowlist', () => {
  assert.equal(isOwnerAttributed('wechat', 'acct|to:wx1', { dmPolicy: 'allowlist', dmAllowFrom: ['wx1'] }), true);
  assert.equal(isOwnerAttributed('wechat', 'acct|to:wx2', { dmPolicy: 'allowlist', dmAllowFrom: ['wx1'] }), false);
  assert.equal(isOwnerAttributed('wechat', 'acct|to:wx1', { dmPolicy: 'allowlist', dmAllowFrom: ['wx1', 'wx2'] }), false);
  assert.equal(isOwnerAttributed('wechat', 'acct|to:wx1', { dmPolicy: 'open' }), false);
  assert.equal(isOwnerAttributed('signal', 'x', { owner: {} }), false);
});

test('selectOwnerDm: a newer non-owner DM is skipped in favour of the owner DM', () => {
  const load = (ch) => ({ telegram: { owner: { chat_id: '1' }, dmPolicy: 'open' }, lark: { owner: { bound: true, user_id: 'uo' }, dmPolicy: 'open' } })[ch];
  const componentsDir = tmp();
  const rows = [
    { id: 3, channel: 'lark', endpoint_id: 'oc_x|type:p2p|msg:om', timestamp: 't3' },
    { id: 2, channel: 'telegram', endpoint_id: '2|msg:1', timestamp: 't2' },
    { id: 1, channel: 'telegram', endpoint_id: '1|msg:1', timestamp: 't1' },
  ];
  assert.deepEqual(selectOwnerDm(rows, load, { componentsDir }), { channel: 'telegram', source: '1|msg:1', endpoint: '1', at: 't1', id: 1 });
  assert.equal(selectOwnerDm(rows.slice(0, 2), load, { componentsDir }), null);
});

test('readCachedEndpoint: re-attributes against current owner config', async () => {
  const cacheFile = path.join(tmp(), 'c.json');
  await refreshOwnerEndpoint({ cacheFile, readRows: async () => [{ channel: 'telegram', endpoint_id: '1|msg:1', timestamp: 't' }], loadConfig: () => ({ owner: { chat_id: '1' } }) });
  assert.equal(readCachedEndpoint(cacheFile, () => ({ owner: { chat_id: '1' } })).endpoint, '1');
  assert.equal(readCachedEndpoint(cacheFile, () => ({ owner: { chat_id: '9' } })), null);
});

test('createDedup: persisted and bounded', () => {
  const file = path.join(tmp(), 'seen.json');
  const d = createDedup({ file, max: 3 });
  for (const id of ['a', 'b', 'c', 'd']) d.add(id);
  assert.equal(d.has('a'), false);
  assert.equal(d.has('d'), true);
  const d2 = createDedup({ file, max: 3 });
  assert.equal(d2.has('b'), true);
  d2.attempt('z'); d2.attempt('z');
  assert.equal(createDedup({ file, max: 3 }).attempts('z'), 2);
  const legacy = path.join(tmp(), 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify(['old']));
  assert.equal(createDedup({ file: legacy }).has('old'), true);
});

test('handleImOwnerNotice: sends; duplicate is a no-op; report_token ignored', async () => {
  const sends = [];
  const deps = {
    dedup: createDedup({ file: path.join(tmp(), 's.json') }),
    resolveEndpoint: async () => ({ channel: 'lark', endpoint: 'oc_a|type:p2p' }),
    send: async (...a) => { sends.push(a); return true; },
  };
  assert.equal(await handleImOwnerNotice(SE, deps), 'sent');
  assert.equal(await handleImOwnerNotice(SE, deps), 'duplicate');
  assert.deepEqual(sends, [['lark', 'oc_a|type:p2p', 'hello']]);
});

test('handleImOwnerNotice: no owner address logs no_address without sending', async () => {
  const logs = []; let sent = false;
  const status = await handleImOwnerNotice(SE, {
    dedup: createDedup({ file: path.join(tmp(), 's.json') }),
    resolveEndpoint: async () => null,
    send: async () => { sent = true; return true; },
    log: (m) => logs.push(m),
  });
  assert.equal(status, 'no_address');
  assert.equal(sent, false);
  assert.ok(logs.some(l => l.includes('status=no_address')));
});

test('handleImOwnerNotice: send failure is logged as failed', async () => {
  const status = await handleImOwnerNotice(SE, {
    dedup: createDedup({ file: path.join(tmp(), 's.json') }),
    resolveEndpoint: async () => ({ channel: 'lark', endpoint: 'oc_a|type:p2p' }),
    send: async () => false,
  });
  assert.equal(status, 'failed');
});


test('handleImOwnerNotice: failed send stays retryable on redelivery, capped at 3 attempts', async () => {
  const dedup = createDedup({ file: path.join(tmp(), 's.json') });
  let calls = 0;
  const deps = { dedup, resolveEndpoint: async () => ({ channel: 'telegram', endpoint: '1' }), send: async () => { calls++; return false; } };
  assert.equal(await handleImOwnerNotice(SE, deps), 'failed');
  assert.equal(await handleImOwnerNotice(SE, deps), 'failed');
  assert.equal(await handleImOwnerNotice(SE, deps), 'failed');
  assert.equal(await handleImOwnerNotice(SE, deps), 'gave_up');
  assert.equal(await handleImOwnerNotice(SE, deps), 'duplicate');
  assert.equal(calls, 3);
  const d2 = createDedup({ file: path.join(tmp(), 's.json') });
  let n = 0;
  const flaky = { dedup: d2, resolveEndpoint: async () => ({ channel: 'telegram', endpoint: '1' }), send: async () => ++n > 1 };
  assert.equal(await handleImOwnerNotice(SE, flaky), 'failed');
  assert.equal(await handleImOwnerNotice(SE, flaky), 'sent');
  assert.equal(await handleImOwnerNotice(SE, flaky), 'duplicate');
});

test('handleImOwnerNotice: sends a stripped endpoint even if the resolver returns a raw one', async () => {
  const sends = [];
  await handleImOwnerNotice(SE, {
    dedup: createDedup({ file: path.join(tmp(), 's.json') }),
    resolveEndpoint: async () => ({ channel: 'telegram', endpoint: '7|msg:9|req:7:9' }),
    send: async (...a) => { sends.push(a); return true; },
  });
  assert.deepEqual(sends, [['telegram', '7', 'hello']]);
});

test('stripMessageParams: drops message-level params, keeps per-channel routing params', () => {
  const cases = [
    ['telegram', '123|msg:9|req:123:9|thread:4', '123'],
    ['lark', 'oc_1|type:p2p|root:om_r|parent:om_p|msg:om_m|thread:omt', 'oc_1|type:p2p'],
    ['slack', 'D1|type:dm|msg:1.2|thread:1.0', 'D1|type:dm'],
    ['discord', 'c1|msg:5|req:c1:5', 'c1'],
    ['line', 'U1|type:dm|account:default|user:U1|replyKey:rk', 'U1|type:dm|account:default|user:U1'],
    ['ms-teams', 'conv|type:dm|user:a1|msg:x', 'conv|type:dm|user:a1'],
    ['wechat', 'acct|to:wx1', 'acct|to:wx1'],
    ['dingtalk', 's1|type:p2p|msg:m', 's1|type:p2p'],
    ['zalo', 'z1|msg:1|req:x', 'z1'],
  ];
  for (const [ch, raw, want] of cases) assert.equal(stripMessageParams(raw), want, ch);
});

test('readC4InboundRows: falls back to sqlite3 CLI when node:sqlite is unavailable; warns once when neither works', async (t) => {
  const db = path.join(tmp(), 'c4.db');
  try {
    execFileSync('sqlite3', [db, `CREATE TABLE conversations (id INTEGER PRIMARY KEY, direction TEXT, channel TEXT, endpoint_id TEXT, content TEXT, timestamp TEXT);
      INSERT INTO conversations VALUES (1,'in','telegram','1|msg:1','hi','t1'),(2,'in','openmax','x','y','t2'),(3,'out','telegram','1','z','t3'),(4,'in','lark','oc|type:p2p|msg:o''x','[Lark DM] a','t4');`]);
  } catch { t.skip('sqlite3 CLI not installed'); return; }
  const noNode = async () => { throw Object.assign(new Error('nope'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' }); };
  const rows = await readC4InboundRows(db, 10, { nodeSqlite: noNode, warn: () => assert.fail('no warn') });
  assert.deepEqual(rows.map(r => [r.id, r.channel, r.endpoint_id]), [[4, 'lark', "oc|type:p2p|msg:o'x"], [1, 'telegram', '1|msg:1']]);
  _resetC4ReadWarning();
  const warns = [];
  const opts = { nodeSqlite: noNode, sqliteBin: '/nonexistent/sqlite3', warn: (m) => warns.push(m) };
  assert.deepEqual(await readC4InboundRows(db, 10, opts), []);
  assert.deepEqual(await readC4InboundRows(db, 10, opts), []);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /cannot read C4.*ERR_UNKNOWN_BUILTIN_MODULE.*ENOENT/);
});

test('classifySystemEvent: im owner notice wins over substring fallbacks', () => {
  assert.equal(IM_OWNER_NOTICE_EVENT, 'agent.im_owner_notice');
  assert.equal(classifySystemEvent('agent.im_owner_notice'), IM_OWNER_NOTICE_TYPE);
  assert.equal(classifySystemEvent('AGENT.IM_OWNER_NOTICE'), IM_OWNER_NOTICE_TYPE);
  assert.equal(classifySystemEvent('agent.config.updated'), 'config_update');
  assert.equal(classifySystemEvent('message.updated'), 'edit');
  assert.equal(classifySystemEvent('message.read'), null);
});

test('routeImOwnerNotice: dispatches the frame data to the handler; ignores other events', async () => {
  const got = []; const warns = [];
  const data = { event_id: 'e9', kind: 'agent_cap_90', text: 'hi' };
  const deps = { onNotice: async (n) => got.push(n), warn: (m) => warns.push(m) };
  assert.equal(await routeImOwnerNotice({ type: 'system', payload: { event: 'agent.im_owner_notice', data } }, deps), true);
  assert.deepEqual(got, [data]);
  assert.equal(await routeImOwnerNotice({ type: 'system', payload: { event: 'agent.im_owner_notice' } }, deps), true);
  assert.equal(got.length, 1);
  assert.match(warns[0], /missing data/);
  assert.equal(await routeImOwnerNotice({ type: 'system', payload: { event: 'message.updated', data } }, deps), false);
  assert.equal(got.length, 1);
});

test('end to end: system frame -> route -> handle -> c4-send stub gets the owner DM (not the stranger)', async () => {
  const componentsDir = componentsWithLogs({ lark: [
    { message_id: 'om1', user_id: 'uo', open_id: 'ou_o' }, { message_id: 'om2', user_id: 'stranger', open_id: 'ou_s' },
  ] });
  const rows = [
    { id: 2, channel: 'lark', endpoint_id: 'oc_s|type:p2p|msg:om2', timestamp: 't2' },
    { id: 1, channel: 'lark', endpoint_id: 'oc_o|type:p2p|msg:om1', timestamp: 't1' },
  ];
  const sends = [];
  const dedup = createDedup({ file: path.join(tmp(), 's.json') });
  const frame = { type: 'system', payload: { event: 'agent.im_owner_notice', data: { event_id: 'x1', kind: 'org_credits_exhausted', text: 'credits out' } } };
  await routeImOwnerNotice(frame, {
    onNotice: (n) => handleImOwnerNotice(n, {
      dedup,
      resolveEndpoint: () => refreshOwnerEndpoint({ cacheFile: path.join(tmp(), 'c.json'), componentsDir, readRows: async () => rows, loadConfig: () => ({ owner: { bound: true, user_id: 'uo', open_id: 'ou_o' }, whitelist: { enabled: false } }) }),
      send: async (...a) => { sends.push(a); return true; },
    }),
  });
  assert.deepEqual(sends, [['lark', 'oc_o|type:p2p', 'credits out']]);
});
