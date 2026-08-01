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
  return new RegExp('@' + esc + '(?![\\p{L}\\p{N}._-])', 'iu').test(text);
}

// Shared "match known registered names, longest-first, against `@name`
// tokens in text" walk — used by both resolveMentions (rewrite) and
// buildMentions (structured extraction).
function matchedEntries(text, conversationId) {
  if (!text || !conversationId || !String(text).includes('@')) return [];
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
    // embedded inside an unrelated longer word (e.g. "@luna.cocoa").
    out = out.replace(new RegExp('@' + esc + '(?![\\p{L}\\p{N}._-])', 'giu'), '@' + name);
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
// wrongly upgrade to a real broadcast wake.
const ALL_AGENTS_RE = /@(?:所有agent|all agents)(?![\p{L}\p{N}._-])/iu;
const ALL_RE = /@(?:所有人|everyone)(?![\p{L}\p{N}._-])/iu;

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
