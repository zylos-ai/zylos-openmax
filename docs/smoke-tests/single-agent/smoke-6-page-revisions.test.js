#!/usr/bin/env node
/**
 * Smoke 6 — 多轮编辑 + 版本对比(NL 驱动)
 *
 * 见同目录 smoke-6-page-revisions.md 完整 spec。
 * 5 轮 NL + 全程旁路。15 断言。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, assertEq, assertTrue, log, ok, die } from './lib/runner.js';
const execp = promisify(execFile);

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_CONV_ID', 'TEST_AGENT_ID', 'TEST_DEFAULT_KB_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
const env = {
  COCO_API_URL:            process.env.COCO_API_URL.replace(/\/+$/, ''),
  TEST_USER_TOKEN:         process.env.TEST_USER_TOKEN,
  TEST_CONV_ID:            process.env.TEST_CONV_ID,
  TEST_AGENT_ID:           process.env.TEST_AGENT_ID,
  TEST_DEFAULT_KB_ID:      process.env.TEST_DEFAULT_KB_ID,
  COCO_AUTH_TOKEN:         process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN,
  CF_ACCESS_CLIENT_ID:     process.env.CF_ACCESS_CLIENT_ID     || '',
  CF_ACCESS_CLIENT_SECRET: process.env.CF_ACCESS_CLIENT_SECRET || '',
};
process.env.COCO_AUTH_TOKEN = env.COCO_AUTH_TOKEN;
process.env.COCO_RPC_LOG = '0';

const TS = Date.now();
const NS = `Smoke6-${TS}`;

const KB = path.join(os.homedir(), 'zylos/.claude/skills/openmax/src/cli/kb.js');
async function kb(cmd, p = {}) {
  const { stdout } = await execp('node', [KB, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data || r;
}
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

function headers() {
  const h = { Authorization: `Bearer ${env.TEST_USER_TOKEN}`, 'Content-Type': 'application/json' };
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}
async function listAgentMessagesAfter(seq) {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=50`, { headers: headers() });
  if (!res.ok) throw new Error(`list-messages HTTP ${res.status}`);
  const body = await res.json();
  const msgs = unwrapList(body).filter(m => {
    const kind = (m.sender_type || m.sender_kind || m.type || '').toUpperCase();
    return kind.includes('AGENT');
  });
  return msgs.filter(m => Number(m.seq || 0) > seq).sort((a,b) => Number(a.seq) - Number(b.seq));
}
function extractText(msg) {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  if (c.body && typeof c.body.text === 'string') return c.body.text;
  if (Array.isArray(c)) return c.map(p => p?.body || p?.text || '').join('\n');
  try { return JSON.stringify(c); } catch { return ''; }
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
        if (matchAny.length === 0 || matchAny.some(p => text.includes(p))) {
          return { msg: m, text };
        }
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

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

// -- Run ------------------------------------------------------------------
log(`=== Smoke 6 (NL): 多轮编辑 + diff ===  ${NS}`);
let cursor = await currentSeq();

// Round 1
log('[Phase 1/2] round1 NL — 起初版');
const NL1 = `帮我起一份 ${NS} 的 LLM 推理优化对比文档,放在默认知识库根目录下。

初版只写 3 个要点(每行一句):
- 点A:KV cache 压缩
- 点B:speculative decoding
- 点C:flash attention v3

建完用一行简短日志告诉我 pageId。`;
await sendInstruction(env, NL1);

const r1 = await waitForCard({ label: 'round1', sinceSeq: cursor, matchAny: [NS, 'pageId', 'page id'], maxMs: 90*1000 });
cursor = Number(r1.msg.seq);
const uuidMatch = r1.text.match(UUID_RE);
assertTrue(uuidMatch, `1. round1 回复含 pageId (uuid)`);
const pageId = uuidMatch[0];
log(`   captured pageId = ${pageId}`);
// 接受两种回复风格:
//   (a) 逐点复读 — 命中三个关键词(原来的检查)
//   (b) 汇总 — agent 提到"3 点 / 三点 / 3 points"已写
// 实际的内容落地由下面 assertion 11(page body 含 点A+B+C)backing 验证,
// 这里只检查 agent 在回复里确认了写入动作完成。
const hasAllThree = /点A|A[:\s].*KV cache|cache 压缩/.test(r1.text)
                 && /点B|speculative/.test(r1.text)
                 && /点C|flash attention/.test(r1.text);
const hasSummary  = /3\s*点|三\s*点|3\s*points|all three|三个要点/i.test(r1.text);
assertTrue(hasAllThree || hasSummary,
    '2. 回复表达初版三点已写(逐条 OR 汇总,page 内容由 assertion 11 backing)');

// Backing
const pg = await kb('kb.page_get', { pageId });
assertTrue(pg && pg.id === pageId, '10a. page_get 返 2xx');
assertTrue((pg.title || '').includes(NS), `10b. page.title 含 ${NS}`);
const body1 = ((await kb('kb.page_content', { pageId })).body || '');
assertTrue(body1.includes('点A') && body1.includes('点B') && body1.includes('点C'),
    `11. page body 含 点A + 点B + 点C`);

// Round 2 - add D
log('[Phase 3/4] round2 NL — 加点 D');
const NL2 = `在刚才那个 ${NS} 文档里加一个新要点:
- 点D:continuous batching
加完告诉我现在这个 page 有几个 revision。`;
await sendInstruction(env, NL2);
const r2 = await waitForCard({ label: 'round2', sinceSeq: cursor, matchAny: ['点D', 'D:', 'continuous batching'], maxMs: 60*1000 });
cursor = Number(r2.msg.seq);
assertTrue(/点D|continuous batching/.test(r2.text), '3. round2 回复含 "D"');
const revCountMatch = r2.text.match(/(\d+)\s*(?:个|条)?\s*revision/i);
const reportedRevCount = revCountMatch ? Number(revCountMatch[1]) : null;
assertTrue(reportedRevCount === null || reportedRevCount >= 2, `4. revision 数 ≥ 2 (agent 报 ${reportedRevCount})`);

// Round 3 - add E
log('[Phase 5/6] round3 NL — 加点 E');
const NL3 = `继续加一点:
- 点E:tensor parallelism + sequence parallelism
加完汇报一次。`;
await sendInstruction(env, NL3);
const r3 = await waitForCard({ label: 'round3', sinceSeq: cursor, matchAny: ['点E', 'E:', 'tensor parallelism'], maxMs: 60*1000 });
cursor = Number(r3.msg.seq);
assertTrue(/点E|tensor parallelism|sequence parallelism/.test(r3.text), '5. round3 回复含 "E"');

// Backing after round3
const revs = unwrapList(await kb('kb.page_revisions', { pageId, limit: 50 }));
assertTrue(revs.length >= 2, `12. page_revisions ≥ 2 (got ${revs.length})`);
const body3 = ((await kb('kb.page_content', { pageId })).body || '');
assertTrue(body3.includes('点D') && body3.includes('点E'), '13. page body 含 点D + 点E');

// Round 4 - ask agent to diff
log('[Phase 7/8] round4 NL — diff 总结');
const NL4 = `对比一下 ${NS} 现在的版本和最初版,告诉我从初版到现在新增了哪些要点(不要重述初版有的内容)。`;
await sendInstruction(env, NL4);
const r4 = await waitForCard({ label: 'round4', sinceSeq: cursor, matchAny: ['点D', 'D', '新增', '加了', '加入'], maxMs: 60*1000 });
cursor = Number(r4.msg.seq);
assertTrue(/点D|D[:\s]|continuous batching/.test(r4.text) && /点E|E[:\s]|tensor parallelism|sequence parallelism/.test(r4.text),
    '6. round4 回复同时含 D 和 E(新增的两点)');
const hasABCRepeat = /点A.*KV|cache 压缩.*改进/.test(r4.text) && /点B.*specu/.test(r4.text);
assertTrue(!hasABCRepeat, '7. round4 回复未重复 A/B/C 三点(按指令自检)');

// Backing diff
if (revs.length >= 2) {
  const oldest = revs[revs.length - 1];
  const newest = revs[0];
  try {
    const diff = await kb('kb.page_diff', { pageId, fromRevisionId: oldest.id, toRevisionId: newest.id });
    const diffText = typeof diff === 'string' ? diff : (diff.diff || diff.body || diff.text || JSON.stringify(diff));
    const hasPlus = /^\+|\n\+/.test(diffText);
    assertTrue(hasPlus && /点D|continuous batching/.test(diffText) && /点E|tensor parallelism/.test(diffText),
        '14. page_diff 文本含 "+" 行 + 点D + 点E');
  } catch (e) {
    die(`14. page_diff 调用失败: ${e.message}`);
  }
}

// Round 5 - cleanup
log('[Phase 10/11] round5 NL — cleanup');
const NL5 = `把 ${NS} 这个 page 永久删掉,删完跟我确认。`;
await sendInstruction(env, NL5);
const r5 = await waitForCard({ label: 'round5', sinceSeq: cursor, matchAny: ['已删', '已清理', '删除完成'], maxMs: 60*1000 });
assertTrue(/已删|已清理|删除完成/.test(r5.text), '8. round5 回复含已删除语义');
assertTrue(r5.text.includes(pageId) || r5.text.includes(NS), '9. round5 回复回归 pageId/NS');

// Backing: page is gone
try {
  await kb('kb.page_get', { pageId });
  die('15. page_get 应非 2xx,实际通了');
} catch { ok('15. page_get 返非 2xx(预期 404,page 已永久删)'); }

log('');
log(`✅ Smoke 6 (NL) PASS (15 / 15)`);
log(`   pageId tested = ${pageId}`);
