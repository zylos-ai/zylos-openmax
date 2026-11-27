/**
 * "Skills used this turn" (OPENM-1396, wsb#830 PRD §6.5, tech-plan-delta
 * 11-27 §3.3, route (b)): once a turn of an OpenMax Web DM has ENDED, the
 * plugin reports the skills the turn called to cws-core (K3,
 * skill-usage-contract.js), which projects them onto the turn's first reply.
 * Nothing rides on the reply itself any more.
 *
 * Lifecycle of one turn (all state in <dir>/<source message id>.json, written
 * only by the comm-bridge process; the sender writes <id>.reply):
 *
 *   1. comm-bridge registers every inbound OpenMax Web DM (and DM topic) turn
 *      from a human member (registerSkillTurn) — with the skills the user
 *      picked, possibly none. It records where each recent session log ends,
 *      so the turn is read from there on, never from a tail.
 *   2. the sender (scripts/send.js, send-body.js) records the message id of
 *      the turn's first delivered reply (planFirstReply → <id>.reply, 'wx').
 *   3. a background task (skill-usage-reporter.js) advances the scan of the
 *      session log incrementally (advanceScan, a stored byte offset per log)
 *      until the turn's turn_end, decides the report (finalizeScan /
 *      decideReport) and PUTs it; the registration is deleted after success or
 *      give-up.
 *
 * The list must be whole or absent (PRD:「不能把『没记到』显示成『没用到』」):
 * complete only when the turn's turn_end was seen and none of these happened
 * (each adds a reason; complete=false never carries skill ids):
 *   - the runtime is not Claude Code (Codex has no Skill tool);
 *   - the inbound arrived merged with another message, was injected into
 *     another message's turn, or another input entered the turn;
 *   - the turn was interrupted (Claude's「[Request interrupted by user…]」
 *     input or interrupted tool result);
 *   - a log record after the inbound has an unknown shape, does not parse, is
 *     too long to read, or the log was rewritten under the scan;
 *   - a Skill call without a skill name, or a name that maps to no skill_id;
 *   - a tool input that reads a skills/<dir>/SKILL.md directly, or a subagent
 *     call (its log is not read);
 *   - the activity run of the message is status_only or merged (only when
 *     activity is on; nothing here depends on OPENMAX_ACTIVITY otherwise);
 *   - more than 50 distinct skills;
 *   - no turn_end within TURN_END_WAIT_MS.
 *
 * skill_id: a market-installed skill lives in skills/market--<slug>/ with a
 * `.market-managed` file naming its skill_id; any other skill directory is
 * `local:<dir>` (the C-16 location_id). System skills are reported like any
 * other: cws-core filters by the Agent's catalog and stores the names.
 *
 * Never throws into the send path or the bridge.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from '../session.js';
import { parseClaudeRecord } from './adapters/claude-jsonl.js';
import { encodeProjectDir, readRuntimeName } from './collector.js';
import { endpointSourceMessageId } from './marker.js';
import { createRunStore } from './run-store.js';
import { stringLeaves } from './classify.js';
import { SOURCE_MESSAGE_ID_RE, MAX_TRACKED_LOGS, MAX_LINE_BYTES } from './constants.js';

export const SKILLS_USED_DIR = process.env.OPENMAX_SKILLS_USED_DIR || path.join(RUNTIME_DIR, 'skills-used');
export const MAX_SKILLS_USED_IDS = 50;
/** A registration (and its report retries) is kept at most this long. */
export const SKILL_TURN_RETENTION_MS = 24 * 60 * 60 * 1000;
/** No turn_end by then → the turn is reported incomplete. */
export const TURN_END_WAIT_MS = 12 * 60 * 60 * 1000;
/** After the turn_end, how long the first reply's id may still arrive. */
export const REPLY_WAIT_MS = 5 * 60 * 1000;
/** Log bytes one registration reads per tick, all logs together. */
export const SCAN_BYTES_PER_TICK = 4 * 1024 * 1024;
/**
 * A log first seen after the registration (a new session, or an older log
 * written again) is read from this far before its end at first sight, not
 * from its start: the message reached it at most a tick before.
 */
export const NEW_LOG_LOOKBACK_BYTES = 8 * 1024 * 1024;

const SKILL_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const LOCATION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MARKET_PREFIX = 'market--';
const SKILL_MD_HEAD_BYTES = 64 * 1024;
const DELEGATE_TOOLS = new Set(['Agent', 'Task']);
// A tool input naming a skill's SKILL.md: the skill is being read directly,
// not through the Skill tool.
const SKILL_MD_RE = /skills\/[^/\s"'`]+\/SKILL\.md/;
// Inputs that start or enter a turn (an `enqueue` only queues a message).
const TURN_INPUT_FORMS = new Set(['user', 'queued_command', 'absorbed']);
// Claude Code's own input after an interrupt (Esc / interrupted tool use).
const INTERRUPT_RE = /^\[Request interrupted by user/;

const validMessageId = (id) => typeof id === 'string' && SOURCE_MESSAGE_ID_RE.test(id);
const regPath = (dir, id) => path.join(dir, `${id}.json`);
const replyPath = (dir, id) => path.join(dir, `${id}.reply`);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, obj) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, p);
}

// ── session logs ──────────────────────────────────────────────────────────────

function projectDir({ homeDir, zylosDir }) {
  return path.join(homeDir, '.claude/projects', encodeProjectDir(fs.realpathSync(zylosDir)));
}

/** The newest MAX_TRACKED_LOGS session logs: [{ p, size, mtime }]. */
function recentLogs(dirs) {
  const dir = projectDir(dirs);
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => {
      const p = path.join(dir, n);
      try { const st = fs.statSync(p); return { p, size: st.size, mtime: st.mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((x, y) => y.mtime - x.mtime)
    .slice(0, MAX_TRACKED_LOGS);
}

// ── registration (comm-bridge) ────────────────────────────────────────────────

/**
 * comm-bridge: register the turn of inbound message `sourceMessageId`, before
 * it is handed to the runtime. Records where each recent session log ends.
 * An existing registration is kept (a redelivery does not restart it). A
 * non-Claude runtime registers only a turn with a selection (nothing could
 * be reported for one without). Returns true when a registration exists
 * afterwards. Never throws.
 */
export function registerSkillTurn({
  sourceMessageId, conversationId, orgId, memberId, selectedSkillIds = [],
  dir = SKILLS_USED_DIR,
  homeDir = process.env.HOME || '/tmp',
  zylosDir = path.join(homeDir, 'zylos'),
  now = Date.now(),
}) {
  try {
    const id = sourceMessageId == null ? '' : String(sourceMessageId);
    if (!validMessageId(id) || typeof conversationId !== 'string' || !conversationId) return false;
    if (typeof orgId !== 'string' || !orgId || typeof memberId !== 'string' || !memberId) return false;
    const selected = Array.isArray(selectedSkillIds) ? selectedSkillIds.filter((s) => typeof s === 'string' && s) : [];
    const runtime = readRuntimeName(zylosDir);
    if (runtime !== 'claude' && selected.length === 0) return false;
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(regPath(dir, id))) return true;
    const logs = {};
    if (runtime === 'claude') {
      try { for (const l of recentLogs({ homeDir, zylosDir })) logs[l.p] = { offset: l.size }; } catch {}
    }
    const reg = {
      v: 2, source_message_id: id, conversation_id: conversationId, org_id: orgId, member_id: memberId,
      registered_at: now, runtime, selected_skill_ids: selected,
      scan: { logs, anchor_log: null, ids: [], reasons: [], ended_at: null },
      report: { attempts: 0, next_at: 0 },
    };
    const fd = fs.openSync(regPath(dir, id), 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(reg)); } finally { fs.closeSync(fd); }
    return true;
  } catch (err) {
    return err?.code === 'EEXIST';
  }
}

/** Remove a turn's registration and reply record (forward failed, reported, gave up). */
export function dropSkillTurn(sourceMessageId, { dir = SKILLS_USED_DIR } = {}) {
  const id = String(sourceMessageId ?? '');
  if (!validMessageId(id)) return;
  for (const p of [regPath(dir, id), replyPath(dir, id)]) {
    try { fs.unlinkSync(p); } catch {}
  }
}

export function readSkillTurn(sourceMessageId, { dir = SKILLS_USED_DIR } = {}) {
  return readJson(regPath(dir, String(sourceMessageId)));
}

export function writeSkillTurn(reg, { dir = SKILLS_USED_DIR } = {}) {
  writeJson(regPath(dir, reg.source_message_id), reg);
}

/** Registered source message ids (in no particular order). */
export function listSkillTurns({ dir = SKILLS_USED_DIR } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^[0-9]{1,19}\.json$/.test(n)).map((n) => n.slice(0, -5));
}

/** Remove .reply files whose registration is gone and that are past retention. */
export function sweepOrphans({ dir = SKILLS_USED_DIR, now = Date.now() } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.endsWith('.reply') && !n.endsWith('.tmp')) continue;
    // A live registration's reply is removed with it (dropSkillTurn), never here.
    if (n.endsWith('.reply') && names.includes(`${n.slice(0, -6)}.json`)) continue;
    const p = path.join(dir, n);
    try { if (now - fs.statSync(p).mtimeMs > SKILL_TURN_RETENTION_MS) fs.unlinkSync(p); } catch {}
  }
}

// ── the first reply (scripts/send.js, send-body.js) ───────────────────────────

/**
 * Plan recording the turn's first reply. Null unless the reply names its
 * inbound message (`|msg:<id>`) and that message's turn is registered for
 * this conversation. settle('ok', messageId) records the delivered reply's
 * message id unless an earlier reply already did ('wx': the first delivered
 * reply wins); any other outcome records nothing, so the next reply may.
 * @returns {null | { settle: (outcome: string, messageId?: string|null) => void }}
 */
export function planFirstReply({ sourceMessageId, convId, dir = SKILLS_USED_DIR }) {
  try {
    const id = sourceMessageId == null ? '' : String(sourceMessageId).trim();
    if (!validMessageId(id) || !convId) return null;
    const reg = readJson(regPath(dir, id));
    if (!reg || reg.conversation_id !== convId) return null;
    if (fs.existsSync(replyPath(dir, id))) return null;
    return {
      settle(outcome, messageId) {
        try {
          const mid = messageId == null ? '' : String(messageId);
          if (outcome !== 'ok' || !validMessageId(mid)) return;
          const fd = fs.openSync(replyPath(dir, id), 'wx', 0o600);
          try { fs.writeSync(fd, JSON.stringify({ reply_message_id: mid, at: Date.now() })); } finally { fs.closeSync(fd); }
        } catch {}
      },
    };
  } catch {
    return null;
  }
}

export function readFirstReply(sourceMessageId, { dir = SKILLS_USED_DIR } = {}) {
  const r = readJson(replyPath(dir, String(sourceMessageId)));
  return r && validMessageId(r.reply_message_id) ? r.reply_message_id : null;
}

// ── skill name → skill_id ─────────────────────────────────────────────────────

function frontmatterName(file) {
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(SKILL_MD_HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  if (!m) return null;
  const line = /^name:\s*(.+?)\s*$/m.exec(m[1]);
  if (!line) return null;
  const v = line[1].replace(/^(["'])(.*)\1$/, '$2').trim();
  return v || null;
}

function marketSkillId(dirPath) {
  let raw;
  try { raw = fs.readFileSync(path.join(dirPath, '.market-managed'), 'utf8'); } catch { return null; }
  let id = null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.skill_id === 'string') id = j.skill_id;
  } catch {
    const m = /^\s*skill_id\s*[:=]\s*["']?([^"'\s]+)["']?\s*$/m.exec(raw);
    if (m) id = m[1];
  }
  return id && SKILL_ID_RE.test(id) ? id : null;
}

/**
 * Map every skill directory of `skillsDir` (one level, no dot dirs) to its
 * skill_id, keyed by both its SKILL.md frontmatter `name` and its directory
 * name. A key two skills claim with different ids resolves to nothing, as
 * does a market directory without a readable `.market-managed`.
 * @returns {{ resolve: (name: string) => string|null }}
 */
export function buildSkillIdMap({ skillsDir }) {
  const byKey = new Map();
  const put = (key, id) => {
    if (!key) return;
    if (byKey.has(key) && byKey.get(key) !== id) byKey.set(key, null);
    else byKey.set(key, id);
  };
  let names = [];
  try { names = fs.readdirSync(skillsDir); } catch {}
  for (const dir of names) {
    if (dir.startsWith('.')) continue;
    const p = path.join(skillsDir, dir);
    try { if (!fs.statSync(p).isDirectory()) continue; } catch { continue; }
    const md = path.join(p, 'SKILL.md');
    if (!fs.existsSync(md)) continue;
    let id = null;
    if (dir.startsWith(MARKET_PREFIX)) id = marketSkillId(p);
    else if (LOCATION_ID_RE.test(dir)) id = `local:${dir}`;
    put(dir, id);
    put(frontmatterName(md), id);
  }
  return { resolve: (name) => (typeof name === 'string' && byKey.get(name)) || null };
}

// ── the turn, from the runtime log (incremental) ──────────────────────────────

function segmentNamesSource(seg, sourceMessageId) {
  const ctx = seg?.ctx || {};
  if (ctx.sourceMessageId === sourceMessageId) return true;
  const rv = ctx.replyVia;
  return !!rv && rv.channel === 'openmax' && endpointSourceMessageId(rv.endpoint) === sourceMessageId;
}

const namesSource = (ev, id) => ev?.t === 'input' && Array.isArray(ev.segments) && ev.segments.some((s) => segmentNamesSource(s, id));

/**
 * Feed parsed log events (claude-jsonl.js shapes, `{t:'unknown'}` for a record
 * that did not parse) into a turn's scan state, in log order. Mutates and
 * returns `scan`: { anchored, ids, reasons, ended }. Events before the anchor
 * (an input of a turn-starting form naming the message) are skipped; the
 * turn_end after it ends the turn and the rest is ignored. An input naming
 * the message again before that restarts the turn (a redelivery).
 * @returns {{ consumed: number }} events used up to and including the turn_end
 */
export function feedTurnEvents(scan, events, { sourceMessageId, resolve }) {
  const why = (r) => { if (!scan.reasons.includes(r)) scan.reasons.push(r); };
  let i = 0;
  for (; i < events.length && !scan.ended; i++) {
    const ev = events[i];
    if (namesSource(ev, sourceMessageId) && TURN_INPUT_FORMS.has(ev.form)) {
      scan.anchored = true;
      scan.ids = [];
      scan.reasons = [];
      if (ev.form !== 'user' || ev.segments.length !== 1) why('merged_input');
      continue;
    }
    if (!scan.anchored) continue;
    if (!ev || ev.t === 'unknown') { why('unknown_record'); continue; }
    if (ev.t === 'input') {
      if (TURN_INPUT_FORMS.has(ev.form)) why(INTERRUPT_RE.test(ev.head || '') ? 'interrupted' : 'merged_input');
      continue;
    }
    if (ev.t === 'turn_end') {
      // Codex-shaped turn_end only (codex-rollout.js); the Claude adapter's
      // turn_end has no flag, its interrupts are the input / tool result above.
      if (ev.interrupted === true) why('interrupted');
      scan.ended = true;
      continue;
    }
    if (ev.t === 'tool_end') {
      if (ev.isError && INTERRUPT_RE.test(ev.result?.text || '')) why('interrupted');
      continue;
    }
    if (ev.t !== 'tool_start') continue;
    if (ev.name === 'Skill') {
      const name = ev.input?.skill;
      if (typeof name !== 'string' || !name.trim()) { why('unrecognized_invocation'); continue; }
      const id = resolve(name.trim());
      if (!id) { why('unrecognized_skill'); continue; }
      if (!scan.ids.includes(id)) scan.ids.push(id);
      continue;
    }
    if (DELEGATE_TOOLS.has(ev.name)) { why('delegated'); continue; }
    if (stringLeaves(ev.input).some((l) => SKILL_MD_RE.test(l))) why('skill_file_read');
  }
  return { consumed: i };
}

function parseLine(line, sessionId) {
  let rec;
  try { rec = JSON.parse(line); } catch { return [{ t: 'unknown' }]; }
  const res = parseClaudeRecord(rec, { sessionId });
  return res.status === 'unknown' ? [{ t: 'unknown' }] : res.events;
}

function readRange(file, start, len) {
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  let n;
  try { n = fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  return buf.subarray(0, n);
}

/**
 * Read whole lines of one log from `cur.offset`, at most `budget` bytes (or,
 * with `allowLong`, a single line longer than that up to MAX_LINE_BYTES). Advances `cur` past what it returns.
 * A longer line is skipped (cur.skipping until its newline) and reported as
 * one unknown record. A partial last line is left for the next tick.
 * @returns {{ lines: string[], bytes: number, skippedLine: boolean }}
 */
function readLines(file, cur, budget, size, { allowLong = true } = {}) {
  const out = { lines: [], bytes: 0, skippedLine: false };
  if (cur.offset >= size) return out;
  if (cur.skipping) {
    const chunk = readRange(file, cur.offset, Math.min(budget, size - cur.offset));
    const nl = chunk.indexOf(0x0a);
    out.bytes = nl === -1 ? chunk.length : nl + 1;
    cur.offset += out.bytes;
    if (nl !== -1) { cur.skipping = false; out.skippedLine = true; }
    return out;
  }
  let len = Math.min(budget, size - cur.offset);
  let chunk = readRange(file, cur.offset, len);
  let nl = chunk.lastIndexOf(0x0a);
  if (nl === -1 && len < size - cur.offset) {
    // The next line is longer than what is left of the budget: stop for this
    // tick, unless nothing was read yet — then read that one line, up to the
    // line limit.
    if (!allowLong) return out;
    len = Math.min(MAX_LINE_BYTES, size - cur.offset);
    chunk = readRange(file, cur.offset, len);
    nl = chunk.indexOf(0x0a);
    if (nl === -1) {
      if (len < MAX_LINE_BYTES) return out; // still being written
      cur.skipping = true;
      cur.offset += chunk.length;
      out.bytes = chunk.length;
      return out;
    }
  }
  if (nl === -1) return out; // partial line at the end of the log
  out.lines = chunk.subarray(0, nl).toString('utf8').split('\n');
  out.bytes = nl + 1;
  cur.offset += nl + 1;
  return out;
}

/**
 * Advance a registration's scan by at most `budget` log bytes. Reads only
 * past the stored offsets: the logs that existed at registration from where
 * they ended then; a log first seen later from NEW_LOG_LOOKBACK_BYTES before
 * its end; once the inbound is found, only that log. Mutates `reg.scan`.
 * @returns {{ ended: boolean, bytes: number }}
 */
export function advanceScan(reg, {
  homeDir = process.env.HOME || '/tmp',
  zylosDir = path.join(homeDir, 'zylos'),
  skillsDir = path.join(zylosDir, '.claude/skills'),
  budget = SCAN_BYTES_PER_TICK,
  now = Date.now(),
} = {}) {
  const scan = reg.scan;
  if (scan.ended_at) return { ended: true, bytes: 0 };
  if (now - reg.registered_at > TURN_END_WAIT_MS) {
    addReason(scan, 'turn_end_not_seen');
    scan.ended_at = now;
    return { ended: true, bytes: 0 };
  }
  if (reg.runtime !== 'claude') {
    scan.reasons = ['runtime_unsupported'];
    scan.ended_at = now;
    return { ended: true, bytes: 0 };
  }
  let bytes = 0;
  let resolver = null;
  const resolve = (name) => (resolver ||= buildSkillIdMap({ skillsDir })).resolve(name);
  try {
    let files;
    if (scan.anchor_log) {
      files = [scan.anchor_log];
    } else {
      for (const l of recentLogs({ homeDir, zylosDir })) {
        if (!scan.logs[l.p]) scan.logs[l.p] = { offset: Math.max(0, l.size - NEW_LOG_LOOKBACK_BYTES), skipping: l.size > NEW_LOG_LOOKBACK_BYTES };
      }
      files = Object.keys(scan.logs);
    }
    for (const file of files) {
      const cur = scan.logs[file];
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      if (size < cur.offset) {
        // Rewritten under us: what was read can no longer be trusted.
        if (scan.anchor_log === file) { addReason(scan, 'log_rewritten'); scan.ended_at = now; return { ended: true, bytes }; }
        cur.offset = 0;
        cur.skipping = false;
      }
      const sessionId = path.basename(file, '.jsonl');
      while (bytes < budget && cur.offset < size) {
        const { lines, bytes: n, skippedLine } = readLines(file, cur, budget - bytes, size, { allowLong: bytes === 0 });
        if (n === 0) break;
        bytes += n;
        const state = { anchored: scan.anchor_log === file, ids: scan.ids, reasons: scan.reasons, ended: false };
        if (skippedLine && state.anchored) addReason(scan, 'unknown_record');
        let consumedBytes = 0;
        for (const line of lines) {
          consumedBytes += Buffer.byteLength(line, 'utf8') + 1;
          if (!line.trim()) continue;
          const wasAnchored = state.anchored;
          feedTurnEvents(state, parseLine(line, sessionId), { sourceMessageId: reg.source_message_id, resolve });
          if (state.anchored && !wasAnchored) {
            // Found: the other logs are not read again.
            scan.anchor_log = file;
            for (const p of Object.keys(scan.logs)) if (p !== file) delete scan.logs[p];
          }
          if (state.ended) {
            // Leave the offset just past the turn_end line.
            cur.offset -= n - consumedBytes;
            break;
          }
        }
        scan.ids = state.ids;
        scan.reasons = state.reasons;
        if (state.ended) { scan.ended_at = now; return { ended: true, bytes }; }
      }
      if (scan.anchor_log) break;
      if (bytes >= budget) break;
    }
  } catch {
    // An unreadable project dir is retried on the next tick.
  }
  return { ended: false, bytes };
}

function addReason(scan, r) {
  if (!scan.reasons.includes(r)) scan.reasons.push(r);
}

/** Degrade on the activity run of this message, when there is one. */
export function activityReasons({ runStore = createRunStore(), convId, sourceMessageId }) {
  const out = [];
  try {
    const ids = runStore.readActive()?.by_conversation?.[convId];
    if (!Array.isArray(ids)) return out;
    for (const id of ids) {
      const run = runStore.readRun(id);
      if (!run || String(run.source_message_id) !== sourceMessageId) continue;
      if (run.status_only === true && !out.includes('status_only')) out.push('status_only');
      if ((run.events || []).some((e) => e?.kind === 'notice' && e.code === 'merged_turn') && !out.includes('merged_turn')) out.push('merged_turn');
    }
  } catch {}
  return out;
}

/**
 * The outcome of an ended turn: complete only with no reasons; an incomplete
 * one carries no skill ids.
 * @returns {{ complete: boolean, skillIds: string[], reasons: string[] }}
 */
export function finalizeScan(reg, { runStore } = {}) {
  const scan = reg.scan;
  const reasons = [...scan.reasons];
  if (reg.runtime === 'claude') {
    for (const r of activityReasons({ ...(runStore ? { runStore } : {}), convId: reg.conversation_id, sourceMessageId: reg.source_message_id })) {
      if (!reasons.includes(r)) reasons.push(r);
    }
    if (scan.ids.length > MAX_SKILLS_USED_IDS && !reasons.includes('too_many')) reasons.push('too_many');
  }
  const complete = reasons.length === 0;
  return { complete, skillIds: complete ? [...scan.ids] : [], reasons };
}

/**
 * What to do with a registration now. Pure.
 *   { action: 'wait' }                      turn not over, or reply id not yet known
 *   { action: 'drop', why }                 nothing to report (deleted)
 *   { action: 'report', complete, skillIds, replyMessageId, reasons }
 * Rules: no Web reply → nothing; no selection and (incomplete or no skill
 * called) → nothing (the UI would show nothing either way; an incomplete
 * no-selection turn is dropped as soon as a reason appears, before its
 * turn_end); otherwise report once the turn has ended.
 */
export function decideReport({ reg, outcome, replyMessageId, now = Date.now() }) {
  const selected = (reg.selected_skill_ids || []).length > 0;
  // Without a selection an incomplete turn shows nothing: stop reading early.
  if (!selected && reg.scan.reasons.length > 0) return { action: 'drop', why: 'incomplete_no_selection' };
  if (!reg.scan.ended_at) return { action: 'wait' };
  if (!selected && (!outcome.complete || outcome.skillIds.length === 0)) {
    return { action: 'drop', why: outcome.complete ? 'no_skills' : 'incomplete_no_selection' };
  }
  if (!replyMessageId) {
    // Codex: the end of its turn is not read here, so its reply may come late.
    const waitMs = reg.runtime === 'claude' ? REPLY_WAIT_MS : SKILL_TURN_RETENTION_MS;
    if (now - reg.scan.ended_at < waitMs) return { action: 'wait' };
    return { action: 'drop', why: 'no_reply' };
  }
  return { action: 'report', complete: outcome.complete, skillIds: outcome.skillIds, replyMessageId, reasons: outcome.reasons };
}
