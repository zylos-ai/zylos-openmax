import assert from 'node:assert/strict';
import test from 'node:test';

import { formatLocalTime, formatLocalWithRaw } from './local-time.js';

const UTC_NOON = '2026-09-24T12:30:00Z';

test('renders an instant in the given zone, with the offset attached', () => {
  assert.equal(formatLocalTime(UTC_NOON, { timeZone: 'Asia/Singapore' }), '2026-09-24 20:30:00 (+08:00)');
  assert.equal(formatLocalTime(UTC_NOON, { timeZone: 'UTC' }), '2026-09-24 12:30:00 (+00:00)');
});

test('🔴 the offset is never omitted, in any zone', () => {
  // Without it the output is a wall clock with no zone, which is exactly the
  // ambiguity this module exists to remove — a reader on another machine
  // cannot tell whether `20:30` is theirs.
  for (const timeZone of ['Asia/Singapore', 'UTC', 'America/New_York', 'Asia/Kolkata']) {
    assert.match(formatLocalTime(UTC_NOON, { timeZone }), /\([+-]\d{2}:\d{2}\)$/, timeZone);
  }
});

test('a zone that shifts the date renders the shifted date, not just the clock', () => {
  // 12:30Z is the previous day in New York — the bug this replaces printed the
  // UTC date beside a local-looking time.
  assert.equal(formatLocalTime('2026-09-24T02:30:00Z', { timeZone: 'America/New_York' }), '2026-09-23 22:30:00 (-04:00)');
});

test('midnight renders as 00, not 24', () => {
  assert.match(formatLocalTime('2026-09-24T16:00:00Z', { timeZone: 'Asia/Singapore' }), /^2026-09-25 00:00:00 /);
});

test('anything that is not a time returns null rather than a wrong-looking clock', () => {
  for (const bad of [undefined, null, '', 'not a time', NaN]) {
    assert.equal(formatLocalTime(bad), null, String(bad));
  }
  assert.equal(formatLocalTime(UTC_NOON, { timeZone: 'Mars/Olympus' }), null);
});

test('formatLocalWithRaw keeps the raw ISO beside the local rendering', () => {
  const out = formatLocalWithRaw(UTC_NOON);
  assert.ok(out.includes(UTC_NOON), out);
  assert.notEqual(out, UTC_NOON);
  // Unparseable input falls back to the raw value alone — never to nothing.
  assert.equal(formatLocalWithRaw('whenever'), 'whenever');
});
