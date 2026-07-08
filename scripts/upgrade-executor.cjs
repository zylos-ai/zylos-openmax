#!/usr/bin/env node
'use strict';

/**
 * Standalone upgrade executor — runs as its OWN PM2 app (`zylos-openmax-upgrader`).
 *
 * Started on demand by auto-upgrade.js via:
 *   pm2 start scripts/upgrade-executor.cjs --name zylos-openmax-upgrader \
 *     --no-autorestart -- <marker-path>
 *
 * Why a separate PM2 app instead of a detached child of the openmax service?
 *   `zylos upgrade openmax` internally runs `pm2 stop zylos-openmax`, and PM2's
 *   TreeKill walks the PPID chain of that service's process tree. A child of the
 *   openmax service (even detached) risks being caught. A process started via
 *   `pm2 start` is parented to the PM2 God daemon — it is a SIBLING of
 *   zylos-openmax, not a descendant — so stopping zylos-openmax can never reach
 *   it. This is the same decoupling zylos-core's self-upgrade relies on
 *   (the upgrader is not one of the services it restarts).
 *
 * Responsibilities:
 *   1. Read the pre-written marker (from, to, notes, url).
 *   2. Run `zylos upgrade openmax --yes --mode overwrite`.
 *   3. Verify the new version is installed AND stable (not crash-looping).
 *   4. Write the terminal result back to the marker (atomically).
 *   5. On ANY failure, ensure the openmax service is running again (fallback).
 *   6. Always remove its own PM2 entry (`pm2 delete`) before exiting, so it is
 *      invisible in `pm2 list` outside of an active upgrade.
 *
 * Anti-infinite-loop guarantees live here + in auto-upgrade.js:
 *   - autorestart:false (set at `pm2 start`) — this one-shot never relaunches.
 *   - verification requires the version to ACTUALLY change to the target, so a
 *     no-op / broken upgrade is recorded as failed (auto-upgrade.js then records
 *     the failed version and won't retry it until a newer release appears).
 *   - crash-loop detection (restart_time must not climb across polls) so a
 *     version that starts then immediately dies is treated as failed, not
 *     "online".
 *
 * CJS (.cjs) so Node treats it as CommonJS regardless of package.json "type".
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PM2_SERVICE = 'zylos-openmax';
const PM2_UPGRADER = 'zylos-openmax-upgrader';
const UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;
const PM2_RESTART_TIMEOUT_MS = 30 * 1000;
const VERIFY_DELAY_MS = 5 * 1000;
const VERIFY_RETRIES = 6;
const SKILL_DIR = path.resolve(__dirname, '..');

const zylosBin = process.env.ZYLOS_BIN || 'zylos';

// Marker path: prefer the argument, fall back to the canonical runtime path so
// the executor still works if PM2 arg forwarding ever misbehaves.
const DEFAULT_MARKER_PATH = path.join(
  process.env.HOME || os.homedir(),
  'zylos/components/openmax/runtime/upgrade-marker.json',
);
const markerPath = process.argv[2] || DEFAULT_MARKER_PATH;

const logFile = path.join(path.dirname(markerPath), 'upgrade-executor.log');
function appendLog(line) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} [upgrader] ${line}\n`);
  } catch {}
}

/**
 * Fallback: make sure the openmax service is running. Called on every failure
 * path so a broken upgrade never leaves the bot dead. `zylos upgrade` already
 * rolls back files + restarts on its own failure; this is a second safety net
 * for the cases it can't cover (e.g. verification failure after a "successful"
 * command, or the upgrade command itself throwing).
 */
function ensurePm2Running() {
  appendLog('ensuring PM2 service is running (safety net)...');
  try {
    execSync(`pm2 restart ${PM2_SERVICE}`, { timeout: PM2_RESTART_TIMEOUT_MS, stdio: 'ignore' });
    appendLog('PM2 restart succeeded');
    return;
  } catch (e2) {
    appendLog(`PM2 restart failed: ${e2.message}`);
  }
  try {
    execSync(`pm2 start ${PM2_SERVICE}`, { timeout: PM2_RESTART_TIMEOUT_MS, stdio: 'ignore' });
    appendLog('PM2 start succeeded (fallback)');
  } catch (e3) {
    appendLog(`PM2 start also failed: ${e3.message}`);
  }
}

/**
 * Remove our own PM2 entry and exit. Because deleting ourselves would kill this
 * process mid-call, the `pm2 delete` runs as a detached, reparented child that
 * outlives us. auto-upgrade.js also cleans up any leftover upgrader entry on its
 * next detection cycle, so this is belt-and-suspenders.
 */
function selfDeleteAndExit(code) {
  appendLog(`self-cleanup: pm2 delete ${PM2_UPGRADER}, exiting(${code})`);
  try {
    // detached + unref + own process group (setsid): the child is fully forked
    // by the time spawn() returns and survives us exiting immediately, so no
    // delay is needed. process.exit() below halts synchronously, which is what
    // lets the guard/catch call sites terminate without falling through.
    const child = spawn('pm2', ['delete', PM2_UPGRADER], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (e) {
    appendLog(`WARN: self pm2 delete spawn failed: ${e.message}`);
  }
  process.exit(code);
}

const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;

let marker;
try {
  marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
} catch (e) {
  appendLog(`FATAL: cannot read marker ${markerPath}: ${e.message}`);
  // Nothing to upgrade toward and no marker to update — just make sure the
  // service is alive and clean ourselves up.
  ensurePm2Running();
  selfDeleteAndExit(1);
}

// Guard against a stray/resurrected launch. auto-upgrade.js writes a fresh
// 'running' marker immediately before starting us, so a legitimate run always
// sees status==='running' and a recent ts. Anything else (a terminal marker, or
// a stale running marker left over from long ago) means we were launched
// spuriously — do nothing and remove ourselves so we can never trigger a rogue
// upgrade on resurrection.
{
  const age = Date.now() - (marker.ts || 0);
  if (marker.status !== 'running' || age >= STALE_RUNNING_THRESHOLD_MS) {
    appendLog(`no fresh pending upgrade (status=${marker.status}, age=${age}ms) — exiting without acting`);
    selfDeleteAndExit(0);
  }
}

// Atomic write: write to a temp file then rename, so a reader (the restarted
// openmax service) never observes a half-written JSON marker.
function writeMarker(updates) {
  Object.assign(marker, updates, { ts: Date.now() });
  const tmp = `${markerPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
    fs.renameSync(tmp, markerPath);
  } catch (e) {
    appendLog(`WARN: failed to write marker: ${e.message}`);
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function readInstalledVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return null;
  }
}

function getPm2Proc() {
  try {
    const out = execSync('pm2 jlist', { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const procs = JSON.parse(out.toString());
    return procs.find(p => p.name === PM2_SERVICE) || null;
  } catch {
    return null;
  }
}

/**
 * Verify the upgrade landed AND is stable.
 *
 * Requires two consecutive polls where the installed version equals the target
 * and the service is online with a NON-increasing restart counter. If the
 * restart counter climbs between polls the new version is crash-looping — we
 * treat that as a failed upgrade rather than declaring success on a process
 * that is about to die again.
 */
async function verifyUpgrade(targetVersion) {
  appendLog(`verifying upgrade to v${targetVersion} (version match + stability)...`);
  let baselineRestarts = null;
  let stableOnce = false;

  for (let i = 0; i < VERIFY_RETRIES; i++) {
    await sleep(VERIFY_DELAY_MS);
    const version = readInstalledVersion();
    const proc = getPm2Proc();
    const status = proc ? proc.pm2_env.status : null;
    const restarts = proc ? (proc.pm2_env.restart_time ?? 0) : null;
    const uptime = proc && proc.pm2_env.pm_uptime ? proc.pm2_env.pm_uptime : null;
    appendLog(`  attempt ${i + 1}: version=${version}, pm2=${status}, restarts=${restarts}, uptime=${uptime}`);

    if (version !== targetVersion || status !== 'online') {
      // Reset stability tracking — not there yet.
      baselineRestarts = null;
      stableOnce = false;
      continue;
    }

    if (baselineRestarts === null) {
      // First healthy sighting — record restart baseline, need one more clean poll.
      baselineRestarts = restarts;
      stableOnce = true;
      continue;
    }

    if (restarts != null && baselineRestarts != null && restarts > baselineRestarts) {
      appendLog(`  restart counter climbed ${baselineRestarts} -> ${restarts}: new version is crash-looping`);
      return false;
    }

    if (stableOnce) {
      appendLog('  version matches and service stable across two polls');
      return true;
    }
  }
  return false;
}

async function run() {
  appendLog(`starting upgrade: v${marker.from} -> v${marker.to}`);
  appendLog(`zylos bin: ${zylosBin}; skill dir: ${SKILL_DIR}; marker: ${markerPath}`);

  try {
    const result = execSync(`${zylosBin} upgrade openmax --yes --mode overwrite`, {
      timeout: UPGRADE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const stdout = result.toString().slice(-2000);
    appendLog(`zylos upgrade exited successfully:\n${stdout}`);

    const ok = await verifyUpgrade(marker.to);
    if (ok) {
      appendLog('post-upgrade verification passed');
      writeMarker({ completed: true, status: 'completed' });
    } else {
      const version = readInstalledVersion();
      const proc = getPm2Proc();
      const status = proc ? proc.pm2_env.status : null;
      appendLog(`post-upgrade verification FAILED: version=${version}, pm2=${status}`);
      writeMarker({
        completed: false,
        status: 'failed',
        error: `Upgrade command succeeded but verification failed: installed=${version}, pm2=${status}`,
      });
      ensurePm2Running();
    }
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().slice(0, 1000) : '';
    const stdout = err.stdout ? err.stdout.toString().slice(-500) : '';
    const errMsg = stderr || err.message || 'unknown error';
    appendLog(`upgrade failed: ${errMsg}`);
    if (stdout) appendLog(`stdout: ${stdout}`);
    writeMarker({ completed: false, status: 'failed', error: errMsg });
    ensurePm2Running();
  }

  appendLog('executor done');
  selfDeleteAndExit(0);
}

run();
