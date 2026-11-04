/**
 * IM owner notice (OPENM-936, contract v2) — deliver a platform-rendered notice
 * to the owner's most recent IM private chat, in code, without waking the model.
 *
 * Contract v2 (cws-core → cws-comm PushAgentNotice → this plugin):
 *   cws-comm pushes a WS `system` frame
 *     { event: "agent.im_owner_notice",
 *       data: { org_id, agent_member_id, event_id, kind, text, occurred_at } }
 *   (any `report_token` in data is ignored — there is no report-back to cws-core).
 *   (no conversation / message — the v1 system-DM carrier was dropped). The
 *   frame path never runs the credit-arrears gate, so notices still go out
 *   while the org is LLM-suspended (that is exactly the org_credits_exhausted case).
 *
 * Plugin behavior:
 *   1. Never forward the notice to C4 / the model.
 *   2. Dedup by event_id (small bounded persisted set).
 *   3. Resolve the "latest owner DM endpoint" and send `text` through
 *      `c4-send.js <channel> <endpoint>` (body on stdin).
 *   4. No owner DM address → log and do nothing. Nothing is reported back.
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
 *     with ERR_CONTEXT_TOKEN_MISSING (no live context token) → logged `failed`.
 *   - discord: C4 row content starts with `[DISCORD DM]`
 *   - zalo: C4 row content starts with `[Zalo DM]`
 *
 * A DM is then only used if it is POSITIVELY attributable to the channel's
 * bound owner (components/<channel>/config.json `owner.*`); see OWNER_MATCHERS.
 * dmPolicy is never used as evidence (legacy `whitelist` configs, history from
 * an earlier open policy or a previous owner would make it wrong).
 *
 * Before sending (and caching), message-level endpoint params (msg / req /
 * replyKey / root / parent / thread) are stripped so the notice is a fresh DM,
 * not a reply to an old message; routing params (type / account / user / to)
 * are kept.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const IM_OWNER_NOTICE_TYPE = 'im_owner_notice';

/** Internal / non-IM C4 channels that must never be chosen as an owner DM. */
export const EXCLUDED_CHANNELS = new Set(['openmax', 'scheduler', 'system', 'web-console', 'shell']);

const ZYLOS_DIR = process.env.ZYLOS_DIR || path.join(os.homedir(), 'zylos');
export const DEFAULT_COMPONENTS_DIR = path.join(ZYLOS_DIR, 'components');
export const DEFAULT_CACHE_FILE = path.join(ZYLOS_DIR, 'components', 'openmax', 'im-owner-endpoint.json');
export const DEFAULT_DEDUP_FILE = path.join(ZYLOS_DIR, 'components', 'openmax', 'im-owner-notice-seen.json');
export const DEFAULT_C4_DB = path.join(ZYLOS_DIR, 'comm-bridge', 'c4.db');
export const DEFAULT_C4_SEND = path.join(ZYLOS_DIR, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-send.js');
export const DEDUP_MAX = 200;
/** Send attempts per event_id across redeliveries before giving up. */
export const MAX_ATTEMPTS = 3;
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

// ---------------------------------------------------------------------------
// Owner attribution (a DM is not necessarily the OWNER's DM)
// ---------------------------------------------------------------------------

/** Read ~/zylos/components/<channel>/config.json (null when missing/invalid). */
export function loadChannelConfig(channel, componentsDir = DEFAULT_COMPONENTS_DIR) {
  if (!/^[a-z0-9-]+$/.test(String(channel || ''))) return null;
  return readJson(path.join(componentsDir, String(channel), 'config.json'));
}

const firstSeg = (ep) => String(ep).split('|')[0];
const token = (ep, key) => {
  const t = String(ep).split('|').slice(1).find(p => p.startsWith(`${key}:`));
  return t ? t.slice(key.length + 1) : '';
};
const same = (a, b) => a != null && b != null && String(a) !== '' && String(a) === String(b);
const jidNum = (j) => String(j || '').split(':')[0].split('@')[0];

/** Message-level endpoint params; never part of a fresh DM address. */
export const MESSAGE_LEVEL_KEYS = new Set(['msg', 'req', 'replyKey', 'root', 'parent', 'thread']);

/**
 * Drop message-level params so the notice is a new DM rather than a reply /
 * thread post on an old message (telegram msg → reply_to, LINE stale replyKey,
 * lark markTypingDone on msg, discord req correlation). Routing params kept:
 * type (lark/feishu/dingtalk/wecom/whatsapp/slack), account+user (line),
 * user (ms-teams), to (wechat).
 */
export function stripMessageParams(endpoint) {
  const parts = String(endpoint || '').split('|');
  return [parts[0], ...parts.slice(1).filter((p) => {
    const i = p.indexOf(':');
    return !(i > 0 && MESSAGE_LEVEL_KEYS.has(p.slice(0, i)));
  })].join('|');
}

// --- Component message-log proof (lark / feishu / slack / discord) ----------
// These endpoints carry only a chat id and the C4 content only a display name,
// so the sender is proven from the component's own per-message log: the C4
// endpoint's `msg:` id must appear in that log with the owner's user id.
//   lark/feishu: components/<ch>/logs/<sender user_id>.log (p2p logs are keyed
//                by sender; threads: <uid>_t_<thread>.log), JSONL
//                {message_id, user_id, open_id}
//   slack:       components/slack/logs/<channel id>.log, JSONL {userId, ts}
//   discord:     components/discord/logs/dm/<channel id>.jsonl, JSONL
//                {direction:'in', userId, messageId}
// No `msg:` / no log entry / different sender → not the owner (skip).

const LOG_TAIL_BYTES = 2 * 1024 * 1024;
const safeName = (s, fallback = '') => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_') || fallback;

function readTail(file, memo) {
  if (memo?.has(file)) return memo.get(file);
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, LOG_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { text = ''; }
  memo?.set(file, text);
  return text;
}

function logHasEntry(files, needle, pred, memo) {
  for (const f of files) {
    const text = readTail(f, memo);
    if (!text || !text.includes(needle)) continue;
    for (const line of text.split('\n')) {
      if (!line.includes(needle)) continue;
      try { if (pred(JSON.parse(line))) return true; } catch {}
    }
  }
  return false;
}

function listLogs(dir, prefixes, memo) {
  const key = `ls:${dir}`;
  let names = memo?.get(key);
  if (!names) {
    try { names = fs.readdirSync(dir); } catch { names = []; }
    memo?.set(key, names);
  }
  return names.filter(n => prefixes.some(p => n === `${p}.log` || n.startsWith(`${p}_t_`)))
    .map(n => path.join(dir, n));
}

const larkLikeProof = (channel) => (ep, c, { componentsDir, memo }) => {
  const msg = token(ep, 'msg');
  const uid = c.owner?.user_id;
  const oid = c.owner?.open_id;
  if (!c.owner?.bound || !msg || (!uid && !oid)) return false;
  const prefixes = [uid, oid].filter(Boolean).map(x => safeName(x));
  const files = listLogs(path.join(componentsDir, channel, 'logs'), prefixes, memo);
  return logHasEntry(files, msg, (e) => e.message_id === msg
    && ((uid && same(e.user_id, uid)) || (oid && same(e.open_id, oid))), memo);
};

/**
 * Per-channel owner attribution (positive evidence only), verified against
 * each component's endpoint builder + persisted data. wechat has no owner
 * binding: accepted only when dmPolicy=allowlist names exactly one user and the
 * row is that user.
 */
export const OWNER_MATCHERS = {
  telegram: (ep, c) => same(firstSeg(ep), c.owner?.chat_id),
  dingtalk: (ep, c) => same(firstSeg(ep), c.owner?.staff_id),
  wecom: (ep, c) => same(firstSeg(ep), c.owner?.user_id),
  zalo: (ep, c) => same(firstSeg(ep), c.owner?.user_id),
  'whatsapp-business': (ep, c) => same(firstSeg(ep), c.owner?.wa_id),
  whatsapp: (ep, c) => !!c.owner?.jid && same(jidNum(firstSeg(ep)), jidNum(c.owner.jid)),
  line: (ep, c) => same(token(ep, 'user'), c.owner?.userId),
  'ms-teams': (ep, c) => same(token(ep, 'user'), c.owner?.aadObjectId),
  lark: larkLikeProof('lark'),
  feishu: larkLikeProof('feishu'),
  slack: (ep, c, { componentsDir, memo }) => {
    const msg = token(ep, 'msg');
    const uid = c.owner?.user_id;
    if (!c.owner?.bound || !uid || !msg) return false;
    const file = path.join(componentsDir, 'slack', 'logs', `${safeName(firstSeg(ep))}.log`);
    return logHasEntry([file], msg, (e) => String(e.ts) === msg && same(e.userId, uid), memo);
  },
  discord: (ep, c, { componentsDir, memo }) => {
    const msg = token(ep, 'msg');
    const owner = typeof c.owner === 'string' || typeof c.owner === 'number' ? String(c.owner) : '';
    if (!owner || !msg) return false;
    const file = path.join(componentsDir, 'discord', 'logs', 'dm', `${safeName(firstSeg(ep), 'unknown')}.jsonl`);
    return logHasEntry([file], msg, (e) => e.direction === 'in' && String(e.messageId) === msg && same(e.userId, owner), memo);
  },
  wechat: (ep, c) => c.dmPolicy === 'allowlist' && Array.isArray(c.dmAllowFrom)
    && c.dmAllowFrom.length === 1 && same(token(ep, 'to'), c.dmAllowFrom[0]),
};

/** Whether a DM endpoint is attributable to the channel's bound owner. */
export function isOwnerAttributed(channel, endpoint, cfg, { componentsDir = DEFAULT_COMPONENTS_DIR, memo = new Map() } = {}) {
  const m = OWNER_MATCHERS[String(channel || '').toLowerCase()];
  if (!m || !cfg || typeof cfg !== 'object' || !endpoint) return false;
  try { return !!m(String(endpoint), cfg, { componentsDir, memo }); } catch { return false; }
}

/**
 * Pick the newest owner-DM row from rows ordered newest-first. A row must be a
 * DM (isOwnerDmEndpoint) AND attributable to the channel owner. Returns
 * { channel, source (raw C4 endpoint), endpoint (stripped send address), at, id }.
 */
export function selectOwnerDm(rows, loadConfig = loadChannelConfig, { componentsDir = DEFAULT_COMPONENTS_DIR } = {}) {
  const cfgs = new Map();
  const memo = new Map();
  const cfgOf = (ch) => {
    if (!cfgs.has(ch)) cfgs.set(ch, loadConfig(ch));
    return cfgs.get(ch);
  };
  for (const r of rows || []) {
    const channel = r.channel;
    const endpoint = r.endpoint_id ?? r.endpoint;
    if (isOwnerDmEndpoint(channel, endpoint, r.content)
      && isOwnerAttributed(channel, endpoint, cfgOf(String(channel).toLowerCase()), { componentsDir, memo })) {
      const hit = { channel, source: endpoint, endpoint: stripMessageParams(endpoint), at: r.timestamp || r.at || null, id: r.id ?? null };
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

const execFileP = promisify(execFile);
let c4ReadWarned = false;
/** Test hook: re-arm the one-time "cannot read C4" warning. */
export function _resetC4ReadWarning() { c4ReadWarned = false; }

function c4Sql(limit) {
  // Only constants + a validated integer are interpolated (no user input), so
  // the same text is safe for the sqlite3 CLI, which has no bind parameters.
  const excluded = [...EXCLUDED_CHANNELS].map(c => `'${c.replace(/'/g, "''")}'`).join(',');
  const n = Math.max(1, Math.min(10000, Number.parseInt(limit, 10) || SCAN_LIMIT));
  return `SELECT id, channel, endpoint_id, timestamp, substr(content, 1, 32) AS content FROM conversations
    WHERE direction = 'in' AND endpoint_id IS NOT NULL AND channel NOT IN (${excluded})
    ORDER BY id DESC LIMIT ${n}`;
}

async function readViaNodeSqlite(dbPath, sql) {
  const { DatabaseSync } = await import('node:sqlite'); // Node >= 22.13 (unflagged)
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).all(); } finally { try { db.close(); } catch {} }
}

async function readViaSqliteCli(dbPath, sql, bin = 'sqlite3') {
  const { stdout } = await execFileP(bin, ['-readonly', '-json', dbPath, sql], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  const out = String(stdout || '').trim();
  return out ? JSON.parse(out) : [];
}

/**
 * Newest-first inbound rows from C4 sqlite. Tries built-in node:sqlite, then
 * the sqlite3 CLI (read-only, 5s timeout). If neither works, warns once and
 * returns [] (the persisted cache is then the only source).
 */
export async function readC4InboundRows(dbPath = DEFAULT_C4_DB, limit = SCAN_LIMIT, {
  warn = (m) => console.warn(m), sqliteBin = 'sqlite3', nodeSqlite = readViaNodeSqlite,
} = {}) {
  if (!fs.existsSync(dbPath)) return [];
  const sql = c4Sql(limit);
  const errors = [];
  try { return await nodeSqlite(dbPath, sql); } catch (e) { errors.push(`node:sqlite: ${e.code || e.message}`); }
  try { return await readViaSqliteCli(dbPath, sql, sqliteBin); } catch (e) { errors.push(`sqlite3 CLI: ${e.code || e.message}`); }
  if (!c4ReadWarned) {
    c4ReadWarned = true;
    warn(`[im-owner-notice] cannot read C4 (${errors.join('; ')}); owner IM address falls back to cache only — install sqlite3 or use Node >= 22.13`);
  }
  return [];
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

export function readCachedEndpoint(cacheFile = DEFAULT_CACHE_FILE, loadConfig = loadChannelConfig, { componentsDir = DEFAULT_COMPONENTS_DIR } = {}) {
  const c = readJson(cacheFile);
  if (!c || !c.channel) return null;
  // Re-attribute on read from the original C4 endpoint: the owner binding may
  // have changed since. Entries without `source` (older format) re-attribute
  // from `endpoint` and fail closed for log-proof channels.
  const source = c.source || c.endpoint;
  if (isOwnerDmEndpoint(c.channel, source, c.content)
    && isOwnerAttributed(c.channel, source, loadConfig(String(c.channel).toLowerCase()), { componentsDir })) {
    return { ...c, source, endpoint: stripMessageParams(source) };
  }
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
  loadConfig = loadChannelConfig,
  componentsDir = DEFAULT_COMPONENTS_DIR,
} = {}) {
  const fresh = selectOwnerDm(await readRows(dbPath), loadConfig, { componentsDir });
  if (fresh) {
    const entry = { channel: fresh.channel, endpoint: fresh.endpoint, source: fresh.source, at: fresh.at };
    // Content-detected channels (discord/zalo) keep the prefix so the cached
    // entry still validates without the C4 row.
    if (fresh.content) entry.content = fresh.content;
    const prev = readJson(cacheFile);
    if (!prev || prev.channel !== entry.channel || prev.source !== entry.source || prev.at !== entry.at) {
      try { writeJsonAtomic(cacheFile, entry); } catch {}
    }
    return entry;
  }
  return readCachedEndpoint(cacheFile, loadConfig, { componentsDir });
}

// ---------------------------------------------------------------------------
// Dedup (bounded, persisted)
// ---------------------------------------------------------------------------

/**
 * Persisted per-event_id state. An id is "done" once it was sent (or is
 * unrecoverable); until then each delivery counts one attempt, so a failed
 * send is retried on a later delivery of the same event, up to MAX_ATTEMPTS.
 * File: { done: [ids], attempts: { id: n } } (legacy: plain array of done ids).
 */
export function createDedup({ file = DEFAULT_DEDUP_FILE, max = DEDUP_MAX } = {}) {
  const loaded = readJson(file);
  const doneList = (Array.isArray(loaded) ? loaded : Array.isArray(loaded?.done) ? loaded.done : [])
    .filter(x => typeof x === 'string').slice(-max);
  const done = new Set(doneList);
  const attempts = new Map(Object.entries(loaded && !Array.isArray(loaded) && typeof loaded.attempts === 'object' && loaded.attempts ? loaded.attempts : {})
    .filter(([, n]) => Number.isInteger(n) && n > 0).slice(-max));
  const persist = () => {
    try { writeJsonAtomic(file, { done: doneList, attempts: Object.fromEntries(attempts) }); } catch {}
  };
  return {
    has: (id) => done.has(id),
    attempts: (id) => attempts.get(id) || 0,
    /** Count one attempt; returns the new count. */
    attempt(id) {
      const n = (attempts.get(id) || 0) + 1;
      attempts.delete(id);
      attempts.set(id, n);
      while (attempts.size > max) attempts.delete(attempts.keys().next().value);
      persist();
      return n;
    },
    add(id) {
      attempts.delete(id);
      if (!done.has(id)) {
        done.add(id);
        doneList.push(id);
        while (doneList.length > max) done.delete(doneList.shift());
      }
      persist();
    },
  };
}

// ---------------------------------------------------------------------------
// Send
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

/**
 * Handle one im_owner_notice systemEvent end to end. Never throws.
 * Returns the logged outcome: 'sent' | 'no_address' | 'failed' |
 * 'duplicate' | 'invalid' | 'gave_up'. Only 'sent' (and unrecoverable
 * 'invalid'/'gave_up') mark the event_id done; 'failed' / 'no_address' leave
 * it retryable on a later delivery, capped at maxAttempts.
 */
export async function handleImOwnerNotice(se, {
  dedup,
  resolveEndpoint = () => refreshOwnerEndpoint(),
  send = c4Send,
  log = () => {},
  warn = () => {},
  maxAttempts = MAX_ATTEMPTS,
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
  if (!text) {
    dedup?.add(eventId);
    warn(`[im-owner-notice] event_id=${eventId} empty text, ignored`);
    return 'invalid';
  }
  if (dedup && dedup.attempts(eventId) >= maxAttempts) {
    dedup.add(eventId);
    warn(`[im-owner-notice] event_id=${eventId} status=gave_up after ${maxAttempts} attempts`);
    return 'gave_up';
  }
  const attempt = dedup ? dedup.attempt(eventId) : 1;

  let status;
  let target = null;
  try { target = await resolveEndpoint(); } catch (e) { warn(`[im-owner-notice] resolve endpoint: ${e.message}`); }
  if (!target) {
    status = 'no_address';
  } else {
    let ok = false;
    try { ok = await send(target.channel, stripMessageParams(target.endpoint), text); } catch { ok = false; }
    status = ok ? 'sent' : 'failed';
  }
  if (status === 'sent') dedup?.add(eventId);
  log(`[im-owner-notice] event_id=${eventId} kind=${se.kind || '?'} status=${status} attempt=${attempt}/${maxAttempts}` +
    (target ? ` channel=${target.channel}` : ''));

  return status;
}
