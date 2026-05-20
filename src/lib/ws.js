/**
 * WebSocket client for cws-comm.
 *
 * Aligned with cws-comm api-design.md §3-§4:
 *   - Auth:       Bearer token in connect headers, plus X-Workspace-Id
 *   - Heartbeat:  JSON ping/pong text frames (NOT WS-level ping/pong);
 *                 server initiates ping, client replies pong within
 *                 cws-comm-configured pongTimeout (default 10s).
 *                 If we receive no frame at all for >
 *                 heartbeatIntervalMs * (maxMissedPongs+1) + grace
 *                 we proactively terminate to force a reconnect.
 *   - Reconnect:  exponential backoff 1s → 2s → 4s → ... capped at
 *                 reconnect_max_delay (default 30s).
 *   - Close codes (§4.5):
 *       1000 / 1001  — normal close, reconnect
 *       4001         — heartbeat timeout, reconnect
 *       4002         — auth failed, STOP (caller alerts)
 *       4003         — session expired, caller should clear session
 *                      then reconnect with api_key
 *       4004         — rate limited, reconnect with longer delay
 *       4005         — workspace suspended, STOP
 *       4006         — duplicate connection, STOP
 *
 * Callbacks (all optional):
 *   onOpen(client)
 *   onMessage(frame)                — frame is parsed JSON, includes ping/pong
 *   onClose(code, reason, willReconnect)
 *   onFatal(code, reason)           — invoked instead of onClose when a
 *                                     terminal close code (4002/4005/4006) hits
 *
 * The client auto-replies to `{type:'ping'}` frames with `{type:'pong'}` —
 * the message handler receives the ping but does NOT need to reply.
 */

import WebSocket from 'ws';

const RECONNECT_BASE_MS = 1000;
const FRAME_GRACE_MS = 5000;
const TERMINAL_CLOSE_CODES = new Set([4002, 4005, 4006]);
const RATE_LIMITED_CLOSE_CODES = new Set([4004]);

export class WsClient {
  constructor({
    url,
    token,
    workspaceId,
    deviceId,
    clientVersion,
    reconnectMaxMs = 30000,
    heartbeatIntervalMs = 30000,
    onOpen,
    onMessage,
    onClose,
    onFatal,
  }) {
    this.url = url;
    this.token = token;
    this.workspaceId   = workspaceId   || '';
    this.deviceId      = deviceId      || '';
    this.clientVersion = clientVersion || '';
    this.reconnectMaxMs = reconnectMaxMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.onOpen    = onOpen    || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onClose   = onClose   || (() => {});
    this.onFatal   = onFatal   || (() => {});

    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.frameWatchdog = null;
    this.reconnectTimer = null;
    this.lastFrameAt = 0;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(1000, 'client stop'); } catch {}
      this.ws = null;
    }
  }

  /**
   * Update the auth token for the next connection (e.g. after handshake
   * yields a session_token, or after 4003 we fall back to api_key).
   */
  setToken(token) { this.token = token; }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN; }

  _connect() {
    const headers = {};
    if (this.token)         headers.Authorization      = `Bearer ${this.token}`;
    if (this.workspaceId)   headers['X-Workspace-Id']  = this.workspaceId;
    if (this.deviceId)      headers['X-Device-Id']     = this.deviceId;
    if (this.clientVersion) headers['X-Client-Version'] = this.clientVersion;

    this.ws = new WebSocket(this.url, { headers });
    this.lastFrameAt = Date.now();

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this._startFrameWatchdog();
      this.onOpen(this);
    });

    this.ws.on('message', (raw) => {
      this.lastFrameAt = Date.now();
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }

      // Auto-reply to JSON ping with JSON pong (cws-comm §4.3).
      if (frame.type === 'ping') {
        try { this.send({ type: 'pong', timestamp: Date.now() }); } catch {}
      }
      this.onMessage(frame);
    });

    this.ws.on('close', (code, reasonBuf) => {
      this._clearTimers();
      const reason = reasonBuf?.toString?.() || '';
      const terminal = TERMINAL_CLOSE_CODES.has(code);
      const rateLimited = RATE_LIMITED_CLOSE_CODES.has(code);

      if (terminal) {
        this.stopped = true;
        this.onFatal(code, reason);
        return;
      }
      const willReconnect = !this.stopped;
      this.onClose(code, reason, willReconnect);
      if (willReconnect) this._scheduleReconnect(rateLimited);
    });

    this.ws.on('error', (err) => {
      // 'close' fires after error; just log
      console.error('[ws] error:', err.message);
    });
  }

  _scheduleReconnect(rateLimited) {
    const base = rateLimited ? Math.max(RECONNECT_BASE_MS * 8, 5000) : RECONNECT_BASE_MS;
    const delay = Math.min(base * (2 ** this.reconnectAttempt), this.reconnectMaxMs);
    this.reconnectAttempt += 1;
    console.log(`[ws] reconnecting in ${delay}ms (attempt #${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this._connect();
    }, delay);
  }

  /**
   * If we receive no frames at all for more than the watchdog window,
   * the connection is dead — terminate to trigger reconnect. The window
   * is sized to allow for one missed ping (server pings every interval,
   * client must pong; if server stops pinging it's down).
   */
  _startFrameWatchdog() {
    this._clearTimers();
    const watchdogMs = (this.heartbeatIntervalMs * 2) + FRAME_GRACE_MS;
    this.frameWatchdog = setInterval(() => {
      if (Date.now() - this.lastFrameAt > watchdogMs) {
        console.warn('[ws] no frames received within watchdog window, terminating');
        try { this.ws.terminate(); } catch {}
      }
    }, this.heartbeatIntervalMs);
  }

  _clearTimers() {
    if (this.frameWatchdog) { clearInterval(this.frameWatchdog); this.frameWatchdog = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

/**
 * Message deduplication based on messageId with TTL.
 *
 * Returns a function that takes a message id and returns true if it was
 * already seen within the TTL window, false otherwise (and records it).
 */
export function createDeduper(ttlMs = 300000) {
  const seen = new Map();
  const sweepMs = Math.max(60000, Math.floor(ttlMs / 5));
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, t] of seen) {
      if (now - t > ttlMs) seen.delete(k);
    }
  }, sweepMs);
  sweeper.unref?.();
  return (id) => {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.set(id, Date.now());
    return false;
  };
}
