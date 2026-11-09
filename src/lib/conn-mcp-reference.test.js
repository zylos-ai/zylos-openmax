import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const connOps = read('../../references/conn-operations.md');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing section: ${start}`);
  return source.slice(from, to);
}

test('conn-operations no longer maps every auth_type straight to provider_type', () => {
  assert.doesNotMatch(connOps, /`provider_type` = `auth_type`,/);
  assert.match(connOps, /`provider_type` = the card's `auth_type` \*\*for `api_key` \/ `oauth2` cards only\*\*/);
  assert.match(connOps, /An `mcp` card is \*\*not\*\* `provider_type: "mcp"` \(refused\)/);
});

test('conn-operations documents the two-step MCP connector path', () => {
  const mcp = section(connOps, '#### MCP connectors (`auth_type: "mcp"`) — two steps', '### Action-def schema semantics');
  assert.match(mcp, /"connector_kind":"mcp","provider_type":"oauth2"/);
  assert.match(mcp, /"auth_type":"mcp"[^']*"server_url":"https:/);
  assert.match(mcp, /Never `provider_type: "mcp"`/);
  assert.match(mcp, /No `actions` \(refused\)/);
  assert.match(mcp, /\*\*\(b\) The user connects it on openmax\.com\.\*\*/);
  assert.match(mcp, /\*\*exact URL to paste\*\*/);
  assert.match(mcp, /`mcp_server\.server_url` with transport `remote_http`/);
  assert.match(mcp, /tell the user plainly what failed/);
});

test('conn.app_create docs: connector_kind is a separate axis from provider_type', () => {
  const create = section(connOps, '### conn.app_create', '### conn.app_list');
  assert.match(create, /`connector_kind` \(optional\): `http` \(default/);
  assert.match(create, /\*\*never\*\* `"mcp"`/);
});
