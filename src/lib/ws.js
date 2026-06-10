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

import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { cfAccessHeaders } from './cf-access.js';

const RECONNECT_BASE_MS = 1000;
const FRAME_GRACE_MS = 5000;
const TERMINAL_CLOSE_CODES = new Set([4002, 4005, 4006]);
const RATE_LIMITED_CLOSE_CODES = new Set([4004]);

export class WsClient {
  constructor({
    url,
    urlProvider,            // optional async () => string; if present, called
                            // before each connect to mint a fresh URL (e.g.
                            // to fetch a one-shot ticket and append it).
                            // If it throws, the connect is retried via the
                            // normal backoff loop.
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
    this.urlProvider = urlProvider || null;
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
    this._connect().catch(err => console.error('[ws] connect threw:', err.message));
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

  async _connect() {
    let url = this.url;
    if (this.urlProvider) {
      try {
        url = await this.urlProvider();
      } catch (err) {
        console.error('[ws] urlProvider failed:', err.message);
        // Respect Retry-After hints from cws-core when fetching ws-ticket
        const retryHint = Number(err.retryAfterMs) || 0;
        if (!this.stopped) this._scheduleReconnect(false, retryHint);
        return;
      }
    }
    if (!url) {
      console.error('[ws] no URL to connect to');
      if (!this.stopped) this._scheduleReconnect(false);
      return;
    }

    const headers = { ...cfAccessHeaders() };
    if (this.token)         headers.Authorization      = `Bearer ${this.token}`;
    if (this.workspaceId)   headers['X-Workspace-Id']  = this.workspaceId;
    if (this.deviceId)      headers['X-Device-Id']     = this.deviceId;
    if (this.clientVersion) headers['X-Client-Version'] = this.clientVersion;

    this.ws = new WebSocket(url, { headers });
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

    // WS protocol-level control frames. The npm `ws` lib auto-replies to
    // server Pings with Pongs (no action needed here), but it does NOT fire
    // the 'message' event for control frames — so without these listeners
    // `lastFrameAt` would stay at the open timestamp even while heartbeats
    // are flowing, and the frame watchdog would kill a perfectly healthy
    // connection. cws-comm uses WS-level Ping/Pong (see
    // cws-comm internal/transport/ws/conn.go RunPingLoop), so this matters.
    this.ws.on('ping', () => {
      this.lastFrameAt = Date.now();
      // One-line debug trace so we can verify server-side ping cadence in
      // pm2 logs. Cheap (default cws-comm PingInterval is 30s).
      console.log('[ws] ping received');
    });
    this.ws.on('pong', () => {
      this.lastFrameAt = Date.now();
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
 *
 * `opts.persistPath` (optional): back the seen-id window with a JSON file so it
 * survives a process restart. On init, entries within the TTL window are
 * reloaded; on each add (and on TTL sweep) the file is rewritten via a
 * debounced atomic write. Best-effort — any fs error is swallowed and the
 * deduper degrades to in-memory only.
 */
export function createDeduper(ttlMs = 300000, opts = {}) {
  const { persistPath = null } = opts;
  const seen = new Map();

  if (persistPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
      const now = Date.now();
      for (const [k, t] of Object.entries(raw)) {
        if (typeof t === 'number' && now - t <= ttlMs) seen.set(k, t);
      }
    } catch { /* missing/corrupt → start empty */ }
  }

  let dirty = false;
  let flushTimer = null;
  function flush() {
    flushTimer = null;
    if (!persistPath || !dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      const tmp = `${persistPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(seen)));
      fs.renameSync(tmp, persistPath);
    } catch { /* best-effort */ }
  }
  function scheduleFlush() {
    if (!persistPath || flushTimer) return;
    flushTimer = setTimeout(flush, 1000);
    flushTimer.unref?.();
  }

  const sweepMs = Math.max(60000, Math.floor(ttlMs / 5));
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, t] of seen) {
      if (now - t > ttlMs) { seen.delete(k); dirty = true; }
    }
    if (dirty) scheduleFlush();
  }, sweepMs);
  sweeper.unref?.();
  return (id) => {
    if (!id) return false;
    if (seen.has(id)) return true;
    seen.set(id, Date.now());
    dirty = true; scheduleFlush();
    return false;
  };
}
