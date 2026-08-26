/**
 * Size-based log rotation via copytruncate — zero external deps.
 *
 * PM2 (fork mode) owns the log file descriptors and opens them O_APPEND, so we
 * cannot rename+reopen from inside the app (the daemon would keep writing to the
 * old inode and `pm2 logs` would tail the wrong file). Instead we use the
 * logrotate `copytruncate` strategy: take a fast raw snapshot of the live file
 * (`copyFileSync` to a tmp file), truncate the live file to 0 IMMEDIATELY, then
 * gzip the tmp snapshot into a timestamped archive next to the log. Under
 * O_APPEND the daemon's next write lands at offset 0 with no sparse hole, the
 * path is unchanged, and `pm2 logs` keeps following it.
 *
 * copytruncate is inherently lossy in one tiny window: bytes the O_APPEND writer
 * emits in the microsecond gap between `copyFileSync` returning and the
 * `truncateSync` are in neither the snapshot nor the (now-empty) live file — they
 * are LOST, not preserved and not deferred to a next window. This is the same
 * trade-off logrotate's own copytruncate makes. Doing copy-then-immediate-
 * truncate (and compressing only AFTER the truncate) shrinks that window from the
 * full gzip-stream duration down to two adjacent syscalls; it does not eliminate
 * it. Acceptable for logs.
 *
 * The live file stays plain text; only the rolled-off archives are gzipped.
 * Archives are kept forever — there is NO pruning / retention limit here.
 *
 * Registered into the existing TaskRegistry via startLogRotation() so it inherits
 * serialization (non-overlapping ticks), error isolation and unified start/stop.
 *
 * Log paths come from PM2's injected env (`pm_out_log_path` / `pm_err_log_path`).
 * Outside PM2 those are absent and every tick is a graceful no-op.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// 20MB is both the rotation threshold AND the floor: files at or below it are
// skipped, so frequent restarts can never accumulate a pile of tiny archives.
export const MAX_BYTES = 20 * 1024 * 1024;
// DAILY size check (this is the *check* cadence, not the rotation frequency —
// a file only rotates on the tick where it has grown past MAX_BYTES).
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Filesystem-safe local timestamp: YYYY-MM-DD_HHMMSS. */
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_`
       + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Log file paths PM2 injects into the child process env. */
export function logPaths() {
  return [process.env.pm_out_log_path, process.env.pm_err_log_path].filter(Boolean);
}

/**
 * Rotate a single file if (and only if) it is larger than `maxBytes`.
 * Returns true if it rotated, false if skipped (small / missing / unreadable).
 * @param {string} file
 * @param {number} [maxBytes]
 */
export async function rotateFile(file, maxBytes = MAX_BYTES) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false; // missing / unreadable → nothing to do
  }
  if (size <= maxBytes) return false; // floor protection: <= threshold never rotates

  const dir = path.dirname(file);
  const bn = path.basename(file);
  const stem = bn.endsWith('.log') ? bn.slice(0, -'.log'.length) : bn;
  const archive = path.join(dir, `${stem}.${stamp()}.log.gz`);
  const tmp = `${archive}.tmp.${process.pid}`;

  try {
    // Fast raw snapshot. copyFileSync reads to EOF, so appends that land while
    // the copy is running (O_APPEND puts them at EOF, ahead of the copy read)
    // are captured too — only the gap AFTER this returns is at risk.
    fs.copyFileSync(file, tmp);
    // Truncate IMMEDIATELY, before the (slow) compression, so the copytruncate
    // loss window is just the syscall gap between the copy and this truncate.
    // Bytes appended in that microsecond gap are LOST — not preserved, not
    // deferred to a next window. Same lossy race as logrotate's copytruncate.
    fs.truncateSync(file, 0); // O_APPEND writer resumes at offset 0, no sparse hole
    // Compress the snapshot outside the loss window.
    await pipeline(
      fs.createReadStream(tmp),
      zlib.createGzip(),
      fs.createWriteStream(archive),
    );
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort cleanup */ }
  }
  return true;
}

/**
 * One rotation tick over all target files. Best-effort and total: a failure on
 * one file is logged and swallowed so nothing can ever throw into the task loop.
 * @param {object} [opts]
 * @param {string[]} [opts.files]     Override target paths (tests); defaults to logPaths()
 * @param {number}   [opts.maxBytes]  Override threshold (tests)
 */
export async function rotateAll(opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_BYTES;
  let files;
  try {
    files = opts.files ?? logPaths();
  } catch {
    return; // resolving paths must never throw into the loop
  }
  for (const f of files) {
    try {
      await rotateFile(f, maxBytes);
    } catch (err) {
      try { console.error(`[log-rotate] rotation failed for ${f}: ${err?.message || err}`); } catch { /* ignore */ }
    }
  }
}

/**
 * Register (and by default start) the `log-rotate` task on an existing
 * TaskRegistry. runOnStart:true → an oversized file is caught at boot rather
 * than after the first full day.
 * @param {import('./task-registry.js').default} taskRegistry
 * @param {object} [opts]
 * @param {string[]} [opts.files]
 * @param {number}   [opts.maxBytes]
 * @param {number}   [opts.intervalMs]
 * @param {boolean}  [opts.autoStart=true]
 * @returns {Function} the registered tick function
 */
export function startLogRotation(taskRegistry, opts = {}) {
  const intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
  const fn = () => rotateAll(opts);
  taskRegistry.register('log-rotate', fn, intervalMs, { runOnStart: true });
  if (opts.autoStart !== false) taskRegistry.start('log-rotate');
  return fn;
}
