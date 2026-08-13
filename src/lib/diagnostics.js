/**
 * Closed Agent diagnostics command interpreter.
 *
 * This is intentionally not a generic remote-control facility. Every action
 * has an explicit implementation and the send-probe action constructs its own
 * message body; the control frame cannot carry arbitrary text, HTTP paths,
 * headers, credentials, local paths, or commands.
 */

export const AGENT_DIAGNOSTICS_EVENT = 'agent.diagnostics.command';
export const AGENT_DIAGNOSTICS_CONFIG_EVENT = 'agent.config.diagnostics_changed';
export const DIAGNOSTICS_SEND_PROBE = 'diagnostics.message.send_probe';

const PROBE_TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SEEN_COMMANDS = 1000;

export function probeMessageText(probeToken) {
  return `[workspace-diagnostics:${probeToken}]`;
}

/** Apply the closed diagnostics configuration event and return the new live config. */
export function applyDiagnosticsConfig(data, { agentMemberId, update }) {
  if (!data || data.agent_member_id !== agentMemberId) {
    return { applied: false, reason: 'target_mismatch' };
  }
  if (typeof data.enabled !== 'boolean') {
    return { applied: false, reason: 'invalid_enabled' };
  }
  const config = update((cfg) => {
    cfg.diagnostics = cfg.diagnostics || {};
    cfg.diagnostics.enabled = data.enabled;
  });
  return { applied: true, enabled: data.enabled, config };
}

export function createDiagnosticsHandler({
  isEnabled,
  postForOrg,
  apiPath,
  now = () => Date.now(),
  log = () => {},
  warn = () => {},
}) {
  const seen = new Map();

  function remember(commandId) {
    seen.set(commandId, true);
    while (seen.size > MAX_SEEN_COMMANDS) {
      seen.delete(seen.keys().next().value);
    }
  }

  return async function handleAgentDiagnostics(orgConfig, frame) {
    if (!isEnabled()) {
      warn(`[${orgConfig.slug}] agent diagnostics command rejected: diagnostics disabled`);
      return { accepted: false, reason: 'disabled' };
    }

    const data = frame?.payload?.data || {};
    const commandId = String(data.command_id || '');
    const action = String(data.action || '');
    const conversationId = String(data.conversation_id || '');
    const probeToken = String(data.probe_token || '');
    const expiresAt = Date.parse(String(data.expires_at || ''));

    if (!COMMAND_ID_RE.test(commandId)) return { accepted: false, reason: 'invalid_command_id' };
    if (action !== DIAGNOSTICS_SEND_PROBE) return { accepted: false, reason: 'unsupported_action' };
    if (!CONVERSATION_ID_RE.test(conversationId)) return { accepted: false, reason: 'invalid_conversation_id' };
    if (!PROBE_TOKEN_RE.test(probeToken)) return { accepted: false, reason: 'invalid_probe_token' };
    if (!Number.isFinite(expiresAt) || expiresAt <= now()) return { accepted: false, reason: 'expired' };
    if (seen.has(commandId)) return { accepted: true, duplicate: true };

    remember(commandId);
    try {
      await postForOrg(
        orgConfig.org_id,
        apiPath(`/conversations/${conversationId}/messages`),
        {
          client_msg_id: `diagnostics_${commandId}`,
          type: 'AGENT_TEXT',
          content: {
            content_type: 'text',
            body: { text: probeMessageText(probeToken) },
            attachments: [],
          },
        },
      );
      log(`[${orgConfig.slug}] diagnostics send_probe completed command=${commandId} conv=${conversationId}`);
      return { accepted: true };
    } catch (error) {
      // Forget on transport failure so a control-plane retry with the same
      // command id can complete. cws-comm still deduplicates client_msg_id if
      // the first request committed but its response was lost.
      seen.delete(commandId);
      throw error;
    }
  };
}
