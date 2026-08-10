import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessGate, createGatedOnlineReporter, READINESS_DEFAULTS } from './agent-readiness.js';

const NOW = 1_700_000_000_000;
const LAUNCH_AT = NOW - 60_000;

function readyStatus(overrides = {}) {
  return {
    data: {
      state: 'idle',
      health: 'ok',
      idle_seconds: 30,
      runtime_launch_at: LAUNCH_AT,
      ...overrides,
    },
    mtimeMs: NOW,
  };
}

/**
 * Clock advances by pollMs on every sleep so wait loops terminate deterministically
 * without real timers.
 */
function makeGate({ status = readyStatus(), foreground = { observed_at: LAUNCH_AT + 1000 }, proc = { alive: true }, options = {} } = {}) {
  let clock = NOW;
  const sleeps = [];
  const gate = createReadinessGate({
    readStatus: () => (typeof status === 'function' ? status(clock) : status),
    readForeground: () => (typeof foreground === 'function' ? foreground(clock) : foreground),
    readProc: () => proc,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    options: () => options,
  });
  return { gate, sleeps, clockAt: () => clock };
}

test('idle + 本轮 launch 内有 session_start ⇒ ready', () => {
  const { gate } = makeGate();
  assert.deepEqual(gate.evaluate(), { ready: true, reason: 'ready' });
});

test('busy ⇒ not ready', () => {
  const { gate } = makeGate({ status: readyStatus({ state: 'busy' }) });
  assert.equal(gate.evaluate().reason, 'busy');
});

test('idle 但还没有任何 session ⇒ not ready（这是 raw idle 会漏掉的启动窗口）', () => {
  const { gate } = makeGate({ foreground: null });
  const v = gate.evaluate();
  assert.equal(v.ready, false);
  assert.equal(v.reason, 'no_session');
});

test('session_start 早于本轮 runtime_launch_at ⇒ 视为上一轮的残留，not ready', () => {
  const { gate } = makeGate({ foreground: { observed_at: LAUNCH_AT - 5000 } });
  assert.equal(gate.evaluate().reason, 'session_predates_launch');
});

test('idle 时间不足 minIdleSeconds ⇒ not ready', () => {
  const { gate } = makeGate({ status: readyStatus({ idle_seconds: 1 }) });
  assert.equal(gate.evaluate().reason, 'idle_too_brief');
});

test('status 文件缺失或过期 ⇒ not ready（monitor 没在写，状态未知）', () => {
  assert.equal(makeGate({ status: null }).gate.evaluate().reason, 'status_missing');
  const stale = { ...readyStatus(), mtimeMs: NOW - READINESS_DEFAULTS.staleStatusMs - 1 };
  assert.equal(makeGate({ status: stale }).gate.evaluate().reason, 'status_stale');
});

test('health 非 ok ⇒ not ready，且 reason 带上具体 health', () => {
  const { gate } = makeGate({ status: readyStatus({ health: 'down' }) });
  assert.equal(gate.evaluate().reason, 'health_down');
});

test('proc 明确 alive=false ⇒ not ready（idle 读数无意义）', () => {
  const { gate } = makeGate({ proc: { alive: false } });
  assert.equal(gate.evaluate().reason, 'runtime_dead');
});

test('proc-state 缺失时不阻塞（advisory only）', () => {
  const { gate } = makeGate({ proc: null });
  assert.equal(gate.evaluate().ready, true);
});

test('waitUntilReady 轮询到 ready 后返回等待时长', async () => {
  let ticks = 0;
  const { gate } = makeGate({
    status: () => (ticks++ < 2 ? readyStatus({ state: 'busy' }) : readyStatus()),
    options: { pollMs: 1000 },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.ready, true);
  assert.equal(v.timedOut, false);
  assert.equal(v.waitedMs, 2000);
});

test('永远不 ready ⇒ 到 maxWaitMs 后 timedOut 返回（fail-open，绝不无限等）', async () => {
  const { gate } = makeGate({
    status: readyStatus({ state: 'busy' }),
    options: { pollMs: 1000, maxWaitMs: 5000 },
  });
  const v = await gate.waitUntilReady();
  assert.equal(v.ready, false);
  assert.equal(v.timedOut, true);
  assert.equal(v.reason, 'busy');
  assert.ok(v.waitedMs <= 5000, `waited ${v.waitedMs} must not exceed the cap`);
});

// --- gated reporter ---------------------------------------------------------

function fakeGate(verdict) {
  let release;
  const gate = {
    calls: 0,
    waitUntilReady: async () => {
      gate.calls++;
      if (verdict === 'hang') return new Promise((r) => { release = () => r({ ready: true, reason: 'ready', waitedMs: 1, timedOut: false }); });
      return verdict;
    },
    release: () => release?.(),
  };
  return gate;
}

test('gated reporter: ready 后才发 online-report', async () => {
  const gate = fakeGate({ ready: true, reason: 'ready', waitedMs: 4000, timedOut: false });
  const posts = [];
  const report = createGatedOnlineReporter({ reportAgentOnline: async (o) => posts.push(o.slug), gate });
  await report({ slug: 'org-a' });
  assert.deepEqual(posts, ['org-a']);
});

test('gated reporter: 等待超时也要发（fail-open），并 warn', async () => {
  const gate = fakeGate({ ready: false, reason: 'busy', waitedMs: 600000, timedOut: true });
  const posts = [];
  const warns = [];
  const report = createGatedOnlineReporter({
    reportAgentOnline: async (o) => posts.push(o.slug), gate, warn: (m) => warns.push(m),
  });
  await report({ slug: 'org-a' });
  assert.deepEqual(posts, ['org-a'], 'timeout must still report — never strand the org');
  assert.equal(warns.length, 1);
});

test('gated reporter: 同一 org 已有 waiter 时第二次调用直接跳过（periodicSync 不叠加轮询）', async () => {
  const gate = fakeGate('hang');
  const posts = [];
  const report = createGatedOnlineReporter({ reportAgentOnline: async (o) => posts.push(o.slug), gate });
  const first = report({ slug: 'org-a' });
  await report({ slug: 'org-a' });           // periodic tick while first is waiting
  assert.equal(gate.calls, 1, 'second call must not start a second wait');
  assert.deepEqual(posts, []);
  gate.release();
  await first;
  assert.deepEqual(posts, ['org-a']);
});

test('gated reporter: waiter 结束后可再次进入（不会永久占位）', async () => {
  const gate = fakeGate({ ready: true, reason: 'ready', waitedMs: 0, timedOut: false });
  const posts = [];
  const report = createGatedOnlineReporter({ reportAgentOnline: async (o) => posts.push(o.slug), gate });
  await report({ slug: 'org-a' });
  await report({ slug: 'org-a' });
  assert.equal(gate.calls, 2);
  assert.deepEqual(posts, ['org-a', 'org-a']);
});

test('gated reporter: 配置关闭时绕过 gate 直接发', async () => {
  const gate = fakeGate('hang');
  const posts = [];
  const report = createGatedOnlineReporter({
    reportAgentOnline: async (o) => posts.push(o.slug), gate, isDisabled: () => true,
  });
  await report({ slug: 'org-a' });
  assert.equal(gate.calls, 0);
  assert.deepEqual(posts, ['org-a']);
});

test('onWait 对同一 reason 只通报一次，避免轮询刷日志', async () => {
  const seen = [];
  const { gate } = makeGate({
    status: readyStatus({ state: 'busy' }),
    options: { pollMs: 1000, maxWaitMs: 5000 },
  });
  await gate.waitUntilReady({ onWait: (reason) => seen.push(reason) });
  assert.deepEqual(seen, ['busy']);
});
