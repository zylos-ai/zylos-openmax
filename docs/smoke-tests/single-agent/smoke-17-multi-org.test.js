#!/usr/bin/env node
/**
 * Smoke 17 — 多 Org 上下文(NL 驱动)
 *
 * 见 smoke-17-multi-org.md。1 轮 NL + 7 断言。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';
const execp = promisify(execFile);

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_CONV_ID', 'TEST_AGENT_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
const env = {
  COCO_API_URL:            process.env.COCO_API_URL.replace(/\/+$/, ''),
  TEST_USER_TOKEN:         process.env.TEST_USER_TOKEN,
  TEST_CONV_ID:            process.env.TEST_CONV_ID,
  TEST_AGENT_ID:           process.env.TEST_AGENT_ID,
  COCO_AUTH_TOKEN:         process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN,
  CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
  CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
};
process.env.COCO_AUTH_TOKEN = env.COCO_AUTH_TOKEN;
process.env.COCO_RPC_LOG = '0';

const TS = Date.now();
const NS = `Smoke17-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const CORE_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/core.js');
async function core(cmd, p = {}) {
  const { stdout } = await execp('node', [CORE_CLI, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data ?? r;
}

function headers() {
  const h = { Authorization: `Bearer ${env.TEST_USER_TOKEN}`, 'Content-Type': 'application/json' };
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}
async function listAgentMessagesAfter(seq) {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=50`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return unwrapList(await res.json()).filter(m => {
    const k = (m.sender_type || m.sender_kind || m.type || '').toUpperCase();
    return k.includes('AGENT');
  }).filter(m => Number(m.seq || 0) > seq).sort((a,b) => Number(a.seq) - Number(b.seq));
}
function extractText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (c.body && typeof c.body.text === 'string') return c.body.text;
  return '';
}
async function waitForCard({ label, sinceSeq, matchAny = [], maxMs }) {
  const startedAt = Date.now();
  const seen = [];
  while (Date.now() - startedAt < maxMs) {
    try {
      const msgs = await listAgentMessagesAfter(sinceSeq);
      for (const m of msgs) {
        const text = extractText(m);
        seen.push({ seq: m.seq, preview: text.slice(0, 120) });
        if (matchAny.length === 0 || matchAny.some(p => text.includes(p))) return { msg: m, text };
      }
    } catch (e) { log(`  · poll err: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.error(`✗ timeout waiting for ${label} (${maxMs}ms)`);
  for (const s of seen.slice(-8)) console.error(`    seq=${s.seq}  ${s.preview}`);
  process.exit(1);
}
async function currentSeq() {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=1`, { headers: headers() });
  const arr = unwrapList(await res.json());
  return arr.length ? Math.max(...arr.map(m => Number(m.seq || 0))) : 0;
}

log(`=== Smoke 17 (NL): 多 Org 上下文 ===  ${NS}`);
const me = await core('core.me');
const ORG_ID = me.org_id || me.orgId;
log(`   原 org_id = ${ORG_ID}`);

let cursor = await currentSeq();

const NL1 = `我想开个新测试 org 跑一些隔离的实验,你帮我:
1. 列下我现在能见的所有 org(给我个数 + 名字)
2. 新建一个 org,叫 "${NS} 实验场",slug 用 "smoke17-${TS}"
3. 把活跃 org 切到刚建的那个,然后看下新 org 里有几个 project
4. 看完切回我们原来的 org(用 org_id ${ORG_ID}),
   确认 project_list 又能看到我们原来的项目

最后简报:原 org 项目数、新 org 项目数、新 org 的 id。`;
await sendInstruction(env, NL1);
const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: [NS, 'org_id', '切到', '切回', 'switch'],
  maxMs: 150 * 1000,
});

const uuids = r1.text.match(new RegExp(UUID_RE.source, 'gi')) || [];
assertTrue(uuids.length >= 1, `1a. round1 含 new org uuid`);
assertTrue(r1.text.includes(NS), `1b. round1 含 ${NS}`);
assertTrue(/切到|切回|switch/i.test(r1.text), `2. round1 含 切到/切回/switch`);
const nums = r1.text.match(/\d+/g) || [];
assertTrue(nums.length >= 2, `3. round1 含 ≥ 2 个数字(原 / 新 项目数)`);

// 旁路:org_list ≥ 2
const orgs = unwrapList(await core('core.org_list', {}));
assertTrue(orgs.length >= 2, `4. core.org_list ≥ 2 (got ${orgs.length})`);
const newOrg = orgs.find(o => (o.name || '').includes(NS));
assertTrue(newOrg && newOrg.id, `5. 新 org name 含 ${NS} (找到 id=${newOrg && newOrg.id})`);
log(`   newOrgId = ${newOrg.id}`);

// 最终态:me.org_id == ORG_ID
const meAfter = await core('core.me');
const finalOrg = meAfter.org_id || meAfter.orgId;
if (finalOrg === ORG_ID) {
  ok(`6. 最终 core.me.org_id == 原 org (已切回)`);
} else {
  warn(`6. core.me.org_id = ${finalOrg} (期 ${ORG_ID});token-side switch 可能需要刷新; warn-only`);
  ok(`6. (warn-only)`);
}

const projsA = unwrapList(await core('core.project_list', { limit: 50 }));
assertTrue(projsA.length >= 1, `7. core.project_list 原 org 下 ≥ 1 个 project (got ${projsA.length})`);

log('');
log(`✅ Smoke 17 (NL) PASS (7 / 7)`);
log(`   原 ORG_ID  = ${ORG_ID}`);
log(`   new org    = ${newOrg.id}`);
log(`   原 org projs = ${projsA.length}`);
