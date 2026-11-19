/**
 * "Skills used this turn" (OPENM-1396, wsb#830 §6.5): the first reply to a
 * message that carried a `skills` context item gets one more context item,
 *
 *   { type: "skills-used", audience: "ui",
 *     attrs: { "reply-to": <inbound message id>, complete: true|false },
 *     data:  { skill_ids: [...] } }            ← only when complete=true
 *
 * so the web UI can say which of the picked skills the Agent used. The list
 * must be whole or absent (PRD: 「不能把『没记到』显示成『没用到』」): whenever
 * this module cannot prove it saw every skill the turn used, it sends
 * complete=false and no data, and the UI falls back to 「已指定：…」.
 * The attribute is `reply-to` with a hyphen (cws-comm drops attribute names
 * with an underscore); cws-comm drops a complete=true item without valid data
 * and any skills-used item not sent by an Agent (cws-comm !643).
 *
 * Independent of the activity feature (OPENMAX_ACTIVITY) and of agent_run
 * compaction: comm-bridge registers the turn (registerSkillTurn) when the
 * inbound message carries skills, and the sender (scripts/send.js) reads the
 * runtime's own session log at reply time (computeSkillsUsed). When activity
 * is on, its run for the same message is consulted only to degrade: a run
 * gone status_only, or one with a merged_turn note, makes the list incomplete.
 *
 * Incomplete (complete=false) when:
 *   - the runtime is not Claude Code (Codex has no Skill tool; it reads
 *     SKILL.md files, which cannot be told apart reliably);
 *   - the inbound message is not found in the log tail, arrived merged with
 *     another message, or was injected into another message's turn; another
 *     input entered the turn, or the turn ended before this reply (cross-turn);
 *   - a log record after it has an unknown shape or does not parse;
 *   - a Skill call has no skill name, or a name that maps to no skill_id;
 *   - a tool input reads a skills/<dir>/SKILL.md directly, or the turn
 *     delegates to a subagent (whose log is not read);
 *   - the activity run of this message is status_only or merged;
 *   - more than 50 distinct skills, or data over 4 KiB;
 *   - a skill the user SELECTED has not been called yet when the first reply
 *     claims the item (an early "收到" before the work): the list would show
 *     it as 「没用到」 when it may well be used after the ack.
 *
 * skill_id: a market-installed skill lives in skills/market--<slug>/ with a
 * `.market-managed` file naming its skill_id (cws-marketplace
 * install-and-client.md「本机落地」); any other skill directory is
 * `local:<dir>` (the C-16 location_id). kb-type skills
 * (openmax-product-faq, …) are skills like any other here.
 *
 * The item rides on the turn's FIRST reply (text, media or [STRUCTURED]; a
 * card reply does not carry it and leaves it to the next). Skills invoked
 * after that reply are not on it — which is why the list is complete only
 * when every selected skill was already called by then (see above).
 *
 * Never throws into the send path.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from '../session.js';
import { parseClaudeRecord } from './adapters/claude-jsonl.js';
import { encodeProjectDir, readRuntimeName } from './collector.js';
import { endpointSourceMessageId } from './marker.js';
import { createRunStore } from './run-store.js';
import { stringLeaves } from './classify.js';
import { SOURCE_MESSAGE_ID_RE, MAX_TRACKED_LOGS, DISCOVERY_SLACK_MS } from './constants.js';

export const SKILLS_USED_DIR = process.env.OPENMAX_SKILLS_USED_DIR || path.join(RUNTIME_DIR, 'skills-used');
export const MAX_SKILLS_USED_IDS = 50;
export const MAX_SKILLS_USED_DATA_BYTES = 4 * 1024;
export const SKILL_TURN_RETENTION_MS = 24 * 60 * 60 * 1000;
// How much of each session log is read back from its end at reply time.
export const SKILLS_LOG_TAIL_BYTES = 8 * 1024 * 1024;

const SKILL_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const LOCATION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const MARKET_PREFIX = 'market--';
const SKILL_MD_HEAD_BYTES = 64 * 1024;
const DELEGATE_TOOLS = new Set(['Agent', 'Task']);
// A tool input naming a skill's SKILL.md: the skill is being read directly,
// not through the Skill tool.
const SKILL_MD_RE = /skills\/[^/\s"'`]+\/SKILL\.md/;

const validSourceId = (id) => typeof id === 'string' && SOURCE_MESSAGE_ID_RE.test(id);

// ── registration (comm-bridge) ────────────────────────────────────────────────

/**
 * comm-bridge: the inbound message `sourceMessageId` carried a `skills` item.
 * Writes <dir>/<id>.json; removes registrations older than a day. Returns
 * false (nothing written) for an id that is not a message id. Never throws.
 */
export function registerSkillTurn({ sourceMessageId, conversationId, selectedSkillIds = [], dir = SKILLS_USED_DIR, now = Date.now() }) {
  try {
    const id = sourceMessageId == null ? '' : String(sourceMessageId);
    if (!validSourceId(id) || typeof conversationId !== 'string' || !conversationId) return false;
    fs.mkdirSync(dir, { recursive: true });
    cleanup(dir, now);
    fs.writeFileSync(path.join(dir, `${id}.json`),
      JSON.stringify({
        v: 1, source_message_id: id, conversation_id: conversationId, registered_at: now,
        selected_skill_ids: Array.isArray(selectedSkillIds) ? selectedSkillIds.filter((s) => typeof s === 'string' && s) : [],
      }), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function cleanup(dir, now) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      if (now - fs.statSync(p).mtimeMs > SKILL_TURN_RETENTION_MS) fs.unlinkSync(p);
    } catch {}
  }
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
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
    else if (LOCATION_ID_RE.test(dir) && dir !== '.' && dir !== '..') id = `local:${dir}`;
    put(dir, id);
    put(frontmatterName(md), id);
  }
  return { resolve: (name) => (typeof name === 'string' && byKey.get(name)) || null };
}

// ── the turn, from the runtime log ────────────────────────────────────────────

function segmentNamesSource(seg, sourceMessageId) {
  const ctx = seg?.ctx || {};
  if (ctx.sourceMessageId === sourceMessageId) return true;
  const rv = ctx.replyVia;
  return !!rv && rv.channel === 'openmax' && endpointSourceMessageId(rv.endpoint) === sourceMessageId;
}

const TURN_INPUT_FORMS = new Set(['user', 'queued_command', 'absorbed']);

/**
 * Decide the skills of one turn from parsed log events, in log order
 * (claude-jsonl.js shapes, plus `{t:'unknown'}` for a record that did not
 * parse or has an unknown shape). The anchor is the LAST input naming the
 * message (a queued message is seen again when it is delivered).
 * @returns {{ found: boolean, complete: boolean, skillIds: string[], reasons: string[], anchorAt?: number }}
 */
export function scanTurnRecords(events, { sourceMessageId, resolve }) {
  let anchor = -1;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev?.t === 'input' && Array.isArray(ev.segments) && ev.segments.some((s) => segmentNamesSource(s, sourceMessageId))) anchor = i;
  }
  if (anchor === -1) return { found: false, complete: false, skillIds: [], reasons: ['inbound_not_found'] };

  const reasons = [];
  const why = (r) => { if (!reasons.includes(r)) reasons.push(r); };
  const a = events[anchor];
  if (a.form !== 'user' || a.segments.length !== 1) why('merged_input');

  const ids = [];
  for (const ev of events.slice(anchor + 1)) {
    if (!ev || ev.t === 'unknown') { why('unknown_record'); continue; }
    if (ev.t === 'input') {
      if (TURN_INPUT_FORMS.has(ev.form)) why('merged_input');
      continue;
    }
    if (ev.t === 'turn_end') { why('turn_ended'); continue; }
    if (ev.t !== 'tool_start') continue;
    if (ev.name === 'Skill') {
      const name = ev.input?.skill;
      if (typeof name !== 'string' || !name.trim()) { why('unrecognized_invocation'); continue; }
      const id = resolve(name.trim());
      if (!id) { why('unrecognized_skill'); continue; }
      if (!ids.includes(id)) ids.push(id);
      continue;
    }
    if (DELEGATE_TOOLS.has(ev.name)) { why('delegated'); continue; }
    if (stringLeaves(ev.input).some((l) => SKILL_MD_RE.test(l))) why('skill_file_read');
  }
  if (ids.length > MAX_SKILLS_USED_IDS) why('too_many');
  else if (Buffer.byteLength(JSON.stringify({ skill_ids: ids }), 'utf8') > MAX_SKILLS_USED_DATA_BYTES) why('too_large');
  return { found: true, complete: reasons.length === 0, skillIds: ids, reasons, anchorAt: a.at };
}

/** The last `maxBytes` of a log as parsed events (a partial first line is dropped). */
function readLogEvents(file, maxBytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  let lines = buf.toString('utf8').split('\n');
  if (start > 0) lines = lines.slice(1);
  const sessionId = path.basename(file, '.jsonl');
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { events.push({ t: 'unknown' }); continue; }
    const res = parseClaudeRecord(rec, { sessionId });
    if (res.status === 'unknown') events.push({ t: 'unknown' });
    else events.push(...res.events);
  }
  return events;
}

function claudeLogs({ homeDir, zylosDir, since }) {
  const dir = path.join(homeDir, '.claude/projects', encodeProjectDir(fs.realpathSync(zylosDir)));
  return fs.readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => {
      const p = path.join(dir, n);
      try { return { p, mtime: fs.statSync(p).mtimeMs }; } catch { return null; }
    })
    // A log not written since the message was registered cannot hold its turn.
    .filter((e) => e && !(Number.isFinite(since) && e.mtime < since - DISCOVERY_SLACK_MS))
    .sort((x, y) => y.mtime - x.mtime)
    .slice(0, MAX_TRACKED_LOGS)
    .map((e) => e.p);
}

/** Degrade on the activity run of this message, when there is one. */
function activityReasons({ runStore, convId, sourceMessageId }) {
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
 * The skills used for `sourceMessageId` so far in its turn.
 * @returns {{ complete: boolean, skillIds: string[], reasons: string[] }}
 */
export function computeSkillsUsed({
  sourceMessageId, convId,
  homeDir = process.env.HOME || '/tmp',
  zylosDir = path.join(homeDir, 'zylos'),
  skillsDir = path.join(zylosDir, '.claude/skills'),
  runStore = createRunStore(),
  tailBytes = SKILLS_LOG_TAIL_BYTES,
  since,
}) {
  try {
    if (readRuntimeName(zylosDir) !== 'claude') return { complete: false, skillIds: [], reasons: ['runtime_unsupported'] };
    const { resolve } = buildSkillIdMap({ skillsDir });
    let best = null;
    for (const file of claudeLogs({ homeDir, zylosDir, since })) {
      let events;
      try { events = readLogEvents(file, tailBytes); } catch { continue; }
      const r = scanTurnRecords(events, { sourceMessageId, resolve });
      if (r.found && (!best || (r.anchorAt ?? 0) > (best.anchorAt ?? 0))) best = r;
    }
    if (!best) return { complete: false, skillIds: [], reasons: ['inbound_not_found'] };
    const reasons = [...best.reasons, ...activityReasons({ runStore, convId, sourceMessageId }).filter((r) => !best.reasons.includes(r))];
    return { complete: reasons.length === 0, skillIds: best.skillIds, reasons };
  } catch {
    return { complete: false, skillIds: [], reasons: ['error'] };
  }
}

/**
 * A list is complete only when every skill the user selected for the turn was
 * already called: the item rides on the first reply, and an early ack
 * ("收到") comes before the work. A registration without a selection list
 * is never complete.
 */
export function withSelectedCheck(result, selectedSkillIds) {
  if (!result.complete) return result;
  if (!Array.isArray(selectedSkillIds) || selectedSkillIds.length === 0) {
    return { ...result, complete: false, reasons: [...result.reasons, 'selection_unknown'] };
  }
  if (selectedSkillIds.every((s) => result.skillIds.includes(s))) return result;
  return { ...result, complete: false, reasons: [...result.reasons, 'selected_not_called'] };
}

/** The context item; complete=false never carries data. */
export function skillsUsedItem({ sourceMessageId, complete, skillIds = [] }) {
  const item = { type: 'skills-used', audience: 'ui', attrs: { 'reply-to': String(sourceMessageId), complete: complete === true } };
  if (complete === true) item.data = { skill_ids: [...skillIds] };
  return item;
}

// ── the first reply (scripts/send.js) ─────────────────────────────────────────

/**
 * Plan the skills-used item of one reply. Null unless the reply names its
 * inbound message (`|msg:<id>`), that message was registered (it carried
 * skills) for this conversation, and this is the turn's first reply.
 *
 * Claim <dir>/<id>.claim (created with 'wx'): settle('ok') → delivered (no
 * later reply carries the item); settle('rejected') → released (the next
 * reply may); 'uncertain' → kept pending, and a retry with the same body hash
 * gets the same item again.
 *
 * @returns {null | { item: object, settle: (outcome: 'ok'|'rejected'|'uncertain') => void }}
 */
export function planSkillsUsed({ sourceMessageId, convId, bodyHash, dir = SKILLS_USED_DIR, now = Date.now(), ...deps }) {
  try {
    const id = sourceMessageId == null ? '' : String(sourceMessageId).trim();
    if (!validSourceId(id) || !convId) return null;
    const reg = readJson(path.join(dir, `${id}.json`));
    if (!reg || reg.conversation_id !== convId) return null;
    const claimPath = path.join(dir, `${id}.claim`);
    const hash = typeof bodyHash === 'function' ? bodyHash() : bodyHash;

    let claim = readJson(claimPath);
    if (!claim) {
      const r = withSelectedCheck(computeSkillsUsed({ sourceMessageId: id, convId, since: reg.registered_at, ...deps }), reg.selected_skill_ids);
      claim = { v: 1, state: 'pending', body_sha256: hash, item: skillsUsedItem({ sourceMessageId: id, ...r }), reasons: r.reasons, claimed_at: now };
      let fd;
      try {
        fd = fs.openSync(claimPath, 'wx', 0o600);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        claim = readJson(claimPath);
      }
      if (fd !== undefined) {
        try { fs.writeSync(fd, JSON.stringify(claim)); } finally { fs.closeSync(fd); }
        return settleable(claimPath, claim);
      }
    }
    if (claim?.state === 'pending' && claim.body_sha256 === hash && claim.item) return settleable(claimPath, claim);
    return null;
  } catch {
    return null;
  }
}

function settleable(claimPath, claim) {
  return {
    item: claim.item,
    settle(outcome) {
      try {
        if (outcome === 'ok') fs.writeFileSync(claimPath, JSON.stringify({ ...claim, state: 'delivered', delivered_at: Date.now() }), { mode: 0o600 });
        else if (outcome === 'rejected') fs.unlinkSync(claimPath);
      } catch {}
    },
  };
}

/**
 * A copy of `body` with the plan's item as its metadata.context (the
 * caller's own metadata keys kept; `context` is reserved for the platform and
 * never caller-supplied, see send-body.js). No plan → `body` unchanged.
 */
export function withSkillsUsed(body, plan) {
  if (!plan?.item) return body;
  return { ...body, metadata: { ...(body.metadata || {}), context: { items: [plan.item] } } };
}
