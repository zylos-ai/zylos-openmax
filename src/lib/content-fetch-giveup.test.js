import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CONTENT_FETCH_ATTEMPTS,
  recordFailure,
  clearFailure,
  failureCount,
} from './content-fetch-giveup.js';

test('MAX_CONTENT_FETCH_ATTEMPTS is a small positive integer', () => {
  assert.ok(Number.isInteger(MAX_CONTENT_FETCH_ATTEMPTS) && MAX_CONTENT_FETCH_ATTEMPTS >= 1);
});

test('recordFailure counts up and does NOT give up before the cap', () => {
  const counts = {};
  for (let i = 1; i < MAX_CONTENT_FETCH_ATTEMPTS; i++) {
    const r = recordFailure(counts, 'k');
    assert.equal(r.failures, i, `failure ${i} counted`);
    assert.equal(r.giveUp, false, `does not give up at ${i} < ${MAX_CONTENT_FETCH_ATTEMPTS}`);
    assert.equal(r.max, MAX_CONTENT_FETCH_ATTEMPTS);
  }
});

test('recordFailure gives up exactly at the Nth consecutive failure', () => {
  const counts = {};
  let last;
  for (let i = 0; i < MAX_CONTENT_FETCH_ATTEMPTS; i++) last = recordFailure(counts, 'k');
  assert.equal(last.failures, MAX_CONTENT_FETCH_ATTEMPTS);
  assert.equal(last.giveUp, true, 'gives up at the cap');
});

test('recordFailure honors a custom max', () => {
  const counts = {};
  assert.equal(recordFailure(counts, 'k', 2).giveUp, false);
  assert.equal(recordFailure(counts, 'k', 2).giveUp, true);
});

test('recordFailure rejects a non-positive-integer max', () => {
  assert.throws(() => recordFailure({}, 'k', 0), TypeError);
  assert.throws(() => recordFailure({}, 'k', 2.5), TypeError);
  assert.throws(() => recordFailure({}, 'k', -1), TypeError);
});

test('clearFailure resets the counter so only CONSECUTIVE failures count', () => {
  const counts = {};
  recordFailure(counts, 'k');
  recordFailure(counts, 'k');
  assert.equal(failureCount(counts, 'k'), 2);

  assert.equal(clearFailure(counts, 'k'), true, 'reports it cleared an existing counter');
  assert.equal(failureCount(counts, 'k'), 0, 'counter reset to zero');

  // After a success the count starts over — never reaching the cap on scattered
  // failures interleaved with successes.
  const r = recordFailure(counts, 'k');
  assert.equal(r.failures, 1);
  assert.equal(r.giveUp, false);
});

test('clearFailure on an unknown key is a no-op', () => {
  const counts = {};
  assert.equal(clearFailure(counts, 'nope'), false);
});

test('counters are independent per key', () => {
  const counts = {};
  recordFailure(counts, 'a');
  recordFailure(counts, 'a');
  recordFailure(counts, 'b');
  assert.equal(failureCount(counts, 'a'), 2);
  assert.equal(failureCount(counts, 'b'), 1);

  clearFailure(counts, 'a');
  assert.equal(failureCount(counts, 'a'), 0);
  assert.equal(failureCount(counts, 'b'), 1, 'clearing one key leaves others untouched');
});

test('numeric and string keys refer to the same counter (keys are stringified)', () => {
  const counts = {};
  recordFailure(counts, 7);
  const r = recordFailure(counts, '7');
  assert.equal(r.failures, 2, 'seq 7 and "7" are the same key');
  assert.equal(failureCount(counts, 7), 2);
});

test('counts map is a plain serializable object (durable-persistence contract)', () => {
  const counts = {};
  recordFailure(counts, 3);
  recordFailure(counts, 3);
  const roundTripped = JSON.parse(JSON.stringify(counts));
  assert.deepEqual(roundTripped, { '3': 2 }, 'survives a JSON round-trip unchanged');
});
