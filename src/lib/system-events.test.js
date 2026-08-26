// Log-hygiene for high-frequency benign no-op system events (task #44 / PR #135).
//
// comm-bridge's `system`-frame dispatch calls traceSystemFrame() (the
// pre-classification trace at the switch) and, when classifySystemEvent()
// returns null, logUnhandledSystemEvent(). These are the exact functions wired
// into src/comm-bridge.js, so testing them here covers the real dispatch log
// behavior without importing the self-executing comm-bridge daemon.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBenignNoopSystemEvent,
  traceSystemFrame,
  logUnhandledSystemEvent,
} from './system-events.js';

const BENIGN = [
  'message.reaction.added',
  'message.reaction.removed',
  'message.read',
  'message.delivered',
  'message.mention.created',
  'message.created',
];

test('isBenignNoopSystemEvent: all known no-ops match (case-insensitive)', () => {
  for (const name of BENIGN) {
    assert.equal(isBenignNoopSystemEvent(name), true, name);
    assert.equal(isBenignNoopSystemEvent(name.toUpperCase()), true, `${name} upper`);
  }
});

test('isBenignNoopSystemEvent: unknown / actionable events do not match', () => {
  for (const name of ['message.recalled', 'message.updated', 'message.somethingnew',
    'connection.authorized', 'agent.config.updated', '', undefined, null]) {
    assert.equal(isBenignNoopSystemEvent(name), false, String(name));
  }
});

test('dispatch trace: a reaction system frame produces NO log', () => {
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const frame = { type: 'system', payload: { event: 'message.reaction.added', conversation_id: 'c-1' } };
  const emitted = traceSystemFrame(log, 'org-a', frame);
  assert.equal(emitted, false);
  assert.equal(logs.length, 0);
});

test('dispatch trace: an unknown event type STILL logs once (drift stays visible)', () => {
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));
  const frame = { type: 'system', payload: { event: 'message.somethingnew', conversation_id: 'c-9' } };
  const emitted = traceSystemFrame(log, 'org-a', frame);
  assert.equal(emitted, true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /system event=message\.somethingnew/);
  assert.match(logs[0], /conv=c-9/);
});

test('unhandled log: benign no-op is suppressed, unknown still logs once', () => {
  const logs = [];
  const log = (...a) => logs.push(a.join(' '));

  // Benign: no log.
  assert.equal(logUnhandledSystemEvent(log, 'org-a', { event: 'message.read', conversation_id: 'c-2' }), false);
  assert.equal(logs.length, 0);

  // Unknown drift: logged once.
  assert.equal(logUnhandledSystemEvent(log, 'org-a', { event: 'message.somethingnew', conversation_id: 'c-3' }), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unhandled system event: message\.somethingnew/);
  assert.match(logs[0], /conv=c-3/);
});
