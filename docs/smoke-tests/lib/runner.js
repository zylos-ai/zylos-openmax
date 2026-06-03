// Smoke-test shared runner.
//
// Each smoke-N.test.js imports this module, builds a per-case instruction
// text + predicate + assertions, and calls runSmokeCase(). Per-case .test.js
// files stay focused on what the case actually verifies.
//
// Notable design choices vs the older docs/smoke-tests draft:
//
//   1. sendInstruction uses the **current cws-core sendMessageRequest schema**
//      (top-level `type`, single `content` object with `content_type` + body
//      object + attachments array). The older draft posted the deprecated
//      `{content: [{type, body}], reply_to}` shape that cws-core now 422s
//      against (see zylos-coco-workspace MR !31).
//
//   2. sendInstruction injects CF-Access-Client-Id / CF-Access-Client-Secret
//      headers when the cws-int gateway is fronted by Cloudflare Access. The
//      service-token values are read from env (CF_ACCESS_CLIENT_ID /
//      CF_ACCESS_CLIENT_SECRET); when both are unset the headers are omitted
//      so this runner also works against a plain (non-CF) deployment.
//
//   3. tm() shells out to a real tm.js binary. By default it points at the
//      installed coco-workspace skill copy
//      (~/zylos/.claude/skills/coco-workspace/src/cli/tm.js) because that
//      copy carries the cf-access.js + multi-org client wiring agents use in
//      production. The repo-local copy is wired identically on main now, so
//      either works; override with COCO_TM_CLI when needed.
//
// Pure Node 20+ — native fetch + child_process. No npm deps.

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
export const ok   = (s) => console.log(`${ts()}   ✓ ${s}`);
export const warn = (s) => console.warn(`${ts()}   ⚠ ${s}`);
export const die  = (s) => { console.error(`✗ ${s}`); process.exit(1); };

// =============================================================================
// Env validation
// =============================================================================

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_CONV_ID',
                  'TEST_AGENT_ID', 'TEST_PROJECT_ID'];

export function loadEnv() {
  for (const k of REQUIRED) {
    if (!process.env[k]) {
      console.error(`✗ Missing required env: ${k}`);
      console.error(`  Required: ${REQUIRED.join(', ')}`);
      console.error(`  Optional: COCO_AUTH_TOKEN (defaults to TEST_USER_TOKEN)`);
      console.error(`            CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET`);
      console.error(`              (needed only when cws-int is behind Cloudflare Access)`);
      console.error(`            COCO_TM_CLI (path to tm.js; default = installed skill copy)`);
      process.exit(2);
    }
  }
  if (!process.env.COCO_AUTH_TOKEN) {
    process.env.COCO_AUTH_TOKEN = process.env.TEST_USER_TOKEN;
    warn(`COCO_AUTH_TOKEN unset — falling back to TEST_USER_TOKEN`);
  }
  return {
    COCO_API_URL:    process.env.COCO_API_URL,
    TEST_USER_TOKEN: process.env.TEST_USER_TOKEN,
    TEST_CONV_ID:    process.env.TEST_CONV_ID,
    TEST_AGENT_ID:   process.env.TEST_AGENT_ID,
    TEST_PROJECT_ID: process.env.TEST_PROJECT_ID,
    COCO_AUTH_TOKEN: process.env.COCO_AUTH_TOKEN,
    CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
    CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
  };
}

// =============================================================================
// tm.js CLI wrapper
// =============================================================================

function resolveTmCli() {
  if (process.env.COCO_TM_CLI) return process.env.COCO_TM_CLI;
  const installed = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/tm.js');
  if (fs.existsSync(installed)) return installed;
  // fallback to repo-local (this file lives at docs/smoke-tests/lib/runner.js,
  // so REPO_ROOT is three levels up)
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../..', 'src/cli/tm.js');
}

const TM_CLI = resolveTmCli();

export async function tm(cmd, params = {}) {
  const { stdout } = await exec('node', [TM_CLI, cmd, JSON.stringify(params)], {
    env: process.env,
    cwd: path.dirname(path.dirname(TM_CLI)), // skill dir or repo root
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

// List helpers — unwrap envelope or array transparently.
export async function listTasks(issueId) {
  const r = await tm('task.list', { issueId });
  return Array.isArray(r) ? r : (r.data || []);
}
export async function listAttempts(taskId) {
  const r = await tm('attempt.list', { taskId });
  return Array.isArray(r) ? r : (r.data || []);
}
export async function listIssuesInProject(projectId) {
  const r = await tm('issue.list_in_project', { projectId });
  return Array.isArray(r) ? r : (r.data || []);
}

// =============================================================================
// sendInstruction
//   - posts a user-facing message into the test conversation; the agent
//     runtime (Claude Code session bound to TEST_AGENT_ID) receives it via WS
//     push and executes the requested tm.js / kb.js flow.
// =============================================================================

export async function sendInstruction(env, instructionText, opts = {}) {
  const { client_msg_id = `smoke-${Date.now()}` } = opts;

  const headers = {
    'Authorization': `Bearer ${env.TEST_USER_TOKEN}`,
    'Content-Type':  'application/json',
  };
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  }

  // cws-core sendMessageRequest body (current schema, internal/transport/http/message.go):
  //   { client_msg_id, type, content: {content_type, body, attachments}, parent_id?, ... }
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
    `${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  );

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON */ }

  if (!res.ok) die(`sendInstruction HTTP ${res.status}: ${text.slice(0, 500)}`);
  if (parsed && (parsed.error || parsed.code === 'ERROR' || parsed.success === false)) {
    die(`sendInstruction 2xx but body indicates error: ${JSON.stringify(parsed)}`);
  }

  log(`  response body: ${text.slice(0, 500)}${text.length > 500 ? '…' : ''}`);
  ok(`instruction sent (client_msg_id=${client_msg_id})`);
  return { client_msg_id, body: parsed };
}

// =============================================================================
// waitForCompletion
//   - polls issue list until predicate matches and status hits targetStatus.
//   - records firstObservedStatus + full statusTrace (status transitions only).
//   - on timeout: dumps last observed issue + its tasks + their attempts.
// =============================================================================

const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_POLL_MS     = 3000;

export async function waitForCompletion(env, predicate, opts = {}) {
  const {
    targetStatus = 'accepted',
    maxWaitMs    = DEFAULT_MAX_WAIT_MS,
    pollMs       = DEFAULT_POLL_MS,
  } = opts;

  const startedAt = Date.now();
  const statusTrace = [];
  let firstObservedStatus = null;
  let lastIssue = null;

  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const issues = await listIssuesInProject(env.TEST_PROJECT_ID);
      const issue = issues.find(predicate);
      if (issue) {
        lastIssue = issue;
        if (firstObservedStatus === null) {
          firstObservedStatus = issue.status;
          log(`  · first observed: status=${issue.status}`);
        }
        const lastTraced = statusTrace.length ? statusTrace[statusTrace.length - 1].status : null;
        if (issue.status !== lastTraced) {
          statusTrace.push({ status: issue.status, observedAt: Date.now() - startedAt });
          log(`  · status transition → ${issue.status} (+${((Date.now()-startedAt)/1000).toFixed(1)}s)`);
        }
        if (issue.status === targetStatus) {
          return { issue, firstObservedStatus, statusTrace, durationMs: Date.now() - startedAt };
        }
      }
    } catch (e) {
      log(`  · poll error (将重试): ${e.message}`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  // Timeout — dump everything we observed
  console.error('');
  console.error(`✗ waitForCompletion timed out after ${maxWaitMs}ms`);
  console.error(`  predicate matched issue? ${lastIssue ? 'yes — id=' + lastIssue.id : 'no'}`);
  console.error(`  firstObservedStatus: ${firstObservedStatus}`);
  console.error(`  statusTrace: ${JSON.stringify(statusTrace)}`);
  if (lastIssue) {
    try {
      const tasks = await listTasks(lastIssue.id);
      console.error(`  tasks (${tasks.length}): ${JSON.stringify(tasks.map(t => ({id:t.id, status:t.status})))}`);
      for (const t of tasks) {
        const atts = await listAttempts(t.id);
        console.error(`    attempts of task ${t.id} (${atts.length}): ${JSON.stringify(atts.map(a => ({id:a.id, status:a.status, attempt_number:a.attempt_number})))}`);
      }
    } catch (e) {
      console.error(`  state dump failed: ${e.message}`);
    }
  }
  process.exit(1);
}

// =============================================================================
// Top-level case runner
//   - default flow: phase 1 send + phase 2 wait + phase 3 assertions.
//   - Smoke 3 (rejection rework) doesn't fit this 3-phase shape and drives
//     its own multi-turn flow directly in the .test.js, but still reuses
//     sendInstruction / waitForCompletion / tm.
// =============================================================================

export async function runSmokeCase({ name, instruction, predicate, assertions, opts = {} }) {
  const env = loadEnv();
  log(`=== ${name} ===`);

  log(`[Phase 1] 发指令到 conversation ${env.TEST_CONV_ID}`);
  await sendInstruction(env, instruction);

  log(`[Phase 2] 等待 agent 自主跑完 (poll ${(opts.pollMs ?? DEFAULT_POLL_MS)/1000}s, max ${(opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS)/60000}min)`);
  const result = await waitForCompletion(env, predicate, opts);

  log(`[Phase 3] 深度断言`);
  await assertions({ env, ...result });

  log('');
  log(`✅ ${name} PASS`);
  log(`   issueId   = ${result.issue.id}`);
  log(`   duration  = ${(result.durationMs/1000).toFixed(1)}s`);
  log(`   trace     = ${result.statusTrace.map(s => s.status).join(' → ')}`);
}

// =============================================================================
// Small assertion helpers used by .test.js — keep deliberately tiny to avoid
// dragging in jest/chai for what is at heart "if (x !== y) die".
// =============================================================================

export function assertEq(actual, expected, label) {
  if (actual === expected) { ok(`${label} = ${JSON.stringify(actual)}`); return; }
  die(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
export function assertTrue(cond, label) {
  if (cond) { ok(label); return; }
  die(label);
}
export function assertIn(value, allowed, label) {
  if (allowed.includes(value)) { ok(`${label} ∈ ${JSON.stringify(allowed)} (got ${JSON.stringify(value)})`); return; }
  die(`${label}: expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(value)}`);
}
