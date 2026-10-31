#!/usr/bin/env node

/**
 * Computer Use CLI — drive a user's paired Mac (cws-connect device connector)
 * via cws-core BFF.
 *
 *   Agent → this CLI → POST /api/v1/connect/connections/{id}/actions/execute
 *         → cws-core → cws-connect DeviceGateway → Mac client (WSS)
 *
 * Server actions: "computer.batch" (params {actions[], target_app?, task_hint?,
 * screenshot_after?}) and "computer.list_apps". The REST response is the D8
 * envelope {data:{status_code, body}} where body is the device's action.result
 * verbatim ({call_id,status,executed,error?,screenshot?{mime,b64,width,height,
 * scale,app?},apps?,frontmost_app}) or a gateway error {error:"device_offline"}.
 *
 * Screenshots are written to a private temp file (0600) and only the path +
 * dimensions are printed, so the agent views it with its image-reading tool and
 * the base64 never lands in stdout / RPC logs.
 *
 * Usage:
 *   node src/cli/computer.js <command> '<json-params>'
 *   node src/cli/computer.js computer.devices    '{}'
 *   node src/cli/computer.js computer.screenshot  '{"device":"<id>"}'
 *   node src/cli/computer.js computer.act        '{"actions":[{"type":"click","x":100,"y":200}]}'
 *   node src/cli/computer.js computer.apps       '{}'
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiPath, getForOrg, postForOrg } from '../lib/client.js';
import { resolveDefaultOrgId } from '../lib/config.js';

export const DEVICE_APP_SLUG = 'desktop-macos';
export const MAX_BATCH = 10;
export const MAX_WAIT_MS = 5000;
// cws-core lifts its execute deadline to CWS_CONNECT_EXECUTE_TIMEOUT (130s
// default); wait a little longer so the server's 504 wins over a local abort.
export const EXECUTE_TIMEOUT_MS = 140_000;
const SHOT_TTL_MS = 30 * 60 * 1000;

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }

// ---------------------------------------------------------------------------
// Action normalization: wire protocol §6 shapes pass through; Claude
// computer-tool shapes (left_click + coordinate, key "cmd+s", scroll_direction…)
// are mapped onto them, so the agent can use whichever it already knows.

const KEY_ALIASES = {
  command: 'cmd', super: 'cmd', meta: 'cmd', win: 'cmd', '⌘': 'cmd',
  control: 'ctrl', option: 'alt', opt: 'alt',
  return: 'enter', escape: 'esc', page_up: 'pageup', page_down: 'pagedown',
};

export function normalizeKeys(keys) {
  const list = Array.isArray(keys) ? keys : String(keys ?? '').split('+');
  const out = list.map((k) => String(k).trim()).filter(Boolean).map((k) => {
    const lower = k.toLowerCase();
    return KEY_ALIASES[lower] ?? lower;
  });
  if (!out.length) throw bad('keypress needs keys, e.g. ["cmd","s"] or "cmd+s"');
  return out;
}

function xy(a, i) {
  let x = a.x; let y = a.y;
  if (Array.isArray(a.coordinate)) [x, y] = a.coordinate;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw bad(`actions[${i}] (${a.type || a.action}) needs x,y (pixels of the latest screenshot)`);
  return { x: Math.round(x), y: Math.round(y) };
}

const SCROLL_STEP = 1; // one notch per scroll_amount unit; sign: down/right positive (wire scroll_x/scroll_y)

export function normalizeAction(a, i = 0) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw bad(`actions[${i}] must be an object`);
  const t = a.type || a.action;
  switch (t) {
    case 'screenshot': return { type: 'screenshot' };
    case 'click': return { type: 'click', ...xy(a, i), button: a.button || 'left' };
    case 'left_click': return { type: 'click', ...xy(a, i), button: 'left' };
    case 'right_click': return { type: 'click', ...xy(a, i), button: 'right' };
    case 'middle_click': return { type: 'click', ...xy(a, i), button: 'middle' };
    case 'double_click': return { type: 'double_click', ...xy(a, i) };
    case 'move': case 'mouse_move': return { type: 'move', ...xy(a, i) };
    case 'drag': {
      if (!Array.isArray(a.path) || a.path.length < 2) throw bad(`actions[${i}] drag needs path:[{x,y},{x,y},...]`);
      return { type: 'drag', path: a.path.map((p, j) => xy(p, `${i}].path[${j}`)) };
    }
    case 'left_click_drag': {
      if (!Array.isArray(a.start_coordinate)) throw bad(`actions[${i}] left_click_drag needs start_coordinate and coordinate`);
      return { type: 'drag', path: [xy({ coordinate: a.start_coordinate }, i), xy(a, i)] };
    }
    case 'scroll': {
      const p = xy(a, i);
      if (a.scroll_direction) {
        const n = (Number.isFinite(a.scroll_amount) ? a.scroll_amount : 3) * SCROLL_STEP;
        const d = { up: [0, -n], down: [0, n], left: [-n, 0], right: [n, 0] }[a.scroll_direction];
        if (!d) throw bad(`actions[${i}] scroll_direction must be up|down|left|right`);
        return { type: 'scroll', ...p, scroll_x: d[0], scroll_y: d[1] };
      }
      return { type: 'scroll', ...p, scroll_x: Number(a.scroll_x) || 0, scroll_y: Number(a.scroll_y) || 0 };
    }
    case 'keypress': return { type: 'keypress', keys: normalizeKeys(a.keys ?? a.text) };
    case 'key': return { type: 'keypress', keys: normalizeKeys(a.keys ?? a.text) };
    case 'type': {
      if (typeof a.text !== 'string' || a.text === '') throw bad(`actions[${i}] type needs non-empty text`);
      return { type: 'type', text: a.text };
    }
    case 'wait': {
      // wire: ms; Claude tool: duration (seconds)
      const ms = a.ms ?? (Number.isFinite(a.duration) ? a.duration * 1000 : undefined);
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_WAIT_MS) throw bad(`actions[${i}] wait needs ms in 0..${MAX_WAIT_MS}`);
      return { type: 'wait', ms: Math.round(ms) };
    }
    case 'focus_app': {
      if (!a.bundle_id) throw bad(`actions[${i}] focus_app needs bundle_id (see computer.apps)`);
      return { type: 'focus_app', bundle_id: a.bundle_id };
    }
    default:
      throw bad(`actions[${i}]: unsupported type "${t}" (screenshot|click|double_click|move|drag|scroll|keypress|type|wait|focus_app)`);
  }
}

export function buildBatchParams(p) {
  const actions = p.actions;
  if (!Array.isArray(actions) || actions.length === 0) throw bad('actions must be a non-empty array');
  if (actions.length > MAX_BATCH) throw bad(`at most ${MAX_BATCH} actions per call — split the batch`);
  const out = { actions: actions.map(normalizeAction) };
  if (p.target_app) out.target_app = String(p.target_app);
  if (p.task_hint) out.task_hint = String(p.task_hint);
  if (p.screenshot_after === false) out.screenshot_after = false;
  return out;
}

// ---------------------------------------------------------------------------
// Result interpretation

const GUIDANCE = {
  device_offline: 'The Mac is offline (app closed, asleep or no network). Do not retry in a loop; tell the user and ask them to open the OpenMax desktop client.',
  device_timeout: 'The Mac did not answer in time (local approval prompt may be pending). Take a fresh screenshot once; if it times out again, ask the user.',
  rate_limited: 'Too many actions this minute. Wait ~60s or batch fewer, larger steps.',
  denied_by_user: 'The user rejected this action on their Mac. Do not retry it; ask the user how to proceed or change plan.',
  needs_app_grant: 'The target app is not authorized yet; the user was asked on the Mac. Tell the user, wait for them to allow it, then retry once.',
  blocked_by_policy: 'This app/action is blocked by local policy (e.g. Terminal, password managers, system security). Do not retry; pick another approach.',
  paused: 'The user paused Computer Use / took over the mouse. Stop and wait for the user to resume.',
  error: 'The Mac failed to run the action. Take a fresh screenshot and re-plan; do not repeat blindly.',
  invalid_actions: 'The batch was rejected as invalid; fix the actions per the message.',
};

export function screenshotDir() {
  return process.env.OPENMAX_COMPUTER_SHOT_DIR || path.join(os.tmpdir(), `openmax-computer-${process.getuid?.() ?? 'u'}`);
}

function pruneOldShots(dir, now = Date.now()) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try { if (now - fs.statSync(fp).mtimeMs > SHOT_TTL_MS) fs.unlinkSync(fp); } catch { /* ignore */ }
    }
  } catch { /* dir missing */ }
}

export function saveScreenshot(shot, callId) {
  const dir = screenshotDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneOldShots(dir);
  const ext = /jpe?g/i.test(shot.mime || '') ? 'jpg' : 'png';
  const safeId = String(callId || 'shot').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'shot';
  const file = path.join(dir, `${Date.now()}-${safeId}.${ext}`);
  fs.writeFileSync(file, Buffer.from(shot.b64, 'base64'), { mode: 0o600 });
  return file;
}

/** Turn the execute envelope {status_code, body} into the agent-facing result. */
export function interpretExecute(data, { save = saveScreenshot } = {}) {
  const statusCode = Number(data?.status_code) || 0;
  let body = data?.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = { error: body }; } }
  body = body && typeof body === 'object' ? body : {};

  const status = body.status || (typeof body.error === 'string' ? body.error : null) || (statusCode === 200 ? 'ok' : 'error');
  const out = { ok: statusCode === 200 && status === 'ok', status_code: statusCode, status };
  if (body.executed !== undefined) out.executed = body.executed;
  if (body.frontmost_app) out.frontmost_app = body.frontmost_app;
  if (body.error && typeof body.error === 'object') out.error = body.error;
  else if (body.message) out.error = { code: status, message: body.message };
  if (Array.isArray(body.apps)) out.apps = body.apps;
  if (body.screenshot?.b64) {
    const s = body.screenshot;
    out.screenshot = {
      path: save(s, body.call_id),
      width: s.width, height: s.height, scale: s.scale, mime: s.mime || 'image/png',
      ...(s.app ? { app: s.app } : {}),
    };
  }
  if (!out.ok) out.agent_instruction = GUIDANCE[status] || GUIDANCE.error;
  return out;
}

// ---------------------------------------------------------------------------
// Device resolution

function resolveOrgId(p) {
  const orgId = p.org || p.orgId || p.org_id || resolveDefaultOrgId();
  if (!orgId) throw bad('cannot resolve org: multiple orgs enabled and no org given — pass {"org":"<org_id>"} or set COCO_ORG_ID');
  return orgId;
}

export function isDeviceConnection(c) {
  return (c.application_slug || c.slug) === DEVICE_APP_SLUG || (c.connector_kind || c.connectorKind) === 'device';
}

export function devicesFromList(resp) {
  const list = Array.isArray(resp) ? resp : (Array.isArray(resp?.connections) ? resp.connections : []);
  return list.filter(isDeviceConnection).map((c) => ({
    device_id: c.id || c.connection_id,
    name: c.display_name || c.displayName || c.application_name || 'Mac',
    status: c.status || 'active',
    ...(c.last_used_at ? { last_used_at: c.last_used_at } : {}),
  }));
}

async function listDevices(orgId) {
  return devicesFromList(await getForOrg(orgId, apiPath('/connect/agents/me/connections')));
}

async function resolveDevice(orgId, p) {
  const explicit = p.device || p.device_id || p.connectionId;
  if (explicit) return explicit;
  const active = (await listDevices(orgId)).filter((d) => d.status === 'active');
  if (active.length === 1) return active[0].device_id;
  if (active.length === 0) {
    throw Object.assign(new Error('no Mac is authorized for this agent — ask the user to pair the OpenMax desktop client and grant it to you'), { status: 404, code: 'no_device' });
  }
  throw Object.assign(new Error(`several Macs are authorized (${active.map((d) => `${d.name}=${d.device_id}`).join(', ')}) — ask the user which one, then pass {"device":"<device_id>"}`), { status: 409, code: 'needs_selection' });
}

async function execute(orgId, deviceId, action, params) {
  const data = await postForOrg(
    orgId,
    apiPath(`/connect/connections/${encodeURIComponent(deviceId)}/actions/execute`),
    { action, params },
    { timeoutMs: EXECUTE_TIMEOUT_MS, omitLogBodies: true },
  );
  return { device_id: deviceId, ...interpretExecute(data) };
}

// ---------------------------------------------------------------------------

export const COMMANDS = {
  'computer.devices': async (p) => ({ devices: await listDevices(resolveOrgId(p)) }),
  'computer.screenshot': async (p) => {
    const orgId = resolveOrgId(p);
    const params = { actions: [{ type: 'screenshot' }] };
    if (p.target_app) params.target_app = String(p.target_app);
    if (p.task_hint) params.task_hint = String(p.task_hint);
    return execute(orgId, await resolveDevice(orgId, p), 'computer.batch', params);
  },
  'computer.act': async (p) => {
    const params = buildBatchParams(p); // validate before any network call
    const orgId = resolveOrgId(p);
    return execute(orgId, await resolveDevice(orgId, p), 'computer.batch', params);
  },
  'computer.apps': async (p) => {
    const orgId = resolveOrgId(p);
    return execute(orgId, await resolveDevice(orgId, p), 'computer.list_apps', {});
  },
};

function printUsage() {
  console.log(`Computer Use CLI — operate the user's paired Mac

Usage: node src/cli/computer.js <command> '<json-params>'

  computer.devices    {}                                         # Macs authorized to this agent
  computer.screenshot {device?, target_app?, task_hint?}         # screenshot → temp file path + width/height
  computer.act        {device?, actions:[...≤10], target_app?, task_hint?, screenshot_after?}
  computer.apps       {device?}                                  # running apps + whether each is granted

  device may be omitted when exactly one Mac is authorized. Actions use the
  pixel coordinates of the latest screenshot. See SKILL.md "Computer Use".
`);
}

async function main() {
  const [rawCmd, ...rest] = process.argv.slice(2);
  if (!rawCmd || ['help', '--help', '-h'].includes(rawCmd)) { printUsage(); process.exit(0); }
  const command = rawCmd.startsWith('computer.') ? rawCmd : `computer.${rawCmd}`;
  const handler = COMMANDS[command];
  if (!handler) { console.error(`Unknown command: ${rawCmd}`); printUsage(); process.exit(1); }
  // stdout must stay clean JSON for the agent; RPC bodies are omitted anyway.
  if (process.env.COCO_RPC_LOG === undefined) process.env.COCO_RPC_LOG = '0';
  try {
    const params = rest.length ? JSON.parse(rest.join(' ')) : {};
    const result = await handler(params);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok === false ? 2 : 0);
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    if (err.code) payload.code = err.code;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main();
}
