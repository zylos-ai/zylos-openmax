import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createChannelLivenessReporter,
  CHANNEL_TYPES,
} from './channel-liveness-reporter.js';
import { CHANNEL_COMPONENT } from './channel-connector.js';

const noop = () => {};
const apiPath = (p) => `/api/v1${p}`;

// Build a pm2 jlist-derived Map (name → online bool) for the given set of
// online pm2 service names; every other known service is offline.
function pm2Map(onlineServices = []) {
  const m = new Map();
  for (const ct of CHANNEL_TYPES) {
    m.set(CHANNEL_COMPONENT[ct].pm2Service, onlineServices.includes(CHANNEL_COMPONENT[ct].pm2Service));
  }
  // A couple of non-IM processes that must be ignored by the reporter.
  m.set('zylos-openmax', true);
  m.set('zylos-dashboard', true);
  return m;
}

function orgMap(entries) {
  return new Map(entries.map((o) => [o.slug, o]));
}

function harness({ readPm2Statuses, orgs, putForOrg }) {
  const puts = [];
  const warns = [];
  const logs = [];
  const defaultPut = async (orgId, path, payload) => { puts.push({ orgId, path, payload }); };
  const report = createChannelLivenessReporter(orgMap(orgs), {
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    apiPath,
    readPm2Statuses,
    putForOrg: putForOrg || defaultPut,
  });
  return { report, puts, warns, logs };
}

test('CHANNEL_TYPES is exactly the 13 cws-connect catalog values', () => {
  assert.equal(CHANNEL_TYPES.length, 13);
  assert.deepEqual(
    [...CHANNEL_TYPES].sort(),
    ['dingtalk', 'discord', 'feishu', 'lark', 'line', 'ms_teams', 'slack',
     'telegram', 'wechat', 'wecom', 'whatsapp', 'whatsapp_business', 'zalo'].sort(),
  );
});

test('healthy pm2: single PUT of 13 channels with correct online flags to the primary org self.member_id', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => pm2Map(['zylos-telegram', 'zylos-slack']),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
  });
  await report();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].orgId, 'org-A');
  assert.equal(puts[0].path, '/api/v1/agents/m-A/channel-liveness');
  const { channels } = puts[0].payload;
  assert.equal(channels.length, 13);
  // Body carries no identity — only channels.
  assert.deepEqual(Object.keys(puts[0].payload), ['channels']);
  const online = channels.filter((c) => c.online).map((c) => c.channel_type).sort();
  assert.deepEqual(online, ['slack', 'telegram']);
  assert.equal(warns.length, 0);
});

test('safety guard: pm2 jlist failure (null) → no PUT, warn once', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => null,
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
  });
  await report();
  await report(); // second failing tick must NOT warn again
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /pm2 jlist unavailable/);
});

test('safety guard: empty pm2 map → no PUT, warn once (never all-offline report)', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => new Map(),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
  });
  await report();
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
});

test('pm2 recovers after a failure → once-guard re-arms and reports', async () => {
  let call = 0;
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => (++call === 1 ? null : pm2Map(['zylos-lark'])),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
  });
  await report(); // fails, warns once
  await report(); // recovers, PUTs
  assert.equal(puts.length, 1);
  assert.equal(warns.length, 1);
  const online = puts[0].payload.channels.filter((c) => c.online).map((c) => c.channel_type);
  assert.deepEqual(online, ['lark']);
});

test('multi-org: reports ONCE to the primary (first) org only — a single PUT', async () => {
  const { report, puts } = harness({
    readPm2Statuses: async () => pm2Map(['zylos-discord']),
    orgs: [
      { slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } },
      { slug: 'orgB', org_id: 'org-B', self: { member_id: 'm-B' } },
    ],
  });
  await report();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].orgId, 'org-A');
  assert.equal(puts[0].path, '/api/v1/agents/m-A/channel-liveness');
});

test('primary org without self.member_id → warned, no PUT (does not fall through to other orgs)', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [
      { slug: 'orgA', org_id: 'org-A', self: {} },
      { slug: 'orgB', org_id: 'org-B', self: { member_id: 'm-B' } },
    ],
  });
  await report();
  assert.equal(puts.length, 0);
  assert.match(warns.find((w) => /orgA/.test(w)), /primary org has no self\.member_id/);
});

test('endpoint 404 → warn once, no throw, does not report again quietly', async () => {
  const putForOrg = async () => { const e = new Error('not found'); e.status = 404; throw e; };
  const { report, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
    putForOrg,
  });
  await report();
  await report();
  const e404 = warns.filter((w) => /endpoint not available \(404\)/.test(w));
  assert.equal(e404.length, 1);
});

test('non-404 PUT error is caught (best-effort, never throws into the tick)', async () => {
  const putForOrg = async () => { throw new Error('boom'); };
  const { report, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
    putForOrg,
  });
  await assert.doesNotReject(report());
  assert.match(warns.find((w) => /report failed/.test(w)), /boom/);
});

test('no active orgs → warn, no PUT', async () => {
  const { report, puts, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [],
  });
  await report();
  assert.equal(puts.length, 0);
  assert.match(warns[0], /no active org/);
});
