#!/usr/bin/env node
//
// Smoke-suite orchestrator. Runs the curated smoke set (smoke-set.json)
// sequentially and prints a pass/fail summary. Intended to be kicked off
// automatically after a new deployment so the bot self-verifies the core
// cross-agent / task-flow / upload paths.
//
// LEAD is self (the bot running this — resolved from the runtime config).
// Single-agent cases need no extra input. Multi-agent cases need the WORKER
// agent's api_key, provided by the caller via SMOKE_WORKER_API_KEY.
//
// Usage:
//   node docs/smoke/run-smoke.js                          # all cases
//   node docs/smoke/run-smoke.js single-8 multi-5         # subset (by id)
//   SMOKE_WORKER_API_KEY=cwsk_... node ... run-smoke.js   # enable multi cases
//   SMOKE_NOTIFY="lark|<endpoint>" node ... run-smoke.js  # report via C4
//   SMOKE_USER=<test-user-b> ...                         # drive NL as other user
//
// Exit code: 0 if all pass, 1 if any fail (so CI / hooks can gate on it).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SET = JSON.parse(fs.readFileSync(path.join(HERE, 'smoke-set.json'), 'utf8'));

const wanted = process.argv.slice(2);
const cases = wanted.length ? SET.cases.filter(c => wanted.includes(c.id)) : SET.cases;
if (!cases.length) {
  console.error('no matching cases for:', wanted.join(', '));
  process.exit(2);
}

function runCase(c) {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`\n▶ ${c.id}  (${c.covers})`);
    const child = spawn('node', [path.join(HERE, c.file)], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    child.on('close', (code) => {
      const secs = ((Date.now() - start) / 1000).toFixed(0);
      resolve({ ...c, pass: code === 0, code, secs });
    });
  });
}

const results = [];
for (const c of cases) {
  // sequential: multi-agent cases share the LEAD↔WORKER conversation and the
  // smoke project, so parallel runs would interfere.
  // eslint-disable-next-line no-await-in-loop
  results.push(await runCase(c));
}

const passed = results.filter(r => r.pass);
const failed = results.filter(r => !r.pass);

const lines = results.map(r => `${r.pass ? '✅' : '❌'} ${r.id.padEnd(10)} ${r.secs}s  ${r.covers}`);
const summary = [
  `Smoke suite: ${passed.length}/${results.length} passed`,
  ...lines,
  ...(failed.length ? [`\nFailed: ${failed.map(f => `${f.id}(exit ${f.code})`).join(', ')}`] : []),
].join('\n');

console.log(`\n${'='.repeat(60)}\n${summary}\n${'='.repeat(60)}`);

// Optional C4 notification (SMOKE_NOTIFY="<channel>|<endpoint>"), e.g.
//   SMOKE_NOTIFY="lark|oc_xxx|type:p2p" node run-smoke.js
// Uses the comm-bridge C4 sender (stdin mode — multi-line safe).
const notify = process.env.SMOKE_NOTIFY;
if (notify) {
  const sep = notify.indexOf('|');
  const channel = notify.slice(0, sep);
  const endpoint = notify.slice(sep + 1);
  const c4send = path.join(process.env.HOME || '', 'zylos/.claude/skills/comm-bridge/scripts/c4-send.js');
  try {
    const send = spawn('node', [c4send, channel, endpoint], { stdio: ['pipe', 'ignore', 'inherit'] });
    send.stdin.write(`【部署后冒烟】${passed.length}/${results.length} 通过\n${lines.join('\n')}`);
    send.stdin.end();
  } catch (e) {
    console.error('C4 notify failed:', e.message);
  }
}

process.exit(failed.length ? 1 : 0);
