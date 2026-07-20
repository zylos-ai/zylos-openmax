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

test('persistent 404 → disable on first 404, warn once, and STOP issuing the PUT (no error.log flood)', async () => {
  let putCalls = 0;
  const putForOrg = async () => { putCalls += 1; const e = new Error('page not found'); e.status = 404; throw e; };
  const { report, warns } = harness({
    readPm2Statuses: async () => pm2Map([]),
    orgs: [{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }],
    putForOrg,
  });
  // First tick fires the PUT (gets 404 → disables). Next ~10 ticks must NOT
  // fire it — this is the flood fix: the HTTP client only logs its [rpc] pair
  // when the PUT is actually issued.
  for (let i = 0; i < 11; i++) await report();
  assert.equal(putCalls, 1, 'PUT issued exactly once, then suppressed');
  const disableWarns = warns.filter((w) => /returns 404 .*disabling reporter/.test(w));
  assert.equal(disableWarns.length, 1, 'the 404 is logged exactly once, not every tick');
});

test('404 backoff re-probes after reprobeEveryTicks and stays quiet if still 404', async () => {
  let putCalls = 0;
  const putForOrg = async () => { putCalls += 1; const e = new Error('not found'); e.status = 404; throw e; };
  const puts = [];
  const warns = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: noop, warn: (m) => warns.push(m), apiPath, readPm2Statuses: async () => pm2Map([]), putForOrg,
    reprobeEveryTicks: 3,
  });
  await report();            // tick 1: PUT → 404 → disabled (putCalls=1)
  await report();            // tick 2: disabled, skip
  await report();            // tick 3: disabled, skip (ticksSinceDisabled=2 < 3)
  assert.equal(putCalls, 1, 'no PUT during the backoff window');
  await report();            // tick 4: re-probe → PUT → still 404 (putCalls=2)
  assert.equal(putCalls, 2, 're-probe issues exactly one PUT');
  const disableWarns = warns.filter((w) => /disabling reporter/.test(w));
  assert.equal(disableWarns.length, 1, 're-probe that still 404s does not re-warn');
});

test('404 backoff self-heals: a later successful probe re-enables the reporter', async () => {
  let call = 0;
  const putForOrg = async () => {
    call += 1;
    if (call === 1) { const e = new Error('not found'); e.status = 404; throw e; }
    // subsequent calls succeed
  };
  const logs = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: (m) => logs.push(m), warn: noop, apiPath, readPm2Statuses: async () => pm2Map(['zylos-lark']), putForOrg,
    reprobeEveryTicks: 2,
  });
  await report();            // 404 → disabled
  await report();            // skipped (ticksSinceDisabled=1 < 2)
  await report();            // re-probe → succeeds → re-enabled
  await report();            // now enabled again → reports normally every tick
  assert.equal(call, 3, 'two successful PUTs after the single 404 (probe + next tick)');
  assert.ok(logs.some((m) => /endpoint recovered/.test(m)), 'recovery is announced');
});

test('disable404Threshold: stays retrying until the threshold, then disables', async () => {
  let putCalls = 0;
  const putForOrg = async () => { putCalls += 1; const e = new Error('nf'); e.status = 404; throw e; };
  const warns = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: noop, warn: (m) => warns.push(m), apiPath, readPm2Statuses: async () => pm2Map([]), putForOrg,
    disable404Threshold: 3, reprobeEveryTicks: 100,
  });
  await report(); await report(); // 2 x 404, below threshold → still trying, not disabled
  assert.equal(putCalls, 2);
  assert.equal(warns.filter((w) => /disabling reporter/.test(w)).length, 0, 'not yet disabled');
  await report();                 // 3rd 404 hits threshold → disable
  assert.equal(putCalls, 3);
  await report();                 // disabled → skipped
  assert.equal(putCalls, 3, 'no further PUT after the 3rd 404 disables it');
  assert.equal(warns.filter((w) => /disabling reporter/.test(w)).length, 1);
});

test('non-404 errors keep retrying and never disable the reporter', async () => {
  let putCalls = 0;
  const putForOrg = async () => { putCalls += 1; const e = new Error('boom'); e.status = 503; throw e; };
  const warns = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: noop, warn: (m) => warns.push(m), apiPath, readPm2Statuses: async () => pm2Map([]), putForOrg,
  });
  await report(); await report(); await report();
  assert.equal(putCalls, 3, '5xx keeps retrying every tick — unchanged behavior');
  assert.equal(warns.filter((w) => /disabling reporter/.test(w)).length, 0);
  assert.ok(warns.filter((w) => /report failed: boom/.test(w)).length >= 1);
});

test('a 404 streak interrupted by a non-404 error resets the streak', async () => {
  let call = 0;
  // 404, then a transient 5xx, then 404 again — with threshold 2 the reporter
  // must NOT disable, because the 5xx reset the consecutive-404 count.
  const putForOrg = async () => {
    call += 1;
    const e = new Error('x');
    e.status = call === 2 ? 503 : 404;
    throw e;
  };
  const warns = [];
  const report = createChannelLivenessReporter(orgMap([{ slug: 'orgA', org_id: 'org-A', self: { member_id: 'm-A' } }]), {
    log: noop, warn: (m) => warns.push(m), apiPath, readPm2Statuses: async () => pm2Map([]), putForOrg,
    disable404Threshold: 2, reprobeEveryTicks: 100,
  });
  await report(); // 404 (streak=1)
  await report(); // 503 (streak reset to 0)
  await report(); // 404 (streak=1, below threshold 2)
  assert.equal(call, 3, 'all three ticks issued the PUT — never disabled');
  assert.equal(warns.filter((w) => /disabling reporter/.test(w)).length, 0);
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
