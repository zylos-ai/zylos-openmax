// Multi-agent smoke runner (NL-driven).
//
// Design summary
// ==============
//
// Mirrors single-agent/lib/runner.js, generalized for two live agent
// runtimes (LEAD + WORKER). The test client sends user-facing natural
// language into each agent's conversation channel; each agent perceives
// and acts via its own tool surface. The runner never references CLI
// command names in the instructions — agents pick tools themselves.
//
// Two actors, lead-on-this-host + worker-elsewhere:
//
//                +-------------------+        +-------------------+
//   test client  |  LEAD agent       |        |  WORKER agent     |
//     (this) ---NL-->  Zylos PM2     |        |  Zylos-GavinBox   |
//          \    |  (this host)       |        |  (other server)   |
//           \   +---------+----+-----+        +-------+----+------+
//            \            |    ^                      |    ^
//             \           v    |                      v    |
//              \    +----------+----------------+----------+
//               \-->|        cws-core BFF                  |
//                   |  (issues/tasks/attempts/blueprints/  |
//                   |   kbs/pages/artifacts/conversations) |
//                   +--------------------------------------+
//
// The runner polls server state (issue.list_in_project etc.) to verify
// outcomes — neither agent's runtime is queried directly.
//
// Worker JWT acquisition
// ----------------------
// The runner exchanges TEST_WORKER_API_KEY for an org-scoped JWT once
// at startup (POST /auth/agent/token then POST /auth/refresh with
// org_id). That JWT is used when the test needs to invoke tm/kb/as as
// the worker actor for verification (e.g. confirming a task's
// assignee_id from the worker's POV). NL goes through the owner JWT
// on the user-message endpoint.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);

// =============================================================================
// Logging
// =============================================================================

const ts = () => `[${new Date().toISOString()}]`;
export const log  = (s) => console.log(`${ts()} ${s}`);
export const ok   = (s) => { _passCount++; console.log(`${ts()}   ✓ ${s}`); };
export const warn = (s) => console.warn(`${ts()}   ⚠ ${s}`);
export const die  = (s) => { _failCount++; console.error(`✗ ${s}`); process.exit(1); };

// =============================================================================
// Env validation
// =============================================================================

const REQUIRED = [
  'COCO_API_URL',
  'TEST_USER_TOKEN',
  'TEST_ORG_ID',
  'TEST_PROJECT_ID',
  'TEST_CONV_ID',
  'TEST_AGENT_ID',
  'TEST_WORKER_CONV_ID',
  'TEST_WORKER_API_KEY',
];

export function loadEnv() {
  for (const k of REQUIRED) {
    if (!process.env[k]) {
      console.error(`✗ Missing required env: ${k}`);
      console.error(`  Required: ${REQUIRED.join(', ')}`);
      console.error(`  Optional: CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET`);
      console.error(`            COCO_TM_CLI (path to tm.js)`);
      process.exit(2);
    }
  }
  return {
    COCO_API_URL:    process.env.COCO_API_URL,
    TEST_USER_TOKEN: process.env.TEST_USER_TOKEN,
    TEST_ORG_ID:     process.env.TEST_ORG_ID,
    TEST_PROJECT_ID: process.env.TEST_PROJECT_ID,
    lead: {
      conv_id:    process.env.TEST_CONV_ID,
      agent_id:   process.env.TEST_AGENT_ID,
    },
    worker: {
      conv_id:    process.env.TEST_WORKER_CONV_ID,
      api_key:    process.env.TEST_WORKER_API_KEY,
      // worker.agent_id (member_id) is derived from JWT claims in
      // getWorkerJwt() — see WORKER_MID extraction in tests. Not an env var.
    },
    CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
  };
}

function cfHeaders(env) {
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    return {
      'CF-Access-Client-Id':     env.CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
    };
  }
  return {};
}

// =============================================================================
// Worker JWT acquisition
//   POST /auth/agent/token with worker api_key       → identity-only JWT
//   POST /auth/refresh     with refresh_token+org_id → org-scoped JWT
// =============================================================================

let _workerJwtCache = null;

export async function getWorkerJwt(env, { force = false } = {}) {
  if (!force && _workerJwtCache && _workerJwtCache.expires_at - Date.now() > 60_000) {
    return _workerJwtCache.access_token;
  }
  const baseHeaders = { 'Content-Type': 'application/json', ...cfHeaders(env) };

  const exchangeRes = await fetch(`${env.COCO_API_URL}/auth/agent/token`, {
    method:  'POST',
    headers: { ...baseHeaders, 'Authorization': env.worker.api_key },
    body:    JSON.stringify({}),
  });
  const exchangeBody = await exchangeRes.json();
  if (!exchangeRes.ok) die(`worker JWT exchange HTTP ${exchangeRes.status}: ${JSON.stringify(exchangeBody)}`);
  const identityJwt     = exchangeBody.data.access_token;
  const identityRefresh = exchangeBody.data.refresh_token;

  // NB: /auth/refresh does NOT accept `token_delivery` (422 with
  // "unexpected property"), unlike /auth/login which requires it. cws-core
  // contract drift — refresh defaults to body, no override available.
  const refreshRes = await fetch(`${env.COCO_API_URL}/auth/refresh`, {
    method:  'POST',
    headers: { ...baseHeaders, 'Authorization': `Bearer ${identityJwt}` },
    body:    JSON.stringify({
      refresh_token:  identityRefresh,
      org_id:         env.TEST_ORG_ID,
    }),
  });
  const refreshBody = await refreshRes.json();
  if (!refreshRes.ok) die(`worker JWT org-refresh HTTP ${refreshRes.status}: ${JSON.stringify(refreshBody)}`);

  _workerJwtCache = {
    access_token: refreshBody.data.access_token,
    expires_at:   new Date(refreshBody.data.access_token_expires_at).getTime(),
  };
  return _workerJwtCache.access_token;
}

// =============================================================================
// tm.js CLI wrapper — same pattern as single-agent runner, but accepts an
// explicit `actor` so we can shell out as lead OR worker.
// =============================================================================

function resolveTmCli() {
  if (process.env.COCO_TM_CLI) return process.env.COCO_TM_CLI;
  const installed = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/tm.js');
  if (fs.existsSync(installed)) return installed;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../../..', 'src/cli/tm.js');
}
const TM_CLI = resolveTmCli();

export async function tm(cmd, params = {}, opts = {}) {
  const { actor = 'lead', env: envArg } = opts;
  const env = envArg || loadEnv();
  let token;
  if (actor === 'lead') {
    token = env.TEST_USER_TOKEN;
  } else if (actor === 'worker') {
    token = await getWorkerJwt(env);
  } else {
    die(`tm(): unknown actor "${actor}", expected "lead" or "worker"`);
  }
  const childEnv = {
    ...process.env,
    COCO_AUTH_TOKEN: token,
    COCO_USER_TOKEN: token,
    COCO_RPC_LOG:    process.env.COCO_RPC_LOG ?? '0',
  };
  const { stdout } = await exec('node', [TM_CLI, cmd, JSON.stringify(params)], {
    env: childEnv,
    cwd: path.dirname(path.dirname(TM_CLI)),
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function listIssuesInProject(projectId, opts = {}) {
  const r = await tm('issue.list_in_project', { projectId }, opts);
  return Array.isArray(r) ? r : (r.data || []);
}
export async function listTasks(issueId, opts = {}) {
  const r = await tm('task.list', { issueId }, opts);
  return Array.isArray(r) ? r : (r.data || []);
}
export async function listAttempts(taskId, opts = {}) {
  const r = await tm('attempt.list', { taskId }, opts);
  return Array.isArray(r) ? r : (r.data || []);
}

// =============================================================================
// sendInstruction — accepts an explicit `to` so we can route NL to either
// actor's conv.
// =============================================================================

export async function sendInstruction(env, instructionText, opts = {}) {
  const { to = 'lead', client_msg_id = `smoke-multi-${Date.now()}` } = opts;
  let convId;
  if (to === 'lead')        convId = env.lead.conv_id;
  else if (to === 'worker') convId = env.worker.conv_id;
  else die(`sendInstruction: unknown 'to' = "${to}" (expected "lead" | "worker")`);

  const headers = {
    'Authorization': `Bearer ${env.TEST_USER_TOKEN}`,
    'Content-Type':  'application/json',
    ...cfHeaders(env),
  };
  const body = {
    client_msg_id,
    type: 'TEXT',
    content: {
      content_type: 'text',
      body: { text: instructionText },
      attachments: [],
    },
  };
  const res = await fetch(
    `${env.COCO_API_URL}/api/v1/conversations/${convId}/messages`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  );
  const text = await res.text();
  if (!res.ok) die(`sendInstruction(to=${to}) HTTP ${res.status}: ${text.slice(0, 500)}`);
  ok(`instruction sent to ${to.toUpperCase()} (client_msg_id=${client_msg_id})`);
  return { to, client_msg_id, raw: text };
}

// =============================================================================
// waitForIssue — polls listIssuesInProject(asActor) until predicate matches
// and (optionally) targetStatus is hit.
// =============================================================================

const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS     = 1500;

export async function waitForIssue(env, predicate, opts = {}) {
  const {
    targetStatus = null,
    actor        = 'lead',
    maxWaitMs    = DEFAULT_MAX_WAIT_MS,
    pollMs       = DEFAULT_POLL_MS,
    label        = 'waitForIssue',
  } = opts;
  const startedAt = Date.now();
  const statusTrace = [];
  let firstObservedStatus = null;
  let lastIssue = null;
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const issues = await listIssuesInProject(env.TEST_PROJECT_ID, { actor, env });
      const issue = issues.find(predicate);
      if (issue) {
        lastIssue = issue;
        if (firstObservedStatus === null) {
          firstObservedStatus = issue.status;
          log(`  · [${label}] first observed: status=${issue.status}`);
        }
        const lastTraced = statusTrace.length ? statusTrace[statusTrace.length - 1].status : null;
        if (issue.status !== lastTraced) {
          statusTrace.push({ status: issue.status, observedAt: Date.now() - startedAt });
          log(`  · [${label}] status → ${issue.status} (+${((Date.now()-startedAt)/1000).toFixed(1)}s)`);
        }
        if (targetStatus === null || issue.status === targetStatus) {
          return { issue, firstObservedStatus, statusTrace, durationMs: Date.now() - startedAt };
        }
      }
    } catch (e) {
      log(`  · [${label}] poll error (重试): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.error('');
  console.error(`✗ ${label} timed out after ${maxWaitMs}ms`);
  console.error(`  predicate matched? ${lastIssue ? 'yes — id=' + lastIssue.id : 'no'}`);
  console.error(`  firstObservedStatus: ${firstObservedStatus}`);
  console.error(`  statusTrace: ${JSON.stringify(statusTrace)}`);
  if (lastIssue) {
    try {
      const tasks = await listTasks(lastIssue.id, { actor, env });
      console.error(`  tasks: ${JSON.stringify(tasks.map(t => ({id:t.id, status:t.status, assignee:t.assignee_id})))}`);
    } catch (e) {
      console.error(`  state dump failed: ${e.message}`);
    }
  }
  process.exit(1);
}

// =============================================================================
// waitForTaskAssignee — useful for cross-actor claim cases:
// polls a known issue's tasks until one matches a predicate.
// =============================================================================

export async function waitForTaskAssignee(env, issueId, taskPredicate, opts = {}) {
  const {
    actor     = 'lead',
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    pollMs    = DEFAULT_POLL_MS,
    label     = 'waitForTaskAssignee',
  } = opts;
  const startedAt = Date.now();
  let lastTasks = [];
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const tasks = await listTasks(issueId, { actor, env });
      lastTasks = tasks;
      const match = tasks.find(taskPredicate);
      if (match) {
        log(`  · [${label}] matched task ${match.id} (assignee=${match.assignee_id}, status=${match.status}) (+${((Date.now()-startedAt)/1000).toFixed(1)}s)`);
        return match;
      }
    } catch (e) {
      log(`  · [${label}] poll error: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  console.error(`✗ ${label} timed out after ${maxWaitMs}ms`);
  console.error(`  last tasks: ${JSON.stringify(lastTasks.map(t => ({id:t.id, status:t.status, assignee:t.assignee_id})))}`);
  process.exit(1);
}

// =============================================================================
// Assertions + summary
// =============================================================================

let _passCount = 0, _failCount = 0;

export function assertEq(actual, expected, label) {
  if (actual === expected) { ok(`${label} = ${JSON.stringify(actual)}`); return; }
  die(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
export function assertTrue(cond, label) {
  if (cond) { ok(label); return; }
  die(label);
}
export function assertNot(cond, label) {
  if (!cond) { ok(label); return; }
  die(label);
}
export function assertIn(value, allowed, label) {
  if (allowed.includes(value)) { ok(`${label} ∈ ${JSON.stringify(allowed)} (got ${JSON.stringify(value)})`); return; }
  die(`${label}: expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`);
}
export function assertNullish(value, label) {
  if (value == null) { ok(`${label} = ${JSON.stringify(value)}`); return; }
  die(`${label}: expected null/undefined, got ${JSON.stringify(value)}`);
}

export function summary(name) {
  console.log('');
  if (_failCount === 0) {
    console.log(`✅ ${name} PASS — ${_passCount} assertions`);
  } else {
    console.error(`✗ ${name} FAIL — ${_failCount}/${_passCount + _failCount} failed`);
    process.exit(1);
  }
}
