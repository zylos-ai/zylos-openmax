import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// comm.send with attachments: shorthand content must carry them (or refuse
// clearly), and a message with no text and no attachments is never posted.

const cliPath = fileURLToPath(new URL('./comm.js', import.meta.url));

// No live run may leak into these sends (see comm.test.js).
process.env.OPENMAX_RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'om-comm-att-runs-'));

// Run comm.send against a stub server; return every request it received and
// how the CLI exited.
async function send(params) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: {}, request_id: 'test-request' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const outcome = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [cliPath, 'comm.send', JSON.stringify(params)],
        {
          env: {
            ...process.env,
            COCO_API_URL: `http://127.0.0.1:${port}`,
            COCO_API_PREFIX: '/api/v1',
            COCO_AUTH_TOKEN: 'cli-contract-token',
            COCO_USER_TOKEN: '',
            COCO_RPC_LOG: '0',
          },
        },
        (error, stdout, stderr) => resolve({ ok: !error, stdout, stderr }),
      );
    });
    return { requests, posts: requests.filter((r) => r.method === 'POST'), ...outcome };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const CONV = 'cv-att';
const PDF = { artifact_id: 'art-pdf', file_name: 'weekly.pdf', content_type: 'application/pdf', size_bytes: 10 };
const PNG = { artifact_id: 'art-png', file_name: 'shot.png', content_type: 'image/png', size_bytes: 20 };

test('🔴 shorthand {text, attachments} carries the attachments as a FILE message', async () => {
  const { ok, posts } = await send({ conversationId: CONV, content: { text: '周报', attachments: [PDF] } });
  assert.equal(ok, true);
  assert.equal(posts.length, 1);
  const { body } = posts[0];
  assert.equal(body.type, 'FILE');
  assert.deepEqual(body.content, {
    content_type: 'file',
    body: { file_name: 'weekly.pdf', text: '周报' },
    attachments: [PDF],
  });
});

test('🔴 shorthand with only image attachments and no text is an IMAGE message', async () => {
  const { ok, posts } = await send({ conversationId: CONV, content: { attachments: [PNG] } });
  assert.equal(ok, true);
  const { body } = posts[0];
  assert.equal(body.type, 'IMAGE');
  assert.deepEqual(body.content, { content_type: 'image', body: { file_name: 'shot.png' }, attachments: [PNG] });
});

test('mixed image + file attachments are a FILE message', async () => {
  const { posts } = await send({ conversationId: CONV, content: { text: 'x', attachments: [PNG, PDF] } });
  assert.equal(posts[0].body.type, 'FILE');
  assert.equal(posts[0].body.content.content_type, 'file');
  assert.deepEqual(posts[0].body.content.attachments, [PNG, PDF]);
});

test('🔴 top-level params.attachments with string content are carried', async () => {
  const { ok, posts } = await send({ conversationId: CONV, content: '看图', attachments: [PNG] });
  assert.equal(ok, true);
  const { body } = posts[0];
  assert.equal(body.type, 'IMAGE');
  assert.deepEqual(body.content.attachments, [PNG]);
  assert.equal(body.content.body.text, '看图');
});

test('🔴 an attachment without artifact_id is refused before anything is sent', async () => {
  const { ok, posts, stderr } = await send({
    conversationId: CONV,
    content: { text: '', attachments: [{ artifactId: 'camel', fileName: 'a.png' }] },
  });
  assert.equal(ok, false);
  assert.equal(posts.length, 0);
  assert.match(stderr, /attachments\[0\] has no artifact_id/);
});

test('attachments given in both places, or top-level with pre-built content, are refused', async () => {
  const both = await send({ conversationId: CONV, content: { text: 'x', attachments: [PDF] }, attachments: [PNG] });
  assert.equal(both.ok, false);
  assert.equal(both.posts.length, 0);
  assert.match(both.stderr, /both in content\.attachments and top-level/);

  const prebuilt = await send({
    conversationId: CONV,
    content: { content_type: 'file', body: { file_name: 'weekly.pdf' }, attachments: [PDF] },
    attachments: [PNG],
  });
  assert.equal(prebuilt.ok, false);
  assert.equal(prebuilt.posts.length, 0);
  assert.match(prebuilt.stderr, /pre-built content object/);
});

test('🔴 an empty message is refused client-side: nothing reaches the server', async () => {
  for (const content of ['', '   ', { text: '' }, { attachments: [] }, undefined, []]) {
    // eslint-disable-next-line no-await-in-loop
    const { ok, posts, stderr } = await send({ conversationId: CONV, content });
    assert.equal(ok, false, `content=${JSON.stringify(content)} must fail`);
    assert.equal(posts.length, 0, `content=${JSON.stringify(content)} must not be posted`);
    assert.match(stderr, /refusing to send an empty message/);
  }
});

test('a pre-built content object with neither text nor attachments is refused', async () => {
  const { ok, posts } = await send({ conversationId: CONV, content: { content_type: 'image', body: {}, attachments: [] } });
  assert.equal(ok, false);
  assert.equal(posts.length, 0);
});

test('unchanged: plain text and the pre-built content object still go out as before', async () => {
  const plain = await send({ conversationId: CONV, content: 'hello' });
  assert.equal(plain.ok, true);
  assert.equal(plain.posts[0].body.type, 'AGENT_TEXT');
  assert.deepEqual(plain.posts[0].body.content, { content_type: 'text', body: { text: 'hello' }, attachments: [] });

  const prebuilt = await send({
    conversationId: CONV,
    content: { content_type: 'file', body: { file_name: 'weekly.pdf', text: 'x' }, attachments: [PDF] },
  });
  assert.equal(prebuilt.ok, true);
  assert.equal(prebuilt.posts[0].body.type, 'FILE');
  assert.deepEqual(prebuilt.posts[0].body.content.attachments, [PDF]);
});
