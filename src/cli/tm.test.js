import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cliPath = fileURLToPath(new URL('./tm.js', import.meta.url));

async function captureRequest(command, params) {
  let resolveRequest;
  const requestPromise = new Promise((resolve) => { resolveRequest = resolve; });
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      resolveRequest({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: rawBody ? JSON.parse(rawBody) : undefined,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: {}, request_id: 'test-request' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const processPromise = new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, command, JSON.stringify(params)],
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
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`tm.js failed: ${stderr || stdout}`));
          return;
        }
        resolve();
      },
    );
  });

  try {
    const [request] = await Promise.all([requestPromise, processPromise]);
    return request;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function captureFailure(command, params) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliPath, command, JSON.stringify(params)],
      { env: { ...process.env, COCO_RPC_LOG: '0' } },
      (error, stdout, stderr) => {
        if (!error) {
          reject(new Error(`tm.js unexpectedly succeeded: ${stdout}`));
          return;
        }
        resolve(JSON.parse(stderr));
      },
    );
  });
}

test('project.create forwards atomic project fields and documented auth token', async () => {
  const request = await captureRequest('project.create', {
    name: 'Semantic alignment',
    leadMemberId: 'lead-1',
    knowledgeBaseId: 'kb-1',
    memberIds: ['member-1', 'member-2'],
    isDefault: true,
  });

  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/v1/projects');
  assert.equal(request.authorization, 'Bearer cli-contract-token');
  assert.deepEqual(request.body, {
    name: 'Semantic alignment',
    lead_member_id: 'lead-1',
    knowledge_base_id: 'kb-1',
    member_ids: ['member-1', 'member-2'],
    is_default: true,
  });
});

test('project and organization issue searches forward query', async () => {
  const projectRequest = await captureRequest('project.list', { query: 'alpha' });
  const issueRequest = await captureRequest('issue.list', { query: 'beta' });

  assert.equal(projectRequest.url, '/api/v1/projects?query=alpha');
  assert.equal(issueRequest.url, '/api/v1/issues?query=beta');
});

test('issue.create preserves backlog presence and requires owner and lead', async () => {
  const backlogRequest = await captureRequest('issue.create', {
    projectId: 'project-1',
    title: 'Record discovered issue',
    leadAgentId: 'agent-1',
    ownerMemberId: 'human-1',
  });
  assert.equal(Object.hasOwn(backlogRequest.body, 'backlog'), false);

  const immediateRequest = await captureRequest('issue.create', {
    projectId: 'project-1',
    title: 'Start immediately',
    leadAgentId: 'agent-1',
    ownerMemberId: 'human-1',
    backlog: false,
  });
  assert.equal(immediateRequest.body.backlog, false);

  const failure = await captureFailure('issue.create', {
    projectId: 'project-1',
    title: 'Missing ownership',
  });
  assert.match(failure.error, /leadAgentId, ownerMemberId/);
});

test('issue.accept_delivered defaults to the Lead text-card proxy source', async () => {
  const proxyRequest = await captureRequest('issue.accept_delivered', {
    id: 'issue-1',
  });
  assert.equal(proxyRequest.method, 'POST');
  assert.equal(proxyRequest.url, '/api/v1/issues/issue-1/accept-delivered');
  assert.deepEqual(proxyRequest.body, { source: 'text_card_proxy' });

  const explicitRequest = await captureRequest('issue.accept_delivered', {
    id: 'issue-1',
    source: 'explicit',
  });
  assert.deepEqual(explicitRequest.body, { source: 'explicit' });
});

test('comment.list uses cursor pagination', async () => {
  const request = await captureRequest('comment.list', {
    workType: 'task',
    workId: 'task-1',
    cursor: 'cursor-1',
    limit: 25,
    orderBy: 'created_at desc',
  });

  const url = new URL(request.url, 'http://localhost');
  assert.equal(url.searchParams.get('work_type'), 'task');
  assert.equal(url.searchParams.get('work_id'), 'task-1');
  assert.equal(url.searchParams.get('cursor'), 'cursor-1');
  assert.equal(url.searchParams.get('limit'), '25');
  assert.equal(url.searchParams.get('order_by'), 'created_at desc');
  assert.equal(url.searchParams.has('page'), false);
  assert.equal(url.searchParams.has('page_size'), false);
});

test('project member commands match BFF paths and bodies', async () => {
  const addRequest = await captureRequest('project.member_add', {
    id: 'project-1',
    memberId: 'member-1',
  });
  const removeRequest = await captureRequest('project.member_remove', {
    id: 'project-1',
    memberId: 'member-1',
  });

  assert.equal(addRequest.method, 'POST');
  assert.equal(addRequest.url, '/api/v1/projects/project-1/members');
  assert.deepEqual(addRequest.body, { member_id: 'member-1', role: 'member' });
  assert.equal(removeRequest.method, 'DELETE');
  assert.equal(removeRequest.url, '/api/v1/projects/project-1/members/member-1');
});
