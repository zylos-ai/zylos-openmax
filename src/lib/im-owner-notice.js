/**
 * IM owner notice (OPENM-936, contract v2) — deliver a platform-rendered notice
 * to the owner's most recent IM private chat, in code, without waking the model.
 *
 * Contract v2 (cws-core → cws-comm PushAgentNotice → this plugin):
 *   cws-comm pushes a WS `system` frame
 *     { event: "agent.im_owner_notice",
 *       data: { org_id, agent_member_id, event_id, kind, text, report_token, occurred_at } }
 *   (no conversation / message — the v1 system-DM carrier was dropped). The
 *   frame path never runs the credit-arrears gate, so notices still go out
 *   while the org is LLM-suspended (that is exactly the org_credits_exhausted case).
 *
 * Plugin behavior:
 *   1. Never forward the notice to C4 / the model.
 *   2. Dedup by event_id (small bounded persisted set).
 *   3. Resolve the "latest owner DM endpoint" and send `text` through
 *      `c4-send.js <channel> <endpoint>` (body on stdin).
 *   4. Report {report_token, event_id, status: sent|no_address|failed} to
 *      cws-core (ReportImOwnerNotice). A report failure only warns.
 *
 * Owner-DM endpoint cache. Every inbound IM message is written by its channel
 * component to C4 sqlite (`conversations`, direction='in'). We read that table
 * on demand at notice time (freshest answer, no extra service), AND persist the
 * winner to `im-owner-endpoint.json` — refreshed periodically and on every
 * notice — so C4 pruning/rotation cannot lose the last known address.
 *
 * DM detection per channel (contract v2 §B, verified against each channel
 * component's endpoint builder). `type:dm-pairing` (admin pairing
 * notifications) is always excluded; anything unknown is NOT cached.
 *   - lark / feishu / dingtalk / wecom / whatsapp: endpoint token `type:p2p`
 *   - slack / line / ms-teams / whatsapp-business: exact endpoint token `type:dm`
 *   - telegram: first endpoint segment is a positive integer (private chat id;
 *     groups are negative)
 *   - wechat: endpoint contains `|to:` (`<account>|to:<user>`). Sending may fail
 *     with ERR_CONTEXT_TOKEN_MISSING (no live context token) → reported `failed`.
 *   - discord: C4 row content starts with `[DISCORD DM]`
 *   - zalo: C4 row content starts with `[Zalo DM]`
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const IM_OWNER_NOTICE_TYPE = 'im_owner_notice';

/** Internal / non-IM C4 channels that must never be chosen as an owner DM. */
export const EXCLUDED_CHANNELS = new Set(['openmax', 'scheduler', 'system', 'web-console', 'shell']);

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export const DEFAULT_CACHE_FILE = path.join(ZYLOS_DIR, 'components', 'openmax', 'im-owner-endpoint.json');
export const DEFAULT_DEDUP_FILE = path.join(ZYLOS_DIR, 'components', 'openmax', 'im-owner-notice-seen.json');
export const DEFAULT_C4_DB = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');
export const DEFAULT_C4_SEND = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-send.js');
export const DEDUP_MAX = 200;
/** Rows scanned per on-demand C4 read (newest first). */
const SCAN_LIMIT = 500;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export const IM_OWNER_NOTICE_EVENT = 'agent.im_owner_notice';

/** Return the notice payload (`payload.data`) of an agent.im_owner_notice system frame. */
export function noticeFromSystemFrame(frame) {
  const data = frame?.payload?.data;
  return data && typeof data === 'object' ? data : null;
}

const P2P_CHANNELS = new Set(['lark', 'feishu', 'dingtalk', 'wecom', 'whatsapp']);
const DM_TOKEN_CHANNELS = new Set(['slack', 'line', 'ms-teams', 'whatsapp-business']);
const CONTENT_PREFIX = { discord: '[DISCORD DM]', zalo: '[Zalo DM]' };

/**
 * Whether a C4 inbound row (channel, endpoint, content) is a private chat with
 * the owner. Conservative: unknown channels / formats return false.
 */
export function isOwnerDmEndpoint(channel, endpoint, content) {
  const ch = String(channel || '').toLowerCase();
  if (!ch || EXCLUDED_CHANNELS.has(ch) || !endpoint) return false;
  const ep = String(endpoint);
  const parts = ep.split('|');
  if (!parts[0] || parts.slice(1).includes('type:dm-pairing')) return false;
  if (P2P_CHANNELS.has(ch)) return parts.slice(1).includes('type:p2p');
  if (DM_TOKEN_CHANNELS.has(ch)) return parts.slice(1).includes('type:dm');
  if (ch === 'telegram') return /^[1-9]\d*$/.test(parts[0]);
  if (ch === 'wechat') return ep.includes('|to:') && parts.some(p => p.startsWith('to:') && p.length > 3);
  if (CONTENT_PREFIX[ch]) return typeof content === 'string' && content.startsWith(CONTENT_PREFIX[ch]);
  return false;
}

/** Pick the newest owner-DM row from rows ordered newest-first. */
export function selectOwnerDm(rows) {
  for (const r of rows || []) {
    const channel = r.channel;
    const endpoint = r.endpoint_id ?? r.endpoint;
    if (isOwnerDmEndpoint(channel, endpoint, r.content)) {
      const hit = { channel, endpoint, at: r.timestamp || r.at || null, id: r.id ?? null };
      const prefix = CONTENT_PREFIX[String(channel).toLowerCase()];
      if (prefix) hit.content = prefix;
      return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// C4 read + persisted cache
// ---------------------------------------------------------------------------

/** Newest-first inbound rows from C4 sqlite. Returns [] when unavailable. */
export async function readC4InboundRows(dbPath = DEFAULT_C4_DB, limit = SCAN_LIMIT) {
  if (!fs.existsSync(dbPath)) return [];
  let DatabaseSync;
  try {
    // Built-in on Node >= 22.5; on older runtimes we fall back to the cache file.
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return [];
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const excluded = [...EXCLUDED_CHANNELS];
    const sql = `SELECT id, channel, endpoint_id, timestamp, substr(content, 1, 32) AS content FROM conversations
      WHERE direction = 'in' AND endpoint_id IS NOT NULL
        AND channel NOT IN (${excluded.map(() => '?').join(',')})
      ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...excluded, limit);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readCachedEndpoint(cacheFile = DEFAULT_CACHE_FILE) {
  const c = readJson(cacheFile);
  if (c && isOwnerDmEndpoint(c.channel, c.endpoint, c.content)) return c;
  return null;
}

/**
 * Refresh the persisted cache from C4. Returns the best known address
 * (fresh C4 hit, else the persisted one), or null.
 */
export async function refreshOwnerEndpoint({
  dbPath = DEFAULT_C4_DB,
  cacheFile = DEFAULT_CACHE_FILE,
  readRows = readC4InboundRows,
} = {}) {
  const fresh = selectOwnerDm(await readRows(dbPath));
  const cached = readCachedEndpoint(cacheFile);
  if (fresh) {
    const entry = { channel: fresh.channel, endpoint: fresh.endpoint, at: fresh.at };
    // Content-detected channels (discord/zalo) keep the prefix so the cached
    // entry still validates without the C4 row.
    if (fresh.content) entry.content = fresh.content;
    if (!cached || cached.channel !== entry.channel || cached.endpoint !== entry.endpoint || cached.at !== entry.at) {
      try { writeJsonAtomic(cacheFile, entry); } catch {}
    }
    return entry;
  }
  return cached;
}

// ---------------------------------------------------------------------------
// Dedup (bounded, persisted)
// ---------------------------------------------------------------------------

export function createDedup({ file = DEFAULT_DEDUP_FILE, max = DEDUP_MAX } = {}) {
  const loaded = readJson(file);
  const ids = Array.isArray(loaded) ? loaded.filter(x => typeof x === 'string').slice(-max) : [];
  const set = new Set(ids);
  return {
    has: (id) => set.has(id),
    add(id) {
      if (set.has(id)) return;
      set.add(id);
      ids.push(id);
      while (ids.length > max) set.delete(ids.shift());
      try { writeJsonAtomic(file, ids); } catch {}
    },
  };
}

// ---------------------------------------------------------------------------
// Send + report
// ---------------------------------------------------------------------------

/** Send `text` via c4-send.js; resolves true on exit code 0. */
export function c4Send(channel, endpoint, text, { script = DEFAULT_C4_SEND, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, channel, endpoint], { timeout: timeoutMs },
      (err) => resolve(!err));
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);
  });
}

/** cws-core ReportImOwnerNotice REST path (self-scoped, like channel-liveness). */
export function reportPath(selfMemberId) {
  return `/agents/${encodeURIComponent(selfMemberId)}/im-owner-notice-reports`;
}

/**
 * Handle one im_owner_notice systemEvent end to end. Never throws.
 * Returns the status reported ('sent' | 'no_address' | 'failed') or
 * 'duplicate' / 'invalid' when nothing was sent or reported.
 */
export async function handleImOwnerNotice(se, {
  dedup,
  resolveEndpoint = () => refreshOwnerEndpoint(),
  send = c4Send,
  report = async () => {},
  log = () => {},
  warn = () => {},
} = {}) {
  const eventId = se?.event_id ? String(se.event_id) : '';
  const text = typeof se?.text === 'string' ? se.text.trim() : '';
  if (!eventId) {
    warn('[im-owner-notice] missing event_id, ignored');
    return 'invalid';
  }
  if (dedup?.has(eventId)) {
    log(`[im-owner-notice] duplicate event_id=${eventId}, skipped`);
    return 'duplicate';
  }
  dedup?.add(eventId);

  let status;
  let target = null;
  try { target = await resolveEndpoint(); } catch (e) { warn(`[im-owner-notice] resolve endpoint: ${e.message}`); }
  if (!text) {
    status = 'failed';
  } else if (!target) {
    status = 'no_address';
  } else {
    let ok = false;
    try { ok = await send(target.channel, target.endpoint, text); } catch { ok = false; }
    status = ok ? 'sent' : 'failed';
  }
  log(`[im-owner-notice] event_id=${eventId} kind=${se.kind || '?'} status=${status}` +
    (target ? ` channel=${target.channel}` : ''));

  try {
    await report({ report_token: se.report_token ?? '', event_id: eventId, status });
  } catch (e) {
    warn(`[im-owner-notice] ReportImOwnerNotice failed (event_id=${eventId}): ${e.message}`);
  }
  return status;
}
