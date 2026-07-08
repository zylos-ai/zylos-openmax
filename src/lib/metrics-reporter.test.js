import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsReporter } from './metrics-reporter.js';

const noop = () => {};
const apiPath = (p) => `/api/v1${p}`;

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const DASHBOARD_STATE = { state: 'IDLE', system_metrics: { cpu_pct: 1 }, runtime_info: {} };

// exchange / state are per-call responders: (call) => response.
// call = { headers, method } as passed to fetch.
function makeHarness({ dashboardApiKey = '', state, exchange, nowRef = { t: 0 } } = {}) {
  const exchangeCalls = [];
  const stateCalls = [];
  const puts = [];
  const warns = [];
  const fakeFetch = async (url, opts = {}) => {
    const { pathname } = new URL(url);
    const call = { headers: opts.headers || {}, method: opts.method || 'GET' };
    if (pathname === '/api/auth/token') {
      exchangeCalls.push(call);
      return exchange
        ? exchange(call)
        : jsonRes(200, { token: 'zylos_st_1', expires_at: '2099-01-01T00:00:00Z', ttl_seconds: 600, scope: 'read' });
    }
    if (pathname === '/api/state') {
      stateCalls.push(call);
      return state ? state(call) : jsonRes(200, DASHBOARD_STATE);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  const reporter = createMetricsReporter(
    new Map([['org-a', { org_id: 'org-id-a', self: { member_id: 'm-1' } }]]),
    {
      log: noop,
      warn: (m) => warns.push(m),
      dashboardApiKey,
      fetch: fakeFetch,
      now: () => nowRef.t,
      putForOrg: async (orgId, path, payload) => { puts.push({ orgId, path, payload }); },
      apiPath,
    },
  );
  return { reporter, exchangeCalls, stateCalls, puts, warns };
}

test('无 key + state 200：直接拉取（不带 Authorization、不换 token）并发出 PUT', async () => {
  const { reporter, exchangeCalls, stateCalls, puts, warns } = makeHarness();
  await reporter();
  assert.equal(exchangeCalls.length, 0);
  assert.equal(stateCalls.length, 1);
  assert.equal(stateCalls[0].headers.Authorization, undefined);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, '/api/v1/agents/m-1/runtime-metrics');
  assert.equal(puts[0].payload.resources.cpu_pct, 1);
  assert.equal(warns.length, 0);
});

test('无 key + state 401：只 warn 一次（带 http 状态码），不发 PUT', async () => {
  const { reporter, puts, warns } = makeHarness({
    state: () => jsonRes(401, { error: 'unauthorized' }),
  });
  await reporter();
  await reporter();
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /http 401/);
  assert.match(warns[0], /metricsReport\.dashboardApiKey/);
});

test('配了 key：先换 token（Bearer ak），state 带 Bearer st，PUT 发出；第二轮复用缓存 token', async () => {
  const { reporter, exchangeCalls, stateCalls, puts, warns } = makeHarness({
    dashboardApiKey: 'zylos_ak_k1',
  });
  await reporter();
  assert.equal(exchangeCalls.length, 1);
  assert.equal(exchangeCalls[0].method, 'POST');
  assert.equal(exchangeCalls[0].headers.Authorization, 'Bearer zylos_ak_k1');
  assert.equal(stateCalls.length, 1);
  assert.equal(stateCalls[0].headers.Authorization, 'Bearer zylos_st_1');
  assert.equal(puts.length, 1);

  await reporter(); // token 未过期 — 不再换
  assert.equal(exchangeCalls.length, 1);
  assert.equal(stateCalls.length, 2);
  assert.equal(puts.length, 2);
  assert.equal(warns.length, 0);
});

test('state 401（token 失效）：重新换一次 token 并只重试一次', async () => {
  let n = 0;
  const { reporter, exchangeCalls, stateCalls, puts } = makeHarness({
    dashboardApiKey: 'zylos_ak_k1',
    exchange: () => { n += 1; return jsonRes(200, { token: `st-${n}`, ttl_seconds: 600 }); },
    state: (call) => (call.headers.Authorization === 'Bearer st-2'
      ? jsonRes(200, DASHBOARD_STATE)
      : jsonRes(401, { error: 'unauthorized' })),
  });
  await reporter();
  assert.equal(exchangeCalls.length, 2); // 首次换 + 401 后重换一次
  assert.equal(stateCalls.length, 2);    // 原始请求 + 单次重试
  assert.equal(puts.length, 1);
});

test('state 持续 401：重试一次后放弃并 warn，不无限换 token', async () => {
  const { reporter, exchangeCalls, stateCalls, puts, warns } = makeHarness({
    dashboardApiKey: 'zylos_ak_k1',
    exchange: () => jsonRes(200, { token: 'st-x', ttl_seconds: 600 }),
    state: () => jsonRes(401, { error: 'unauthorized' }),
  });
  await reporter();
  assert.equal(exchangeCalls.length, 2);
  assert.equal(stateCalls.length, 2);
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /http 401/);
});

test('key 无效（换 token 401）：只 warn 一次，本进程不再尝试换 token', async () => {
  const { reporter, exchangeCalls, stateCalls, puts, warns } = makeHarness({
    dashboardApiKey: 'zylos_ak_bad',
    exchange: () => jsonRes(401, { error: 'unauthorized' }),
  });
  await reporter();
  await reporter();
  await reporter();
  assert.equal(exchangeCalls.length, 1); // 拒绝后不再重试
  assert.equal(stateCalls.length, 0);
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /api key rejected \(401\)/);
});

test('token 到期（含安全边际）：下一轮重新换 token', async () => {
  const nowRef = { t: 0 };
  let n = 0;
  const { reporter, exchangeCalls, puts } = makeHarness({
    dashboardApiKey: 'zylos_ak_k1',
    exchange: () => { n += 1; return jsonRes(200, { token: `st-${n}`, ttl_seconds: 600 }); },
    nowRef,
  });
  await reporter();
  assert.equal(exchangeCalls.length, 1);
  nowRef.t = 580_000; // ttl 600s，30s 边际 → 570s 后视为过期
  await reporter();
  assert.equal(exchangeCalls.length, 2);
  assert.equal(puts.length, 2);
});

test('恢复后重置 warn-once：401 → warn，成功一次，再 401 → 再 warn', async () => {
  const responses = [
    jsonRes(401, { error: 'unauthorized' }),
    jsonRes(200, DASHBOARD_STATE),
    jsonRes(401, { error: 'unauthorized' }),
  ];
  const { reporter, puts, warns } = makeHarness({
    state: () => responses.shift(),
  });
  await reporter();
  assert.equal(warns.length, 1);
  await reporter(); // 恢复 — PUT 发出，warn-once 重置
  assert.equal(puts.length, 1);
  await reporter();
  assert.equal(warns.length, 2);
});
