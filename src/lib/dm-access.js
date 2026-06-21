// DM access rules that are pure (no I/O), so they can be unit-tested in
// isolation. The owner identities they compare are resolved authoritatively
// from cws-core by the caller (comm-bridge.shouldHandleMessage) — never trusted
// from a WS frame.

/**
 * Sibling-agent DM exemption: two agents that share the same owner may DM each
 * other by default, regardless of the target agent's dmPolicy (open / allowlist
 * / owner). This mirrors the owner-exempt branch — an owner's own agents form a
 * trusted circle, so they don't need to be added to each other's allowlist.
 *
 * Only AGENT senders qualify; humans always go through the normal dmPolicy
 * gates. Both owner ids must be known and equal — a missing owner (e.g. the
 * target agent has no bound owner yet, or the sender's owner couldn't be read
 * from cws-core) never grants access.
 *
 * @param {object} [p]
 * @param {string} [p.senderType]    frame sender_type ("HUMAN" | "AGENT" | "SYSTEM")
 * @param {string} [p.senderOwnerId] sender agent's owner_member_id (from cws-core)
 * @param {string} [p.selfOwnerId]   this agent's own owner_member_id
 * @returns {boolean}
 */
export function isSiblingAgentSender({ senderType, senderOwnerId, selfOwnerId } = {}) {
  if (String(senderType || '').toUpperCase() !== 'AGENT') return false;
  if (!selfOwnerId || !senderOwnerId) return false;
  return String(senderOwnerId) === String(selfOwnerId);
}
