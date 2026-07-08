/**
 * Auto-upgrade — periodically check GitHub for new releases and upgrade openmax
 * via a dedicated, on-demand PM2 app (the "upgrader").
 *
 * Flow:
 *   1. Timer fires (first check after INITIAL_DELAY, then every intervalMs).
 *   2. Fetch latest GitHub release tag via REST API.
 *   3. Compare against current package.json version (semver).
 *   4. If newer: write a 'running' marker, notify owners, then start the
 *      executor as its OWN PM2 app (`zylos-openmax-upgrader`) via `pm2 start`.
 *   5. Because a pm2-started process is parented to the PM2 daemon (a sibling of
 *      zylos-openmax, not a descendant), the `pm2 stop zylos-openmax` inside
 *      `zylos upgrade openmax` can never kill it — no "suicide" mid-upgrade.
 *      The executor verifies the new version, writes a terminal marker, ensures
 *      the service is running on failure, and removes its own PM2 entry.
 *   6. On the next startup / check, notifyUpgradeComplete reads the terminal
 *      marker and DMs owners. A leftover upgrader found on a later check is
 *      treated as a zombie: cleaned up and (if its marker was still 'running')
 *      recorded as a failed version so it is never retried into a loop.
 *
 * Config (all optional, in config.json top level):
 *   autoUpgrade.enabled        — boolean, default true
 *   autoUpgrade.intervalHours  — number,  default 24
 */

import fs from 'fs';
import path from 'path';
import { execFile, execFileSync } from 'child_process';

const HOME = process.env.HOME || '/tmp';
const RUNTIME_DIR = path.join(HOME, 'zylos/components/openmax/runtime');
const MARKER_PATH = path.join(RUNTIME_DIR, 'upgrade-marker.json');
const SEND_SCRIPT = path.resolve(new URL('../../scripts/send.js', import.meta.url).pathname);
const EXECUTOR_SCRIPT = path.resolve(new URL('../../scripts/upgrade-executor.cjs', import.meta.url).pathname);
const FAILED_VERSION_PATH = path.join(RUNTIME_DIR, 'upgrade-failed-version');
const GITHUB_REPO = 'zylos-ai/zylos-openmax';
export const INITIAL_DELAY_MS = 60 * 1000;

// PM2 app name for the on-demand upgrade executor. It is started as its own PM2
// app (a sibling of zylos-openmax under the PM2 daemon) so that the
// `pm2 stop zylos-openmax` inside `zylos upgrade openmax` can never kill it.
const PM2_UPGRADER = 'zylos-openmax-upgrader';

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
    // Don't consume 'running' markers — the executor owns them and will write
    // the terminal result. zylos upgrade restarts this service mid-upgrade, so
    // startup must not treat 'running' as terminal.
    if (data.status === 'running') return null;
    fs.unlinkSync(MARKER_PATH);
    return data;
  } catch {
    return null;
  }
}

/** Read the marker without consuming it. Returns null if absent/unreadable. */
function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER_PATH, 'utf-8'));
  } catch {
    return null;
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

/**
 * Return the PM2 process record for the upgrader app, or null if it is not
 * currently registered.
 */
function getUpgraderProc() {
  try {
    const out = execFileSync('pm2', ['jlist'], { timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    const procs = JSON.parse(out.toString());
    return procs.find(p => p.name === PM2_UPGRADER) || null;
  } catch {
    return null;
  }
}

/**
 * Remove a leftover upgrader PM2 entry. The upgrader deletes itself when it
 * finishes, but if it ever crashes before doing so a stopped/errored entry can
 * linger. Clearing it here keeps `pm2 list` clean and frees the name for the
 * next real upgrade.
 */
function deleteUpgraderEntry() {
  try {
    execFileSync('pm2', ['delete', PM2_UPGRADER], { timeout: 15000, stdio: 'ignore' });
    log(`removed leftover upgrader pm2 entry (${PM2_UPGRADER})`);
  } catch {
    // Not registered / already gone — nothing to do.
  }
}

/**
 * Pre-flight guard against concurrent / stuck upgrades.
 *
 * @returns {boolean} true if an upgrade is genuinely in progress (caller should
 *   skip), false if it is safe to proceed. Side effect: clears zombie upgrader
 *   entries so a crashed previous run never blocks future upgrades forever.
 */
function upgradeInProgress() {
  const proc = getUpgraderProc();
  if (!proc) return false;

  const status = proc.pm2_env?.status;
  const marker = readMarker();
  const markerRunning = marker && marker.status === 'running';
  const fresh = markerRunning && Date.now() - (marker.ts || 0) < STALE_RUNNING_THRESHOLD_MS;

  if (status === 'online' && fresh) {
    // Rare legitimate overlap: verification is running unusually long and its
    // window bumps into a detection check. Skip to avoid a concurrent upgrade.
    // In the normal path the executor self-deletes (~40s) well before the next
    // check, so we should almost never get here.
    log('upgrader still online with a fresh marker — treating as an in-flight upgrade, skipping this cycle');
    return true;
  }

  // Anything else means a leaked/zombie upgrader. Given the long check interval
  // and that a healthy executor removes itself within ~40s, finding one here is
  // an anomaly (likely a bug) — surface it loudly, clean it up, and don't let it
  // block future upgrades.
  warn(`found a leftover upgrader (pm2=${status}, markerRunning=${markerRunning}, fresh=${fresh}) — likely a stuck/leaked upgrade, cleaning up`);
  // If the marker was still 'running', the previous upgrade got stuck/killed
  // before writing a terminal result — mark it failed so the owner is notified
  // and the version is recorded as failed (preventing an endless retry loop).
  if (markerRunning) {
    writeMarker({
      ...marker,
      status: 'failed',
      completed: false,
      error: 'Upgrade process was interrupted or leaked (found still registered on a later check)',
    });
  }
  deleteUpgraderEntry();
  return false;
}

/**
 * Start the upgrade executor as its own PM2 app.
 *
 * `--no-autorestart` makes it a one-shot (it must never be relaunched into a
 * loop). We deliberately do NOT run `pm2 save` afterwards, so the upgrader is
 * never persisted into the PM2 dump and a daemon resurrection can't bring back
 * a stale upgrader. The executor removes its own entry when it finishes.
 *
 * @returns {boolean} whether the executor was started.
 */
function startUpgraderApp(fromVersion, toVersion, notes, releaseUrl) {
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

  // Ensure the name is free (defensive — upgradeInProgress already cleared
  // zombies, but a race with a just-finished run could leave a stopped entry).
  deleteUpgraderEntry();

  try {
    execFileSync('pm2', [
      'start', EXECUTOR_SCRIPT,
      '--name', PM2_UPGRADER,
      '--no-autorestart',
      '--interpreter', 'node',
      '--', MARKER_PATH,
    ], {
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Pass our full environment so the upgrader inherits PATH (to find the
      // `zylos` binary), GITHUB_TOKEN, ZYLOS_BIN, etc.
      env: { ...process.env },
    });
    log(`started upgrade executor as pm2 app ${PM2_UPGRADER}`);
    return true;
  } catch (e) {
    warn(`failed to start upgrader pm2 app: ${e.stderr?.toString() || e.message}`);
    // Roll back the running marker so the next check retries instead of seeing
    // a phantom in-progress upgrade.
    try { fs.unlinkSync(MARKER_PATH); } catch {}
    deleteUpgraderEntry();
    return false;
  }
}

export async function checkForUpdates(enabledOrgConfigs, postForOrgFn, apiPathFn) {
  // Guard against concurrent upgrades and clear any zombie upgrader left behind
  // by a crashed previous run (which also converts a stuck marker to failed).
  if (upgradeInProgress()) {
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

    startUpgraderApp(current, latest.tag, latest.body, latest.url);
  } catch (e) {
    warn(`check failed: ${e.message}`);
  }
}
