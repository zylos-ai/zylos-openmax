/**
 * Channel connector — IM channel connect / disconnect for the openmax path.
 *
 * cws-connect dispatches a `channel.connect` / `channel.disconnect` command over
 * cws-comm to this openmax runtime. This is the single channel path for ALL
 * agents (platform + external): openmax runs in every agent's pod, so the
 * backend no longer distinguishes agent type or calls cws-agent-manager for
 * channels.
 *
 * connect (idempotent): pull bind credentials from cws-core (BFF) with a
 * one-shot X-Channel-Bind-Token → probe the component → `zylos add` if missing /
 * `zylos upgrade` if present (`zylos add` refuses an already-installed
 * component, so the probe-then-branch is required) → write creds + config →
 * restart → verify the component actually connected → report the result back to
 * cws-connect.
 *
 * disconnect (soft-disable, mirrors coco-dashboard): stop the service + set the
 * component's `enabled: false`; keep the component installed and its
 * credentials. Reconnect is the same idempotent connect (upgrade branch).
 *
 * Fire-and-forget from the WS dispatcher (comm-bridge awaits nothing; it only
 * `.catch`es), so a bounded verify does not block heartbeats. This function MUST
 * NEVER throw out into the dispatcher.
 *
 * Deps are injected so the flow is unit-testable without a live cws-core, the
 * `zylos`/`pm2` binaries, or the real filesystem (see channel-connector.test.js).
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const HOME = process.env.HOME;

const promisifiedExecFile = promisify(execFileCb);

// Bounded timeouts: everything here runs off the comm-bridge WS event loop.
const INSTALL_TIMEOUT_MS = 180_000; // `zylos add`/`upgrade` may run npm install
const QUERY_TIMEOUT_MS = 20_000;    // info / pm2 / restart / stop
const VERIFY_TIMEOUT_MS = 60_000;   // bounded wait for the component to connect
const VERIFY_POLL_MS = 2_000;

const realExecFile = (file, args, opts) =>
  promisifiedExecFile(file, args, { timeout: QUERY_TIMEOUT_MS, ...(opts || {}) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * channel_type → the zylos IM component that services it, plus the mapping from
 * the pulled credential config (a { key: value } map from cws-core) to what the
 * component consumes. Scope: feishu (the one channel openmax implements today);
 * add more entries here as they are supported.
 */
export const CHANNEL_COMPONENT = {
  feishu: {
    component: 'feishu',
    pm2Service: 'zylos-feishu',
    // zylos-feishu reads FEISHU_APP_ID / FEISHU_APP_SECRET from ~/zylos/.env at
    // process start, and connection_mode / enabled from
    // components/feishu/config.json. buildConfig returns both.
    // NOTE: cws-core owns the exact pulled key names; accept a few spellings.
    buildConfig(config) {
      const c = config || {};
      const appId = c.app_id ?? c.appId ?? c.APP_ID ?? c.feishu_app_id ?? '';
      const appSecret = c.app_secret ?? c.appSecret ?? c.APP_SECRET ?? c.feishu_app_secret ?? '';
      return {
        env: { FEISHU_APP_ID: appId, FEISHU_APP_SECRET: appSecret },
        configJson: { enabled: true, connection_mode: 'websocket' },
      };
    },
  },
};

/**
 * True for cws-connect channel-connector commands (`channel.connect`,
 * `channel.disconnect`, ...). classifySystemEvent in comm-bridge delegates here.
 */
export function isChannelEvent(eventName) {
  return String(eventName || '').toLowerCase().startsWith('channel.');
}

/**
 * Normalize the command action to `connect` / `disconnect`. Tolerant of the
 * legacy install / update-credentials / uninstall names during the transition
 * so the connector works regardless of which cws-connect version dispatches.
 */
export function normalizeAction(action) {
  const a = String(action || '').toLowerCase();
  if (a === 'connect' || a === 'install' || a === 'update-credentials') return 'connect';
  if (a === 'disconnect' || a === 'uninstall') return 'disconnect';
  return a;
}

// Whether a fan-out event addressed to a set of agents (or a single one) is for
// this agent. Mirrors comm-bridge's isEventForMe for connection events.
function isEventForMe(data, selfMemberId) {
  if (data.agent_member_id) return data.agent_member_id === selfMemberId;
  if (Array.isArray(data.agent_member_ids)) return data.agent_member_ids.includes(selfMemberId);
  return true;
}

// --- default filesystem writers (overridable via deps for tests) -------------

// Upsert KEY=VALUE lines into ~/zylos/.env. Never logs values. Atomic write.
function defaultWriteEnv(vars, { home = HOME, fsDep = fs } = {}) {
  const envPath = path.join(home, 'zylos/.env');
  let content = '';
  try { content = fsDep.readFileSync(envPath, 'utf8'); } catch { /* first write */ }
  for (const [key, value] of Object.entries(vars)) {
    const safeVal = String(value ?? '');
    const keyRe = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
    if (keyRe.test(content)) {
      content = content.replace(keyRe, () => `${key}=${safeVal}`);
    } else {
      if (content.length && !content.endsWith('\n')) content += '\n';
      content += `${key}=${safeVal}\n`;
    }
  }
  const tmp = `${envPath}.tmp.${process.pid}`;
  fsDep.writeFileSync(tmp, content);
  fsDep.renameSync(tmp, envPath);
}

// Merge a patch into components/<component>/config.json. Atomic write.
function defaultWriteConfig(component, patch, { home = HOME, fsDep = fs } = {}) {
  const dir = path.join(home, 'zylos/components', component);
  const cfgPath = path.join(dir, 'config.json');
  fsDep.mkdirSync(dir, { recursive: true });
  let existing = {};
  try { existing = JSON.parse(fsDep.readFileSync(cfgPath, 'utf8')); } catch { /* new config */ }
  const merged = { ...existing, ...patch };
  const tmp = `${cfgPath}.tmp.${process.pid}`;
  fsDep.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fsDep.renameSync(tmp, cfgPath);
}

/**
 * Default connect verification: bounded poll that the pm2 service reaches
 * `online`. NOTE: this is a PROCESS-HEALTH check only — it does NOT confirm the
 * IM side (e.g. the Feishu websocket handshake / bot login) actually succeeded,
 * so wrong credentials can still surface as "connected". A real readiness
 * signal from the component (ws-connected marker) should replace this; tracked
 * in zylos-openmax#34. Returns true if online within the timeout, else false.
 */
async function defaultVerify(spec, { execFile, timeoutMs = VERIFY_TIMEOUT_MS, pollMs = VERIFY_POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let online = false;
    try {
      const { stdout } = await execFile('pm2', ['jlist']);
      const procs = JSON.parse(String(stdout));
      if (Array.isArray(procs)) {
        const p = procs.find((x) => x?.name === spec.pm2Service);
        online = p?.pm2_env?.status === 'online';
      }
    } catch { /* pm2 unavailable — retry until deadline */ }
    if (online) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Build the channel-command handler.
 *
 * @param {object} deps
 * @param {(orgId:string, path:string, extraHeaders:object) => Promise<any>} deps.getForOrgWithHeaders
 * @param {(p:string) => string} deps.apiPath
 * @param {(key:string) => boolean} deps.dedupe   returns true if already seen
 * @param {function} [deps.execFile]  promisified (file, args, opts) => {stdout}
 * @param {function} [deps.writeEnv]  (vars) => void
 * @param {function} [deps.writeConfig] (component, patch) => void
 * @param {(spec) => Promise<boolean>} [deps.verifyConnected]  connect verification
 * @param {(result) => Promise<void>} [deps.reportResult]  connect-result callback
 * @param {function} [deps.log] @param {function} [deps.warn]
 * @param {string}   [deps.home]
 * @returns {(orgConfig, frame) => Promise<void>} never throws
 */
export function createChannelInstaller({
  getForOrgWithHeaders,
  apiPath,
  dedupe,
  execFile = realExecFile,
  writeEnv,
  writeConfig,
  verifyConnected,
  reportResult,
  log = () => {},
  warn = () => {},
  home = HOME,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
} = {}) {
  const doWriteEnv = writeEnv || ((vars) => defaultWriteEnv(vars, { home }));
  const doWriteConfig = writeConfig || ((component, patch) => defaultWriteConfig(component, patch, { home }));
  const doVerify = verifyConnected || ((spec) => defaultVerify(spec, { execFile, timeoutMs: verifyTimeoutMs }));
  // Default connect-result callback: log-only placeholder. The real per-binding
  // report to cws-connect is wired once cws-connect exposes the endpoint
  // (coco-workspace/cws-connect#4). Must never throw.
  const doReport = reportResult || (async (r) => {
    log(`[connect-result] binding=${r.bindingId} channel=${r.channelType} status=${r.status}`
      + (r.detail ? ` detail=${r.detail}` : ''));
  });

  const report = async (meta, status, detail = '') => {
    try { await doReport({ ...meta, status, detail }); }
    catch (e) { warn(`[${meta.slug}] connect-result report failed binding=${meta.bindingId}: ${e.message}`); }
  };

  async function isComponentInstalled(component) {
    try {
      const { stdout } = await execFile('zylos', ['info', component, '--json'], { timeout: queryTimeoutMs });
      const info = JSON.parse(String(stdout));
      return !!(info && info.name === component);
    } catch {
      // `zylos info` exits non-zero when the component is not installed.
      return false;
    }
  }

  // Idempotent: install if missing, upgrade if present. `zylos add` refuses an
  // already-installed component (won't upgrade even a lower version), so we must
  // branch on the probe rather than always `add`.
  async function ensureInstalledOrUpgraded(slug, spec) {
    if (await isComponentInstalled(spec.component)) {
      log(`[${slug}] '${spec.component}' already installed → zylos upgrade`);
      await execFile('zylos', ['upgrade', spec.component, '--yes'], { timeout: installTimeoutMs });
    } else {
      log(`[${slug}] '${spec.component}' not installed → zylos add`);
      await execFile('zylos', ['add', spec.component, '--yes'], { timeout: installTimeoutMs });
    }
  }

  async function startOrRestartService(spec) {
    // Prefer restart --update-env so a running service re-reads the freshly
    // written ~/zylos/.env. If it is not yet registered, start from ecosystem.
    try {
      await execFile('pm2', ['restart', spec.pm2Service, '--update-env'], { timeout: queryTimeoutMs });
      return;
    } catch {
      /* not registered yet — start below */
    }
    const ecosystem = path.join(home, 'zylos/.claude/skills', spec.component, 'ecosystem.config.cjs');
    await execFile('pm2', ['start', ecosystem, '--update-env'], { timeout: queryTimeoutMs });
  }

  async function connectChannel(slug, spec, config, meta) {
    const built = spec.buildConfig(config);

    // 1. install or upgrade (idempotent)
    try {
      await ensureInstalledOrUpgraded(slug, spec);
    } catch (e) {
      warn(`[${slug}] install/upgrade failed (${spec.component}): ${e.message}`);
      await report(meta, 'error', 'install/upgrade failed');
      return;
    }

    // 2. write secrets to ~/zylos/.env (log KEYS only, never values)
    try {
      if (built.env && Object.keys(built.env).length) {
        doWriteEnv(built.env);
        log(`[${slug}] wrote channel secrets to .env (keys=[${Object.keys(built.env).join(',')}])`);
      }
    } catch (e) {
      warn(`[${slug}] writing .env failed (${spec.component}): ${e.message}`);
      await report(meta, 'error', 'writing credentials failed');
      return;
    }

    // 3. write non-secret runtime config
    try {
      if (built.configJson) {
        doWriteConfig(spec.component, built.configJson);
        log(`[${slug}] wrote ${spec.component} config.json (keys=[${Object.keys(built.configJson).join(',')}])`);
      }
    } catch (e) {
      warn(`[${slug}] writing config.json failed (${spec.component}): ${e.message}`);
      await report(meta, 'error', 'writing config failed');
      return;
    }

    // 4. start / restart so the component picks up the new credentials
    try {
      await startOrRestartService(spec);
      log(`[${slug}] '${spec.component}' started (${spec.pm2Service})`);
    } catch (e) {
      warn(`[${slug}] starting service failed (${spec.pm2Service}): ${e.message}`);
      await report(meta, 'error', 'starting service failed');
      return;
    }

    // 5. verify the component actually connected (bounded)
    let ok = false;
    try {
      ok = await doVerify(spec);
    } catch (e) {
      warn(`[${slug}] connect verification errored (${spec.component}): ${e.message}`);
      ok = false;
    }

    // 6. report the result back to cws-connect
    await report(meta, ok ? 'connected' : 'error', ok ? '' : 'connect verification failed/timed out');
    log(`[${slug}] connect ${spec.component} binding=${meta.bindingId} → ${ok ? 'connected' : 'error'}`);
  }

  // Soft-disable (mirrors coco-dashboard): stop the service + set enabled:false.
  // Keep the component installed and its credentials, so reconnect is the same
  // idempotent connect (upgrade branch). NOT an uninstall.
  async function disconnectChannel(slug, spec, meta) {
    try {
      await execFile('pm2', ['stop', spec.pm2Service], { timeout: queryTimeoutMs });
      log(`[${slug}] stopped ${spec.pm2Service}`);
    } catch (e) {
      warn(`[${slug}] pm2 stop failed (${spec.pm2Service}): ${e.message}`);
    }
    try {
      doWriteConfig(spec.component, { enabled: false });
    } catch (e) {
      warn(`[${slug}] disabling ${spec.component} config failed: ${e.message}`);
    }
    await report(meta, 'disconnected', '');
    log(`[${slug}] disconnect ${spec.component} binding=${meta.bindingId} → soft-disabled (kept installed + creds)`);
  }

  return async function handleChannelCommand(orgConfig, frame) {
    try {
      const { event, data } = frame?.payload || {};
      if (!event || !data) return;

      const slug = orgConfig.slug;
      const selfId = orgConfig.self?.member_id;
      const {
        channel_type,
        action,
        binding_id,
        request_id,
        credential_pull_token,
      } = data;

      if (!binding_id) {
        warn(`[${slug}] channel ${event}: missing binding_id`);
        return;
      }
      if (!isEventForMe(data, selfId)) {
        log(`[${slug}] channel ${event} not for us (binding=${binding_id}), skip`);
        return;
      }

      const act = normalizeAction(action);

      // Replay/reconnect-safe: cws-comm may redeliver the same command on a
      // catch-up sweep. Keyed by action+binding+request so a genuine retry with
      // a new request_id is NOT deduped.
      const dedupKey = `channel:${act}:${binding_id}:${request_id}`;
      if (dedupe(dedupKey)) {
        log(`[${slug}] channel ${act} dedup binding=${binding_id}`);
        return;
      }

      const orgId = orgConfig.org_id;
      const spec = CHANNEL_COMPONENT[channel_type];
      const meta = { slug, orgId, bindingId: binding_id, channelType: channel_type, requestId: request_id };

      if (act === 'connect') {
        if (!spec) {
          warn(`[${slug}] channel_type '${channel_type}' not supported by openmax `
            + `(binding=${binding_id}) — skipping`);
          return;
        }

        // Pull the bind credentials. The one-shot token authorizes the pull; it
        // is NOT the org JWT (which getForOrgWithHeaders still attaches).
        let config;
        try {
          const resp = await getForOrgWithHeaders(
            orgId,
            apiPath(`/connect/channel-bindings/${binding_id}/credential`),
            { 'X-Channel-Bind-Token': credential_pull_token || '' },
          );
          config = resp?.config ?? resp?.data?.config ?? null;
        } catch (e) {
          warn(`[${slug}] channel credential pull failed binding=${binding_id}: ${e.message}`);
          await report(meta, 'error', 'credential pull failed');
          return;
        }
        if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
          warn(`[${slug}] channel credential empty/absent binding=${binding_id} — skipping`);
          await report(meta, 'error', 'credential empty/absent');
          return;
        }

        // Log KEYS only — the config values are secrets.
        log(`[${slug}] channel connect ${channel_type} binding=${binding_id} `
          + `config keys=[${Object.keys(config).join(',')}]`);
        await connectChannel(slug, spec, config, meta);
        return;
      }

      if (act === 'disconnect') {
        if (!spec) {
          log(`[${slug}] channel disconnect for unsupported channel_type '${channel_type}' — nothing to do`);
          return;
        }
        await disconnectChannel(slug, spec, meta);
        return;
      }

      warn(`[${slug}] unknown channel action '${action}' binding=${binding_id}`);
    } catch (e) {
      // Absolute backstop: this runs off the WS dispatcher and must NEVER throw.
      warn(`[${orgConfig?.slug}] handleChannelCommand crashed: ${e?.message || e}`);
    }
  };
}
