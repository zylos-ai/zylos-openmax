/**
 * Workflow context (wf_ref).
 *
 * A message sent from the right-hand panel of the OpenMax workflows page
 * carries message metadata written by the server
 *
 *   wf_ref: { workflow_id: string|null, run_id: string|null, page: string }
 *
 * telling the Agent which workflow, which run, and which page the user is on
 * (`run_id` is null when there is no run; on the create page `workflow_id` is
 * null too). The key is absent on every other message.
 *
 * The bridge renders it as a structural self-closing <wf-context .../> element
 * in the inbound header (next to <message-context> / <connector-preference>),
 * not inside the user's text, so typed text cannot forge it. Values are passed
 * through as-is — no allow-list of pages or id formats (the design may still
 * change); only escaping is applied, which is safety, not validation. It is a
 * hint only: the workflows service's own records remain the source of truth.
 */

// Attribute name ← metadata key. Only these keys are read; anything else in
// wf_ref is ignored.
const WF_REF_ATTRS = [
  ['workflow-id', 'workflow_id'],
  ['run-id', 'run_id'],
  ['page', 'page'],
];

// Sanity bound on a malformed/abusive payload, far above any real id or page
// name. An over-long value is dropped rather than cut: a truncated id would
// point at the wrong thing.
export const MAX_WF_REF_VALUE_LENGTH = 200;

function attrText(raw) {
  // Scalars only: an object / array value is not something to render.
  if (raw === null || raw === undefined) return '';
  if (!['string', 'number', 'boolean', 'bigint'].includes(typeof raw)) return '';
  // Control characters and Unicode line/paragraph separators would break the
  // one-line element; collapse them (and runs of spaces) to one space.
  // eslint-disable-next-line no-control-regex
  const flat = String(raw).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat || [...flat].length > MAX_WF_REF_VALUE_LENGTH) return '';
  return flat;
}

/**
 * Read `wf_ref` from a fetched message (top-level `metadata`, or the nested
 * `message.metadata` envelope — same lookup as preferred_connectors). Returns
 * `{ 'workflow-id'?, 'run-id'?, page? }` (attribute name → value) with only
 * the usable values, or null when wf_ref is missing, not an object, or has no
 * usable value.
 */
export function wfRefFrom(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const meta = [msg.metadata, msg.message?.metadata]
    .find((m) => m && typeof m === 'object' && !Array.isArray(m) && 'wf_ref' in m);
  const raw = meta?.wf_ref;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const out = {};
  for (const [attr, key] of WF_REF_ATTRS) {
    const v = attrText(raw[key]);
    if (v) out[attr] = v;
  }
  return Object.keys(out).length ? out : null;
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Render the <wf-context .../> element. Returns '' when there is nothing to
 * render.
 */
export function formatWfContext(ref) {
  if (!ref || typeof ref !== 'object') return '';
  const attrs = WF_REF_ATTRS
    .filter(([attr]) => typeof ref[attr] === 'string' && ref[attr])
    .map(([attr]) => `${attr}="${escapeAttr(ref[attr])}"`);
  return attrs.length ? `<wf-context ${attrs.join(' ')}/>` : '';
}
