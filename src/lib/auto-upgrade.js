/**
 * Auto-upgrade — periodically check GitHub for new releases and upgrade
 * via a detached child process.
 *
 * Flow:
 *   1. Timer fires (first check after INITIAL_DELAY, then every intervalMs).
 *   2. Fetch latest GitHub release tag via REST API.
 *   3. Compare against current package.json version (semver).
 *   4. If newer: write a marker, notify owners, spawn a detached child that
 *      runs `zylos upgrade openmax --yes --mode overwrite`.
 *   5. The child process survives the parent being stopped by zylos upgrade.
 *      On success: writes completed marker (new openmax reads it on startup).
 *      On failure: writes failed marker + pm2 restarts the old version.
 *   6. On next startup, notifyUpgradeComplete reads the marker and DMs owners.
 *
 * Config (all optional, in config.json top level):
 *   autoUpgrade.enabled        — boolean, default true
 *   autoUpgrade.intervalHours  — number,  default 24
 */

import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';

const HOME = process.env.HOME || '/tmp';
const RUNTIME_DIR = path.join(HOME, 'zylos/components/openmax/runtime');
const MARKER_PATH = path.join(RUNTIME_DIR, 'upgrade-marker.json');
const SEND_SCRIPT = path.resolve(new URL('../../scripts/send.js', import.meta.url).pathname);
const EXECUTOR_SCRIPT = path.resolve(new URL('../../scripts/upgrade-executor.cjs', import.meta.url).pathname);
const FAILED_VERSION_PATH = path.join(RUNTIME_DIR, 'upgrade-failed-version');
const GITHUB_REPO = 'zylos-ai/zylos-openmax';
export const INITIAL_DELAY_MS = 60 * 1000;

const STALE_RUNNING_THRESHOLD_MS = 10 * 60 * 1000;

const log  = (...a) => console.log('[auto-upgrade]', ...a);
const warn = (...a) => console.warn('[auto-upgrade]', ...a);

function readPkgVersion() {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function compareSemver(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  return 0;
}

async function fetchLatestRelease() {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const headers = { Accept: 'application/vnd.github.v3+json' };
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return {
    tag: (data.tag_name || '').replace(/^v/, ''),
    name: data.name || data.tag_name || '',
    body: data.body || '',
    url: data.html_url || '',
  };
}

function writeMarker(data) {
  fs.mkdirSync(path.dirname(MARKER_PATH), { recursive: true });
  fs.writeFileSync(MARKER_PATH, JSON.stringify(data, null, 2));
}

export function recordFailedVersion(version) {
  fs.mkdirSync(path.dirname(FAILED_VERSION_PATH), { recursive: true });
  fs.writeFileSync(FAILED_VERSION_PATH, version);
}

export function getFailedVersion() {
  try {
    return fs.readFileSync(FAILED_VERSION_PATH, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function clearFailedVersion() {
  try { fs.unlinkSync(FAILED_VERSION_PATH); } catch {}
}

export function readAndClearMarker() {
  try {
    const raw = fs.readFileSync(MARKER_PATH, 'utf-8');
    const data = JSON.parse(raw);
    // Don't consume 'running' markers — the detached executor owns them
    // and will write the terminal result. zylos upgrade restarts this
    // service mid-upgrade, so startup must not treat 'running' as terminal.
    if (data.status === 'running') return null;
    fs.unlinkSync(MARKER_PATH);
    return data;
  } catch {
    return null;
  }
}

function isUpgradeRunning() {
  try {
    const raw = fs.readFileSync(MARKER_PATH, 'utf-8');
    const marker = JSON.parse(raw);
    if (marker.status === 'running') {
      const age = Date.now() - (marker.ts || 0);
      if (age < STALE_RUNNING_THRESHOLD_MS) return true;
      log('stale running marker detected, treating as failed');
      writeMarker({
        ...marker,
        status: 'failed',
        completed: false,
        error: 'Upgrade process timed out or was interrupted',
        ts: Date.now(),
      });
    }
    return false;
  } catch {
    return false;
  }
}

function sendMessage(conversationId, text) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SEND_SCRIPT, conversationId, text], { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
  });
}

export function formatUpgradeNotification(marker) {
  const lines = [];

  if (marker.completed) {
    lines.push(`OpenMax upgraded: v${marker.from} → v${marker.to}`);
  } else if (marker.error) {
    lines.push(`OpenMax upgrade failed: v${marker.from} → v${marker.to}`);
    lines.push('Rolled back to previous version and restarted.');
    const errSummary = marker.error.split('\n').filter(l => l.trim()).slice(0, 5).join('\n');
    if (errSummary) lines.push('', `Error: ${errSummary}`);
  } else if (marker.status === 'running') {
    lines.push(`OpenMax upgrading: v${marker.from} → v${marker.to}`);
    lines.push('Running zylos upgrade in background...');
  } else {
    lines.push(`OpenMax update available: v${marker.from} → v${marker.to}`);
    lines.push('', 'Run `zylos upgrade openmax --yes --mode overwrite` to upgrade.');
  }

  if (marker.notes && !marker.error) {
    const summary = marker.notes.split('\n').filter(l => l.trim()).slice(0, 8).join('\n');
    if (summary) lines.push('', summary);
  }
  if (marker.url) lines.push('', marker.url);
  return lines.join('\n');
}

/**
 * On startup, read the marker left by the detached upgrade executor
 * and notify owners of the outcome.
 */
export async function notifyUpgradeComplete(enabledOrgConfigs, postForOrgFn, apiPathFn) {
  const marker = readAndClearMarker();
  if (!marker) return;

  if (marker.status === 'running') {
    // readAndClearMarker now skips 'running' markers, so this is
    // unreachable. Defensive: if somehow reached, don't treat as failed.
    return;
  }

  const label = marker.completed ? 'completed' : 'failed';
  log(`upgrade ${label}: v${marker.from} → v${marker.to}, notifying owners...`);
  const text = formatUpgradeNotification(marker);

  for (const [slug, orgConfig] of enabledOrgConfigs) {
    const ownerMemberId = orgConfig.owner?.member_id;
    if (!ownerMemberId) {
      warn(`[${slug}] no owner member_id, skipping notification`);
      continue;
    }
    try {
      const res = await postForOrgFn(orgConfig.org_id,
        apiPathFn('/conversations/dm'), { peer_member_id: ownerMemberId });
      const convId = res?.conversation?.id;
      if (!convId) {
        warn(`[${slug}] could not resolve owner DM conversation`);
        continue;
      }
      await sendMessage(convId, text);
      log(`[${slug}] owner notified in conversation ${convId}`);
    } catch (e) {
      warn(`[${slug}] notification failed: ${e.message}`);
    }
  }

  if (marker.completed) {
    clearFailedVersion();
  } else {
    recordFailedVersion(marker.to);
  }
}

async function notifyOwners(text, enabledOrgConfigs, postForOrgFn, apiPathFn) {
  for (const [slug, orgConfig] of enabledOrgConfigs) {
    const ownerMemberId = orgConfig.owner?.member_id;
    if (!ownerMemberId) continue;
    try {
      const res = await postForOrgFn(orgConfig.org_id,
        apiPathFn('/conversations/dm'), { peer_member_id: ownerMemberId });
      const convId = res?.conversation?.id;
      if (!convId) continue;
      await sendMessage(convId, text);
      log(`[${slug}] owner notified of upgrade`);
    } catch (e) {
      warn(`[${slug}] notification failed: ${e.message}`);
    }
  }
}

function spawnUpgradeExecutor(fromVersion, toVersion, notes, releaseUrl) {
  const markerData = {
    from: fromVersion,
    to: toVersion,
    notes: notes || '',
    url: releaseUrl || '',
    status: 'running',
    completed: false,
    ts: Date.now(),
  };
  writeMarker(markerData);

  const child = spawn(process.execPath, [EXECUTOR_SCRIPT, MARKER_PATH], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  log(`spawned detached upgrade executor (pid=${child.pid})`);
}

export async function checkForUpdates(enabledOrgConfigs, postForOrgFn, apiPathFn) {
  if (isUpgradeRunning()) {
    log('upgrade in progress, skipping check');
    return;
  }

  // The executor may have written a terminal marker after the post-restart
  // startup already ran notifyUpgradeComplete. Pick it up here.
  await notifyUpgradeComplete(enabledOrgConfigs, postForOrgFn, apiPathFn);

  const current = readPkgVersion();
  log(`checking for updates (current: v${current})...`);
  try {
    const latest = await fetchLatestRelease();
    if (!latest.tag) {
      warn('no release tag found');
      return;
    }
    if (compareSemver(current, latest.tag) >= 0) {
      log(`up to date (latest: v${latest.tag})`);
      return;
    }

    const failedVersion = getFailedVersion();
    if (failedVersion && failedVersion === latest.tag) {
      log(`v${latest.tag} was already attempted and failed — skipping until a newer release`);
      return;
    }
    clearFailedVersion();

    log(`new version available: v${current} → v${latest.tag}, starting upgrade...`);

    const notifyText = formatUpgradeNotification({
      from: current, to: latest.tag, notes: latest.body, url: latest.url, status: 'running',
    });
    await notifyOwners(notifyText, enabledOrgConfigs, postForOrgFn, apiPathFn);

    spawnUpgradeExecutor(current, latest.tag, latest.body, latest.url);
  } catch (e) {
    warn(`check failed: ${e.message}`);
  }
}
