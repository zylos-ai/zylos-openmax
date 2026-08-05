import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { WsClient, createDeduper } from './ws.js';

// Minimal fake of the `ws` WebSocket the client drives. Extends EventEmitter so
// the client's `.on(...)` handlers wire up exactly as with the real lib. We
// count ping() calls and terminate() calls; ping() optionally simulates the
// pong that an RFC-compliant server / nearest terminating proxy sends back.
class FakeWebSocket extends EventEmitter {
  constructor({ autoPong = false } = {}) {
    super();
    this.readyState = WebSocket.OPEN; // 1 — matches the client's readyState check
    this.pingCount = 0;
    this.terminateCount = 0;
    this.closed = false;
    this._autoPong = autoPong;
  }
  ping() {
    this.pingCount += 1;
    // Model the server (or nearest hop) auto-replying with a WS pong, which is
    // what feeds the client's frame-watchdog via its on('pong') handler.
    if (this._autoPong) this.emit('pong');
  }
  terminate() { this.terminateCount += 1; }
  send() {}
  close() { this.closed = true; }
}

// Build a client wired to fabricate fake sockets. Returns the client plus the
// list of sockets it created (newest last) so tests can drive events.
function makeClient(opts = {}) {
  const { autoPong = false, ...clientOpts } = opts;
  const sockets = [];
  const client = new WsClient({
    url: 'wss://example.test/ws',
    ...clientOpts,
    wsFactory: () => {
      const ws = new FakeWebSocket({ autoPong });
      sockets.push(ws);
      return ws;
    },
  });
  return { client, sockets };
}

test('pingIntervalMs defaults to 20000 and is configurable', () => {
  const a = new WsClient({ url: 'wss://x/ws' });
  assert.equal(a.pingIntervalMs, 20000);

  const b = new WsClient({ url: 'wss://x/ws', pingIntervalMs: 5000 });
  assert.equal(b.pingIntervalMs, 5000);
});

test('on open, a keepalive ping is sent every pingIntervalMs', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    // Large heartbeat so the frame-watchdog cannot interfere; isolate cadence.
    const { client, sockets } = makeClient({
      pingIntervalMs: 20000,
      heartbeatIntervalMs: 10_000_000,
    });
    client.start();
    const ws = sockets[0];
    ws.emit('open');

    assert.equal(ws.pingCount, 0, 'no ping before the first interval elapses');
    mock.timers.tick(20000);
    assert.equal(ws.pingCount, 1);
    mock.timers.tick(20000);
    assert.equal(ws.pingCount, 2);
    mock.timers.tick(60000); // three more intervals
    assert.equal(ws.pingCount, 5);

    client.stop();
  } finally {
    mock.timers.reset();
  }
});

test('keepalive ping is not double-armed if open fires twice', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const { client, sockets } = makeClient({
      pingIntervalMs: 20000,
      heartbeatIntervalMs: 10_000_000,
    });
    client.start();
    const ws = sockets[0];
    ws.emit('open');
    ws.emit('open'); // must not arm a second interval

    mock.timers.tick(20000);
    assert.equal(ws.pingCount, 1, 'exactly one ping per interval, not two');

    client.stop();
  } finally {
    mock.timers.reset();
  }
});

test('watchdog does NOT terminate while our pings are ponged, with zero server pings/data', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    // Defaults: watchdog window = 30000*2 + 5000 = 65000ms; ping every 20000ms.
    const { client, sockets } = makeClient({
      pingIntervalMs: 20000,
      heartbeatIntervalMs: 30000,
      autoPong: true, // each client ping elicits a pong (nearest hop)
    });
    client.start();
    const ws = sockets[0];
    ws.emit('open');

    // Run well past several watchdog windows with NO inbound server ping and NO
    // data frames — only the pongs elicited by our own pings.
    mock.timers.tick(300000);

    assert.ok(ws.pingCount >= 14, `expected ~15 pings, got ${ws.pingCount}`);
    assert.equal(ws.terminateCount, 0, 'connection must stay alive on client pings alone');

    client.stop();
  } finally {
    mock.timers.reset();
  }
});

test('watchdog DOES terminate when nothing feeds it (no pongs) — sanity check', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    // autoPong false: pings go out but nothing comes back, watchdog starves.
    const { client, sockets } = makeClient({
      pingIntervalMs: 20000,
      heartbeatIntervalMs: 30000,
      autoPong: false,
    });
    client.start();
    const ws = sockets[0];
    ws.emit('open');

    mock.timers.tick(70000); // > 65000 watchdog window
    assert.ok(ws.terminateCount >= 1, 'watchdog should terminate a starved connection');

    client.stop();
  } finally {
    mock.timers.reset();
  }
});

test('receiving a pong advances lastFrameAt', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const { client, sockets } = makeClient({
      pingIntervalMs: 20000,
      heartbeatIntervalMs: 30000,
    });
    client.start();
    const ws = sockets[0];
    ws.emit('open');

    mock.timers.tick(40000);
    const before = client.lastFrameAt;
    ws.emit('pong');
    const after = client.lastFrameAt;
    assert.ok(after >= before, 'pong should not regress lastFrameAt');
    assert.equal(after, Date.now(), 'pong stamps lastFrameAt to now');

    client.stop();
  } finally {
    mock.timers.reset();
  }
});

test('on close, the ping timer is cleared (no pings after close, no leak)', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const { client, sockets } = makeClient({
      pingIntervalMs: 20000,
      heartbeatIntervalMs: 10_000_000,
    });
    client.start();
    const ws = sockets[0];
    ws.emit('open');

    mock.timers.tick(20000);
    assert.equal(ws.pingCount, 1);

    // Non-terminal close → client clears timers (and schedules a reconnect).
    ws.emit('close', 1000, Buffer.from('bye'));
    assert.equal(client.pingTimer, null, 'ping timer nulled on close');

    // Advance time; the CLOSED socket must not receive any further pings.
    mock.timers.tick(100000);
    assert.equal(ws.pingCount, 1, 'no pings issued on a closed socket');

    client.stop();
  } finally {
    mock.timers.reset();
  }
});

test('stop() clears the ping timer', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const { client, sockets } = makeClient({
      pingIntervalMs: 20000,
      heartbeatIntervalMs: 10_000_000,
    });
    client.start();
    const ws = sockets[0];
    ws.emit('open');
    mock.timers.tick(20000);
    assert.equal(ws.pingCount, 1);

    client.stop();
    assert.equal(client.pingTimer, null, 'ping timer nulled on stop');
    mock.timers.tick(100000);
    assert.equal(ws.pingCount, 1, 'no pings after stop');
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// forceReconnect — used to recover from an inbound message whose content could
// not be fetched. Reuses the frame-watchdog's terminate() so the close handler
// runs and the reconnect + /sync catch-up path fires.
// ---------------------------------------------------------------------------

test('forceReconnect terminates the live socket (same mechanism as the watchdog)', () => {
  const { client, sockets } = makeClient({ heartbeatIntervalMs: 10_000_000 });
  client.start();
  const ws = sockets[0];
  ws.emit('open');
  const did = client.forceReconnect('empty-message-content-fetch-failed');
  assert.equal(did, true);
  assert.equal(ws.terminateCount, 1, 'underlying socket terminated to trigger reconnect');
  client.stop(); // clear the real interval timers armed on open
});

test('forceReconnect is a no-op after stop() (avoids reconnect storms)', () => {
  const { client, sockets } = makeClient({ heartbeatIntervalMs: 10_000_000 });
  client.start();
  const ws = sockets[0];
  ws.emit('open');
  client.stop();
  const did = client.forceReconnect('x');
  assert.equal(did, false, 'stopped client must not reconnect');
});

test('forceReconnect is a no-op when there is no live socket', () => {
  const client = new WsClient({ url: 'wss://x/ws' });
  assert.equal(client.forceReconnect('x'), false);
});

// ---------------------------------------------------------------------------
// createDeduper.forget — lets a message that was recorded but not fully
// processed (content fetch failed) be re-processed on the next /sync re-pull.
// ---------------------------------------------------------------------------

test('deduper.forget lets a recorded id be re-processed', () => {
  const dedupe = createDeduper();
  assert.equal(dedupe('m1'), false, 'first sighting is not a duplicate');
  assert.equal(dedupe('m1'), true, 'second sighting is a duplicate');
  assert.equal(dedupe.forget('m1'), true, 'forget drops the recorded id');
  assert.equal(dedupe('m1'), false, 're-pull is no longer suppressed as a duplicate');
});

test('deduper.forget on an unknown id is a harmless no-op', () => {
  const dedupe = createDeduper();
  assert.equal(dedupe.forget('never-seen'), false);
});

// Persisted (cross-process) dedupe taint — the #79 P1 scenario: a comm-bridge
// started during the runtime prepare phase records a message id to dedup.json
// but never delivers it (no agent session). A later "real boot" process loads
// that file and would skip the message as a duplicate; the first-boot replay
// path forgets the id first so the backlog re-dispatches.
test('deduper: forget clears a taint loaded from a persisted dedup.json (cross-process)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-dedup-'));
  const persistPath = path.join(dir, 'dedup.json');
  // A previous (prepare-phase) process persisted the activation DM's id.
  fs.writeFileSync(persistPath, JSON.stringify({ 'msg-activation': Date.now() }));

  const dedupe = createDeduper({ persistPath });
  assert.equal(dedupe('msg-activation'), true, 'persisted id is treated as a duplicate on the new process');

  // First-boot replay forgets it before the duplicate check…
  assert.equal(dedupe.forget('msg-activation'), true);
  // …so it is now re-processable (dispatched to the agent).
  assert.equal(dedupe('msg-activation'), false, 'after forget the activation DM re-dispatches');
});

// ---------------------------------------------------------------------------
// Dial-stall handling. A dial that is accepted but never answered leaves the
// socket in CONNECTING: no 'open', no 'error', no 'close'. Before the deadline
// existed, that state was permanent — no timer remained, nothing was logged
// again, and the agent stayed offline until a human restarted the process.
// ---------------------------------------------------------------------------

// A socket that never resolves: stays CONNECTING and emits nothing at all.
class HangingWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.CONNECTING; // 0
    this.terminateCount = 0;
    this.pingCount = 0;
  }
  ping() { this.pingCount += 1; }
  terminate() { this.terminateCount += 1; }
  send() {}
  close() {}
}

function makeHangingClient(clientOpts = {}) {
  const sockets = [];
  const optsSeen = [];
  const client = new WsClient({
    url: 'wss://example.test/ws',
    ...clientOpts,
    wsFactory: (_u, opts) => {
      optsSeen.push(opts);
      const ws = new HangingWebSocket();
      sockets.push(ws);
      return ws;
    },
  });
  return { client, sockets, optsSeen };
}

test('a dial that never reaches open is terminated and retried', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { client, sockets } = makeHangingClient({ dialTimeoutMs: 25000 });
    client.start();
    assert.equal(sockets.length, 1);
    assert.equal(client.state, 'connecting');

    // Just before the deadline: still waiting, nothing killed.
    mock.timers.tick(24999);
    assert.equal(sockets[0].terminateCount, 0);

    // Deadline passes: the stuck socket is terminated and a retry is queued.
    mock.timers.tick(2);
    assert.equal(sockets[0].terminateCount, 1, 'stalled socket should be terminated');
    assert.ok(client.reconnectTimer, 'a reconnect must be scheduled after a stalled dial');

    // And the retry actually dials again rather than stopping there.
    mock.timers.tick(client.reconnectMaxMs);
    assert.equal(sockets.length, 2, 'the scheduled retry should dial a second time');
  } finally {
    mock.timers.reset();
  }
});

test('the dial deadline is not armed for a socket that is already open', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    // makeClient's fake reports OPEN synchronously — there is nothing to wait
    // for, so no deadline should be armed (and no spurious terminate later).
    const { client, sockets } = makeClient();
    client.start();
    assert.equal(client.dialTimer, null, 'no deadline should be armed when already OPEN');
    mock.timers.tick(120000);
    assert.equal(sockets[0].terminateCount, 0, 'an open socket must not be terminated by the dial deadline');
  } finally {
    mock.timers.reset();
  }
});

test('a stalled dial plus a late close schedule only one retry', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { client, sockets } = makeHangingClient({ dialTimeoutMs: 1000 });
    client.start();
    mock.timers.tick(1001);                 // deadline fires, schedules retry
    assert.ok(client.reconnectTimer, 'the deadline should have queued a retry');

    // The close arriving late (from terminate()) goes through _clearTimers()
    // first, so it replaces the pending retry rather than adding to it. What
    // must hold is the invariant — never two attempts in flight — so assert
    // that ticking forward produces exactly one further dial, not two.
    sockets[0].emit('close', 1006, Buffer.from(''));
    assert.ok(client.reconnectTimer, 'a retry must still be pending after the late close');

    mock.timers.tick(client.reconnectMaxMs * 2);
    assert.equal(sockets.length, 2, 'exactly one extra dial, not one per event');
  } finally {
    mock.timers.reset();
  }
});

test('handshakeTimeout is handed to the underlying socket', () => {
  const { client, optsSeen } = makeHangingClient({ handshakeTimeoutMs: 4321 });
  client.start();
  assert.equal(optsSeen[0].handshakeTimeout, 4321);
  client.stop();
});

test('ensureConnecting acts only when an attempt is actually needed', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    // No socket yet, not stopped → schedules an attempt.
    const idle = new WsClient({ url: 'wss://x/ws' });
    assert.equal(idle.ensureConnecting('test'), true);
    assert.ok(idle.reconnectTimer);
    // Already scheduled → does not pile on.
    assert.equal(idle.ensureConnecting('test'), false);
    idle.stop();

    // Deliberately stopped → must stay stopped.
    const stopped = new WsClient({ url: 'wss://x/ws' });
    stopped.stop();
    assert.equal(stopped.ensureConnecting('test'), false);

    // Open → nothing to do.
    const { client } = makeClient();
    client.start();
    client.ws.emit('open');
    assert.equal(client.state, 'open');
    assert.equal(client.ensureConnecting('test'), false);
    client.stop();
  } finally {
    mock.timers.reset();
  }
});

test('stalledMs tracks time in the current connection phase', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const { client } = makeHangingClient();
    client.start();
    assert.equal(client.state, 'connecting');
    mock.timers.tick(5000);
    assert.ok(client.stalledMs() >= 5000, `expected >=5000, got ${client.stalledMs()}`);
    client.stop();
  } finally {
    mock.timers.reset();
  }
});
