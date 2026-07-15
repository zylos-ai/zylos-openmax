import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createMetricsReporter,
} from './metrics-reporter.js';

const noop = () => {};
const apiPath = (p) => `/api/v1${p}`;

function jsonRes(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const DASHBOARD_STATE = {
  state: 'IDLE',
  // cpu_pct here is deliberately node-level junk the reporter must IGNORE now
  // that CPU/memory come from the cgroup collector, not the dashboard. disk_*
  // is still sourced from the dashboard.
  system_metrics: { cpu_pct: 1, disk_pct: 7, disk_free_bytes: 999 },
  runtime_info: {},
};

// Deterministic stand-in for the cgroup collector (cpu/mem source of truth).
const FAKE_CGROUP = {
  sample() {},
  read: () => ({
    cpu_pct: 12.5,
    cpu_usage_cores: 0.25,
    cpu_limit_cores: 2,
    mem_pct: 40,
    mem_total_bytes: 800_000_000,
    mem_used_bytes: 320_000_000,
    cgroup_version: 'v2',
    errors: [],
  }),
};

const CLI_PATH = '/fake/skills/dashboard/scripts/api-key.js';

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// exchange / state are per-call responders: (call) => response.
// call = { headers, method } as passed to fetch.
// cli is a per-invocation responder: (argv) => { stdout } (throw to simulate
// a non-zero exit; attach .stdout/.stderr like child_process does). Default:
// `generate` succeeds and prints `Key: zylos_ak_auto1`.
// Default `zylos list` output: two IM channels (lark, telegram) plus non-IM
// components that must be filtered out (browser, dashboard, openmax).
const ZYLOS_LIST_DEFAULT = [
  'Installed Components',
  '====================',
  '',
  '✓ browser (v0.1.3)',
  '✓ lark (v0.3.5)',
  '✓ telegram (v0.4.0)',
  '✓ dashboard (v0.5.1)',
  '✓ openmax (v2.7.2)',
  '',
].join('\n');

// Default `pm2 jlist`: lark online, telegram stopped.
const PM2_JLIST_DEFAULT = JSON.stringify([
  { name: 'zylos-lark', pm2_env: { status: 'online' } },
  { name: 'zylos-telegram', pm2_env: { status: 'stopped' } },
]);

function makeHarness({
  dashboardApiKey = '', state, exchange, cli, fileExists, nowRef = { t: 0 },
  zylosList = ZYLOS_LIST_DEFAULT, pm2Jlist = PM2_JLIST_DEFAULT, cgroup = FAKE_CGROUP,
} = {}) {
  const exchangeCalls = [];
  const stateCalls = [];
  const puts = [];
  const warns = [];
  const cliCalls = [];
  const channelCalls = [];
  const persisted = [];
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
  const fakeExecFile = async (file, args) => {
    // installed_channels derivation shells out to `zylos list` / `pm2 jlist`.
    if (file === 'zylos') {
      channelCalls.push(['zylos', ...args]);
      if (zylosList instanceof Error) throw zylosList;
      return { stdout: zylosList };
    }
    if (file === 'pm2') {
      channelCalls.push(['pm2', ...args]);
      if (pm2Jlist instanceof Error) throw pm2Jlist;
      return { stdout: pm2Jlist };
    }
    // dashboard api-key CLI (auto-provision path)
    assert.equal(args[0], CLI_PATH);
    const argv = args.slice(1); // e.g. ['generate', 'openmax-metrics', 'read']
    cliCalls.push(argv);
    if (cli) return cli(argv);
    return { stdout: 'API key generated\nName: openmax-metrics\nKey: zylos_ak_auto1\nScope: read\n' };
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
      execFile: fakeExecFile,
      fileExists: fileExists ?? (() => true),
      persistKey: (k) => persisted.push(k),
      apiKeyCliPath: CLI_PATH,
      cgroup,
    },
  );
  return { reporter, exchangeCalls, stateCalls, puts, warns, cliCalls, channelCalls, persisted };
}

test('无 key + state 200：直接拉取（不带 Authorization、不换 token）并发出 PUT', async () => {
  const { reporter, exchangeCalls, stateCalls, puts, warns } = makeHarness();
  await reporter();
  assert.equal(exchangeCalls.length, 0);
  assert.equal(stateCalls.length, 1);
  assert.equal(stateCalls[0].headers.Authorization, undefined);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].path, '/api/v1/agents/m-1/runtime-metrics');
  // cpu/mem come from the cgroup collector; disk still from the dashboard.
  assert.equal(puts[0].payload.resources.cpu_pct, 12.5);
  assert.equal(puts[0].payload.resources.mem_pct, 40);
  assert.equal(puts[0].payload.resources.mem_total_bytes, 800_000_000);
  assert.equal(puts[0].payload.resources.mem_used_bytes, 320_000_000);
  assert.equal(puts[0].payload.resources.disk_pct, 7);
  assert.equal(puts[0].payload.resources.disk_free_bytes, 999);
  assert.equal(warns.length, 0);
});

test('payload 携带顶层 version 字段（openmax package version）', async () => {
  const { reporter, puts } = makeHarness();
  await reporter();
  assert.equal(puts.length, 1);
  const pkgVersion = JSON.parse(
    fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
  ).version;
  assert.equal(puts[0].payload.version, pkgVersion);
});

test('多 org：只上报给主（第一个启用的）org，单次 PUT', async () => {
  const puts = [];
  const warns = [];
  const reporter = createMetricsReporter(
    new Map([
      ['coco', { org_id: 'org-primary', self: { member_id: 'm-primary' } }],
      ['other', { org_id: 'org-secondary', self: { member_id: 'm-secondary' } }],
    ]),
    {
      log: noop,
      warn: (m) => warns.push(m),
      fetch: async (url) => {
        const { pathname } = new URL(url);
        if (pathname === '/api/state') return jsonRes(200, DASHBOARD_STATE);
        throw new Error(`unexpected fetch: ${url}`);
      },
      now: () => 0,
      putForOrg: async (orgId, path, payload) => { puts.push({ orgId, path, payload }); },
      apiPath,
      execFile: async () => { throw new Error('skip channels'); },
      fileExists: () => true,
      cgroup: FAKE_CGROUP,
    },
  );
  await reporter();
  assert.equal(puts.length, 1); // 单次 PUT，不循环所有 org
  assert.equal(puts[0].orgId, 'org-primary');
  assert.equal(puts[0].path, '/api/v1/agents/m-primary/runtime-metrics');
});

test('空 org Map：不 PUT，优雅 warn 一次', async () => {
  const puts = [];
  const warns = [];
  const reporter = createMetricsReporter(new Map(), {
    log: noop,
    warn: (m) => warns.push(m),
    fetch: async (url) => {
      const { pathname } = new URL(url);
      if (pathname === '/api/state') return jsonRes(200, DASHBOARD_STATE);
      throw new Error(`unexpected fetch: ${url}`);
    },
    now: () => 0,
    putForOrg: async (orgId, path, payload) => { puts.push({ orgId, path, payload }); },
    apiPath,
    execFile: async () => { throw new Error('skip channels'); },
    fileExists: () => true,
  });
  await reporter();
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /no active org/);
});

test('无 key + state 持续 401：自动供给 key 后 state 仍 401 → 只 warn 一次（带 http 状态码），不发 PUT，不重复供给', async () => {
  const { reporter, puts, warns, cliCalls } = makeHarness({
    state: () => jsonRes(401, { error: 'unauthorized' }),
  });
  await reporter();
  await reporter();
  assert.equal(cliCalls.length, 1); // 401 触发一次自动供给，之后不再供给
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

test('key 无效且自动供给的新 key 也被拒（换 token 持续 401）：只供给一次、只 warn 一次，之后静默', async () => {
  const { reporter, exchangeCalls, stateCalls, puts, warns, cliCalls, persisted } = makeHarness({
    dashboardApiKey: 'zylos_ak_bad',
    exchange: () => jsonRes(401, { error: 'unauthorized' }),
  });
  await reporter();
  await reporter();
  await reporter();
  assert.equal(cliCalls.length, 1);      // 供给一次（generate），不 rotate 循环
  assert.deepEqual(cliCalls[0], ['generate', 'openmax-metrics', 'read']);
  assert.deepEqual(persisted, ['zylos_ak_auto1']); // 新 key 仍会持久化（下次重启再试）
  assert.equal(exchangeCalls.length, 2); // 原 key 一次 + 新 key 一次，之后静默
  assert.equal(exchangeCalls[1].headers.Authorization, 'Bearer zylos_ak_auto1');
  assert.equal(stateCalls.length, 0);
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /rejected \(401\) after auto-provision/);
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

test('恢复后重置 warn-once：503 → warn，成功一次，再 503 → 再 warn', async () => {
  const responses = [
    jsonRes(503, { error: 'unavailable' }),
    jsonRes(200, DASHBOARD_STATE),
    jsonRes(503, { error: 'unavailable' }),
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

// ============================================================================
// API-key 自动供给（dashboard 本地 CLI）
// ============================================================================

// 只有携带有效 session token 才放行 /api/state（模拟 dashboard 开启了 auth）。
const authedState = (call) => (call.headers.Authorization === 'Bearer zylos_st_1'
  ? jsonRes(200, DASHBOARD_STATE)
  : jsonRes(401, { error: 'unauthorized' }));

test('无 key + auth 开启 + CLI generate 成功：key 持久化、用新 key 换 token、同一 tick 内发出 PUT', async () => {
  const { reporter, exchangeCalls, puts, warns, cliCalls, persisted } = makeHarness({
    state: authedState,
  });
  await reporter();
  assert.deepEqual(cliCalls, [['generate', 'openmax-metrics', 'read']]);
  assert.deepEqual(persisted, ['zylos_ak_auto1']);
  assert.equal(exchangeCalls.length, 1);
  assert.equal(exchangeCalls[0].headers.Authorization, 'Bearer zylos_ak_auto1');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].payload.resources.cpu_pct, 12.5);
  assert.equal(warns.length, 0);

  await reporter(); // 之后正常复用缓存 token，不再碰 CLI
  assert.equal(cliCalls.length, 1);
  assert.equal(puts.length, 2);
});

test('无 key + generate 报 already exists：回退 rotate → 成功', async () => {
  const { reporter, exchangeCalls, puts, warns, cliCalls, persisted } = makeHarness({
    state: authedState,
    cli: (argv) => {
      if (argv[0] === 'generate') {
        const err = new Error('Command failed: api-key.js generate');
        err.code = 1;
        err.stderr = 'Error: API key "openmax-metrics" already exists — use rotate to replace it\n';
        throw err;
      }
      return { stdout: 'API key rotated\nName: openmax-metrics\nNew key: zylos_ak_auto1\nPrevious key and its sessions have been invalidated.\n' };
    },
  });
  await reporter();
  assert.deepEqual(cliCalls, [
    ['generate', 'openmax-metrics', 'read'],
    ['rotate', 'openmax-metrics'],
  ]);
  assert.deepEqual(persisted, ['zylos_ak_auto1']);
  assert.equal(exchangeCalls[0].headers.Authorization, 'Bearer zylos_ak_auto1');
  assert.equal(puts.length, 1);
  assert.equal(warns.length, 0);
});

test('并发 tick 共享同一次自动供给：不会因第二个 tick 提前静默成功进程', async () => {
  const cliGate = deferred();
  let cliStarted = 0;
  const { reporter, exchangeCalls, stateCalls, puts, warns, cliCalls, persisted } = makeHarness({
    state: authedState,
    cli: async () => {
      cliStarted += 1;
      await cliGate.promise;
      return { stdout: 'API key generated\nName: openmax-metrics\nKey: zylos_ak_auto1\nScope: read\n' };
    },
  });

  const first = reporter();
  const second = reporter();
  while (cliStarted === 0) await new Promise((resolve) => setImmediate(resolve));
  cliGate.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(cliCalls, [['generate', 'openmax-metrics', 'read']]);
  assert.deepEqual(persisted, ['zylos_ak_auto1']);
  assert.equal(exchangeCalls.length, 2);
  assert.equal(stateCalls.length, 4); // two unauthenticated probes + two authenticated retries
  assert.equal(puts.length, 2);
  assert.equal(warns.length, 0);

  await reporter();
  assert.equal(cliCalls.length, 1);
  assert.equal(puts.length, 3);
  assert.equal(warns.length, 0);
});

test('配了 key 但换 token 401：自动供给一次 → 用新 key 成功', async () => {
  const { reporter, exchangeCalls, puts, warns, cliCalls, persisted } = makeHarness({
    dashboardApiKey: 'zylos_ak_stale',
    state: authedState,
    exchange: (call) => (call.headers.Authorization === 'Bearer zylos_ak_auto1'
      ? jsonRes(200, { token: 'zylos_st_1', ttl_seconds: 600 })
      : jsonRes(401, { error: 'unauthorized' })),
  });
  await reporter();
  assert.equal(exchangeCalls.length, 2); // 配置的 key 先试（被拒）→ 供给后用新 key 再试
  assert.equal(exchangeCalls[0].headers.Authorization, 'Bearer zylos_ak_stale');
  assert.equal(exchangeCalls[1].headers.Authorization, 'Bearer zylos_ak_auto1');
  assert.deepEqual(cliCalls, [['generate', 'openmax-metrics', 'read']]);
  assert.deepEqual(persisted, ['zylos_ak_auto1']);
  assert.equal(puts.length, 1);
  assert.equal(warns.length, 0);
});

test('CLI 不存在：warn 一次（提示需要 dashboard 组件 / 手工配 key），之后静默且不再尝试 CLI', async () => {
  const { reporter, stateCalls, puts, warns, cliCalls } = makeHarness({
    state: authedState,
    fileExists: () => false,
  });
  await reporter();
  await reporter();
  await reporter();
  assert.equal(cliCalls.length, 0);   // 路径检查失败，从未执行 CLI
  assert.equal(stateCalls.length, 1); // 静默后连 state 都不再拉
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /auto-provision failed/);
  assert.match(warns[0], /dashboard component/);
  assert.match(warns[0], /metricsReport\.dashboardApiKey/);
});

test('CLI 输出无法解析出 key：视为供给失败 → warn 一次后静默', async () => {
  const { reporter, puts, warns, cliCalls, persisted } = makeHarness({
    state: authedState,
    cli: () => ({ stdout: 'something went sideways, no key here\n' }),
  });
  await reporter();
  await reporter();
  assert.equal(cliCalls.length, 1);
  assert.deepEqual(persisted, []);
  assert.equal(puts.length, 0);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /auto-provision failed/);
});

test('供给成功后同进程再遇 401：不再二次供给，warn 一次后静默', async () => {
  // 供给出的新 key 第一轮工作正常；随后 dashboard 侧把 key 和 session 都作废。
  let keyValid = true;
  const { reporter, exchangeCalls, stateCalls, puts, warns, cliCalls } = makeHarness({
    state: (call) => (keyValid && call.headers.Authorization === 'Bearer zylos_st_1'
      ? jsonRes(200, DASHBOARD_STATE)
      : jsonRes(401, { error: 'unauthorized' })),
    exchange: (call) => (keyValid && call.headers.Authorization === 'Bearer zylos_ak_auto1'
      ? jsonRes(200, { token: 'zylos_st_1', ttl_seconds: 600 })
      : jsonRes(401, { error: 'unauthorized' })),
  });
  await reporter(); // 无 key → 供给 → 成功 PUT
  assert.equal(cliCalls.length, 1);
  assert.equal(puts.length, 1);

  keyValid = false; // 作废：state 401 → 重换 token 也 401（key 无效）
  await reporter();
  assert.equal(cliCalls.length, 1); // 不做第二次供给（避免 rotate 循环）
  assert.equal(warns.length, 1);
  assert.match(warns[0], /rejected \(401\) after auto-provision/);

  const exchangesSoFar = exchangeCalls.length;
  const statesSoFar = stateCalls.length;
  await reporter(); // 静默：不再碰 CLI / 换 token / 拉 state
  await reporter();
  assert.equal(cliCalls.length, 1);
  assert.equal(exchangeCalls.length, exchangesSoFar);
  assert.equal(stateCalls.length, statesSoFar);
  assert.equal(warns.length, 1);
  assert.equal(puts.length, 1);
});

// installed_channels reporting was removed (connect/disconnect redesign):
// channel-binding status is now driven by the connector's connect-result
// callback, not by reconciling a periodic installed-channels report. The
// per-channel derivation + its tests were removed accordingly.
