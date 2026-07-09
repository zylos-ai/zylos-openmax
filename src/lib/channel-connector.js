/**
 * Channel connector — external-agent IM channel install/uninstall.
 *
 * Phase 1 (feishu-websocket). cws-connect dispatches a `channel.*` command over
 * cws-comm to this openmax runtime. We pull the bind credentials from cws-core
 * (BFF) with a one-shot X-Channel-Bind-Token, then install / configure / start
 * the corresponding zylos IM component. This mirrors the credential-lifecycle
 * precedent (comm-bridge's handleConnectionEvent): fire-and-forget from the WS
 * dispatcher, best-effort, and it MUST NEVER throw out into the dispatcher.
 *
 * Platform agents use a different path (cws-agent-manager) — not our concern.
 *
 * Deps are injected so the flow is unit-testable without a live cws-core, the
 * `zylos`/`pm2` binaries, or the real filesystem (see channel-connector.test.js).
 *
 * DEFERRED (follow-ups — intentionally NOT implemented here):
 *   - Reconnect-reconcile: on WS reconnect, query cws-connect for bindings whose
 *     install command we may have missed while disconnected, and re-drive them.
 *     No endpoint exists yet — add when cws-connect exposes one.
 *   - Immediate status callback to cws-connect after install. For now the
 *     install result is reconciled asynchronously via the `installed_channels`
 *     field of the runtime-metrics report (see metrics-reporter.js). A direct
 *     per-command status callback is a future improvement.
 */

import fs from 'fs';
import path from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const HOME = process.env.HOME;

const promisifiedExecFile = promisify(execFileCb);

// Bounded timeouts: everything here runs on the comm-bridge WS event loop, so a
// hung `zylos`/`pm2` must never freeze heartbeats indefinitely.
const INSTALL_TIMEOUT_MS = 180_000; // `zylos add` may run npm install
const QUERY_TIMEOUT_MS = 20_000;    // info / pm2 / restart

const realExecFile = (file, args, opts) =>
  promisifiedExecFile(file, args, { timeout: QUERY_TIMEOUT_MS, ...(opts || {}) });

/**
 * channel_type → the zylos IM component that services it, plus the mapping from
 * the pulled credential config (a { key: value } map from cws-core) to what the
 * component actually consumes. Adding a channel later is a one-liner here.
 *
 * Phase 1: ONLY feishu is wired up. Any other channel_type is intentionally
 * absent so handleChannelCommand skips it with a warning.
 */
export const CHANNEL_COMPONENT = {
  feishu: {
    component: 'feishu',
    pm2Service: 'zylos-feishu',
    // The feishu component (zylos-feishu) reads its bot credentials from
    // ~/zylos/.env (FEISHU_APP_ID / FEISHU_APP_SECRET) at process start, and its
    // non-secret runtime config from components/feishu/config.json
    // (connection_mode, enabled, ...). So buildConfig returns BOTH:
    //   - env:        the secrets, written to ~/zylos/.env
    //   - configJson: a merge patch for the component's config.json
    // NOTE: the exact key names in the pulled config are owned by cws-core;
    // we accept a few likely spellings for the app id / secret. Double-check
    // against the real cws-core channel-binding credential payload.
    buildConfig(config) {
      const c = config || {};
      const appId = c.app_id ?? c.appId ?? c.APP_ID ?? c.feishu_app_id ?? '';
      const appSecret = c.app_secret ?? c.appSecret ?? c.APP_SECRET ?? c.feishu_app_secret ?? '';
      return {
        env: {
          // The feishu/lark component shares one codebase; FEISHU_IS_LARK
          // selects the Feishu (China) endpoints over Lark (intl). coco-dashboard's
          // provisioning path sets this for feishu, so we match it here.
          FEISHU_IS_LARK: 'N',
          FEISHU_APP_ID: appId,
          FEISHU_APP_SECRET: appSecret,
        },
        configJson: {
          enabled: true,
          connection_mode: 'websocket',
        },
      };
    },
  },
};

/**
 * True for cws-connect channel-connector commands (`channel.install`,
 * `channel.update-credentials`, `channel.uninstall`, ...). classifySystemEvent
 * in comm-bridge delegates here so the predicate has a single, testable home.
 */
export function isChannelEvent(eventName) {
  return String(eventName || '').toLowerCase().startsWith('channel.');
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
      // Function replacement so `$&`/`$1` in the secret are not interpreted.
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
 * Build the channel-command handler.
 *
 * @param {object} deps
 * @param {(orgId:string, path:string, extraHeaders:object) => Promise<any>} deps.getForOrgWithHeaders
 * @param {(p:string) => string} deps.apiPath
 * @param {(key:string) => boolean} deps.dedupe   returns true if already seen
 * @param {function} [deps.execFile]  promisified (file, args, opts) => {stdout}
 * @param {function} [deps.writeEnv]  (vars) => void
 * @param {function} [deps.writeConfig] (component, patch) => void
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
  log = () => {},
  warn = () => {},
  home = HOME,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
} = {}) {
  const doWriteEnv = writeEnv || ((vars) => defaultWriteEnv(vars, { home }));
  const doWriteConfig = writeConfig || ((component, patch) => defaultWriteConfig(component, patch, { home }));

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

  async function startOrRestartService(spec) {
    // Prefer restart --update-env so a running service re-reads the freshly
    // written ~/zylos/.env. If it is not yet registered (fresh install),
    // fall back to starting from its ecosystem file.
    try {
      await execFile('pm2', ['restart', spec.pm2Service, '--update-env'], { timeout: queryTimeoutMs });
      return;
    } catch {
      /* not registered yet — start below */
    }
    const ecosystem = path.join(home, 'zylos/.claude/skills', spec.component, 'ecosystem.config.cjs');
    await execFile('pm2', ['start', ecosystem, '--update-env'], { timeout: queryTimeoutMs });
  }

  async function installChannelComponent(slug, spec, config) {
    const built = spec.buildConfig(config);

    // 1. ensure the component is installed
    try {
      if (!(await isComponentInstalled(spec.component))) {
        log(`[${slug}] installing channel component '${spec.component}'...`);
        await execFile('zylos', ['add', spec.component, '--yes'], { timeout: installTimeoutMs });
        log(`[${slug}] channel component '${spec.component}' installed`);
      }
    } catch (e) {
      warn(`[${slug}] channel component install failed (${spec.component}): ${e.message}`);
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
      return;
    }

    // 4. start / restart the pm2 service so it picks up the new credentials
    try {
      await startOrRestartService(spec);
      log(`[${slug}] channel component '${spec.component}' started (${spec.pm2Service})`);
    } catch (e) {
      warn(`[${slug}] starting service failed (${spec.pm2Service}): ${e.message}`);
    }
  }

  async function uninstallChannelComponent(slug, spec) {
    try {
      await execFile('zylos', ['uninstall', spec.component, '--force'], { timeout: installTimeoutMs });
      log(`[${slug}] channel component '${spec.component}' uninstalled`);
    } catch (e) {
      warn(`[${slug}] channel component uninstall failed (${spec.component}): ${e.message}`);
    }
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

      // Replay/reconnect-safe: cws-comm may redeliver the same command on a
      // catch-up sweep. Keyed by action+binding+request so a genuine retry with
      // a new request_id is NOT deduped.
      const dedupKey = `channel:${action}:${binding_id}:${request_id}`;
      if (dedupe(dedupKey)) {
        log(`[${slug}] channel ${action} dedup binding=${binding_id}`);
        return;
      }

      const orgId = orgConfig.org_id;
      const spec = CHANNEL_COMPONENT[channel_type];

      if (action === 'install' || action === 'update-credentials') {
        if (!spec) {
          warn(`[${slug}] channel_type '${channel_type}' not yet supported on external agents `
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
          // request() already unwraps the D8 envelope's outer `.data`; accept
          // both `{ config }` and a still-nested `{ data: { config } }`.
          config = resp?.config ?? resp?.data?.config ?? null;
        } catch (e) {
          warn(`[${slug}] channel credential pull failed binding=${binding_id}: ${e.message}`);
          return;
        }
        if (!config || typeof config !== 'object' || Object.keys(config).length === 0) {
          warn(`[${slug}] channel credential empty/absent binding=${binding_id} — skipping`);
          return;
        }

        // Log KEYS only — the config values are secrets.
        log(`[${slug}] channel ${action} ${channel_type} binding=${binding_id} `
          + `config keys=[${Object.keys(config).join(',')}]`);
        await installChannelComponent(slug, spec, config);
        return;
      }

      if (action === 'uninstall') {
        if (!spec) {
          log(`[${slug}] channel uninstall for unsupported channel_type '${channel_type}' — nothing to do`);
          return;
        }
        await uninstallChannelComponent(slug, spec);
        return;
      }

      warn(`[${slug}] unknown channel action '${action}' binding=${binding_id}`);
    } catch (e) {
      // Absolute backstop: this runs off the WS dispatcher and must NEVER throw.
      warn(`[${orgConfig?.slug}] handleChannelCommand crashed: ${e?.message || e}`);
    }
  };
}
