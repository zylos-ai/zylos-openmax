import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWorkspacePrefix } from './workspace-prefix.js';

test('adds /workspace to a host-only URL (no path) — bff_url case', () => {
  assert.equal(addWorkspacePrefix('https://cws-int.coco.xyz'), 'https://cws-int.coco.xyz/workspace');
});

test('adds /workspace to a URL with only a trailing slash', () => {
  assert.equal(addWorkspacePrefix('https://cws-int.coco.xyz/'), 'https://cws-int.coco.xyz/workspace');
});

test('inserts /workspace before an existing path segment — ws_url case', () => {
  assert.equal(addWorkspacePrefix('wss://cws-int.coco.xyz/ws'), 'wss://cws-int.coco.xyz/workspace/ws');
});

test('preserves port and query string', () => {
  assert.equal(addWorkspacePrefix('http://127.0.0.1:8080/ws?x=1'), 'http://127.0.0.1:8080/workspace/ws?x=1');
});

test('idempotent: the exact /workspace root is unchanged', () => {
  assert.equal(addWorkspacePrefix('https://cws-int.coco.xyz/workspace'), 'https://cws-int.coco.xyz/workspace');
});

test('idempotent: a URL already under /workspace/... is unchanged', () => {
  assert.equal(addWorkspacePrefix('wss://cws-int.coco.xyz/workspace/ws'), 'wss://cws-int.coco.xyz/workspace/ws');
});

test('does NOT treat a /workspace-lookalike path as already-prefixed', () => {
  assert.equal(
    addWorkspacePrefix('https://cws-int.coco.xyz/workspace-foo'),
    'https://cws-int.coco.xyz/workspace/workspace-foo',
  );
});

test('malformed / empty / non-string inputs pass through untouched', () => {
  assert.equal(addWorkspacePrefix('not a url'), 'not a url');
  assert.equal(addWorkspacePrefix(''), '');
  assert.equal(addWorkspacePrefix(undefined), undefined);
  assert.equal(addWorkspacePrefix(null), null);
});
