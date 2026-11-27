import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// OPENM-1396: comm.send with sourceMessageId is a reply path like c4-send —
// the turn's first delivered reply is recorded for the skill-usage report
// (activity/skills-used.js); nothing is added to the body.

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-first-reply-home-'));
const STATE = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-first-reply-state-'));
const RUNS = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-first-reply-runs-'));
const CONV = '019f6a10-1af8-73ef-b9bb-08b28dcaa111';
const SRC = '7300000000000002001';

function registerTurn(conv = CONV, src = SRC) {
  fs.writeFileSync(path.join(STATE, `${src}.json`), JSON.stringify({
    v: 2, source_message_id: src, conversation_id: conv, org_id: 'org-test', member_id: 'agent-1',
    registered_at: Date.now(), runtime: 'claude', selected_skill_ids: [],
    scan: { logs: {}, anchor_log: null, ids: [], reasons: [], ended_at: null }, report: { attempts: 0, next_at: 0 },
  }));
}
const replyOf = (src = SRC) => {
  try { return JSON.parse(fs.readFileSync(path.join(STATE, `${src}.reply`), 'utf8')).reply_message_id; } catch { return null; }
};

async function send(params, status = 200, verb = 'comm.send') {
  const posts = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST') posts.push(JSON.parse(raw));
      res.writeHead(status, { 'content-type': 'application/json' });
      let out = { id: `740000000000000200${posts.length}` };
      if (req.url.endsWith('/interaction-requests')) {
        const body = JSON.parse(raw);
        out = {
          message_id: `740000000000000300${posts.length}`,
          action_ids: (body.choice?.options || []).map((_, i) => `act_${i}`),
          form_option_ids: Object.fromEntries((body.form?.fields || []).filter((f) => f.type !== 'text').map((f) => [f.key, f.options.map((_, i) => `opt_${i}`)])),
        };
      }
      if (req.method === 'GET') out = { id: CONV, type: 'dm' };
      res.end(JSON.stringify(status === 200 ? out : { error: 'bad' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const outcome = await new Promise((resolve) => {
      execFile(process.execPath, [cliPath, verb, JSON.stringify(params)], {
        env: {
          ...process.env,
          HOME,
          OPENMAX_SKILLS_USED_DIR: STATE,
          OPENMAX_RUNS_DIR: RUNS,
          COCO_ORG_ID: 'org-test',
          COCO_API_URL: `http://127.0.0.1:${server.address().port}`,
          COCO_API_PREFIX: '/api/v1',
          COCO_AUTH_TOKEN: 'cli-contract-token',
          COCO_USER_TOKEN: '',
          COCO_RPC_LOG: '0',
        },
      }, (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }));
    });
    return { posts, ...outcome };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('comm.send with sourceMessageId records the first delivered reply only; body unchanged', async () => {
  registerTurn();
  let r = await send({ conversationId: CONV, content: 'first', sourceMessageId: SRC }, 400);
  assert.equal(r.ok, false);
  assert.equal(replyOf(), null, 'a rejected send records nothing');
  r = await send({ conversationId: CONV, content: 'second', sourceMessageId: SRC });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(replyOf(), '7400000000000002001');
  assert.equal('metadata' in r.posts[0], false);
  r = await send({ conversationId: CONV, content: 'third', sourceMessageId: SRC });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(replyOf(), '7400000000000002001', 'later replies do not replace it');
});

test('comm.send without sourceMessageId, or for an unregistered message, records nothing', async () => {
  const src = '7300000000000002002';
  let r = await send({ conversationId: CONV, content: 'x' });
  assert.equal(r.ok, true, r.stderr);
  r = await send({ conversationId: CONV, content: 'x', sourceMessageId: src });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(replyOf(src), null);
});

// OPEN-2: a card sent before any text is the turn's first reply.
for (const [verb, params] of [
  ['comm.send_card', { title: '继续吗', text: '要继续吗', options: ['是', '否'] }],
  ['comm.ask_card', { kind: 'confirm', askedOf: 'm-owner', title: '继续吗', text: '要继续吗', options: ['是', '否'] }],
  ['comm.ask', { interactionType: 'form', kind: 'survey', askedOf: 'm-owner', title: '选一个', fields: [{ key: 'q1', label: '哪个', options: ['A', 'B'] }] }],
]) {
  test(`${verb} with sourceMessageId records a card-first reply; the later text does not replace it`, async () => {
    const src = { 'comm.send_card': '7300000000000002011', 'comm.ask_card': '7300000000000002012', 'comm.ask': '7300000000000002013' }[verb];
    registerTurn(CONV, src);
    let r = await send({ conversationId: CONV, sourceMessageId: src, ...params }, 400, verb);
    assert.equal(r.ok, false);
    assert.equal(replyOf(src), null, 'a rejected card records nothing');
    r = await send({ conversationId: CONV, sourceMessageId: src, ...params }, 200, verb);
    assert.equal(r.ok, true, r.stderr);
    const cardId = replyOf(src);
    assert.match(cardId || '', /^7400000000000003/, `card message id recorded, got ${cardId}`);
    r = await send({ conversationId: CONV, content: 'text after the card', sourceMessageId: src });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(replyOf(src), cardId);
  });
}
