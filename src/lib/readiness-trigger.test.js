import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadinessTrigger, TRIGGER_DEFAULTS } from './readiness-trigger.js';

function makeTrigger({ verdicts, options = {}, startClock = 100_000 } = {}) {
  let i = 0;
  let clock = startClock;
  const reports = [];
  const logs = [];
  const trigger = createReadinessTrigger({
    evaluate: () => verdicts[Math.min(i++, verdicts.length - 1)],
    report: async () => { reports.push(clock); },
    now: () => clock,
    options: () => options,
    log: (m) => logs.push(m),
    warn: (m) => logs.push('WARN ' + m),
  });
  return { trigger, reports, logs, advance: (ms) => { clock += ms; }, clockAt: () => clock };
}

const READY = { ready: true, reason: 'ready' };
const BUSY = { ready: false, reason: 'busy' };
const IDLE_BRIEF = { ready: false, reason: 'idle_too_brief' };
const NO_SESSION = { ready: false, reason: 'no_session' };

test('第一次采样只建立基线，不上报', async () => {
  const { trigger, reports } = makeTrigger({ verdicts: [READY] });
  await trigger.tick();
  assert.deepEqual(reports, []);
});

test('未就绪 → 就绪：立刻上报（这是解禁聊天的关键边）', async () => {
  const { trigger, reports, advance } = makeTrigger({ verdicts: [NO_SESSION, READY] });
  await trigger.tick();          // baseline: not ready
  advance(TRIGGER_DEFAULTS.minGapMs + 1);
  await trigger.tick();          // flips to ready
  assert.equal(reports.length, 1);
});

test('busy ↔ idle 抖动不触发上报（否则干活中的 agent 会持续刷 PUT）', async () => {
  const { trigger, reports, advance } = makeTrigger({
    verdicts: [BUSY, IDLE_BRIEF, BUSY, IDLE_BRIEF, BUSY],
  });
  for (let n = 0; n < 5; n++) { await trigger.tick(); advance(2000); }
  assert.deepEqual(reports, [], 'neither ready nor observable changes, so no report');
});

test('可观测性变化（进程消失/出现）会触发上报', async () => {
  const { trigger, reports, advance } = makeTrigger({ verdicts: [BUSY, NO_SESSION] });
  await trigger.tick();
  advance(TRIGGER_DEFAULTS.minGapMs + 1);
  await trigger.tick();
  assert.equal(reports.length, 1, 'busy→no_session flips observable');
});

test('就绪 → 未就绪也上报（平台要能收回可聊天状态）', async () => {
  const { trigger, reports, advance } = makeTrigger({ verdicts: [READY, BUSY] });
  await trigger.tick();
  advance(TRIGGER_DEFAULTS.minGapMs + 1);
  await trigger.tick();
  assert.equal(reports.length, 1);
});

test('最小间隔内的变化被压住，交给周期 tick，并留日志', async () => {
  const { trigger, reports, logs, advance } = makeTrigger({
    verdicts: [NO_SESSION, READY, BUSY],
    options: { minGapMs: 10_000 },
  });
  await trigger.tick();               // baseline
  advance(20_000);
  await trigger.tick();               // → ready, reports
  assert.equal(reports.length, 1);
  advance(1000);                      // inside the floor
  await trigger.tick();               // → not ready again
  assert.equal(reports.length, 1, 'suppressed by the floor');
  assert.ok(logs.some(l => l.includes('floor')), 'suppression must be visible in logs');
});

test('上报失败只 warn，不抛（周期 tick 是兜底）', async () => {
  let clock = 0;
  const logs = [];
  const trigger = createReadinessTrigger({
    evaluate: (() => { let n = 0; return () => (n++ === 0 ? NO_SESSION : READY); })(),
    report: async () => { throw new Error('network down'); },
    now: () => clock,
    log: (m) => logs.push(m),
    warn: (m) => logs.push('WARN ' + m),
  });
  await trigger.tick();
  clock += 999_999;
  await assert.doesNotReject(() => trigger.tick());
  assert.ok(logs.some(l => l.startsWith('WARN') && l.includes('network down')));
});

test('慢上报期间不叠加第二次', async () => {
  let clock = 0, active = 0, maxActive = 0;
  let n = 0;
  const trigger = createReadinessTrigger({
    evaluate: () => (n++ % 2 === 0 ? NO_SESSION : READY),
    report: async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    },
    now: () => clock,
    options: () => ({ minGapMs: 0 }),
  });
  await trigger.tick();
  clock += 100;
  await Promise.all([trigger.tick(), trigger.tick(), trigger.tick()]);
  assert.equal(maxActive, 1, 'reports must not overlap');
});

test('start/stop 幂等且不泄漏定时器', () => {
  const created = [];
  const cleared = [];
  const trigger = createReadinessTrigger({
    evaluate: () => READY,
    report: async () => {},
    setIntervalImpl: (fn, ms) => { const h = { fn, ms, unref(){} }; created.push(h); return h; },
    clearIntervalImpl: (h) => cleared.push(h),
  });
  trigger.start(); trigger.start();
  assert.equal(created.length, 1, 'second start is a no-op');
  trigger.stop(); trigger.stop();
  assert.equal(cleared.length, 1);
});
