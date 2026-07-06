#!/usr/bin/env node
'use strict';

/**
 * Standalone detached upgrade executor.
 *
 * Spawned by auto-upgrade.js with { detached: true, stdio: 'ignore' }.unref()
 * so it survives the parent openmax PM2 process being stopped mid-upgrade.
 *
 * Usage: node upgrade-executor.cjs <marker-path>
 *
 * Reads the pre-written marker (from, to, notes, url), runs
 * `zylos upgrade openmax --yes --mode overwrite`, verifies the new version
 * is running, and writes the result back to the marker. On failure, ensures
 * PM2 restarts the old version.
 *
 * CJS (.cjs) so Node treats it as CommonJS regardless of the parent
 * package.json's "type": "module" setting.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const markerPath = process.argv[2];
if (!markerPath) {
  console.error('[upgrade-executor] missing marker path argument');
  process.exit(1);
}

const zylosBin = process.env.ZYLOS_BIN || 'zylos';
const PM2_SERVICE = 'zylos-openmax';
const UPGRADE_TIMEOUT_MS = 5 * 60 * 1000;
const PM2_RESTART_TIMEOUT_MS = 30 * 1000;
const VERIFY_DELAY_MS = 5 * 1000;
const VERIFY_RETRIES = 6;
const SKILL_DIR = path.resolve(__dirname, '..');

let marker;
try {
  marker = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
} catch (e) {
  console.error('[upgrade-executor] cannot read marker:', e.message);
  process.exit(1);
}

function writeMarker(updates) {
  Object.assign(marker, updates, { ts: Date.now() });
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
}

const logFile = path.join(path.dirname(markerPath), 'upgrade-executor.log');
function appendLog(line) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {}
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

function getPm2Status() {
  try {
    const out = execSync(`pm2 jlist`, { timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] });
    const procs = JSON.parse(out.toString());
    const proc = procs.find(p => p.name === PM2_SERVICE);
    return proc ? proc.pm2_env.status : null;
  } catch {
    return null;
  }
}

async function verifyUpgrade(targetVersion) {
  appendLog(`verifying upgrade to v${targetVersion}...`);
  for (let i = 0; i < VERIFY_RETRIES; i++) {
    await sleep(VERIFY_DELAY_MS);
    const version = readInstalledVersion();
    const status = getPm2Status();
    appendLog(`  attempt ${i + 1}: version=${version}, pm2=${status}`);
    if (version === targetVersion && status === 'online') {
      return true;
    }
  }
  return false;
}

async function run() {
  appendLog(`starting upgrade: v${marker.from} -> v${marker.to}`);
  appendLog(`zylos bin: ${zylosBin}`);
  appendLog(`skill dir: ${SKILL_DIR}`);

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
      const status = getPm2Status();
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
}

function ensurePm2Running() {
  appendLog('ensuring PM2 service is running (safety net)...');
  try {
    execSync(`pm2 restart ${PM2_SERVICE}`, {
      timeout: PM2_RESTART_TIMEOUT_MS,
      stdio: 'ignore',
    });
    appendLog('PM2 restart succeeded');
  } catch (e2) {
    appendLog(`PM2 restart failed: ${e2.message}`);
    try {
      execSync(`pm2 start ${PM2_SERVICE}`, {
        timeout: PM2_RESTART_TIMEOUT_MS,
        stdio: 'ignore',
      });
      appendLog('PM2 start succeeded (fallback)');
    } catch (e3) {
      appendLog(`PM2 start also failed: ${e3.message}`);
    }
  }
}

run();
