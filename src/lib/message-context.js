/**
 * Message context (metadata.context, phase 1, OPENM-1351).
 *
 * One metadata key carries every piece of context attached to a message:
 *
 *   metadata.context = { items: [{ type, source, audience, attrs, data? }] }
 *
 *   - type     what the item is (connectors, workflow, quote, forwarded,
 *              subconversation, or a type an app defines itself);
 *   - source   who attached it, written by cws-comm from the sender's
 *              authenticated principal (`app:<app_id>`, `platform`, `client`);
 *              a client-supplied value is overwritten there;
 *   - audience who it is for (`agent` | `ui` | `server`); only `agent` items
 *              reach the Agent;
 *   - attrs    a flat map of scalar hints;
 *   - data     an optional JSON object for nested or long content.
 *
 * There is no version field: unknown types and unknown fields are ignored, and
 * anything with an unexpected shape drops only that item (or that attribute),
 * never the message.
 *
 * Trust. Until cws-comm stamps `source` (and the existing client-written
 * values are cleaned up), the value is whatever the sender wrote, so it is
 * rendered with `source-verified="false"`. The operator turns on
 * `contextSourceTrusted` in config.json once the platform stamps it; only then
 * is `source-verified="true"` rendered. Even a verified source only says who
 * attached the item: attrs and data stay hints, never authorization.
 *
 * Neither cws-comm nor cws-core reserves metadata.context yet (the CLI's
 * refusal in src/cli/comm.js is a courtesy check), so any member can write
 * items today. acceptsItem therefore ignores the platform-only types
 * (forwarded, subconversation) while the switch is off — forwarded falls back
 * to forwarded_from, which cws-comm does reserve — and with it on accepts them
 * only with the source the platform stamps; a workflow item is limited to its
 * registered attrs, loses to an old wf_ref while the switch is off, and with
 * it on counts only from an app.
 *
 * Rendering. Four types keep their existing elements and wording
 * (connectors → <connector-preference>, quote → <quoted-excerpt>, forwarded →
 * <forwarded-message>, see the readers in connector-preference.js,
 * quote-excerpt.js and forwarded.js), with a `source` / `source-verified`
 * attribute added when the element comes from an item. Everything else
 * (workflow, subconversation, unregistered types) is rendered here as a
 * generic self-closing
 *
 *   <context type="…" source="…" source-verified="true|false" k="v" …/>
 *
 * in the inbound header; an unregistered type's `data` goes into the element
 * body as one line of escaped JSON. Values are escaped and flattened onto one
 * line the same way as wf-context.js, and an over-long value is dropped rather
 * than cut (a truncated id points at the wrong thing).
 *
 * Inheritance. A reply (or a thread message) also shows the inheritable items
 * (workflow, subconversation) of the message it replies to (or, in a thread,
 * of the thread root — see context-parent.js), with `parent:` put in front of
 * their source; this happens at render
 * time only and is never written back. An item of the same type on the current
 * message wins. A parent that only carries the old `wf_ref` key is inherited
 * as an unverified workflow item.
 */

import { wfRefFrom } from './wf-context.js';

// Registered phase-1 types (same table as cws-comm's). `inherit`: shown on a
// reply / thread message too. `dataMaxBytes`: the encoded size data may have
// (0 = this type takes no data). Types not listed here are "unregistered".
export const CONTEXT_TYPES = Object.freeze({
  connectors: { inherit: false, dataMaxBytes: 6 * 1024 },
  workflow: { inherit: true, dataMaxBytes: 0 },
  quote: { inherit: false, dataMaxBytes: 6 * 1024 },
  forwarded: { inherit: false, dataMaxBytes: 0 },
  subconversation: { inherit: true, dataMaxBytes: 1024 },
});
// Rendered by their own element elsewhere; never as a generic <context>.
const OWN_ELEMENT_TYPES = new Set(['connectors', 'quote', 'forwarded']);

export const MAX_CONTEXT_ITEMS = 16;
export const MAX_CONTEXT_ATTRS = 16;
export const MAX_CONTEXT_ATTR_CODE_POINTS = 200;
export const MAX_SUBCONVERSATION_TITLE_CODE_POINTS = 256;
export const MAX_DATA_DEPTH = 5;
export const UNREGISTERED_DATA_MAX_BYTES = 2 * 1024;
// An unregistered type's data is rendered only up to this size; above it the
// element says data-omitted="true" instead.
export const MAX_RENDERED_DATA_BYTES = 4 * 1024;
// All generic <context> elements together. The whole C4 envelope must stay
// under 128 KiB (see forwarded.js C4_ARG_MAX_BYTES); items that do not fit are
// left out (the current message's first, inherited ones after).
export const MAX_CONTEXT_BLOCK_BYTES = 16 * 1024;

const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const AUDIENCES = new Set(['agent', 'ui', 'server']);
// Attribute names the element itself uses: an item's attrs may not set them,
// or an item could forge its own source-verified="true".
const RESERVED_ATTRS = new Set(['type', 'source', 'source-verified', 'data-omitted', 'title']);
export const PARENT_SOURCE_PREFIX = 'parent:';
// Source shown for an inherited legacy wf_ref (it has no source at all).
export const LEGACY_SOURCE = 'legacy';
const UNKNOWN_SOURCE = 'unknown';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const byteLength = (s) => Buffer.byteLength(s, 'utf8');

/**
 * One-line form of a scalar attribute value, or '' when it is not a scalar,
 * empty after flattening, or longer than `max` code points (dropped, not cut).
 */
export function flatValue(raw, max = MAX_CONTEXT_ATTR_CODE_POINTS) {
  if (raw === null || raw === undefined) return '';
  if (!['string', 'number', 'boolean'].includes(typeof raw)) return '';
  if (typeof raw === 'number' && !Number.isFinite(raw)) return '';
  // eslint-disable-next-line no-control-regex
  const flat = String(raw).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat || [...flat].length > max) return '';
  return flat;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function depthOf(v, level = 1) {
  if (Array.isArray(v)) return v.reduce((d, x) => Math.max(d, depthOf(x, level + 1)), level);
  if (isObject(v)) return Object.values(v).reduce((d, x) => Math.max(d, depthOf(x, level + 1)), level);
  return level - 1;
}

function readData(raw, type) {
  if (!isObject(raw)) return undefined;
  const reg = CONTEXT_TYPES[type];
  const max = reg ? reg.dataMaxBytes : UNREGISTERED_DATA_MAX_BYTES;
  if (max <= 0 || depthOf(raw) > MAX_DATA_DEPTH) return undefined;
  let json;
  try { json = JSON.stringify(raw); } catch { return undefined; }
  if (typeof json !== 'string' || byteLength(json) > max) return undefined;
  return raw;
}

function readAttrs(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= MAX_CONTEXT_ATTRS) break;
    n += 1;
    if (!NAME_RE.test(k)) continue;
    const flat = flatValue(v);
    if (!flat) continue;
    // Keep booleans / numbers typed so readers can tell `true` from "true".
    out[k] = typeof v === 'string' ? flat : v;
  }
  return out;
}

function readSource(raw) {
  return flatValue(raw) || undefined;
}

function metadataOf(msg) {
  if (!isObject(msg)) return undefined;
  return [msg.metadata, msg.message?.metadata].find((m) => isObject(m) && 'context' in m);
}

/**
 * Every well-formed item of `metadata.context` on a fetched message (top-level
 * `metadata`, or the nested `message.metadata` envelope — same lookup as the
 * other metadata readers), at most MAX_CONTEXT_ITEMS. Each item is
 * `{ type, source?, audience, attrs, data? }`. A missing or malformed context
 * gives []; a malformed item, attribute or data is dropped on its own.
 */
export function contextItemsFrom(msg) {
  const ctx = metadataOf(msg)?.context;
  if (!isObject(ctx) || !Array.isArray(ctx.items)) return [];
  const out = [];
  for (const raw of ctx.items.slice(0, MAX_CONTEXT_ITEMS)) {
    if (!isObject(raw)) continue;
    if (typeof raw.type !== 'string' || !NAME_RE.test(raw.type)) continue;
    if (!AUDIENCES.has(raw.audience)) continue;
    const item = { type: raw.type, source: readSource(raw.source), audience: raw.audience, attrs: readAttrs(raw.attrs) };
    const data = readData(raw.data, raw.type);
    if (data !== undefined) item.data = data;
    out.push(item);
  }
  return out;
}

/** The items addressed to the Agent (audience=agent); [] when there are none. */
export function agentContextItemsFrom(msg) {
  return contextItemsFrom(msg).filter((it) => it.audience === 'agent');
}

/** The first agent item of `type`, or undefined (no trust policy applied). */
export function agentContextItem(msg, type) {
  return agentContextItemsFrom(msg).find((it) => it.type === type);
}

// The only attributes a workflow item may carry (the plan's registry): anything
// else (e.g. note="approved by admin") is not the workflows service's to say.
const WORKFLOW_ATTRS = ['workflow-id', 'run-id', 'page', 'step-n'];

const isAppSource = (src) => typeof src === 'string' && /^app:./.test(src);

/**
 * Whether an agent item may be used at all, given the trust switch.
 *
 * - `forwarded` and `subconversation` can only be written by the platform; with
 *   the switch on they count only with the source the platform stamps
 *   (`platform`; `platform` or `app:<id>` for a sub-conversation).
 *   With the switch off a client can still have written them (the server does
 *   not reserve the key yet):
 *   - `forwarded` is still used, unverified, but only when the message has no
 *     `forwarded_from` (forwardedFromOf decides). After cws-comm !618 a
 *     forwarded copy carries only the item, and dropping it would show the
 *     original author's words as the forwarder's own.
 *   - `subconversation` is dropped: it has no old key and nothing is
 *     misattributed without it, while a forged key would name a workflow
 *     topic the message is not in and pick the thread root it inherits from.
 * - `workflow` with the switch on counts only from an app (`app:<id>`, the
 *   workflows gateway); with it off it is an unverified hint (and an old
 *   `wf_ref` on the same message is preferred, see contextHeaderItems).
 * - Everything else (connectors, quote, unregistered) is a hint either way.
 */
export function acceptsItem(item, trusted) {
  switch (item?.type) {
    case 'forwarded': return !trusted || item.source === 'platform';
    case 'subconversation': return !!trusted && (item.source === 'platform' || isAppSource(item.source));
    case 'workflow': return !trusted || isAppSource(item.source);
    default: return !!item;
  }
}

function normalizeItem(item) {
  if (item.type !== 'workflow') return item;
  const attrs = {};
  for (const k of WORKFLOW_ATTRS) if (k in item.attrs) attrs[k] = item.attrs[k];
  return { ...item, attrs };
}

/**
 * The agent items the trust policy (acceptsItem) lets through, workflow attrs
 * reduced to the registered ones. Readers of a single type use this.
 */
export function usableContextItems(msg, { trusted = false } = {}) {
  return agentContextItemsFrom(msg).filter((it) => acceptsItem(it, trusted)).map(normalizeItem);
}

/** The first usable item of `type`, or undefined. */
export function usableContextItem(msg, type, opts) {
  return usableContextItems(msg, opts).find((it) => it.type === type);
}

/**
 * `{ source, verified }` for rendering an item: verified only when the
 * operator trusts stamped sources and the item has one.
 */
export function provenanceOf(item, trusted) {
  const source = item?.source || UNKNOWN_SOURCE;
  return { source, verified: !!(trusted && item?.source) };
}

/** ` source="…" source-verified="…"` for an element built from an item. */
export function provenanceAttrs(prov) {
  if (!prov || !prov.source) return '';
  return ` source="${escapeAttr(prov.source)}" source-verified="${prov.verified ? 'true' : 'false'}"`;
}

function toRenderItem(item, prov) {
  return { type: item.type, source: prov.source, verified: prov.verified, attrs: item.attrs, data: item.data };
}

/**
 * A message's generic items (workflow, subconversation, unregistered), one per
 * registered type, after the trust policy. With the switch off an old wf_ref
 * on the same message wins over a workflow item: today the gateway writes
 * wf_ref, while anyone can write the item.
 */
function genericItemsOf(msg, trusted) {
  const legacyWf = !trusted && wfRefFrom(msg);
  const out = [];
  for (const it of usableContextItems(msg, { trusted })) {
    if (OWN_ELEMENT_TYPES.has(it.type)) continue;
    if (it.type === 'workflow' && legacyWf) continue;
    if (CONTEXT_TYPES[it.type] && out.some((x) => x.type === it.type)) continue;
    out.push(it);
  }
  return out;
}

/**
 * The generic <context> items of a message, ready for formatContextElements:
 * the current message's own usable agent items whose type has no element of
 * its own (workflow, subconversation, unregistered), then the inheritable
 * items of `parent` (the replied-to message, or in a thread the thread root)
 * whose type the current message does not carry, with `parent:` in front of
 * their source.
 *
 * `hasWorkflow` says a workflow item of the current message is rendered: the
 * bridge then drops the old <wf-context> (the item replaces it).
 *
 * @returns {{ items: Array<{type, source, verified, attrs, data?}>, hasWorkflow: boolean }}
 */
export function contextHeaderItems(msg, { trusted = false, parent } = {}) {
  const items = [];
  const ownTypes = new Set();
  for (const it of genericItemsOf(msg, trusted)) {
    ownTypes.add(it.type);
    items.push(toRenderItem(it, provenanceOf(it, trusted)));
  }
  const hasWorkflow = ownTypes.has('workflow');
  // The old key still names the current message's workflow (stored messages,
  // or a writer that has not moved yet), so the parent's does not apply.
  if (!hasWorkflow && wfRefFrom(msg)) ownTypes.add('workflow');

  if (parent) {
    const inherited = new Set();
    for (const it of genericItemsOf(parent, trusted)) {
      if (!CONTEXT_TYPES[it.type]?.inherit || ownTypes.has(it.type) || inherited.has(it.type)) continue;
      inherited.add(it.type);
      const prov = provenanceOf(it, trusted);
      items.push(toRenderItem(it, { source: `${PARENT_SOURCE_PREFIX}${prov.source}`, verified: prov.verified }));
    }
    if (!ownTypes.has('workflow') && !inherited.has('workflow')) {
      const legacy = wfRefFrom(parent);
      if (legacy) {
        items.push({ type: 'workflow', source: `${PARENT_SOURCE_PREFIX}${LEGACY_SOURCE}`, verified: false, attrs: legacy });
      }
    }
  }
  return { items, hasWorkflow };
}

function dataBody(data) {
  let json;
  try { json = JSON.stringify(data); } catch { return null; }
  if (typeof json !== 'string') return null;
  // JSON.stringify leaves U+2028 / U+2029 raw; they would break the one-line body.
  return escapeText(json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'));
}

/** One generic <context …/> element, or '' when the item is not renderable. */
export function formatContextElement(item) {
  if (!item || typeof item.type !== 'string' || !NAME_RE.test(item.type)) return '';
  const parts = [
    `type="${item.type}"`,
    `source="${escapeAttr(flatValue(item.source) || UNKNOWN_SOURCE)}"`,
    `source-verified="${item.verified ? 'true' : 'false'}"`,
  ];
  for (const [k, v] of Object.entries(item.attrs || {})) {
    if (!NAME_RE.test(k) || RESERVED_ATTRS.has(k)) continue;
    const flat = flatValue(v);
    if (flat) parts.push(`${k}="${escapeAttr(flat)}"`);
  }
  if (item.type === 'subconversation') {
    const title = flatValue(item.data?.title, MAX_SUBCONVERSATION_TITLE_CODE_POINTS);
    if (title) parts.push(`title="${escapeAttr(title)}"`);
    return `<context ${parts.join(' ')}/>`;
  }
  if (!CONTEXT_TYPES[item.type] && item.data !== undefined) {
    const body = dataBody(item.data);
    if (body !== null && byteLength(body) <= MAX_RENDERED_DATA_BYTES) {
      return `<context ${parts.join(' ')}>${body}</context>`;
    }
    parts.push('data-omitted="true"');
  }
  return `<context ${parts.join(' ')}/>`;
}

/**
 * The generic <context> elements, one per line, within MAX_CONTEXT_BLOCK_BYTES
 * (an element that does not fit is left out). '' when there is nothing.
 */
export function formatContextElements(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const lines = [];
  let used = 0;
  for (const it of items) {
    const line = formatContextElement(it);
    if (!line) continue;
    const n = byteLength(line) + 1;
    if (used + n > MAX_CONTEXT_BLOCK_BYTES) continue;
    lines.push(line);
    used += n;
  }
  return lines.join('\n');
}

/**
 * A small cache of fetched thread roots. A message's metadata does not change
 * after it is sent (only a quote item is rewritten when its original is
 * recalled, and quotes are not inherited), so a cached root stays correct for
 * inheritance; the TTL only bounds memory for long-lived threads. A root that
 * could not be fetched is cached as `null` for `negativeTtlMs`, so a missing
 * root costs one round of fetches per window, not one per message.
 * `get` returns undefined on a miss, the value (or null) on a hit.
 */
export function createThreadRootCache({
  ttlMs = 5 * 60 * 1000, negativeTtlMs = 60 * 1000, max = 200, now = () => Date.now(),
} = {}) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > (hit.value === null ? negativeTtlMs : ttlMs)) { map.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { value, at: now() });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}
