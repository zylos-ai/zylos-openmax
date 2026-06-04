#!/usr/bin/env node
/**
 * Smoke 10 — KB 实例生命周期(NL 驱动)
 *
 * 见同目录 smoke-10-kb-instance-lifecycle.md。3 轮 NL + 12 断言。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, log, ok, die, assertEq, assertTrue } from './lib/runner.js';
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
const NS = `Smoke10-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const KB_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/kb.js');
async function kb(cmd, p = {}) {
  const { stdout } = await execp('node', [KB_CLI, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
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
  if (!res.ok) throw new Error(`list-messages HTTP ${res.status}`);
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

// ---- Run --------------------------------------------------------------------
log(`=== Smoke 10 (NL): KB 实例生命周期 ===  ${NS}`);
let cursor = await currentSeq();

// ---------- Round 1 ----------
log('[Round 1] 建 KB + 一页笔记');
const NL1 = `我想新建一个独立 KB 做 ${NS} 实验:
1. 新建一个 KB 叫 "${NS}",描述写"KB 实例生命周期实验"
2. 在这个新 KB 的根目录下建一页测试笔记,标题 "${NS} 测试笔记",
   内容写 "# Smoke10\\n初版内容,一会儿要改名挪路径再冻结"

建完一行报 kbId + pageId。`;
await sendInstruction(env, NL1);
const r1 = await waitForCard({
  label: 'round1', sinceSeq: cursor,
  matchAny: [NS, 'kbId', 'pageId', '已建'],
  maxMs: 120 * 1000,
});
cursor = Number(r1.msg.seq);

const uuids1 = r1.text.match(new RegExp(UUID_RE.source, 'gi')) || [];
assertTrue(uuids1.length >= 2, `1. round1 含 ≥ 2 uuid (got ${uuids1.length})`);
assertTrue(/KB 已建|KB 创建|笔记|已建|创建/.test(r1.text), `2. round1 含 KB + 笔记 已建`);

// 旁路:找新建的 KB
const kbList = unwrapList(await kb('kb.list', { limit: 100 }));
const newKb = kbList.find(k => (k.name || '').includes(NS));
assertTrue(newKb && newKb.id, `7. kb.list 含 ${NS}`);
log(`   newKbId=${newKb.id}`);
const newKbId = newKb.id;
const status0 = (newKb.status || '').toLowerCase();
assertTrue(status0 === 'active' || !newKb.archived, `8. new KB status == active (got "${status0}")`);

// 找新建的 page(roots → children walk)
const roots = unwrapList(await kb('kb.tree_roots', { kbId: newKbId }));
// Tree node id (`id`) and page id (`page_id`) are distinct UUIDs even for a
// page node — node_breadcrumb later needs the tree node id, not the page id.
let foundPageId = null;
let foundNodeId = null;
for (const r of roots) {
  if (r.node_type === 'page' && (r.name || '').includes(NS)) {
    foundPageId = r.page_id || r.pageId;
    foundNodeId = r.id;
    break;
  }
}
if (!foundPageId) {
  // 也可能在某个 folder 下
  for (const r of roots) {
    if (r.node_type === 'folder') {
      const kids = unwrapList(await kb('kb.node_children', { kbId: newKbId, nodeId: r.id }));
      const p = kids.find(n => n.node_type === 'page' && (n.name || '').includes(NS));
      if (p) {
        foundPageId = p.page_id || p.pageId;
        foundNodeId = p.id;
        break;
      }
    }
  }
}
assertTrue(foundPageId, `(pre-2) 在 KB 树里找到新 page`);
log(`   pageId=${foundPageId}  nodeId=${foundNodeId}`);

// ---------- Round 2 ----------
log('[Round 2] 改 page metadata + freeze + breadcrumb');
const NL2 = `那个 ${NS} 测试笔记:
- 标题改成 "${NS} 测试笔记(已重命名)"
- path 改成 "/smoke10-renamed"
- 改完冻结这一页(以后不让人改了)

最后给我看下这个 page 在 KB 树里的 breadcrumb 路径,顺便列下有没有 references。`;
await sendInstruction(env, NL2);
const r2 = await waitForCard({
  label: 'round2', sinceSeq: cursor,
  matchAny: ['重命名', 'renamed', '冻结', 'freeze', 'breadcrumb'],
  maxMs: 120 * 1000,
});
cursor = Number(r2.msg.seq);

assertTrue(/重命名|renamed/i.test(r2.text) && /冻结|freeze|frozen/i.test(r2.text),
    `3. round2 含 重命名 + 冻结`);
assertTrue(/breadcrumb|路径|目录/.test(r2.text),
    `4. round2 含 breadcrumb / 路径`);

// 旁路:page 改名生效
const pg2 = await kb('kb.page_get', { pageId: foundPageId });
assertTrue(/重命名|renamed/i.test(pg2.title || ''),
    `9a. page.title 含 重命名/renamed (got "${(pg2.title||'').slice(0,80)}")`);
assertTrue((pg2.path || '').includes('smoke10-renamed'),
    `9b. page.path 含 smoke10-renamed (got "${pg2.path}")`);

const crumb = await kb('kb.node_breadcrumb', { kbId: newKbId, nodeId: foundNodeId });
assertTrue(unwrapList(crumb).length >= 1, `10. node_breadcrumb 返 ≥ 1 段`);

// ---------- Round 3 ----------
log('[Round 3] archive → unarchive → delete');
const NL3 = `${NS} 这个 KB 实验做完了,操作三步:
1. 先归档(走 archive)
2. 等会发现还需要看,unarchive 恢复
3. 真不用了,delete 永久删

每一步操作完一行简单日志,最后确认这个 KB 已经删了(get 应该 4xx 或显示 deleted)。`;
await sendInstruction(env, NL3);
const r3 = await waitForCard({
  label: 'round3', sinceSeq: cursor,
  matchAny: ['归档', '恢复', '删除', 'deleted', 'archive', 'unarchive'],
  maxMs: 150 * 1000,
});
cursor = Number(r3.msg.seq);

assertTrue(/归档|archive/i.test(r3.text), `5a. round3 含 归档`);
assertTrue(/恢复|unarchive|restore/i.test(r3.text), `5b. round3 含 恢复`);
assertTrue(/删|delet/i.test(r3.text), `5c. round3 含 删除`);
assertTrue(/已删|delet|消失|不在/i.test(r3.text), `6. round3 表达 KB 已删`);

// 旁路:list 中要么找不到 newKbId,要么 status != active
const kbListAfter = unwrapList(await kb('kb.list', { limit: 100 }));
const stillThere = kbListAfter.find(k => k.id === newKbId);
if (!stillThere) {
  ok(`11. kb.list 找不到 newKbId(硬删)`);
} else {
  const s = (stillThere.status || '').toLowerCase();
  assertTrue(s !== 'active', `11. kb.list 找到 newKbId 但 status != active (got "${s}")`);
}

let assertion12Pass = false;
try {
  const g = await kb('kb.get', { kbId: newKbId });
  if (g && (g.status || '').toLowerCase() === 'deleted') {
    ok(`12. kb.get 软删 status=deleted`);
    assertion12Pass = true;
  } else {
    die(`12. kb.get 仍 200 且 status=${g.status}`);
  }
} catch (e) {
  if (/4\d\d|not.?found|gone/i.test(e.message)) {
    ok(`12. kb.get 4xx(硬删)`);
    assertion12Pass = true;
  } else {
    die(`12. kb.get 抛非 4xx: ${e.message}`);
  }
}
assertTrue(assertion12Pass, `12. kb.delete 行为符合预期`);

// ---------------------------------------------------------------------------
log('');
log(`✅ Smoke 10 (NL) PASS (12 / 12)`);
log(`   newKbId = ${newKbId}  (created → updated → frozen → archive → unarchive → deleted)`);
log(`   pageId  = ${foundPageId}`);
