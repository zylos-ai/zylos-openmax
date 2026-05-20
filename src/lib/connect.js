/**
 * WebSocket handshake helper (cws-comm api-design.md §3.1-§3.2).
 *
 * Sequence:
 *   1. WS connects with Authorization: Bearer <api_key|invite_token>
 *      and X-Workspace-Id header (handled by WsClient).
 *   2. Client sends the first text frame: a `connect` request with
 *      {token, client_id, platform, last_seq, app_version, device_id}.
 *   3. Server replies with a `connect_response` frame containing
 *      {session_token, server_time, max_seq, user_id, resume_result?}.
 *   4. Subsequent calls use session_token. ResumeResult tells the
 *      client whether the gap can be filled via missed_messages
 *      (small gap, embedded) or requires SYNC_BATCH flow (larger gap).
 *
 * This helper is a thin builder/parser around the wire shapes. The
 * actual frame I/O is driven by comm-bridge.js's message loop.
 */

export function buildConnectFrame({
  token,
  clientId,
  platform = 'server',
  lastSeq = 0,
  appVersion = '0.1.0',
  deviceId,
}) {
  if (!token)    throw new Error('buildConnectFrame: token is required');
  if (!deviceId) throw new Error('buildConnectFrame: deviceId is required');
  return {
    type: 'connect',
    payload: {
      token,
      client_id:   clientId || deviceId,
      platform,
      last_seq:    lastSeq,
      app_version: appVersion,
      device_id:   deviceId,
    },
  };
}

/**
 * Validate a connect_response frame and extract canonical fields.
 * Throws if the frame is missing required fields.
 */
export function parseConnectResponse(frame) {
  if (!frame || (frame.type !== 'connect_response' && frame.type !== 'connect-response')) {
    throw new Error(`expected connect_response frame, got type=${frame?.type}`);
  }
  const p = frame.payload || {};
  if (!p.session_token) throw new Error('connect_response: missing session_token');
  return {
    sessionToken: p.session_token,
    serverTime:   Number(p.server_time) || Date.now(),
    maxSeq:       Number(p.max_seq) || 0,
    userId:       p.user_id || '',
    resume:       p.resume_result || null,
  };
}

/**
 * Compute clock offset (server - local). Apply to outbound timestamps to
 * compensate for local clock drift (api-design.md §3.1).
 */
export function computeClockOffset(serverTime, localTimeAtRecv) {
  return (Number(serverTime) || 0) - (Number(localTimeAtRecv) || Date.now());
}

/**
 * Build a SYNC_ACK frame to acknowledge a SYNC_BATCH (api-design.md §3.3).
 */
export function buildSyncAck(lastReceivedSeq) {
  return {
    type: 'sync_ack',
    payload: { last_received_seq: Number(lastReceivedSeq) || 0 },
  };
}
