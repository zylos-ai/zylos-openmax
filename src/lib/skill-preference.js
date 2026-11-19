/**
 * Skill preference (OPENM-1396, wsb#830).
 *
 * The user can pick skills in the OpenMax input box ("+" → 技能). Every message
 * sent from the box while some are picked carries one `skills` item of
 * `metadata.context` (see message-context.js):
 *
 *   { type: "skills", audience: "agent", attrs: { count },
 *     data: { skills: [{ skill_id, name }] } }
 *
 * `skill_id` is the market skill id, or `local:<location_id>` for a skill
 * that is only on this host (location_id = its directory under skills/).
 * The bridge renders it as a structural <skill-preference> element in the
 * inbound header (right after <connector-preference>), not inside the user's
 * text. It is a preference, not a gate: nothing is blocked and the Agent may
 * use other skills (PRD §6.6 「优先」, not 「必须」). The two sentences are the
 * PRD v0.3.4 §6.6 wording, verbatim.
 */

import { agentContextItem } from './message-context.js';

// cws-comm caps the item at 50 skills; this is the same bound for a malformed
// payload, not a product limit.
export const MAX_PREFERRED_SKILLS = 50;
export const MAX_SKILL_NAME_LENGTH = 60;

// Ids are interpolated into an attribute: id-shaped strings only (market ids,
// `local:<location_id>` with location_id ^[A-Za-z0-9._-]{1,128}$).
const SKILL_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

function oneLineName(raw) {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const chars = [...flat];
  if (chars.length <= MAX_SKILL_NAME_LENGTH) return flat;
  return `${chars.slice(0, MAX_SKILL_NAME_LENGTH - 1).join('')}…`;
}

/**
 * The skills the user picked for this message, from the `skills` agent item of
 * `metadata.context`: `[{ skillId, name }]` in the user's order, or null when
 * there is nothing usable. Malformed entries are dropped one by one;
 * duplicates (by id) keep the first.
 */
export function skillPreferenceOf(msg) {
  const raw = agentContextItem(msg, 'skills')?.data?.skills;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = [];
  const seen = new Set();
  for (const it of raw) {
    if (out.length >= MAX_PREFERRED_SKILLS) break;
    if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
    const id = it.skill_id;
    if (typeof id !== 'string' || !SKILL_ID_RE.test(id) || seen.has(id)) continue;
    const name = oneLineName(it.name);
    if (!name) continue;
    seen.add(id);
    out.push({ skillId: id, name });
  }
  return out.length ? out : null;
}

function escapeText(s) {
  return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the <skill-preference> element: exactly two content lines (PRD §6.6).
 * Returns '' when there is nothing to render.
 */
export function formatSkillPreference(prefs) {
  if (!Array.isArray(prefs) || prefs.length === 0) return '';
  const ids = prefs.map((p) => p.skillId).join(',');
  const list = prefs.map((p) => escapeText(p.name)).join('、');
  return [
    `<skill-preference skill-ids="${ids}">`,
    `用户希望这条消息优先用这些技能：${list}。先看它们适不适合这条消息，适合的就用，先后和怎么组合由你决定。`,
    '不适合或用不了的就不用，照常处理，并在回复里用用户正在用的语言简短说一句哪个没用、为什么。',
    '</skill-preference>',
  ].join('\n');
}
