/**
 * WebSocket client for cws-comm.
 *
 * Per DESIGN.md §3.6:
 *   - Auth:        Bearer token in connect headers
 *   - Heartbeat:   ws ping/pong every heartbeat_interval (default 30s)
 *   - Reconnect:   exponential backoff 1s → 2s → 4s → ... → reconnect_max_delay (default 30s)
 *   - Dedup:       caller-provided (see createDeduper below)
 *   - Sync:        caller invokes sendSyncRequest(lastSeq) on reconnect if desired
 *
 * The cws-comm protocol frame format is not yet finalised (DESIGN.md §8
 * "待细化"). This implementation assumes JSON frames with `{event, data}`
 * shape; switch to the canonical wire format once cws-comm publishes the
 * protocol spec.
 */

import WebSocket from 'ws';

const RECONNECT_BASE_MS = 1000;
const PONG_GRACE_MS = 10000;

export class WsClient {
  constructor({
    url,
    token,
    reconnectMaxMs = 30000,
    heartbeatIntervalMs = 30000,
    onOpen,
    onMessage,
    onClose,
  }) {
    this.url = url;
    this.token = token;
    this.reconnectMaxMs = reconnectMaxMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.onOpen = onOpen || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onClose = onClose || (() => {});

    this.ws = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.lastPong = 0;
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

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not open');
    }
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  isOpen() {
    return this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  _connect() {
    const headers = this.token ? { Authorization: `Bearer ${this.token}` } : {};
    this.ws = new WebSocket(this.url, { headers });
    this.lastPong = Date.now();

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this._startHeartbeat();
      this.onOpen(this);
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.onMessage(msg);
    });

    this.ws.on('pong', () => { this.lastPong = Date.now(); });

    this.ws.on('close', (code, reason) => {
      this._clearTimers();
      this.onClose(code, reason?.toString?.());
      if (!this.stopped) this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      // 'close' fires after error; just log
      console.error('[ws] error:', err.message);
    });
  }

  _scheduleReconnect() {
    const delay = Math.min(
      RECONNECT_BASE_MS * (2 ** this.reconnectAttempt),
      this.reconnectMaxMs,
    );
    this.reconnectAttempt += 1;
    console.log(`[ws] reconnecting in ${delay}ms (attempt #${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this._connect();
    }, delay);
  }

  _startHeartbeat() {
    this._clearTimers();
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPong > this.heartbeatIntervalMs + PONG_GRACE_MS) {
        console.warn('[ws] pong timeout, terminating to force reconnect');
        try { this.ws.terminate(); } catch {}
        return;
      }
      try { this.ws.ping(); } catch {}
    }, this.heartbeatIntervalMs);
  }

  _clearTimers() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

/**
 * Message deduplication based on messageId with TTL (DESIGN.md §3.6).
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
