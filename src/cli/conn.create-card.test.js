import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONNECTOR_CREATE_CARD_SCHEMA, CREATE_CARD_MAX_ACTIONS, CREATE_CARD_LIMITS,
  isSecretLikeKey, assertNoSecretKeys, parseCreateCardInput,
  buildConnectorCreateCardMessage, buildCreateCardFallbackText,
  sendConnectorCard, runCreateCard, buildConnectorAuthNoticeMessage,
} from './conn.js';

// conn.create_card (OPENM-836): the "create this custom connector?" card.

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));
const CONV = 'conv-abc_1';
const APP_ID = '3f401897-545e-4633-a486-5b3c464137a5';
const CARD_ID = '11111111-2222-4333-8444-555555555555';

function valid(overrides = {}) {
  return {
    conversationId: CONV,
    connector: {
      name: 'Acme CRM',
      slug: 'acme-crm',
      auth_type: 'oauth2',
      icon_url: 'https://acme.example.com/icon.png',
      description: 'Acme 的客户管理系统',
      base_url: 'https://api.acme.example.com/v1',
    },
    actions: [
      { name: 'list_contacts', effect: 'read', summary: '列出联系人' },
      { name: 'create_contact', effect: 'write', summary: '新建联系人' },
    ],
    ...overrides,
  };
}
const withConnector = (patch) => { const p = valid(); p.connector = { ...p.connector, ...patch }; return p; };
const withAction = (patch, i = 0) => { const p = valid(); p.actions[i] = { ...p.actions[i], ...patch }; return p; };
const rejects400 = (p, re) => assert.throws(() => parseCreateCardInput(p), (e) => e.status === 400 && re.test(e.message));

// --- validation ---------------------------------------------------------------

test('parseCreateCardInput: valid payload → trimmed, normalized', () => {
  const p = valid({ application_id: APP_ID });
  p.connector.name = '  Acme CRM ';
  const out = parseCreateCardInput(p);
  assert.equal(out.conversationId, CONV);
  assert.equal(out.connector.name, 'Acme CRM');
  assert.equal(out.application_id, APP_ID);
  assert.equal(out.actions.length, 2);
  // optional fields absent → omitted
  const min = parseCreateCardInput({ conversationId: CONV, connector: { name: 'X', slug: 'x', auth_type: 'mcp' }, actions: [{ name: 'a', effect: 'read', summary: 's' }] });
  assert.deepEqual(min.connector, { name: 'X', slug: 'x', auth_type: 'mcp' });
  assert.equal('application_id' in min, false);
  // applicationId alias + conversation_id alias
  const alias = parseCreateCardInput({ ...valid(), conversationId: undefined, conversation_id: CONV, applicationId: APP_ID });
  assert.equal(alias.application_id, APP_ID);
});

test('parseCreateCardInput: conversationId required and well-formed', () => {
  rejects400(valid({ conversationId: undefined }), /conversationId/);
  rejects400(valid({ conversationId: 'a/b' }), /conversationId/);
});

test('parseCreateCardInput: connector fields', () => {
  rejects400(valid({ connector: undefined }), /connector object/);
  rejects400(valid({ connector: [] }), /connector object/);
  rejects400(withConnector({ name: undefined }), /connector\.name is required/);
  rejects400(withConnector({ name: '   ' }), /connector\.name is required/);
  rejects400(withConnector({ name: 42 }), /connector\.name must be a string/);
  rejects400(withConnector({ name: 'x'.repeat(CREATE_CARD_LIMITS.name + 1) }), /too long/);
  rejects400(withConnector({ name: 'a\nb' }), /control/);
  rejects400(withConnector({ slug: undefined }), /connector\.slug is required/);
  for (const bad of ['Acme', 'acme crm', '-acme', 'acme-', 'acme/crm', 'ä', 'a'.repeat(65)]) {
    rejects400(withConnector({ slug: bad }), /connector\.slug/);
  }
  for (const ok of ['a', 'acme', 'acme-crm-k3wujp', 'tencent_ads', 'a1-b2']) {
    assert.equal(parseCreateCardInput(withConnector({ slug: ok })).connector.slug, ok);
  }
  rejects400(withConnector({ auth_type: undefined }), /auth_type/);
  rejects400(withConnector({ auth_type: 'basic' }), /auth_type must be one of api_key \| oauth2 \| mcp/);
  rejects400(withConnector({ auth_type: 'OAUTH2' }), /auth_type/);
  rejects400(withConnector({ icon_url: 'javascript:alert(1)' }), /icon_url/);
  rejects400(withConnector({ icon_url: 'not a url' }), /icon_url/);
  rejects400(withConnector({ base_url: 'ftp://acme.example.com' }), /base_url/);
  rejects400(withConnector({ base_url: 'https://u:p@acme.example.com' }), /credentials/);
  rejects400(withConnector({ base_url: `https://a.example.com/${'x'.repeat(CREATE_CARD_LIMITS.url)}` }), /too long/);
  rejects400(withConnector({ description: 'x'.repeat(CREATE_CARD_LIMITS.description + 1) }), /too long/);
  rejects400(withConnector({ category: 'crm' }), /unknown field "connector\.category"/);
});

test('parseCreateCardInput: actions', () => {
  rejects400(valid({ actions: undefined }), /actions/);
  rejects400(valid({ actions: [] }), /actions/);
  rejects400(valid({ actions: ['x'] }), /actions\[0\] must be an object/);
  rejects400(withAction({ name: undefined }), /actions\[0\]\.name is required/);
  rejects400(withAction({ name: 'acme-crm/list' }), /bare action name/);
  rejects400(withAction({ name: 'x'.repeat(CREATE_CARD_LIMITS.action_name + 1) }), /too long/);
  rejects400(withAction({ name: 'LIST_CONTACTS' }, 1), /duplicated/);
  rejects400(withAction({ effect: undefined }), /effect must be one of read \| write/);
  rejects400(withAction({ effect: 'delete' }), /effect/);
  rejects400(withAction({ summary: '' }), /summary is required/);
  rejects400(withAction({ summary: 'x'.repeat(CREATE_CARD_LIMITS.action_summary + 1) }), /too long/);
  rejects400(withAction({ method: 'GET' }), /unknown field "actions\[0\]\.method"/);
  const many = Array.from({ length: CREATE_CARD_MAX_ACTIONS }, (_, i) => ({ name: `a${i}`, effect: 'read', summary: 's' }));
  assert.equal(parseCreateCardInput(valid({ actions: many })).actions.length, 50);
  rejects400(valid({ actions: [...many, { name: 'a50', effect: 'read', summary: 's' }] }), /at most 50 actions/);
});

test('parseCreateCardInput: application_id must be a UUID; unknown top-level keys refused', () => {
  rejects400(valid({ application_id: 'acme' }), /application_id must be a UUID/);
  rejects400(valid({ extra: 1 }), /unknown field "extra"/);
});

// --- secret refusal -------------------------------------------------------------

test('isSecretLikeKey: catches secret names in any casing/separator, leaves card fields alone', () => {
  for (const k of ['api_key', 'apiKey', 'API-KEY', 'secret', 'client_secret', 'clientSecret', 'oauth_client_secret',
    'token', 'access_token', 'refreshToken', 'password', 'passwd', 'passphrase', 'private_key', 'key',
    'authorization', 'bearer', 'credentials', 'cookie', 'aws_secret_access_key', 'webhook_secret']) {
    assert.equal(isSecretLikeKey(k), true, k);
  }
  for (const k of ['name', 'slug', 'icon_url', 'description', 'base_url', 'auth_type', 'effect', 'summary',
    'conversationId', 'actions', 'application_id', 'org']) {
    assert.equal(isSecretLikeKey(k), false, k);
  }
});

test('parseCreateCardInput: secret-like key at ANY depth → 400 secret_field_rejected (before other checks)', () => {
  const cases = [
    { ...valid(), api_key: 'sk-1' },
    withConnector({ oauth_client_secret: 's' }),
    withConnector({ client_secret: 's' }),
    withAction({ token: 't' }, 1),
    withConnector({ extra: { nested: [{ password: 'p' }] } }),
    { ...valid(), meta: [[{ Authorization: 'Bearer x' }]] },
    // secret refusal wins even when everything else is invalid too
    { apiKey: 'x' },
  ];
  for (const p of cases) {
    assert.throws(() => parseCreateCardInput(p), (e) => e.status === 400 && e.code === 'secret_field_rejected'
      && /secret-like field/.test(e.message) && /填写 Client Secret/.test(e.message), JSON.stringify(p));
  }
  // the error names the path, never the value
  try { parseCreateCardInput(withConnector({ extra: { nested: [{ password: 'hunter2' }] } })); } catch (e) {
    assert.match(e.message, /connector\.extra\.nested\[0\]\.password/);
    assert.doesNotMatch(e.message, /hunter2/);
  }
  assert.doesNotThrow(() => assertNoSecretKeys({ a: [{ b: 1 }], c: null }));
});

// --- payload shape --------------------------------------------------------------

test('buildConnectorCreateCardMessage: exact schema, AGENT_STRUCTURED body + compact metadata copy', () => {
  const input = parseCreateCardInput(valid({ application_id: APP_ID }));
  const m = buildConnectorCreateCardMessage(input, CARD_ID);
  assert.equal(CONNECTOR_CREATE_CARD_SCHEMA, 'openmax.connector-create.v1');
  assert.equal(m.type, 'AGENT_STRUCTURED');
  assert.match(m.client_msg_id, /^[0-9a-f-]{36}$/);
  assert.equal(m.content.content_type, 'connector_create_card');
  assert.deepEqual(m.content.attachments, []);
  const body = m.content.body;
  assert.deepEqual(Object.keys(body), ['schema', 'card_id', 'connector', 'actions', 'application_id', 'fallback_text']);
  assert.equal(body.schema, 'openmax.connector-create.v1');
  assert.equal(body.card_id, CARD_ID);
  assert.deepEqual(body.connector, input.connector);
  assert.deepEqual(body.actions, input.actions);
  assert.equal(body.application_id, APP_ID);
  assert.equal(body.fallback_text, m.fallback_text);
  const meta = m.metadata.connector_create_card;
  assert.deepEqual(meta, {
    schema: 'openmax.connector-create.v1',
    card_id: CARD_ID,
    connector: { name: 'Acme CRM', slug: 'acme-crm', auth_type: 'oauth2', icon_url: 'https://acme.example.com/icon.png' },
    actions: input.actions,
    application_id: APP_ID,
  });
  assert.notEqual(meta.actions, body.actions, 'metadata is a copy');
  assert.equal(JSON.stringify(m).includes('secret'), false);
});

test('buildConnectorCreateCardMessage: no application_id → omitted; card_id defaults to a fresh uuid', () => {
  const input = parseCreateCardInput(valid());
  const a = buildConnectorCreateCardMessage(input);
  const b = buildConnectorCreateCardMessage(input);
  assert.equal('application_id' in a.content.body, false);
  assert.equal('application_id' in a.metadata.connector_create_card, false);
  assert.match(a.content.body.card_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a.content.body.card_id, b.content.body.card_id);
  assert.equal(a.metadata.connector_create_card.card_id, a.content.body.card_id);
});

test('fallback_text: name, slug, auth type, every action with 读/写, reply words', () => {
  const t = buildCreateCardFallbackText(parseCreateCardInput(valid()));
  assert.match(t, /「Acme CRM」（acme-crm）/);
  assert.match(t, /认证方式：OAuth 2\.0/);
  assert.match(t, /- \[读\] list_contacts：列出联系人/);
  assert.match(t, /- \[写\] create_contact：新建联系人/);
  assert.match(t, /动作（2）/);
  assert.match(t, /确认创建 Acme CRM/);
  assert.match(t, /我要改 Acme CRM/);
  assert.match(t, /Client Secret 请在「连接」页面填写/);
  const k = buildCreateCardFallbackText(parseCreateCardInput(withConnector({ auth_type: 'api_key' })));
  assert.match(k, /认证方式：API Key/);
  assert.doesNotMatch(k, /Client Secret/);
});

// --- send path ------------------------------------------------------------------

test('sendConnectorCard: auth_notice and create_card share one send path (POST conversation messages)', async () => {
  const calls = [];
  const post = async (...args) => { calls.push(args); return { id: 'msg-9' }; };
  const notice = buildConnectorAuthNoticeMessage([{ name: 'Notion', slug: 'notion' }]);
  await sendConnectorCard('org-1', CONV, notice, post);
  const out = await runCreateCard(valid(), { resolveOrg: () => 'org-1', post, cardId: CARD_ID });
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c[0], 'org-1');
    assert.match(c[1], new RegExp(`/conversations/${CONV}/messages$`));
    assert.deepEqual(c[3], { timeoutMs: 30_000, quietOnSuccess: true });
  }
  assert.equal(calls[1][2].content.body.card_id, CARD_ID);
  assert.deepEqual(out, {
    status: 'sent', conversation_id: CONV, card_id: CARD_ID, message_id: 'msg-9',
    connector: { name: 'Acme CRM', slug: 'acme-crm', auth_type: 'oauth2' }, actions_total: 2,
  });
});

test('runCreateCard: invalid / secret input → nothing sent, org not resolved', async () => {
  let posted = 0; let resolved = 0;
  const deps = { resolveOrg: () => { resolved += 1; return 'org-1'; }, post: async () => { posted += 1; } };
  await assert.rejects(runCreateCard(withConnector({ client_secret: 'x' }), deps), (e) => e.code === 'secret_field_rejected');
  await assert.rejects(runCreateCard(withConnector({ auth_type: 'basic' }), deps), (e) => e.status === 400);
  assert.equal(posted, 0);
  assert.equal(resolved, 0);
});

// --- CLI end to end (subprocess + fake cws-core) -----------------------------

function setupHome(orgId = 'org-1') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-cc-home-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/connect'), { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: { [orgId]: { enabled: true, org_id: orgId, self: { member_id: 'm-self' } } },
  }));
  return home;
}

function runConn(home, params, apiUrl) {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: home, COCO_API_URL: apiUrl, COCO_AUTH_TOKEN: 'test-token', COCO_RPC_LOG: '0' };
    execFile(process.execPath, [cliPath, 'conn.create_card', JSON.stringify(params)], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function runWithServer(params) {
  const posted = [];
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === `/api/v1/conversations/${CONV}/messages`) {
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        posted.push(JSON.parse(buf));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'msg-1' }, request_id: 'r-p' }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r9"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await runConn(setupHome(), params, `http://127.0.0.1:${server.address().port}`);
    return { ...r, posted, seen };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('conn.create_card CLI: posts the card and prints card_id + message_id', async () => {
  const { code, stdout, stderr, posted, seen } = await runWithServer(valid());
  assert.equal(code, 0, stderr);
  const out = JSON.parse(stdout);
  assert.equal(out.status, 'sent');
  assert.equal(out.message_id, 'msg-1');
  assert.equal(seen.length, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].content.body.schema, 'openmax.connector-create.v1');
  assert.equal(posted[0].content.body.card_id, out.card_id);
  assert.equal(posted[0].metadata.connector_create_card.card_id, out.card_id);
});

test('conn.create_card CLI: secret in input → exit 1, 400, nothing sent', async () => {
  const p = valid();
  p.connector.oauth_client_secret = 'shh-very-secret';
  const { code, stderr, seen } = await runWithServer(p);
  assert.equal(code, 1);
  const err = JSON.parse(stderr);
  assert.equal(err.status, 400);
  assert.equal(err.code, 'secret_field_rejected');
  assert.doesNotMatch(stderr, /shh-very-secret/);
  assert.equal(seen.length, 0);
});
