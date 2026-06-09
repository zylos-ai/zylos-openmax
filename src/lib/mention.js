/**
 * Outbound @-mention resolution for COCO Workspace messages.
 *
 * cws-fe highlights a mention purely client-side: it scans a message's text for
 * `@<participant display_name>` and wraps matches in a highlight chip
 * (`renderTextWithMentions` in cws-fe message-bubble.tsx). There is NO
 * structured mention token, no member_id in the body, and no backend mention
 * storage — the contract is simply "the text contains `@` immediately followed
 * by the exact display_name of a conversation participant".
 *
 * To make the agent's outbound mentions land on that contract we:
 *   1. record the display names we see in each conversation (from inbound
 *      senders / group-context), and
 *   2. on send, canonicalize any `@name` token in the outbound text to the
 *      exact recorded display_name (case/spacing-tolerant match → canonical
 *      form) so cws-fe's participant-name matcher hits.
 *
 * Note: highlighting in cws-fe currently only runs for `type: TEXT` messages;
 * agent messages (`type: AGENT_TEXT`) render via MarkdownRenderer, which does
 * not yet apply mention highlighting. Canonicalizing the name here is the
 * sender-side half — the render-side half is tracked in cws-fe issue #6. Once
 * that lands, these canonicalized `@names` light up with no further change.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/tmp';
const REG_PATH = path.join(HOME, 'zylos/components/coco-workspace/mention-registry.json');

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

/**
 * Record one or more participant display names seen in a conversation.
 * @param {string} conversationId
 * @param {string|string[]} names
 */
export function recordParticipants(conversationId, names) {
  if (!conversationId) return;
  const list = (Array.isArray(names) ? names : [names])
    .map((n) => String(n ?? '').trim())
    .filter(Boolean);
  if (!list.length) return;

  const reg = load();
  const conv = reg[conversationId] || (reg[conversationId] = {});
  let changed = false;
  for (const name of list) {
    const key = norm(name);
    if (conv[key] !== name) {
      conv[key] = name;
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
  if (!text || !conversationId || !String(text).includes('@')) return text;
  const conv = load()[conversationId];
  if (!conv) return text;

  // Match cws-fe's strategy: try known names longest-first so a longer name
  // (e.g. "Alice Wong") wins over a shorter prefix ("Alice"). Names may contain
  // spaces, so we match the full display_name case-insensitively after an `@`.
  const names = Object.values(conv).sort((a, b) => b.length - a.length);
  let out = String(text);
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `@` + the name (case-insensitive); rewrite to the canonical `@<exact>`.
    out = out.replace(new RegExp('@' + esc, 'gi'), '@' + name);
  }
  return out;
}
