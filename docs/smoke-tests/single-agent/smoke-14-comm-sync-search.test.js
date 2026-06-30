#!/usr/bin/env node
/**
 * Smoke 14 — Comm Sync + Search(NL 驱动)
 *
 * 见 smoke-14-comm-sync-search.md。1 轮 NL + 8 断言。
 */

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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
const NS = `Smoke14-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

const COMM_CLI = path.join(os.homedir(), 'zylos/.claude/skills/openmax/src/cli/comm.js');
async function comm(cmd, p = {}) {
  const { stdout } = await execp('node', [COMM_CLI, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
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

log(`=== Smoke 14 (NL): Comm Sync + Search ===  ${NS}`);
let cursor = await currentSeq();
const deviceId = crypto.randomUUID();

const NL1 = `我刚才电脑挂起了一段时间没看 IM。帮我:
1. 从 seq=0 开始把所有会话事件都补一下,看下离线期间漏了多少条
   (用 comm.sync 这条 CLI,deviceId 用 ${deviceId})
2. 列下当前所有会话(包括归档的也算上)
3. 帮我搜一下 KB 里跟 "Smoke" 相关的页面,大概有多少

3 项做完一行简报:漏了几条 / 总共多少会话 / 搜到几页。`;
await sendInstruction(env, NL1);
const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: ['漏', '事件', '会话', '搜', '页', 'event', '条'],
  maxMs: 120 * 1000,
});
cursor = Number(r1.msg.seq);

assertTrue(/漏|事件|event|条/.test(r1.text), `1. round1 含 漏 / 事件 / 条`);
assertTrue(/会话|conversation/i.test(r1.text), `2. round1 含 会话`);
assertTrue(/搜|search|页|page/i.test(r1.text), `3. round1 含 搜 / 页面`);
const nums = (r1.text.match(/\d+/g) || []);
assertTrue(nums.length >= 3, `4. round1 含 ≥ 3 个数字(漏的事件数 / 会话数 / 搜到数) (got ${nums.length})`);

// 旁路:sync from 0 with this deviceId
const sync0 = await comm('comm.sync', { sinceSeq: 0, deviceId, limit: 100 });
const events = sync0.events || sync0.items || [];
const hasMore = sync0.has_more ?? sync0.hasMore;
assertTrue(Array.isArray(events) && typeof hasMore === 'boolean',
    `5. comm.sync(sinceSeq=0) 返 events 数组 + has_more boolean (events=${events.length})`);

const convsArc = unwrapList(await comm('comm.list_conversations', { includeArchived: true,  limit: 100 }));
const convsAct = unwrapList(await comm('comm.list_conversations', { includeArchived: false, limit: 100 }));
assertTrue(convsArc.length >= convsAct.length,
    `6. includeArchived=true 长度 ≥ active (${convsArc.length} ≥ ${convsAct.length})`);

const searchRes = await comm('comm.search', { query: 'Smoke', limit: 5 });
const sdata = searchRes.data || searchRes.items || [];
const stotal = (searchRes.pagination && (searchRes.pagination.total_count ?? searchRes.pagination.totalCount)) ?? 0;
assertTrue(Array.isArray(sdata) && Number.isInteger(stotal),
    `7. comm.search 返 data 数组 + total integer (got data=${sdata.length} total=${stotal})`);

const syncFuture = await comm('comm.sync', { sinceSeq: 99999999, deviceId, limit: 50 });
const fEvents = syncFuture.events || [];
const fHasMore = syncFuture.has_more ?? syncFuture.hasMore;
assertTrue(fEvents.length === 0 && fHasMore === false,
    `8. comm.sync(sinceSeq=巨大) events 空 + has_more false`);

log('');
log(`✅ Smoke 14 (NL) PASS (8 / 8)`);
log(`   deviceId=${deviceId} convsActive=${convsAct.length} convsArc=${convsArc.length}`);
log(`   syncEvents(seq=0)=${events.length} searchHits=${sdata.length}/${stotal}`);
