/**
 * Display-card assembly for `cws.card.v1`.
 *
 * Scope: display-mode cards only — a title/summary, one text block, and up to
 * five `ui.quick_reply` buttons. That is the shape behind "ask the user to pick
 * one of a few answers". Interactive (business-operation) cards need a context
 * plus a registry entry and are deliberately out of scope here.
 *
 * Every limit below mirrors the cws-comm validator
 * (`internal/domain/card.go`, card-message design v1.0). They are duplicated
 * here so a malformed card fails locally with the offending field named,
 * instead of coming back as an opaque 422 from cws-core.
 */

export const CARD_SCHEMA_V1 = 'cws.card.v1';
export const CARD_MODE_DISPLAY = 'display';
export const QUICK_REPLY_OPERATION = 'ui.quick_reply';

// Mirrors of the frozen v1.0 caps. Rune counts are code points, matching Go runes.
export const MAX_TITLE_RUNES = 200;
export const MAX_SUMMARY_RUNES = 1000;
export const MAX_BLOCK_TEXT_RUNES = 2000;
export const MAX_BLOCK_FALLBACK_RUNES = 512;
export const MAX_ACTIONS = 5;
export const MAX_ACTION_LABEL_RUNES = 32;
export const MAX_QUICK_REPLY_TEXT_RUNES = 200;
export const MAX_BODY_BYTES = 65536;

const KIND_RE = /^[a-z][a-z0-9_.-]{2,63}$/;
const ACTION_ID_RE = /^[a-z0-9_-]{1,64}$/;

const DEFAULT_KIND = 'agent.prompt';

/** Thrown with the offending field named, so the caller can fix it without guessing. */
export class CardError extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'CardError';
    this.field = field;
  }
}

const runes = (s) => [...s].length;

/**
 * Mirror of cws-comm's `normalizeCardReplyText` (NFC over a trimmed string).
 * Used only to compare two option texts for equality — never to rewrite what
 * the caller wrote.
 */
const normalizeOptionText = (s) => s.trim().normalize('NFC');

function requireText(value, field) {
  if (typeof value !== 'string' || value === '') {
    throw new CardError(field, 'is required and must be a non-empty string');
  }
  return value;
}

function capRunes(value, max, field) {
  const n = runes(value);
  if (n > max) throw new CardError(field, `must be at most ${max} code points, got ${n}`);
  return value;
}

/**
 * Derive an action id from its option text: lowercase, non-`[a-z0-9_-]` runs
 * collapsed to `-`. Falls back to a positional id when the text carries no
 * usable characters (e.g. pure CJK), which is why callers can always pass `id`
 * explicitly instead.
 */
function deriveActionId(text, index) {
  const slug = text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return ACTION_ID_RE.test(slug) ? slug : `option-${index + 1}`;
}

function normalizeOption(option, index) {
  const raw = typeof option === 'string' ? { text: option } : option;
  if (!raw || typeof raw !== 'object') {
    throw new CardError(`options[${index}]`, 'must be a string or an object');
  }
  const path = `options[${index}]`;
  const text = requireText(raw.text, `${path}.text`);
  capRunes(text, MAX_QUICK_REPLY_TEXT_RUNES, `${path}.text`);

  // The label defaults to the option text, but the two caps differ: a quick
  // reply may carry 200 code points while a label may carry 32. Blaming
  // `${path}.label` for a text-only input would name a field the caller never
  // wrote, so point at what they did write and say what to do about it.
  let label;
  if (raw.label === undefined) {
    if (runes(text) > MAX_ACTION_LABEL_RUNES) {
      throw new CardError(`${path}.text`, `is ${runes(text)} code points, which is too long to double as the button label (max ${MAX_ACTION_LABEL_RUNES}); pass an explicit shorter "label"`);
    }
    label = text;
  } else {
    label = capRunes(requireText(raw.label, `${path}.label`), MAX_ACTION_LABEL_RUNES, `${path}.label`);
  }

  const idExplicit = raw.id !== undefined;
  const id = idExplicit ? raw.id : deriveActionId(text, index);
  if (typeof id !== 'string' || !ACTION_ID_RE.test(id)) {
    throw new CardError(`${path}.id`, `must match ${ACTION_ID_RE}, got ${JSON.stringify(id)}`);
  }

  const action = { id, label, kind: 'ui', operation: QUICK_REPLY_OPERATION, params: { text }, idExplicit };
  if (raw.style !== undefined) {
    if (!['primary', 'secondary', 'danger'].includes(raw.style)) {
      throw new CardError(`${path}.style`, `must be primary, secondary or danger, got ${JSON.stringify(raw.style)}`);
    }
    action.style = raw.style;
  }
  return action;
}

/**
 * Build a validated `cws.card.v1` display-card body.
 *
 * @param {object} input
 * @param {string} input.title     Card heading (required).
 * @param {string} input.summary   One-line gist; also what a non-rendering
 *                                 surface shows (required).
 * @param {string} [input.text]    Body text block. Defaults to `summary`.
 * @param {string} [input.fallbackText] Plain-text projection of the block.
 *                                 Defaults to `text`, truncated to the cap.
 * @param {Array<string|object>} [input.options] Quick-reply choices. A string is
 *                                 shorthand for `{text}`; `{text, label?, id?, style?}`
 *                                 for the long form. Omit for a plain display card.
 * @param {string} [input.kind]    Card kind slug. Defaults to `agent.prompt`.
 * @returns {object} the card body, ready to send as `content.body`.
 */
export function buildDisplayCard(input = {}) {
  const title = capRunes(requireText(input.title, 'title'), MAX_TITLE_RUNES, 'title');
  const summary = capRunes(requireText(input.summary, 'summary'), MAX_SUMMARY_RUNES, 'summary');

  const kind = input.kind === undefined ? DEFAULT_KIND : input.kind;
  if (typeof kind !== 'string' || !KIND_RE.test(kind)) {
    throw new CardError('kind', `must match ${KIND_RE}, got ${JSON.stringify(kind)}`);
  }

  const text = input.text === undefined ? summary : requireText(input.text, 'text');
  capRunes(text, MAX_BLOCK_TEXT_RUNES, 'text');

  // Truncating a default we derived ourselves is fine. Truncating what the
  // caller explicitly wrote would change their message without telling them,
  // so that case is an error instead.
  let fallbackText;
  if (input.fallbackText === undefined) {
    fallbackText = runes(text) > MAX_BLOCK_FALLBACK_RUNES
      ? `${[...text].slice(0, MAX_BLOCK_FALLBACK_RUNES - 1).join('')}…`
      : text;
  } else {
    fallbackText = capRunes(requireText(input.fallbackText, 'fallbackText'), MAX_BLOCK_FALLBACK_RUNES, 'fallbackText');
  }

  const body = {
    schema: CARD_SCHEMA_V1,
    kind,
    mode: CARD_MODE_DISPLAY,
    title,
    summary,
    blocks: [{ type: 'text', text, fallback_text: fallbackText }],
  };

  const rawOptions = input.options === undefined ? [] : input.options;
  if (!Array.isArray(rawOptions)) throw new CardError('options', 'must be an array');
  if (rawOptions.length > MAX_ACTIONS) {
    throw new CardError('options', `must hold at most ${MAX_ACTIONS} choices, got ${rawOptions.length}`);
  }
  if (rawOptions.length > 0) {
    const actions = rawOptions.map(normalizeOption);

    // Validator rule 11: two quick-reply buttons may not carry the same option
    // text — the reply they produce would be indistinguishable.
    const seenText = new Map();
    const seenId = new Map();
    actions.forEach((action, i) => {
      // Compare after the same trim + NFC the backend applies, or "是" and
      // "是 " pass here and collide there — which is precisely the 422 this
      // local validation exists to prevent. The text itself is left untouched.
      const optionText = normalizeOptionText(action.params.text);
      if (seenText.has(optionText)) {
        throw new CardError(`options[${i}].text`, `duplicates options[${seenText.get(optionText)}].text (${JSON.stringify(action.params.text)}); two quick replies may not share one option text, compared after trim + NFC`);
      }
      seenText.set(optionText, i);

      // A derived id is ours to adjust: two distinct options whose slugs happen
      // to collide ("Yes!" and "Yes?" both slugify to "yes") are legitimate, so
      // fall back to the positional id rather than rejecting the card. An id the
      // caller chose is never rewritten — a duplicate there is their mistake.
      if (seenId.has(action.id)) {
        const clashesWith = seenId.get(action.id);
        if (action.idExplicit) {
          throw new CardError(`options[${i}].id`, `duplicates options[${clashesWith}].id (${JSON.stringify(action.id)})`);
        }
        const positional = `option-${i + 1}`;
        if (seenId.has(positional)) {
          throw new CardError(`options[${i}].id`, `cannot be derived: both ${JSON.stringify(action.id)} and ${JSON.stringify(positional)} are already taken; pass an explicit id`);
        }
        action.id = positional;
      }
      seenId.set(action.id, i);
    });
    body.actions = actions.map(({ idExplicit, ...action }) => action);
  }

  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > MAX_BODY_BYTES) {
    throw new CardError('body', `serializes to ${bytes} bytes, over the ${MAX_BODY_BYTES}-byte cap`);
  }
  return body;
}
