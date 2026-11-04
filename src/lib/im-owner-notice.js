/**
 * IM owner notice (OPENM-936) — deliver a platform-rendered notice to the
 * owner's most recent IM private chat, in code, without waking the model.
 *
 * Contract (cws-core → cws-comm → this plugin):
 *   A SYSTEM-sender TEXT message in the agent's system DM carries
 *     content.metadata.systemEvent = {
 *       type: "im_owner_notice", event_id, kind, text, report_token }
 *   The marker lives in `content` (real-time WS frames carry `content` but not
 *   the top-level `metadata`); the get-message detail envelope may nest it
 *   under `message.content`, so every known shape is read.
 *
 * Plugin behavior:
 *   1. Never forward the message to C4 / the model.
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
 * notice — so C4 pruning/rotation cannot lose the last known address. The
 * on-demand read wins when it finds a DM; otherwise the persisted file is used.
 *
 * DM detection per channel (only channels whose endpoint format is known from
 * locally available component code; anything else is NOT cached):
 *   - lark / feishu: endpoint `chatId|type:p2p` (zylos-lark buildEndpoint);
 *     dmPolicy defaults to `owner`, so a p2p inbound is the channel owner.
 *   - telegram / dingtalk / whatsapp / wechat: endpoint DM marker not
 *     determinable from code available here → never cached (documented gap).
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

/** Return the im_owner_notice systemEvent from any known message shape, or null. */
export function extractImOwnerNotice(msg) {
  if (!msg) return null;
  const candidates = [
    msg.content?.metadata?.systemEvent,
    msg.message?.content?.metadata?.systemEvent,
    msg.metadata?.systemEvent,
    msg.message?.metadata?.systemEvent,
  ];
  for (const se of candidates) {
    if (se && typeof se === 'object' && se.type === IM_OWNER_NOTICE_TYPE) return se;
  }
  return null;
}

/**
 * Whether a C4 inbound (channel, endpoint) is a private chat with the owner.
 * Conservative: unknown channels / formats return false (never cached).
 */
export function isOwnerDmEndpoint(channel, endpoint) {
  const ch = String(channel || '').toLowerCase();
  if (!ch || EXCLUDED_CHANNELS.has(ch) || !endpoint) return false;
  const parts = String(endpoint).split('|');
  switch (ch) {
    case 'lark':
    case 'feishu':
      return Boolean(parts[0]) && parts.slice(1).includes('type:p2p');
    default:
      return false;
  }
}

/** Pick the newest owner-DM row from rows ordered newest-first. */
export function selectOwnerDm(rows) {
  for (const r of rows || []) {
    const channel = r.channel;
    const endpoint = r.endpoint_id ?? r.endpoint;
    if (isOwnerDmEndpoint(channel, endpoint)) {
      return { channel, endpoint, at: r.timestamp || r.at || null, id: r.id ?? null };
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
    const sql = `SELECT id, channel, endpoint_id, timestamp FROM conversations
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
  if (c && isOwnerDmEndpoint(c.channel, c.endpoint)) return c;
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
