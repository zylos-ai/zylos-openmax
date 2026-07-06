/**
 * Auto-upgrade — periodically check GitHub for new releases and notify.
 *
 * Flow:
 *   1. Timer fires (first check after INITIAL_DELAY, then every intervalMs).
 *   2. Fetch latest GitHub release tag via REST API.
 *   3. Compare against current package.json version (semver).
 *   4. If newer: notify owners via DM (detect-and-notify only).
 *
 * Self-execution (`zylos upgrade` from within the process) is disabled —
 * the upgrade command stops this PM2 service as its first step, killing
 * the parent process mid-execution and leaving the service stopped.
 * Upgrades should be triggered externally (manual or via ops-agent).
 *
 * Config (all optional, in config.json top level):
 *   autoUpgrade.enabled        — boolean, default true
 *   autoUpgrade.intervalHours  — number,  default 24
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const HOME = process.env.HOME || '/tmp';
const RUNTIME_DIR = path.join(HOME, 'zylos/components/openmax/runtime');
const MARKER_PATH = path.join(RUNTIME_DIR, 'upgrade-marker.json');
const SEND_SCRIPT = path.resolve(new URL('../../scripts/send.js', import.meta.url).pathname);
const GITHUB_REPO = 'zylos-ai/zylos-openmax';
export const INITIAL_DELAY_MS = 60 * 1000;

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
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return {
    tag: (data.tag_name || '').replace(/^v/, ''),
    name: data.name || data.tag_name || '',
    body: data.body || '',
    url: data.html_url || '',
  };
}

export function readAndClearMarker() {
  try {
    const raw = fs.readFileSync(MARKER_PATH, 'utf-8');
    fs.unlinkSync(MARKER_PATH);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Send a message to a conversation via scripts/send.js.
 * send.js handles auth, org resolution, and message formatting.
 */
function sendMessage(conversationId, text) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [SEND_SCRIPT, conversationId, text], { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
  });
}

/**
 * Build the upgrade notification text from the marker.
 */
export function formatUpgradeNotification(marker) {
  const lines = marker.completed
    ? [`OpenMax upgraded: v${marker.from} → v${marker.to}`]
    : [`OpenMax update available: v${marker.from} → v${marker.to}`,
       '', 'Run `zylos upgrade openmax --yes --mode overwrite` to upgrade.'];
  if (marker.notes) {
    const summary = marker.notes.split('\n').filter(l => l.trim()).slice(0, 8).join('\n');
    if (summary) lines.push('', summary);
  }
  if (marker.url) lines.push('', marker.url);
  return lines.join('\n');
}

/**
 * On startup, check for a completed-upgrade marker left by an external
 * `zylos upgrade` run and notify owners. The marker is written by
 * checkAndUpgrade() but the actual upgrade is done externally.
 */
export async function notifyUpgradeComplete(enabledOrgConfigs, postForOrgFn, apiPathFn) {
  const marker = readAndClearMarker();
  if (!marker) return;
  log(`upgrade completed: v${marker.from} → v${marker.to}, notifying owners...`);
  const text = formatUpgradeNotification({ ...marker, completed: true });

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
}

/**
 * Notify owners about an available update (no self-upgrade).
 */
async function notifyUpdateAvailable(current, latest, enabledOrgConfigs, postForOrgFn, apiPathFn) {
  const text = formatUpgradeNotification({ from: current, to: latest.tag, notes: latest.body, url: latest.url });
  for (const [slug, orgConfig] of enabledOrgConfigs) {
    const ownerMemberId = orgConfig.owner?.member_id;
    if (!ownerMemberId) continue;
    try {
      const res = await postForOrgFn(orgConfig.org_id,
        apiPathFn('/conversations/dm'), { peer_member_id: ownerMemberId });
      const convId = res?.conversation?.id;
      if (!convId) continue;
      await sendMessage(convId, text);
      log(`[${slug}] owner notified of v${latest.tag}`);
    } catch (e) {
      warn(`[${slug}] notification failed: ${e.message}`);
    }
  }
}

export async function checkForUpdates(enabledOrgConfigs, postForOrgFn, apiPathFn) {
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
    log(`new version available: v${current} → v${latest.tag}, notifying owners...`);
    await notifyUpdateAvailable(current, latest, enabledOrgConfigs, postForOrgFn, apiPathFn);
  } catch (e) {
    warn(`check failed: ${e.message}`);
  }
}
