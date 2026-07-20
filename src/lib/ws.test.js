import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { WsClient } from './ws.js';

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
// Configurable frame-watchdog window (issue #71 — half-open detection)
// ---------------------------------------------------------------------------

test('frameWatchdogMs defaults to heartbeatIntervalMs*2 + grace and is overridable', () => {
  const def = new WsClient({ url: 'wss://x/ws', heartbeatIntervalMs: 30000, pingIntervalMs: 20000 });
  assert.equal(def.frameWatchdogMs, 65000, 'default = 30000*2 + 5000');

  const custom = new WsClient({ url: 'wss://x/ws', heartbeatIntervalMs: 30000, pingIntervalMs: 5000, frameWatchdogMs: 20000 });
  assert.equal(custom.frameWatchdogMs, 20000, 'explicit override wins');
});

test('frameWatchdogMs is floored so it cannot fire before a couple of pings could pong', () => {
  // A too-small window (below 3× ping cadence + grace) is clamped up so a
  // mis-config can never cause a reconnect storm.
  const c = new WsClient({ url: 'wss://x/ws', pingIntervalMs: 20000, frameWatchdogMs: 1000 });
  assert.equal(c.frameWatchdogMs, (20000 * 3) + 5000, 'floored to pingIntervalMs*3 + grace');
});

test('a shorter frameWatchdogMs terminates a starved connection sooner', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    // Window floored to pingIntervalMs*3 + 5000 = 3000*3 + 5000 = 14000ms.
    const { client, sockets } = makeClient({
      pingIntervalMs: 3000,
      heartbeatIntervalMs: 30000,
      frameWatchdogMs: 1, // floored up to 14000
      autoPong: false,    // nothing feeds the watchdog
    });
    assert.equal(client.frameWatchdogMs, 14000);
    client.start();
    const ws = sockets[0];
    ws.emit('open');

    mock.timers.tick(13000);
    assert.equal(ws.terminateCount, 0, 'not yet past the (floored) window');
    mock.timers.tick(3000); // now past 14000
    assert.ok(ws.terminateCount >= 1, 'terminated once the shorter window elapses');

    client.stop();
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// forceReconnect() — out-of-band liveness trigger (issue #71, suggestion #2)
// ---------------------------------------------------------------------------

test('forceReconnect() terminates an open socket and returns true', () => {
  const { client, sockets } = makeClient({ heartbeatIntervalMs: 10_000_000 });
  client.start();
  const ws = sockets[0];
  ws.emit('open');

  const did = client.forceReconnect('core reports offline');
  assert.equal(did, true);
  assert.equal(ws.terminateCount, 1, 'the live socket is torn down');
  client.stop();
});

test('forceReconnect() reuses the existing close → reconnect path (new socket created)', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const { client, sockets } = makeClient({ heartbeatIntervalMs: 10_000_000 });
    client.start();
    const ws = sockets[0];
    ws.emit('open');

    assert.equal(client.forceReconnect('offline'), true);
    // Real ws.terminate() emits 'close'; the fake doesn't, so drive it — this
    // is the SAME close path a watchdog teardown takes.
    ws.emit('close', 1006, Buffer.from('terminated'));
    assert.equal(sockets.length, 1, 'reconnect is scheduled with backoff, not immediate');

    mock.timers.tick(1000); // first backoff step (RECONNECT_BASE_MS)
    assert.equal(sockets.length, 2, 'a fresh socket is created on reconnect');

    client.stop();
  } finally {
    mock.timers.reset();
  }
});

test('forceReconnect() is a no-op when the socket is not open', () => {
  const { client, sockets } = makeClient({ heartbeatIntervalMs: 10_000_000 });
  client.start();
  const ws = sockets[0];
  // Never emit 'open' → readyState default is OPEN in the fake, so simulate a
  // not-open socket explicitly.
  ws.readyState = 0; // CONNECTING
  assert.equal(client.forceReconnect('offline'), false);
  assert.equal(ws.terminateCount, 0);
  client.stop();
});

test('forceReconnect() is a no-op after stop()', () => {
  const { client, sockets } = makeClient({ heartbeatIntervalMs: 10_000_000 });
  client.start();
  const ws = sockets[0];
  ws.emit('open');
  client.stop();
  assert.equal(client.forceReconnect('offline'), false, 'stopped client never reconnects');
});

test('forceReconnect() honors minOpenMs — skips a just-opened connection, fires once aged', () => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  try {
    const { client, sockets } = makeClient({ heartbeatIntervalMs: 10_000_000 });
    client.start();
    const ws = sockets[0];
    ws.emit('open');

    // Connection is brand new → guarded away.
    assert.equal(client.forceReconnect('offline', { minOpenMs: 60000 }), false);
    assert.equal(ws.terminateCount, 0, 'young connection is not torn down');

    mock.timers.tick(60000); // age past the guard
    assert.equal(client.forceReconnect('offline', { minOpenMs: 60000 }), true);
    assert.equal(ws.terminateCount, 1);

    client.stop();
  } finally {
    mock.timers.reset();
  }
});
