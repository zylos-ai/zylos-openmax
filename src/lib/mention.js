/**
 * Outbound @-mention handling for OpenMax messages.
 *
 * cws-comm's `mentions` array (see message.proto MentionInput) is entirely
 * client-assembled: cws-fe's compose box tracks a `member_id` per mention
 * chip and submits it in the SendMessageRequest; cws-comm only validates and
 * stores whatever it is given — it never parses `@name` out of message text
 * (confirmed empirically: an agent's plain-text `@name` produces a message
 * with no `mentions` field at all, so nothing wakes the target). This file
 * is OpenMax's equivalent of cws-fe's chip-tracking: it plays back the
 * member_id ↔ display_name pairs we've already seen in a conversation so an
 * outbound `@name` can be resolved to a real `mentions` entry, the same way
 * cws-fe's picker would have.
 *
 * We also keep the older text-canonicalization behavior (rewriting `@name`
 * to the exact recorded display_name) for cws-fe's separate, purely
 * client-side highlight matcher (`renderTextWithMentions` in
 * message-bubble.tsx, which scans TEXT-type message bodies for `@name`).
 * That highlighter is unrelated to the `mentions` array and doesn't apply to
 * AGENT_TEXT messages yet (cws-fe issue #6) — canonicalizing here is just
 * the sender-side half, kept for when that lands.
 *
 * Registry entries record BOTH pieces of data:
 *   1. record the display names + member_ids we see in each conversation
 *      (from inbound senders / group-context), and
 *   2. on send, resolve any `@name` token in the outbound text against that
 *      registry to build the structured `mentions` array, AND canonicalize
 *      the text to the exact recorded display_name.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/tmp';
const REG_PATH = path.join(HOME, 'zylos/components/openmax/mention-registry.json');

// Bound the per-conversation name set so a busy group can't grow the file
// unbounded. LRU-ish: we just cap the number of distinct names retained.
const MAX_NAMES_PER_CONV = 200;

const norm = (s) => String(s ?? '').trim().toLowerCase();

function load() {
  try {
    return JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function save(reg) {
  try {
    fs.mkdirSync(path.dirname(REG_PATH), { recursive: true });
    fs.writeFileSync(REG_PATH, JSON.stringify(reg, null, 2) + '\n');
  } catch {
    /* best-effort: a write failure must never break message handling */
  }
}

// Reserved top-level registry key holding a { conversationId: epochMs } map of
// the last time we fetched (or attempted to fetch) each conversation's roster.
// Kept at the top level, alongside the conversationId-keyed name maps, so it
// never collides with a real conversation id and is invisible to matchedEntries
// (which only ever indexes reg[conversationId]). Deliberately NOT a normalized
// display-name key: no name normalizes to a string starting with "__".
const ROSTER_META_KEY = '__rosterFetchedAt';

// Negative-cache window for roster hydration. Once we've hit a conversation's
// member list, skip re-hitting it for this long — EVEN IF the @name still
// didn't resolve (misspelled, not a member, or a longer name that only shares a
// prefix). Two problems this closes, both raised in review:
//   1. an @token that can never resolve would otherwise re-fetch /members on
//      every single message (needsRosterHydration stays true forever), and
//   2. once the GET is bounded by a timeout, an unresponsive members endpoint
//      would otherwise cost that timeout on every send; with the cache it costs
//      it at most once per window.
// We stamp the timestamp BEFORE the fetch, so a hang/timeout/error is cached
// too — the whole point is to not retry a bad endpoint per-message.
export const ROSTER_FETCH_TTL_MS = 10 * 60 * 1000; // 10 min

/**
 * Has this conversation's roster been fetched within `ttlMs`? Callers use this
 * to decide whether to skip a (bounded, best-effort) roster hydration.
 * @param {string} conversationId
 * @param {number} [ttlMs]
 * @param {number} [nowMs] injectable clock for tests
 * @returns {boolean}
 */
export function rosterFetchedRecently(conversationId, ttlMs = ROSTER_FETCH_TTL_MS, nowMs = Date.now()) {
  if (!conversationId) return false;
  const meta = load()[ROSTER_META_KEY];
  const ts = meta && meta[conversationId];
  return Number.isFinite(ts) && (nowMs - ts) < ttlMs;
}

/**
 * Record that this conversation's roster was just fetched (or attempted).
 * Best-effort persistence, like the rest of the registry.
 * @param {string} conversationId
 * @param {number} [nowMs] injectable clock for tests
 */
export function markRosterFetched(conversationId, nowMs = Date.now()) {
  if (!conversationId) return;
  const reg = load();
  const meta = reg[ROSTER_META_KEY] || (reg[ROSTER_META_KEY] = {});
  meta[conversationId] = nowMs;
  save(reg);
}

// Registry entries were originally plain strings (display_name only, pre
// mentions support). Normalize either shape to {name, memberId}.
function entryOf(v) {
  if (v && typeof v === 'object') return { name: v.name, memberId: v.memberId };
  return { name: v, memberId: undefined };
}

/**
 * Record one or more participants seen in a conversation.
 * @param {string} conversationId
 * @param {string|{name:string, memberId?:string}|Array<string|{name,memberId}>} participants
 */
export function recordParticipants(conversationId, participants) {
  if (!conversationId) return;
  const list = (Array.isArray(participants) ? participants : [participants])
    .map((p) => (p && typeof p === 'object' ? p : { name: p }))
    .map((p) => ({ name: String(p.name ?? '').trim(), memberId: p.memberId ? String(p.memberId) : undefined }))
    .filter((p) => p.name);
  if (!list.length) return;

  const reg = load();
  const conv = reg[conversationId] || (reg[conversationId] = {});
  let changed = false;
  for (const { name, memberId } of list) {
    const key = norm(name);
    const prev = conv[key] ? entryOf(conv[key]) : undefined;
    const next = { name, memberId: memberId || prev?.memberId };
    if (!prev || prev.name !== next.name || prev.memberId !== next.memberId) {
      conv[key] = next;
      changed = true;
    }
  }
  if (!changed) return;

  // Cap retained names (drop oldest insertion order).
  const keys = Object.keys(conv);
  if (keys.length > MAX_NAMES_PER_CONV) {
    for (const k of keys.slice(0, keys.length - MAX_NAMES_PER_CONV)) delete conv[k];
  }
  save(reg);
}

// The mention-trigger character: ASCII '@' (U+0040), or the fullwidth '＠'
// (U+FF20) many CJK input methods substitute for it (autocorrect while
// typing Chinese/Japanese punctuation-width, or copy/paste from a source
// that already used the fullwidth form) — a common enough real-world typo
// that treating it as equivalent avoids a silently-dead mention. Both
// forms canonicalize to the plain ASCII '@' wherever we rewrite text.
const AT = '[@＠]';

// A name match only counts as a real mention token if it isn't itself a
// prefix of a longer identifier — otherwise a registry containing only
// "luna" would spuriously fire on "@luna.coco please check" (the ".coco"
// continuation makes it a different, longer name, not "luna" plus trailing
// punctuation). Require whatever follows the match to NOT be a
// letter/digit/./_/- (i.e. not something that could still be part of the
// same identifier); anything else (whitespace, most punctuation, end of
// string) is a valid boundary. \p{L}/\p{N} (Unicode letter/number, `u`
// flag) so this holds for CJK display names too, not just ASCII ones.
function nameMatches(name, text) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(AT + esc + '(?![\\p{L}\\p{N}._-])', 'iu').test(text);
}

// Shared "match known registered names, longest-first, against `@name`
// tokens in text" walk — used by both resolveMentions (rewrite) and
// buildMentions (structured extraction).
function matchedEntries(text, conversationId) {
  if (!text || !conversationId || !/[@＠]/.test(text)) return [];
  const conv = load()[conversationId];
  if (!conv) return [];
  return Object.values(conv)
    .map(entryOf)
    .filter((e) => e.name)
    .sort((a, b) => b.name.length - a.name.length)
    .filter((e) => nameMatches(e.name, text));
}

/**
 * Canonicalize `@name` tokens in outbound text to the exact recorded display
 * name for the conversation, so cws-fe's participant-name matcher highlights
 * them. Only rewrites mentions that match a known participant; leaves all other
 * text (including unknown `@handles`) untouched.
 *
 * @param {string} text
 * @param {string} conversationId
 * @returns {string}
 */
export function resolveMentions(text, conversationId) {
  const matches = matchedEntries(text, conversationId);
  let out = String(text ?? '');
  for (const { name } of matches) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Same post-name boundary as nameMatches()/matchedEntries — without it a
    // canonicalized "luna.coco" would also rewrite the "@luna.coco" prefix
    // embedded inside an unrelated longer word (e.g. "@luna.cocoa"). Also
    // normalizes a fullwidth "＠" trigger to the plain ASCII "@" here.
    out = out.replace(new RegExp(AT + esc + '(?![\\p{L}\\p{N}._-])', 'giu'), '@' + name);
  }
  return out;
}

// Broadcast @所有人 / @所有Agent sentinels (cws-core MentionInput type="all" /
// "all_agents" — "all" sweeps every HUMAN member, "all_agents" every AGENT
// member; both may coexist on one message). Matched against the exact same
// literal labels cws-fe's own composer recognizes (see cws-fe
// chat-area/mentions.ts BROADCAST_MENTION_DISPLAY_NAMES) — deliberately NOT
// a bare "@all"/"@all_agents" ASCII shorthand, which would false-positive on
// any ordinary text containing the common word "all". Same post-label
// boundary as nameMatches() (not just a substring test) — otherwise
// "@EveryoneElse", "@All agentship", "@所有agent123", "@所有人类" would all
// wrongly upgrade to a real broadcast wake. Also accepts the fullwidth "＠"
// trigger (see AT above) alongside the ASCII "@".
const ALL_AGENTS_RE = new RegExp(AT + '(?:所有agent|all agents)(?![\\p{L}\\p{N}._-])', 'iu');
const ALL_RE = new RegExp(AT + '(?:所有人|everyone)(?![\\p{L}\\p{N}._-])', 'iu');

/**
 * Build the structured `mentions` array (cws-core MentionInput[] shape:
 * `{type:'member', member_id}` for an individual, or `{type:'all'}` /
 * `{type:'all_agents'}` for a broadcast) for the outbound text: any `@name`
 * token that matches a known participant with a recorded member_id, plus
 * either broadcast sentinel if its exact literal label appears. Mirrors
 * cws-fe's `collectMentionInputs` contract: returns `undefined` — not an
 * empty array — when there's nothing to mention, so a no-mention send omits
 * the field entirely.
 *
 * @param {string} text
 * @param {string} conversationId
 * @returns {Array<{type:string, member_id?:string}>|undefined}
 */
export function buildMentions(text, conversationId) {
  const out = [];
  const s = String(text ?? '');
  if (ALL_RE.test(s)) out.push({ type: 'all' });
  if (ALL_AGENTS_RE.test(s)) out.push({ type: 'all_agents' });

  const seen = new Set();
  for (const { name, memberId } of matchedEntries(text, conversationId)) {
    if (!memberId || seen.has(memberId)) continue;
    seen.add(memberId);
    out.push({ type: 'member', member_id: memberId });
  }
  return out.length ? out : undefined;
}

// Global twins of the broadcast matchers, for stripping every sentinel from a
// string rather than just the first (the originals are single-shot `test()`
// matchers, so they deliberately aren't global — a global regex carries
// lastIndex state that would make repeated test() calls alternate).
const ALL_AGENTS_RE_G = new RegExp(ALL_AGENTS_RE.source, 'giu');
const ALL_RE_G = new RegExp(ALL_RE.source, 'giu');

// A conservative `@token` scanner, used ONLY to decide whether the registry
// looks incomplete — never to resolve anybody. Display names may contain
// characters this misses (a space, most obviously: "@gavin yang" yields the
// token "gavin"), which is fine, because a partial token is still enough to
// notice "the registry has nothing for this" and trigger a roster fetch. The
// actual resolution stays with matchedEntries(), which matches full recorded
// names against the raw text.
const MENTION_TOKEN_RE = new RegExp(AT + '([\\p{L}\\p{N}._-]+)', 'giu');

/**
 * Does `text` mention somebody the local registry can't resolve to a member_id?
 *
 * The registry is only ever populated from participants observed speaking in
 * the conversation (see recordParticipants' caller in comm-bridge.js), so
 * anyone who has never spoken is invisible to it and an `@name` aimed at them
 * silently produces no mention at all. This predicate is the trigger for
 * filling that gap from the conversation roster — see recordRoster().
 *
 * Broadcast sentinels are stripped first: `@所有人` / `@所有Agent` resolve
 * without the registry, so they must never trigger a roster fetch.
 *
 * @param {string} text
 * @param {string} conversationId
 * @returns {boolean}
 */
export function needsRosterHydration(text, conversationId) {
  const s = String(text ?? '');
  if (!conversationId || !/[@＠]/.test(s)) return false;

  // Blank out everything that already resolves without a roster fetch, then see
  // if any `@token` survives. We strip the actual matched SPANS rather than
  // comparing name prefixes: a resolvable long name (e.g. "@test11") must not
  // mask a distinct shorter token that merely shares its prefix (e.g. "@test",
  // a different member who has never spoken) — that prefix collision was a
  // false-negative that left "@test" silently unresolved forever. Stripping the
  // "@test11" span leaves "@test" standing, so it correctly triggers a fetch.
  //   - broadcast sentinels (@所有人/@所有Agent) resolve without the registry;
  //   - any @name matchedEntries can already resolve to a member_id will become
  //     a real mention as-is.
  let remaining = s.replace(ALL_AGENTS_RE_G, ' ').replace(ALL_RE_G, ' ');
  for (const { name } of matchedEntries(s, conversationId).filter((e) => e.memberId)) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    remaining = remaining.replace(new RegExp(AT + esc + '(?![\\p{L}\\p{N}._-])', 'giu'), ' ');
  }
  // A fresh (non-global) matcher so lingering lastIndex state can't skew test().
  return new RegExp(AT + '[\\p{L}\\p{N}._-]+', 'u').test(remaining);
}

/**
 * Record a conversation's full member roster into the registry, so that an
 * `@name` aimed at someone who has never spoken can still resolve.
 *
 * Two rules, both deliberate:
 *
 *  - **Duplicate display names: the first one wins.** Two members can share a
 *    display name, and the registry is keyed by normalized name, so only one
 *    can be kept. Ties go to whichever the roster lists first (per Gavin's
 *    call, 2026-08-07). Without the pre-dedup below, recordParticipants would
 *    instead let the *last* duplicate overwrite the earlier ones.
 *  - **Gap-filling only: never overwrite a name that already resolves.** An
 *    existing entry with a member_id came from someone actually observed
 *    speaking here, which is stronger evidence of who "@name" means than an
 *    arbitrary roster ordering. Names recorded without a member_id (legacy
 *    string-shaped entries) are NOT resolvable, so those do get filled in.
 *
 * @param {string} conversationId
 * @param {Array<{member_id?:string, display_name?:string}>} members
 */
export function recordRoster(conversationId, members) {
  if (!conversationId || !Array.isArray(members)) return;

  const conv = load()[conversationId] || {};
  const alreadyResolved = new Set(
    Object.keys(conv).filter((k) => entryOf(conv[k]).memberId),
  );

  const picked = [];
  const takenNames = new Set();
  for (const m of members) {
    const name = String(m?.display_name ?? '').trim();
    const memberId = m?.member_id ? String(m.member_id) : undefined;
    if (!name || !memberId) continue;
    const key = norm(name);
    if (alreadyResolved.has(key) || takenNames.has(key)) continue;  // first wins
    takenNames.add(key);
    picked.push({ name, memberId });
  }

  if (picked.length) recordParticipants(conversationId, picked);
}
