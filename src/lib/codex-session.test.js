import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexSessionReader, readZylosRuntime } from './codex-session.js';

// Fixtures live in a throwaway temp dir — the real ~/.codex is never touched.
function makeHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-session-test-'));
  const codexHome = path.join(root, '.codex');
  const zylosDir = path.join(root, 'zylos');
  fs.mkdirSync(zylosDir, { recursive: true });
  return { root, codexHome, zylosDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const pad = (n) => String(n).padStart(2, '0');

/** Write a rollout whose dir/name use the epoch's UTC fields (any tz is within the slack). */
function writeRollout(codexHome, { at, id, source = 'cli', cwd, partial = false, type = 'session_meta' }) {
  const d = new Date(at);
  const [y, mo, da] = [d.getUTCFullYear(), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())];
  const stamp = `${y}-${mo}-${da}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
  const dir = path.join(codexHome, 'sessions', String(y), mo, da);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    timestamp: new Date(at + 1500).toISOString(),
    type,
    payload: { id, session_id: id, timestamp: new Date(at).toISOString(), cwd, originator: 'codex-tui', source, base_instructions: { text: 'x'.repeat(70_000) } },
  };
  const line = JSON.stringify(meta);
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  fs.writeFileSync(file, partial ? line.slice(0, 100) : `${line}\n{"type":"event_msg"}\n`);
  return file;
}

const LAUNCH = Date.UTC(2026, 10, 3, 6, 22, 25);

test('readCodexSession: 取本轮 launch 后最新的前台 cli thread，忽略 subagent / exec / 其它 cwd', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  writeRollout(h.codexHome, { at: LAUNCH - 3600_000, id: 'old-cli', cwd: h.zylosDir });
  writeRollout(h.codexHome, { at: LAUNCH + 9_000, id: 'main', cwd: h.zylosDir });
  writeRollout(h.codexHome, { at: LAUNCH + 60_000, id: 'sub', cwd: h.zylosDir, source: { subagent: { thread_spawn: { parent_thread_id: 'main' } } } });
  writeRollout(h.codexHome, { at: LAUNCH + 70_000, id: 'exec', cwd: h.zylosDir, source: 'exec' });
  writeRollout(h.codexHome, { at: LAUNCH + 80_000, id: 'elsewhere', cwd: '/tmp/other' });

  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH + 100_000 });
  const s = read({ launchAt: LAUNCH });
  assert.equal(s.session_id, 'main');
  assert.equal(s.started_at, LAUNCH + 9_000);
});

test('readCodexSession: 只有早于 launch 的 thread ⇒ 返回它（由 gate 判 predates）', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  writeRollout(h.codexHome, { at: LAUNCH - 60_000, id: 'prev', cwd: h.zylosDir });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH + 10_000 });
  const s = read({ launchAt: LAUNCH });
  assert.equal(s.session_id, 'prev');
  assert.ok(s.started_at < LAUNCH);
});

test('readCodexSession: 远早于 launch 的目录/文件根本不读；没有 sessions 目录 ⇒ null', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH });
  assert.equal(read({ launchAt: LAUNCH }), null);

  writeRollout(h.codexHome, { at: LAUNCH - 5 * 24 * 3600_000, id: 'ancient', cwd: h.zylosDir });
  const read2 = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH });
  assert.equal(read2({ launchAt: LAUNCH }), null);
});

test('readCodexSession: 首行还没写完 ⇒ 这次不算、不缓存，写完后能读到', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  let clock = LAUNCH + 5_000;
  const file = writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'booting', cwd: h.zylosDir, partial: true });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => clock, minScanIntervalMs: 5000 });
  assert.equal(read({ launchAt: LAUNCH }), null);

  writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'booting', cwd: h.zylosDir });
  assert.ok(fs.existsSync(file));
  assert.equal(read({ launchAt: LAUNCH }), null, 'throttled: no rescan inside minScanIntervalMs');
  clock += 5000;
  assert.equal(read({ launchAt: LAUNCH })?.session_id, 'booting');
});

test('readCodexSession: 非 session_meta 首行 / 坏 JSON ⇒ 忽略', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  writeRollout(h.codexHome, { at: LAUNCH + 1_000, id: 'weird', cwd: h.zylosDir, type: 'response_item' });
  const dir = path.dirname(writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'ok', cwd: h.zylosDir }));
  fs.writeFileSync(path.join(dir, 'rollout-2026-11-03T06-30-00-bad.jsonl'), '{not json\n');
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH + 600_000 });
  assert.equal(read({ launchAt: LAUNCH }).session_id, 'ok');
});

test('readCodexSession: launch 改变时立即重扫（不吃旧缓存）', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  writeRollout(h.codexHome, { at: LAUNCH + 2_000, id: 'first', cwd: h.zylosDir });
  const read = createCodexSessionReader({ codexHome: h.codexHome, zylosDir: h.zylosDir, now: () => LAUNCH + 3_600_000 });
  assert.equal(read({ launchAt: LAUNCH }).session_id, 'first');
  const relaunch = LAUNCH + 1_800_000;
  writeRollout(h.codexHome, { at: relaunch + 3_000, id: 'second', cwd: h.zylosDir });
  assert.equal(read({ launchAt: relaunch }).session_id, 'second');
});

test('readZylosRuntime: 读 .zylos/config.json 的 runtime；缺失/坏文件 ⇒ null', (t) => {
  const h = makeHome();
  t.after(h.cleanup);
  assert.equal(readZylosRuntime(h.zylosDir), null);
  fs.mkdirSync(path.join(h.zylosDir, '.zylos'));
  fs.writeFileSync(path.join(h.zylosDir, '.zylos', 'config.json'), '{"runtime":"codex"}');
  assert.equal(readZylosRuntime(h.zylosDir), 'codex');
  fs.writeFileSync(path.join(h.zylosDir, '.zylos', 'config.json'), '{oops');
  assert.equal(readZylosRuntime(h.zylosDir), null);
});
