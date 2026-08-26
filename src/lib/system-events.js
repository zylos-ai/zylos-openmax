/**
 * System-event log hygiene (task #44 / PR #135).
 *
 * cws-comm delivers every non-create message lifecycle event as a `system`
 * frame. A handful of these are pure no-ops for the agent (reactions, read /
 * delivered receipts, @-mention notices) and arrive at high frequency — logging
 * them on every frame floods out.log with lines the agent never acts on.
 *
 * These helpers centralize the "is this a benign no-op?" decision and the two
 * comm-bridge log sites that were the noise source, so both the suppression and
 * its exact log strings stay unit-testable without importing the comm-bridge
 * daemon (which self-executes on import).
 */

// Known benign no-op system events. Matched case-insensitively. These are
// suppressed from stdout; every OTHER system event still logs so genuine
// contract drift (a new/unexpected event kind) stays visible.
export const BENIGN_NOOP_SYSTEM_EVENTS = new Set([
  'message.reaction.added',
  'message.reaction.removed',
  'message.read',
  'message.delivered',
  'message.mention.created',
  'message.created',
]);

export function isBenignNoopSystemEvent(name) {
  return BENIGN_NOOP_SYSTEM_EVENTS.has(String(name || '').toLowerCase());
}

/**
 * Pre-classification trace for an inbound `system` frame. Skips (logs nothing)
 * for benign no-op events; logs the original trace line otherwise. Returns true
 * when a line was emitted.
 */
export function traceSystemFrame(log, slug, frame) {
  const ev = frame?.payload?.event;
  if (isBenignNoopSystemEvent(ev)) return false;
  log(`[${slug}] system event=${ev || '<unknown>'} conv=${frame?.payload?.conversation_id || '<unknown>'}`);
  return true;
}

/**
 * Log for a system event that classifySystemEvent couldn't map to an action.
 * Suppressed for benign no-ops; logged for every other unknown event so
 * contract drift is still discoverable. Returns true when a line was emitted.
 */
export function logUnhandledSystemEvent(log, slug, payload) {
  if (isBenignNoopSystemEvent(payload?.event)) return false;
  log(`[${slug}] unhandled system event: ${payload?.event || '(unknown)'} conv=${payload?.conversation_id || '?'}`);
  return true;
}
