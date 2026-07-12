import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOrgLLMSuspended,
  planStateCache,
  PLAN_STATE_TTL_MS,
  OVERDUE_NOTICE,
} from './billing-status.js';

const org = (id = 'org-1') => ({ org_id: id, slug: id });

// getForOrg stub factory: records calls, returns a plan-state body (the
// D8-unwrapped `data` shape getForOrg hands back).
function stubGet({ suspended, body, throws } = {}) {
  const calls = [];
  const getForOrg = async (orgId, path) => {
    calls.push({ orgId, path });
    if (throws) throw (throws instanceof Error ? throws : new Error(String(throws)));
    if (body !== undefined) return body;
    return { usage_snapshot: { enforcement_suspended: suspended } };
  };
  return { getForOrg, calls };
}

beforeEach(() => planStateCache.clear());

test('enforcement_suspended=true → returns true', async () => {
  const { getForOrg } = stubGet({ suspended: true });
  assert.equal(await isOrgLLMSuspended(org(), { getForOrg }), true);
});

test('enforcement_suspended=false → returns false', async () => {
  const { getForOrg } = stubGet({ suspended: false });
  assert.equal(await isOrgLLMSuspended(org(), { getForOrg }), false);
});

test('missing usage_snapshot / field → false', async () => {
  const a = stubGet({ body: {} });
  assert.equal(await isOrgLLMSuspended(org('a'), { getForOrg: a.getForOrg }), false);
  const b = stubGet({ body: { usage_snapshot: {} } });
  assert.equal(await isOrgLLMSuspended(org('b'), { getForOrg: b.getForOrg }), false);
});

test('non-boolean-true (e.g. truthy string) is NOT treated as suspended', async () => {
  const { getForOrg } = stubGet({ body: { usage_snapshot: { enforcement_suspended: 'true' } } });
  assert.equal(await isOrgLLMSuspended(org(), { getForOrg }), false);
});

test('tolerates a full (non-unwrapped) envelope: body.data.usage_snapshot', async () => {
  const { getForOrg } = stubGet({ body: { data: { usage_snapshot: { enforcement_suspended: true } } } });
  assert.equal(await isOrgLLMSuspended(org(), { getForOrg }), true);
});

test('TTL cache: second call within TTL does not re-fetch', async () => {
  const { getForOrg, calls } = stubGet({ suspended: true });
  const t = 1_000_000;
  assert.equal(await isOrgLLMSuspended(org(), { getForOrg, now: () => t }), true);
  assert.equal(await isOrgLLMSuspended(org(), { getForOrg, now: () => t + PLAN_STATE_TTL_MS - 1 }), true);
  assert.equal(calls.length, 1, 'served from cache within TTL');
});

test('TTL cache: after TTL expires it re-fetches', async () => {
  const { getForOrg, calls } = stubGet({ suspended: true });
  const t = 2_000_000;
  await isOrgLLMSuspended(org(), { getForOrg, now: () => t });
  await isOrgLLMSuspended(org(), { getForOrg, now: () => t + PLAN_STATE_TTL_MS + 1 });
  assert.equal(calls.length, 2, 'refetched after TTL');
});

test('cache is keyed per org_id', async () => {
  const { getForOrg, calls } = stubGet({ suspended: true });
  const t = 3_000_000;
  await isOrgLLMSuspended(org('x'), { getForOrg, now: () => t });
  await isOrgLLMSuspended(org('y'), { getForOrg, now: () => t });
  assert.equal(calls.length, 2, 'different orgs do not share a cache slot');
});

test('fail-open: getForOrg throws → false (and warns)', async () => {
  const { getForOrg } = stubGet({ throws: new Error('network down') });
  let warned = 0;
  assert.equal(await isOrgLLMSuspended(org(), { getForOrg, warn: () => { warned += 1; } }), false);
  assert.equal(warned, 1);
});

test('fail-open: non-object body → false', async () => {
  const { getForOrg } = stubGet({ body: 'not json' });
  assert.equal(await isOrgLLMSuspended(org(), { getForOrg, warn: () => {} }), false);
});

test('missing org_id → false without querying', async () => {
  const { getForOrg, calls } = stubGet({ suspended: true });
  assert.equal(await isOrgLLMSuspended({ slug: 'no-id' }, { getForOrg }), false);
  assert.equal(calls.length, 0);
});

test('queries the plan-state path through the org-scoped client', async () => {
  const { getForOrg, calls } = stubGet({ suspended: false });
  await isOrgLLMSuspended(org('org-42'), { getForOrg });
  assert.equal(calls[0].orgId, 'org-42');
  assert.match(calls[0].path, /\/billing\/plan-state$/);
});

test('OVERDUE_NOTICE is bilingual (zh + en on separate lines)', () => {
  const lines = OVERDUE_NOTICE.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /积分/);
  assert.match(lines[1], /credits/i);
});
