/**
 * Market client install on explicit request (self-hosted Agents).
 *
 * On each periodic sync, pull the Agent's pending market client request from
 * cws-core: GET /api/v1/agents/{member_id}/market-client. When one is pending,
 * install or upgrade the market client and report the outcome:
 * POST /api/v1/agents/{member_id}/market-client:result.
 *
 * - The component name is a constant; nothing the server sends is used as a
 *   name, ref or command. Only `version` is read, and it must be X.Y.Z.
 * - zylos is run with an argv array (no shell).
 * - Each request id is acted on at most once (persisted across restarts); a
 *   failed install is not retried until the server issues a new request. Only
 *   pending requests are acted on, so an owner uninstall is respected.
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

export const MARKET_CLIENT_COMPONENT = 'om-marketplace-client';

const INSTALL_TIMEOUT_MS = 180_000;
const QUERY_TIMEOUT_MS = 20_000;
const MAX_REMEMBERED_REQUESTS = 50;

const SEMVER_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const promisifiedExecFile = promisify(execFileCb);
const realExecFile = (file, args, opts) => promisifiedExecFile(file, args, opts);

const DEFAULT_STATE_PATH = path.join(process.env.HOME || '/tmp', 'zylos/components/openmax/runtime/market-client.json');

export function parseStrictSemver(value) {
  if (typeof value !== 'string') return null;
  const m = SEMVER_RE.exec(value);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// Reported versions: a leading "v" is stripped, then strict X.Y.Z is required.
export function normaliseVersion(value) {
  if (typeof value !== 'string') return null;
  const stripped = value.startsWith('v') ? value.slice(1) : value;
  return parseStrictSemver(stripped) ? stripped : null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function fileStore(statePath) {
  return {
    load() {
      try {
        const parsed = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        return parsed && typeof parsed.requests === 'object' && parsed.requests ? parsed : { requests: {} };
      } catch {
        return { requests: {} };
      }
    },
    save(state) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp.${process.pid}.${Date.now()}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
        fs.renameSync(tmp, statePath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        throw err;
      }
    },
  };
}

// Exit status only: zylos output is never logged or reported.
function describeExecError(err) {
  if (err?.killed || err?.signal) return `signal=${err.signal || 'SIGTERM'}`;
  if (err?.code !== undefined) return `exit=${err.code}`;
  return 'spawn failed';
}

export function createMarketClientEnsurer({
  loadConfig,
  getForOrg,
  postForOrg,
  apiPath,
  log = () => {},
  warn = () => {},
  execFile = realExecFile,
  store = fileStore(DEFAULT_STATE_PATH),
  now = () => Date.now(),
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
} = {}) {
  const unavailable = new Set();
  let chain = Promise.resolve();

  async function installedVersion() {
    let stdout;
    try {
      ({ stdout } = await execFile('zylos', ['info', MARKET_CLIENT_COMPONENT, '--json'], { timeout: queryTimeoutMs }));
    } catch {
      return { installed: false, version: null };
    }
    try {
      const info = JSON.parse(String(stdout));
      if (!info || info.name !== MARKET_CLIENT_COMPONENT) return { installed: false, version: null };
      return { installed: true, version: normaliseVersion(info.version) };
    } catch {
      return { installed: true, version: null };
    }
  }

  async function install(slug, version) {
    const before = await installedVersion();
    const current = parseStrictSemver(before.version);
    if (before.installed && current && compareSemver(current, parseStrictSemver(version)) >= 0) {
      return { outcome: 'succeeded', client_version: before.version };
    }
    const args = before.installed
      ? ['upgrade', MARKET_CLIENT_COMPONENT, '--yes']
      : ['add', `${MARKET_CLIENT_COMPONENT}@${version}`, '--yes'];
    log(`[${slug}] market client: zylos ${args[0]} ${args[1]}`);
    try {
      await execFile('zylos', args, { timeout: installTimeoutMs });
    } catch (err) {
      const timedOut = !!(err?.killed || err?.signal);
      warn(`[${slug}] market client: zylos ${args[0]} failed (${describeExecError(err)})`);
      return {
        outcome: 'failed',
        reason: timedOut ? 'install_timeout' : (before.installed ? 'upgrade_failed' : 'install_failed'),
      };
    }
    const after = await installedVersion();
    if (!after.installed || !after.version) {
      return { outcome: 'failed', reason: 'version_unverified' };
    }
    return { outcome: 'succeeded', client_version: after.version };
  }

  async function report(orgConfig, memberId, requestId, result) {
    const body = { request_id: requestId, outcome: result.outcome };
    if (result.client_version) body.client_version = result.client_version;
    if (result.reason) body.reason = result.reason;
    await postForOrg(orgConfig.org_id, apiPath(`/agents/${memberId}/market-client:result`), body);
  }

  function remember(state, requestId, entry) {
    state.requests[requestId] = { ...(state.requests[requestId] || {}), ...entry, updated_at: now() };
    const ids = Object.keys(state.requests);
    if (ids.length > MAX_REMEMBERED_REQUESTS) {
      ids.sort((a, b) => (state.requests[a].updated_at || 0) - (state.requests[b].updated_at || 0));
      for (const id of ids.slice(0, ids.length - MAX_REMEMBERED_REQUESTS)) delete state.requests[id];
    }
    store.save(state);
  }

  async function reportAndRecord(orgConfig, memberId, requestId, state, result) {
    try {
      await report(orgConfig, memberId, requestId, result);
      remember(state, requestId, { reported: true });
      log(`[${orgConfig.slug}] market client: reported ${result.outcome} request=${requestId}`);
    } catch (err) {
      warn(`[${orgConfig.slug}] market client: result report failed request=${requestId}: ${err.message}`);
    }
  }

  async function run(orgConfig) {
    const slug = orgConfig.slug;
    let memberId = orgConfig.self?.member_id;
    if (!memberId) memberId = loadConfig?.().orgs?.[slug]?.self?.member_id || '';
    if (!memberId) return;

    let pending;
    try {
      pending = await getForOrg(orgConfig.org_id, apiPath(`/agents/${memberId}/market-client`), undefined, { quietOnSuccess: true });
    } catch (err) {
      if (err?.status === 404) {
        if (!unavailable.has(slug)) {
          unavailable.add(slug);
          log(`[${slug}] market client request endpoint not available (404), skipping`);
        }
        return;
      }
      throw err;
    }
    unavailable.delete(slug);
    if (!pending || pending.required !== true) return;

    const requestId = typeof pending.request_id === 'string' ? pending.request_id : '';
    if (!UUID_RE.test(requestId)) {
      warn(`[${slug}] market client: ignoring request with an invalid request_id`);
      return;
    }

    const state = store.load();
    const seen = state.requests[requestId];
    if (seen) {
      if (seen.reported) return;
      // Crash mid-install leaves no result: report it, never reinstall.
      const result = seen.result || { outcome: 'failed', reason: 'interrupted' };
      if (!seen.result) remember(state, requestId, { result });
      await reportAndRecord(orgConfig, memberId, requestId, state, result);
      return;
    }

    remember(state, requestId, { org: slug, reported: false });

    let result;
    const version = pending.version;
    if (!parseStrictSemver(version)) {
      warn(`[${slug}] market client: rejected request=${requestId}, version is not X.Y.Z`);
      result = { outcome: 'failed', reason: 'invalid_version' };
    } else {
      result = await install(slug, version);
    }
    remember(state, requestId, { result });
    await reportAndRecord(orgConfig, memberId, requestId, state, result);
  }

  // Serialized: one install at a time across orgs.
  return function ensureMarketClient(orgConfig) {
    const next = chain.then(() => run(orgConfig));
    chain = next.catch(() => {});
    return next;
  };
}
