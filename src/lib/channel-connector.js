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

const PROBE_TIMEOUT_MS = 8_000; // one-shot credential probe against the IM API

// Fetch helper for credential probes: bounded, returns { status, json } and
// never logs the URL or body (they can carry secrets). A thrown error means
// the IM API was unreachable — the caller treats that as INCONCLUSIVE (the
// component may reach the API via its own proxy), not as a credential failure.
async function probeFetch(fetchDep, url, opts, timeoutMs = PROBE_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchDep(url, { ...opts, signal: ctrl.signal });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { status: resp.status, json };
  } finally {
    clearTimeout(t);
  }
}

// Inconclusive marker: probe couldn't decide (unreachable / 5xx / odd body).
// Distinct from { ok:false } which is a DEFINITIVE credential rejection.
const inconclusive = (detail) => {
  const e = new Error(detail);
  e.probeInconclusive = true;
  return e;
};

const DETAIL_MAX_CHARS = 300;

// Failure receipts carry a bounded slice of the underlying error so operators
// can diagnose from the binding row without shell access to the agent host.
// Any secret VALUES this connect flow handled are masked defensively (shell
// errors normally never echo env values, but the receipt leaves the host).
function sanitizeDetail(message, secretValues = []) {
  let s = String(message || '').replace(/\s+/g, ' ').trim();
  for (const v of secretValues) {
    const secret = String(v ?? '');
    if (secret.length >= 6) s = s.split(secret).join('***');
  }
  return s.length > DETAIL_MAX_CHARS ? `${s.slice(0, DETAIL_MAX_CHARS - 3)}...` : s;
}

// Feishu/Lark share the tenant_access_token/internal shape, different domains.
function larkStyleProbe(base) {
  return async (c, { fetchDep, timeoutMs }) => {
    const { status, json } = await probeFetch(fetchDep, `${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: c.app_id, app_secret: c.app_secret }),
    }, timeoutMs);
    if (json && json.code === 0) return { ok: true };
    if (json && typeof json.code === 'number') {
      return { ok: false, detail: `app auth rejected (code ${json.code})` };
    }
    throw inconclusive(`unexpected response (http ${status})`);
  };
}

// ── QR-login flows (wechat / whatsapp) ───────────────────────────────────────
//
// QR channels have no credential form: the user scans a code the component
// generates locally. The connect flow installs/starts the component, then runs
// spec.qrLogin.run(...) which surfaces each fresh QR via onQr (relayed to the
// frontend through cws-connect) and resolves { status:'connected'|'error',
// detail } when the login reaches a terminal state or the deadline passes.

const QR_LOGIN_TIMEOUT_MS = 270_000; // < the FE's 5-min connecting cap
const QR_POLL_MS = 3_000;
// A QR component is often pm2-started moments before the login flow runs: its
// admin token file / HTTP listener / status file appear asynchronously. The
// flow treats "not listening yet" as not-ready and retries within this window
// instead of failing the connect (int E2E 2026-07-10: wechat QR never showed
// because the first /login/start fired the same second the service started).
const QR_READY_TIMEOUT_MS = 45_000;
const QR_READY_POLL_MS = 2_000;

// zylos-wechat: local admin HTTP (default 127.0.0.1:17605, Bearer token file at
// <dataDir>/.admin-token). POST /v1/login/start → session (409 = an account is
// already logged in on this host). GET /v1/login/session → { state:
// idle|qr_ready|scanned|confirmed|expired..., qrPngBase64 }. `confirmed` needs
// POST /v1/login/finalize to persist the account.
export async function wechatQrLogin({
  fetchDep, fsDep = fs, home = HOME, onQr, log,
  timeoutMs = QR_LOGIN_TIMEOUT_MS, pollMs = QR_POLL_MS, sleepDep = sleep,
  readyTimeoutMs = QR_READY_TIMEOUT_MS, readyPollMs = QR_READY_POLL_MS,
}) {
  const base = 'http://127.0.0.1:17605';
  let token = '';
  const call = async (method, p, body) => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const resp = await fetchDep(`${base}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: resp.status, json };
  };

  // Component-ready wait: a missing token file or an unreachable/not-yet-OK
  // admin API right after pm2 start is "booting", not failure — retry within
  // the bounded window. Only a response the component meaningfully produced
  // (200 / 409) exits the loop.
  const readyDeadline = Date.now() + readyTimeoutMs;
  let started = null;
  for (;;) {
    try {
      token = String(fsDep.readFileSync(path.join(home, 'zylos/components/wechat/.admin-token'), 'utf8')).trim();
      if (token) started = await call('POST', '/v1/login/start');
    } catch { started = null; }
    if (started && (started.status === 409 || (started.status === 200 && started.json?.ok))) break;
    if (Date.now() >= readyDeadline) {
      if (started) return { status: 'error', detail: `wechat login start failed (http ${started.status})` };
      return { status: 'error', detail: 'wechat admin token unavailable / login API unreachable (component not ready)' };
    }
    log('[wechat-qr] component not ready yet — retrying');
    await sleepDep(readyPollMs);
  }
  if (started.status === 409) {
    // An account already exists on this host — already logged in.
    log('[wechat-qr] account already present → connected');
    return { status: 'connected', detail: '' };
  }
  const sessionId = started.json.session?.sessionId;

  const deadline = Date.now() + timeoutMs;
  let lastQr = '';
  while (Date.now() < deadline) {
    await sleepDep(pollMs);
    let sess;
    try { sess = (await call('GET', '/v1/login/session')).json?.session; } catch { continue; }
    if (!sess) continue;
    if (sess.state === 'qr_ready' && sess.qrPngBase64 && sess.qrPngBase64 !== lastQr) {
      lastQr = sess.qrPngBase64;
      await onQr(sess.qrPngBase64); // fresh (or rotated) code → relay
    } else if (sess.state === 'confirmed') {
      const fin = await call('POST', '/v1/login/finalize', { sessionId: sess.sessionId || sessionId });
      if (fin.status === 200 && fin.json?.ok) return { status: 'connected', detail: '' };
      return { status: 'error', detail: `wechat login finalize failed (${fin.json?.error?.code ?? fin.status})` };
    } else if (sess.state === 'expired') {
      return { status: 'error', detail: 'wechat login QR expired before scan' };
    }
    // idle / scanned / other intermediate states: keep polling
  }
  try { await call('POST', '/v1/login/cancel', { sessionId }); } catch { /* best-effort */ }
  return { status: 'error', detail: 'wechat login timed out waiting for scan' };
}

// zylos-whatsapp (Baileys): writes <home>/zylos/components/whatsapp/status.json
// ({ status: connecting|qr_waiting|open|disconnected }) and qr.png alongside.
// `open` = logged in (a persisted session reconnects without a scan).
export async function whatsappQrLogin({
  fsDep = fs, home = HOME, onQr, log,
  timeoutMs = QR_LOGIN_TIMEOUT_MS, pollMs = QR_POLL_MS, sleepDep = sleep,
}) {
  const dir = path.join(home, 'zylos/components/whatsapp');
  const deadline = Date.now() + timeoutMs;
  let lastQr = '';
  while (Date.now() < deadline) {
    await sleepDep(pollMs);
    let status = '';
    try { status = JSON.parse(fsDep.readFileSync(path.join(dir, 'status.json'), 'utf8'))?.status || ''; } catch { continue; }
    if (status === 'open') {
      log('[whatsapp-qr] session open → connected');
      return { status: 'connected', detail: '' };
    }
    if (status === 'qr_waiting') {
      try {
        const png = fsDep.readFileSync(path.join(dir, 'qr.png'));
        const b64 = Buffer.from(png).toString('base64');
        if (b64 && b64 !== lastQr) {
          lastQr = b64;
          await onQr(b64); // fresh (or rotated) code → relay
        }
      } catch { /* qr.png being rewritten — next poll */ }
    }
    // connecting / disconnected: Baileys retries and regenerates — keep polling
  }
  return { status: 'error', detail: 'whatsapp login timed out waiting for scan' };
}

/**
 * channel_type → the zylos IM component that services it, plus the mapping from
 * the pulled credential config (a { key: value } map from cws-core, keyed by
 * the cws-connect catalog form-field keys) to what the component consumes.
 *
 * Entry shape:
 *   component   — `zylos add|upgrade` package name. Keys are cws-connect
 *                 channel_type strings, which use underscores for ms_teams /
 *                 whatsapp_business — the entry translates to the hyphenated
 *                 component name (naming decision D-1: alias here, no backend
 *                 rename).
 *   pm2Service  — pm2 process name to restart/stop/health-check.
 *   buildConfig — { env, configJson }: secrets → ~/zylos/.env, non-secret
 *                 runtime flags → components/<c>/config.json. Env var names
 *                 verified against each component's config loader.
 *   probe       — optional one-shot credential check against the IM API
 *                 (deep-verify decision D-5). Returns { ok:true } /
 *                 { ok:false, detail } on a definitive answer; throws
 *                 (probeInconclusive) when the API is unreachable, in which
 *                 case connect proceeds and falls back to process-health
 *                 verification. detail must NEVER contain secrets.
 *
 *   qrLogin     — QR-login channels (wechat / whatsapp) have no credential
 *                 form: connect skips the credential pull, installs/starts the
 *                 component, then runs qrLogin.run(...) which relays each QR
 *                 via reportQR and resolves the terminal login state.
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
    probe: larkStyleProbe('https://open.feishu.cn'),
  },

  lark: {
    component: 'lark',
    pm2Service: 'zylos-lark',
    // Independent fork of the feishu component: LARK_* env vars, and the
    // connection mode key is `transport` (not connection_mode).
    buildConfig(config) {
      const c = config || {};
      return {
        env: { LARK_APP_ID: c.app_id ?? '', LARK_APP_SECRET: c.app_secret ?? '' },
        configJson: { enabled: true, transport: 'websocket' },
      };
    },
    probe: larkStyleProbe('https://open.larksuite.com'),
  },

  telegram: {
    component: 'telegram',
    pm2Service: 'zylos-telegram',
    buildConfig(config) {
      const c = config || {};
      return {
        env: { TELEGRAM_BOT_TOKEN: c.bot_token ?? '' },
        configJson: { enabled: true },
      };
    },
    async probe(c, { fetchDep, timeoutMs }) {
      const { status, json } = await probeFetch(
        fetchDep, `https://api.telegram.org/bot${c.bot_token}/getMe`, {}, timeoutMs,
      );
      if (json?.ok === true) return { ok: true };
      if (json && json.ok === false) {
        return { ok: false, detail: `bot token rejected (${json.error_code ?? status})` };
      }
      throw inconclusive(`unexpected response (http ${status})`);
    },
  },

  dingtalk: {
    component: 'dingtalk',
    pm2Service: 'zylos-dingtalk',
    buildConfig(config) {
      const c = config || {};
      return {
        env: {
          DINGTALK_APP_KEY: c.app_key ?? '',
          DINGTALK_APP_SECRET: c.app_secret ?? '',
          DINGTALK_ROBOT_CODE: c.robot_code ?? '',
        },
        configJson: { enabled: true },
      };
    },
    // v1.0 token endpoint takes the secret in the JSON body (not the URL).
    async probe(c, { fetchDep, timeoutMs }) {
      const { status, json } = await probeFetch(fetchDep, 'https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: c.app_key, appSecret: c.app_secret }),
      }, timeoutMs);
      if (json?.accessToken) return { ok: true };
      if (status === 400 || status === 401 || status === 403) {
        return { ok: false, detail: `app key/secret rejected (${json?.code ?? status})` };
      }
      throw inconclusive(`unexpected response (http ${status})`);
    },
  },

  wecom: {
    component: 'wecom',
    pm2Service: 'zylos-wecom',
    buildConfig(config) {
      const c = config || {};
      return {
        env: { WECOM_BOT_ID: c.bot_id ?? '', WECOM_BOT_SECRET: c.bot_secret ?? '' },
        configJson: { enabled: true },
      };
    },
    // No public credential-check endpoint for the智能机器人 long-connection
    // mode — verification falls back to process health (+ #34 later).
  },

  slack: {
    component: 'slack',
    pm2Service: 'zylos-slack',
    buildConfig(config) {
      const c = config || {};
      return {
        env: { SLACK_BOT_TOKEN: c.bot_token ?? '', SLACK_APP_TOKEN: c.app_token ?? '' },
        configJson: { enabled: true, connection_mode: 'socket' },
      };
    },
    // Two tokens, two checks: bot token via auth.test, app-level token via
    // apps.connections.open (the Socket Mode capability the component needs).
    async probe(c, { fetchDep, timeoutMs }) {
      const bot = await probeFetch(fetchDep, 'https://slack.com/api/auth.test', {
        method: 'POST', headers: { Authorization: `Bearer ${c.bot_token}` },
      }, timeoutMs);
      if (bot.json && bot.json.ok === false) {
        return { ok: false, detail: `bot token rejected (${bot.json.error})` };
      }
      if (bot.json?.ok !== true) throw inconclusive(`unexpected auth.test response (http ${bot.status})`);
      const app = await probeFetch(fetchDep, 'https://slack.com/api/apps.connections.open', {
        method: 'POST', headers: { Authorization: `Bearer ${c.app_token}` },
      }, timeoutMs);
      if (app.json && app.json.ok === false) {
        return { ok: false, detail: `app-level token rejected (${app.json.error})` };
      }
      if (app.json?.ok !== true) throw inconclusive(`unexpected connections.open response (http ${app.status})`);
      return { ok: true };
    },
  },

  discord: {
    component: 'discord',
    pm2Service: 'zylos-discord',
    // zylos-discord's loader prefers config.json creds over env
    // (cfg.botToken || DISCORD_BOT_TOKEN), so the fresh credential must be
    // written to config.json too or a stale config value survives upgrades.
    buildConfig(config) {
      const c = config || {};
      return {
        env: { DISCORD_BOT_TOKEN: c.bot_token ?? '' },
        configJson: { enabled: true, botToken: c.bot_token ?? '' },
      };
    },
    async probe(c, { fetchDep, timeoutMs }) {
      const { status } = await probeFetch(fetchDep, 'https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${c.bot_token}` },
      }, timeoutMs);
      if (status === 200) return { ok: true };
      if (status === 401 || status === 403) return { ok: false, detail: `bot token rejected (http ${status})` };
      throw inconclusive(`unexpected response (http ${status})`);
    },
  },

  zalo: {
    // Bot Platform only (decision D-4); zalo-personal is out of scope.
    component: 'zalo',
    pm2Service: 'zylos-zalo',
    // config-first loader (config.botToken beats ZALO_BOT_TOKEN) — write the
    // fresh credential to config.json too.
    buildConfig(config) {
      const c = config || {};
      return {
        env: { ZALO_BOT_TOKEN: c.bot_token ?? '' },
        configJson: { enabled: true, botToken: c.bot_token ?? '' },
      };
    },
    // Same /bot{token}/{method} shape as telegram (zylos-zalo src/lib/api.js).
    async probe(c, { fetchDep, timeoutMs }) {
      const { status, json } = await probeFetch(
        fetchDep, `https://bot-api.zaloplatforms.com/bot${c.bot_token}/getMe`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
        timeoutMs,
      );
      if (json?.ok === true) return { ok: true };
      if (json && json.ok === false) return { ok: false, detail: `bot token rejected (${json.error_code ?? status})` };
      throw inconclusive(`unexpected response (http ${status})`);
    },
  },

  line: {
    // Webhook-inbound channel: the user pastes the webhook URL into the LINE
    // console and manages public ingress themselves (decision D-2). Credential
    // write + outbound send need no ingress.
    component: 'line',
    pm2Service: 'zylos-line',
    // config-first loader (merged.channelAccessToken/channelSecret beat the
    // env vars) — write the fresh credentials to config.json too.
    buildConfig(config) {
      const c = config || {};
      return {
        env: {
          LINE_CHANNEL_ACCESS_TOKEN: c.channel_access_token ?? '',
          LINE_CHANNEL_SECRET: c.channel_secret ?? '',
        },
        configJson: {
          enabled: true,
          channelAccessToken: c.channel_access_token ?? '',
          channelSecret: c.channel_secret ?? '',
        },
      };
    },
    async probe(c, { fetchDep, timeoutMs }) {
      const { status } = await probeFetch(fetchDep, 'https://api.line.me/v2/bot/info', {
        headers: { Authorization: `Bearer ${c.channel_access_token}` },
      }, timeoutMs);
      if (status === 200) return { ok: true };
      if (status === 401 || status === 403) return { ok: false, detail: `channel access token rejected (http ${status})` };
      throw inconclusive(`unexpected response (http ${status})`);
    },
  },

  // cws-connect channel_type uses underscores; the component name is hyphenated.
  whatsapp_business: {
    component: 'whatsapp-business',
    pm2Service: 'zylos-whatsapp-business',
    // config-first loader (cfg.credentials.* beat the WAB_* env vars) — write
    // the fresh credentials object to config.json too. The shallow merge
    // replaces the whole credentials object, which is intended: every cred
    // field comes from this submit (an omitted optional field is cleared).
    buildConfig(config) {
      const c = config || {};
      const env = {
        WAB_PHONE_NUMBER_ID: c.phone_number_id ?? '',
        WAB_ACCESS_TOKEN: c.access_token ?? '',
        WAB_APP_SECRET: c.app_secret ?? '',
        WAB_VERIFY_TOKEN: c.verify_token ?? '',
      };
      const credentials = {
        phone_number_id: c.phone_number_id ?? '',
        access_token: c.access_token ?? '',
        app_secret: c.app_secret ?? '',
        verify_token: c.verify_token ?? '',
      };
      if (c.waba_id) { // optional field
        env.WAB_WABA_ID = c.waba_id;
        credentials.waba_id = c.waba_id;
      }
      return { env, configJson: { enabled: true, credentials } };
    },
    // v21.0 mirrors the component's default WAB_GRAPH_VERSION.
    async probe(c, { fetchDep, timeoutMs }) {
      const { status, json } = await probeFetch(
        fetchDep, `https://graph.facebook.com/v21.0/${encodeURIComponent(c.phone_number_id)}?fields=id`,
        { headers: { Authorization: `Bearer ${c.access_token}` } },
        timeoutMs,
      );
      if (status === 200) return { ok: true };
      if (json?.error) return { ok: false, detail: `graph API rejected (code ${json.error.code ?? status})` };
      throw inconclusive(`unexpected response (http ${status})`);
    },
  },

  ms_teams: {
    component: 'ms-teams',
    pm2Service: 'zylos-ms-teams',
    // config-first loader (cfg.credentials.* beat the MSTEAMS_* env vars;
    // teamsAppCatalogId is top-level) — write the fresh credentials to
    // config.json too.
    buildConfig(config) {
      const c = config || {};
      const env = {
        MSTEAMS_APP_ID: c.app_id ?? '',
        MSTEAMS_APP_PASSWORD: c.app_password ?? '',
        MSTEAMS_TENANT_ID: c.tenant_id ?? '',
      };
      const configJson = {
        enabled: true,
        credentials: {
          appId: c.app_id ?? '',
          appPassword: c.app_password ?? '',
          tenantId: c.tenant_id ?? '',
        },
      };
      if (c.app_catalog_id) { // optional field
        env.MSTEAMS_APP_CATALOG_ID = c.app_catalog_id;
        configJson.teamsAppCatalogId = c.app_catalog_id;
      }
      return { env, configJson };
    },
    // AAD client-credentials grant for the Bot Framework scope — validates
    // app_id/app_password/tenant_id in one shot.
    async probe(c, { fetchDep, timeoutMs }) {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c.app_id ?? '',
        client_secret: c.app_password ?? '',
        scope: 'https://api.botframework.com/.default',
      });
      const { status, json } = await probeFetch(
        fetchDep, `https://login.microsoftonline.com/${encodeURIComponent(c.tenant_id ?? '')}/oauth2/v2.0/token`,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
        timeoutMs,
      );
      if (json?.access_token) return { ok: true };
      if (status === 400 || status === 401) {
        return { ok: false, detail: `AAD rejected app credentials (${json?.error ?? status})` };
      }
      throw inconclusive(`unexpected response (http ${status})`);
    },
  },

  // ── QR-login channels (no credential form; see qrLogin flows above) ────────
  wechat: {
    component: 'wechat',
    pm2Service: 'zylos-wechat',
    buildConfig() {
      return { env: {}, configJson: { enabled: true } };
    },
    qrLogin: { run: wechatQrLogin },
  },

  whatsapp: {
    component: 'whatsapp',
    pm2Service: 'zylos-whatsapp',
    buildConfig() {
      return { env: {}, configJson: { enabled: true } };
    },
    qrLogin: { run: whatsappQrLogin },
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
 * @param {function} [deps.fetchDep]  fetch used by credential probes
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
  reportQR,
  fetchDep = fetch,
  log = () => {},
  warn = () => {},
  home = HOME,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  queryTimeoutMs = QUERY_TIMEOUT_MS,
  verifyTimeoutMs = VERIFY_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  qrTimeoutMs = QR_LOGIN_TIMEOUT_MS,
  qrReadyTimeoutMs = QR_READY_TIMEOUT_MS,
} = {}) {
  const doWriteEnv = writeEnv || ((vars) => defaultWriteEnv(vars, { home }));
  const doWriteConfig = writeConfig || ((component, patch) => defaultWriteConfig(component, patch, { home }));
  const doVerify = verifyConnected || ((spec) => defaultVerify(spec, { execFile, timeoutMs: verifyTimeoutMs }));
  // Default connect-result callback: log-only fallback used by tests / when no
  // reporter is injected. In production comm-bridge.js injects the real
  // reportResult that POSTs to cws-core's
  // /connect/channel-bindings/{binding_id}/result passthrough. Must never throw.
  const doReport = reportResult || (async (r) => {
    log(`[connect-result] binding=${r.bindingId} channel=${r.channelType} status=${r.status}`
      + (r.detail ? ` detail=${r.detail}` : ''));
  });

  const report = async (meta, status, detail = '') => {
    try { await doReport({ ...meta, status, detail }); }
    catch (e) { warn(`[${meta.slug}] connect-result report failed binding=${meta.bindingId}: ${e.message}`); }
  };

  // QR relay: production (comm-bridge.js) injects a reporter that POSTs to
  // cws-core's /connect/channel-bindings/{binding_id}/qr passthrough. Default
  // is log-only (never logs the QR payload itself). Best-effort — a failed QR
  // relay must not kill the login flow (the code rotates; the next one retries).
  const doReportQR = reportQR || (async (r) => {
    log(`[connect-qr] binding=${r.bindingId} channel=${r.channelType} qr updated (${(r.qrPngBase64 || '').length}b64)`);
  });
  const relayQr = async (meta, qrPngBase64) => {
    try { await doReportQR({ ...meta, qrPngBase64 }); }
    catch (e) { warn(`[${meta.slug}] QR relay failed binding=${meta.bindingId}: ${e.message}`); }
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
    // Secret values this flow handles — masked out of any receipt detail.
    const secretValues = Object.values(built.env || {});
    const failDetail = (msg) => sanitizeDetail(msg, secretValues);

    // 0. one-shot credential probe against the IM API (fail fast, before any
    //    install/restart side effects). Only a DEFINITIVE rejection fails the
    //    connect; an unreachable API (throw) is inconclusive — the component
    //    may reach it via its own proxy — so we log and proceed, falling back
    //    to the process-health verification below.
    if (spec.probe) {
      let probed = null;
      try {
        probed = await spec.probe(config, { fetchDep, timeoutMs: probeTimeoutMs });
      } catch (e) {
        log(`[${slug}] credential probe inconclusive (${spec.component}): ${e.message} — proceeding`);
      }
      if (probed && probed.ok === false) {
        warn(`[${slug}] credential probe rejected (${spec.component}): ${probed.detail}`);
        await report(meta, 'error', `credential check failed: ${probed.detail}`);
        return;
      }
      if (probed?.ok) log(`[${slug}] credential probe passed (${spec.component})`);
    }

    // 1. install or upgrade (idempotent)
    try {
      await ensureInstalledOrUpgraded(slug, spec);
    } catch (e) {
      warn(`[${slug}] install/upgrade failed (${spec.component}): ${e.message}`);
      await report(meta, 'error', failDetail(`install/upgrade failed: ${e.message}`));
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
      await report(meta, 'error', failDetail(`writing credentials failed: ${e.message}`));
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
      await report(meta, 'error', failDetail(`writing config failed: ${e.message}`));
      return;
    }

    // 4. start / restart so the component picks up the new credentials. A
    //    thrown pm2 invocation is NOT terminal: `zylos add` may itself have
    //    just registered/started the service, and the two racing pm2 calls
    //    can crash the pm2 CLI transiently while the process still comes up
    //    fine (int E2E 2026-07-10: telegram reported a false failure this
    //    way). Record the error and let verification below decide.
    let startError = null;
    try {
      await startOrRestartService(spec);
      log(`[${slug}] '${spec.component}' started (${spec.pm2Service})`);
    } catch (e) {
      startError = e;
      warn(`[${slug}] starting service failed (${spec.pm2Service}): ${e.message} — deferring to connect verification`);
    }

    // 5a. QR-login channels: run the interactive login flow — it relays each
    //     fresh QR to the frontend and resolves the terminal login state
    //     (already-logged-in resolves immediately). Replaces the plain
    //     process-health verify.
    if (spec.qrLogin) {
      let res;
      try {
        res = await spec.qrLogin.run({
          fetchDep,
          home,
          onQr: (qr) => relayQr(meta, qr),
          log: (m) => log(`[${slug}] ${m}`),
          timeoutMs: qrTimeoutMs,
          readyTimeoutMs: qrReadyTimeoutMs,
        });
      } catch (e) {
        warn(`[${slug}] QR login flow crashed (${spec.component}): ${e.message}`);
        res = { status: 'error', detail: failDetail(`QR login flow failed: ${e.message}`) };
      }
      if (res.status !== 'connected' && startError) {
        res.detail = failDetail(`${res.detail || 'QR login failed'}; service start had failed: ${startError.message}`);
      }
      await report(meta, res.status === 'connected' ? 'connected' : 'error', res.detail || '');
      log(`[${slug}] connect ${spec.component} binding=${meta.bindingId} → ${res.status}`);
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

    // 6. report the result back to cws-connect. If the service never came
    //    online AND the start step had errored, the start error is the story.
    const verifyFail = startError
      ? failDetail(`starting service failed: ${startError.message}`)
      : 'connect verification failed/timed out';
    await report(meta, ok ? 'connected' : 'error', ok ? '' : verifyFail);
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

        // QR-login channels have no credential form — skip the pull entirely.
        if (spec.qrLogin) {
          log(`[${slug}] channel connect ${channel_type} binding=${binding_id} (QR login)`);
          await connectChannel(slug, spec, {}, meta);
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
