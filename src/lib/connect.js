/**
 * WebSocket connection helpers — cws-comm api-usage-guide §1 + §6.
 *
 * Sequence:
 *   1. WS upgrade against cws-comm with HTTP headers:
 *        Authorization: Bearer <api_key>
 *        X-Workspace-Id: <workspace_id>
 *        X-Device-Id:    <device_id>          (optional but recommended)
 *        X-Client-Version: <app_version>      (optional)
 *      Header injection is handled by `WsClient` in ./ws.js.
 *   2. After WS open, client sends a `connect` text frame conveying
 *      app-layer identity + seq cursor:
 *        {type:"connect", payload:{
 *          token: api_key, client_id, platform, last_seq,
 *          app_version, device_id
 *        }}                                                [buildConnectFrame]
 *   3. Server replies with a `connect_response` frame:
 *        {type:"connect_response", payload:{
 *          session_token, server_time, max_seq, user_id, resume_result?
 *        }}                                                [parseConnectResponse]
 *      The session_token is persisted for diagnostics. We keep using
 *      api_key as the WS-upgrade credential on reconnects (long-lived
 *      and key-based, per §6 agent flow); session_token is not required
 *      for our REST path either (REST uses api_key throughout).
 *   4. resume_result tells the client whether the gap can be filled
 *      inline via missed_messages, or via the SYNC_BATCH flow.
 *
 * Earlier scaffold went via cws-core /auth/ws-ticket; that path is no
 * longer used (the ticket helpers were removed). If you need to talk
 * to a deployment that requires tickets, restore them from VCS history.
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
