import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  MAX_BYTES,
  CHECK_INTERVAL_MS,
  rotateFile,
  rotateAll,
  startLogRotation,
} from './log-rotate.js';
import TaskRegistry from './task-registry.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'log-rotate-'));
}
function gzArchives(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.log.gz'));
}

test('constants match the approved design (20MB threshold, DAILY check)', () => {
  assert.equal(MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(CHECK_INTERVAL_MS, 24 * 60 * 60 * 1000);
});

test('size-threshold: a file at/below the floor is left untouched', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'out.log');
  fs.writeFileSync(file, 'x'.repeat(100)); // 100 bytes
  const rotated = await rotateFile(file, 100); // <= maxBytes → skip
  assert.equal(rotated, false);
  assert.equal(gzArchives(dir).length, 0);
  assert.equal(fs.readFileSync(file, 'utf8').length, 100); // untouched
});

test('copytruncate: oversized file is gzip-archived then truncated to 0', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'out.log');
  const payload = 'line-of-log\n'.repeat(500); // > 100-byte threshold below
  fs.writeFileSync(file, payload);

  const rotated = await rotateFile(file, 100);
  assert.equal(rotated, true);

  // live file truncated to 0, still plain text and present
  assert.equal(fs.statSync(file).size, 0);

  // exactly one gzip archive, decompressing back to the pre-rotation bytes
  const archives = gzArchives(dir);
  assert.equal(archives.length, 1);
  assert.match(archives[0], /^out\.\d{4}-\d{2}-\d{2}_\d{6}\.log\.gz$/);
  const restored = zlib.gunzipSync(fs.readFileSync(path.join(dir, archives[0]))).toString('utf8');
  assert.equal(restored, payload);

  // the intermediate raw snapshot (.tmp) is cleaned up
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0);
});

test('copytruncate captures the snapshot even while the file is being appended', async () => {
  // NOTE: copytruncate is intentionally NOT lossless under concurrent writes —
  // bytes appended in the tiny gap between the copy and the truncate are dropped.
  // We assert only what IS true: the archive holds a valid gzip snapshot of the
  // file as it stood, and the live file ends up truncated. We do NOT assert that
  // every concurrently-appended byte survives.
  const dir = tmpDir();
  const file = path.join(dir, 'out.log');
  fs.writeFileSync(file, 'seed-'.repeat(200)); // > 100-byte threshold

  const rotate = rotateFile(file, 100);
  // race some appends against the rotation; these may or may not be retained
  for (let i = 0; i < 50; i++) fs.appendFileSync(file, `late-${i}\n`);
  const rotated = await rotate;

  assert.equal(rotated, true);
  const archives = gzArchives(dir);
  assert.equal(archives.length, 1);
  // archive decompresses cleanly to a non-empty snapshot (validity, not losslessness)
  const restored = zlib.gunzipSync(fs.readFileSync(path.join(dir, archives[0]))).toString('utf8');
  assert.ok(restored.length > 0);
  assert.ok(restored.startsWith('seed-'));
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0);
});

test('archives are kept forever — repeated rotations never prune', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'err.log');

  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(file, `batch-${i} `.repeat(50));
    const rotated = await rotateFile(file, 10);
    assert.equal(rotated, true);
    // distinct timestamps: nudge the clock so archive names don't collide
    await new Promise((r) => setTimeout(r, 1100));
  }
  assert.equal(gzArchives(dir).length, 3); // all retained, zero deletions
});

test('rotateAll no-ops gracefully when PM2 env is absent', async () => {
  const savedOut = process.env.pm_out_log_path;
  const savedErr = process.env.pm_err_log_path;
  delete process.env.pm_out_log_path;
  delete process.env.pm_err_log_path;
  try {
    await assert.doesNotReject(() => rotateAll()); // no files → clean no-op
  } finally {
    if (savedOut !== undefined) process.env.pm_out_log_path = savedOut;
    if (savedErr !== undefined) process.env.pm_err_log_path = savedErr;
  }
});

test('startLogRotation registers a runOnStart log-rotate task and rotates oversized targets', async () => {
  const dir = tmpDir();
  const out = path.join(dir, 'out.log');
  const err = path.join(dir, 'err.log');
  fs.writeFileSync(out, 'o'.repeat(500)); // over the 100-byte test threshold
  fs.writeFileSync(err, 'e'.repeat(10));  // under → skipped

  const tasks = new TaskRegistry();
  // autoStart:false so the awaited tickNow below is the single serialized run
  // (a live runOnStart tick would still be in flight and make tickNow a no-op).
  startLogRotation(tasks, { files: [out, err], maxBytes: 100, autoStart: false });

  assert.equal(tasks.list().some((t) => t.name === 'log-rotate'), true);

  await tasks.tickNow('log-rotate');
  tasks.stopAll();

  assert.equal(fs.statSync(out).size, 0);          // oversized → rotated
  assert.equal(fs.readFileSync(err, 'utf8').length, 10); // small → untouched
  assert.equal(gzArchives(dir).length, 1);
});
