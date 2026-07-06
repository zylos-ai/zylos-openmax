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
 * `zylos upgrade openmax --yes --mode overwrite`, and writes the result
 * back to the marker. On failure, ensures PM2 restarts the old version.
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

appendLog(`starting upgrade: v${marker.from} -> v${marker.to}`);
appendLog(`zylos bin: ${zylosBin}`);

try {
  const result = execSync(`${zylosBin} upgrade openmax --yes --mode overwrite`, {
    timeout: UPGRADE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const stdout = result.toString().slice(-2000);
  appendLog(`upgrade succeeded:\n${stdout}`);
  writeMarker({ completed: true, status: 'completed' });
} catch (err) {
  const stderr = err.stderr ? err.stderr.toString().slice(0, 1000) : '';
  const stdout = err.stdout ? err.stdout.toString().slice(-500) : '';
  const errMsg = stderr || err.message || 'unknown error';
  appendLog(`upgrade failed: ${errMsg}`);
  if (stdout) appendLog(`stdout: ${stdout}`);
  writeMarker({ completed: false, status: 'failed', error: errMsg });
  appendLog('restarting PM2 service (safety net)...');
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

appendLog('executor done');
