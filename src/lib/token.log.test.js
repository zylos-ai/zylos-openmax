import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, beforeEach, afterEach, after } from 'node:test';

// #264: the `[token]` progress lines (exchange / refresh / ws-ticket / member_id
// auto-fill) were printed with an unconditional console.log. A CLI verb whose
// token falls inside the refresh window printed them on stdout ahead of its
// JSON result, even with COCO_RPC_LOG=0, so callers that parse that stdout as
// JSON failed about once per token TTL. They now follow the `[rpc]` switches:
// stdout only while COCO_RPC_LOG is not '0', and the COCO_RPC_LOG_FILE sink.

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'token-log-'));
process.env.HOME = HOME;
process.env.COCO_API_KEY = 'cwsk_test';
process.env.COCO_API_URL = 'http://127.0.0.1:65535';

const ORG_ID = 'org-1';
const MEMBER_ID = 'm-self';
const COMP_DIR = path.join(HOME, 'zylos/components/openmax');
const CONFIG_PATH = path.join(COMP_DIR, 'config.json');
const TOKEN_DIR = path.join(COMP_DIR, 'runtime/tokens');
const LOG_FILE = path.join(HOME, 'rpc.log');

fs.mkdirSync(COMP_DIR, { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify({
  orgs: { acme: { org_id: ORG_ID, enabled: true, self: { member_id: '', name: '' } } },
}));

const { getAccessToken, getWsTicket, invalidate } = await import('./token.js');
const { updateConfig } = await import('./config.js');

const realFetch = globalThis.fetch;
const realLog = console.log;
let stdout;

// An unsigned JWT whose payload carries the member_id claim writeBackMemberId reads.
function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

/** A token file whose access token is inside the 60 s refresh margin. */
function writeExpiringToken(orgId) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  fs.writeFileSync(path.join(TOKEN_DIR, `${orgId || '_identity'}.json`), JSON.stringify({
    access_token: 'access-old',
    access_token_expires_at: Date.now() + 10_000,
    refresh_token: 'refresh-old',
    refresh_token_expires_at: Date.now() + 7 * 24 * 3600_000,
  }));
}

beforeEach(() => {
  fs.rmSync(TOKEN_DIR, { recursive: true, force: true });
  fs.rmSync(LOG_FILE, { force: true });
  // Every exchange / refresh fills the empty member_id; clear it again so each
  // test reaches the auto-fill line.
  updateConfig((c) => { c.orgs.acme.self.member_id = ''; });
  invalidate();
  delete process.env.COCO_RPC_LOG;
  delete process.env.COCO_RPC_LOG_FILE;
  stdout = [];
  console.log = (...a) => stdout.push(a.join(' '));
  globalThis.fetch = async (url) => {
    const payload = new URL(url).pathname === '/auth/ws-ticket'
      ? { ticket: 'ticket-1', expires_at: new Date(Date.now() + 30_000).toISOString() }
      : {
        access_token: jwt({ member_id: MEMBER_ID }),
        access_token_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        refresh_token: 'refresh-new',
        refresh_token_expires_at: new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: payload }) };
  };
});

afterEach(() => {
  console.log = realLog;
  globalThis.fetch = realFetch;
});

after(() => {
  delete process.env.COCO_RPC_LOG;
  delete process.env.COCO_RPC_LOG_FILE;
  fs.rmSync(HOME, { recursive: true, force: true });
});

const tokenLines = (lines) => lines.filter((l) => l.includes('[token]'));

test('COCO_RPC_LOG=0: a refresh inside the margin prints nothing on stdout', async () => {
  process.env.COCO_RPC_LOG = '0';
  writeExpiringToken(ORG_ID);
  assert.notEqual(await getAccessToken(ORG_ID), 'access-old');
  assert.deepEqual(stdout, []);
});

test('COCO_RPC_LOG=0: exchange, member_id auto-fill and ws-ticket print nothing on stdout', async () => {
  process.env.COCO_RPC_LOG = '0';
  assert.equal(await getWsTicket(ORG_ID), 'ticket-1');
  // The exchange really ran its side effect, so the auto-fill line was reached.
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(cfg.orgs.acme.self.member_id, MEMBER_ID);
  assert.deepEqual(stdout, []);
});

test('default (COCO_RPC_LOG unset): the [token] lines still go to stdout', async () => {
  writeExpiringToken(ORG_ID);
  await getAccessToken(ORG_ID);
  await getWsTicket(ORG_ID);
  const lines = tokenLines(stdout);
  assert.ok(lines.some((l) => l.startsWith(`[token] refresh org=${ORG_ID}`)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`[token] refresh ok org=${ORG_ID}`)), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes(`auto-filled orgs.acme.self.member_id from JWT claims: ${MEMBER_ID}`)), lines.join('\n'));
  assert.ok(lines.some((l) => l === `[token] ws-ticket org=${ORG_ID}`), lines.join('\n'));
  assert.ok(lines.some((l) => l === `[token] ws-ticket ok org=${ORG_ID}`), lines.join('\n'));
});

test('COCO_RPC_LOG=0 with COCO_RPC_LOG_FILE: the [token] lines go to the file only', async () => {
  process.env.COCO_RPC_LOG = '0';
  process.env.COCO_RPC_LOG_FILE = LOG_FILE;
  await getAccessToken('');
  assert.deepEqual(stdout, []);
  const file = tokenLines(fs.readFileSync(LOG_FILE, 'utf8').split('\n'));
  assert.ok(file.some((l) => l.endsWith('[token] exchange org=(identity-only)')), file.join('\n'));
  assert.ok(file.some((l) => l.includes('[token] exchange ok org=(identity-only) exp=')), file.join('\n'));
});
