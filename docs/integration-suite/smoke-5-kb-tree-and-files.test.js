#!/usr/bin/env node
/**
 * Smoke 5 — KB 研究工作区(NL 驱动)
 *
 * 见同目录 smoke-5-kb-tree-and-files.md 完整 spec。
 *
 * 3 轮 NL 指令 + 全程旁路 KB 状态校验。Phase 1-7 / 18 断言。
 * 失败时**不**自动清理,留现场给排查;Phase 6/7 是 agent 自己负责清理。
 */

import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendInstruction, assertEq, assertTrue, log, ok, warn, die } from './lib/runner.js';
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
const NS = `Smoke5-${TS}`;

// -- KB CLI (裁判视角,不让 agent 跑,test client 自己跑只读检查) ---------
const KB = path.join(os.homedir(), 'zylos/.claude/skills/openmax/src/cli/kb.js');
async function kb(cmd, p = {}) {
  const { stdout } = await execp('node', [KB, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data || r;
}
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);

// -- Conversation message poll (与 Smoke 4 同款) -------------------------
function headers(extra = {}) {
  const h = { Authorization: `Bearer ${env.TEST_USER_TOKEN}`, 'Content-Type': 'application/json', ...extra };
  if (env.CF_ACCESS_CLIENT_ID)     h['CF-Access-Client-Id']     = env.CF_ACCESS_CLIENT_ID;
  if (env.CF_ACCESS_CLIENT_SECRET) h['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET;
  return h;
}
async function listAgentMessagesAfter(seq) {
  const url = `${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=50`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`list-messages HTTP ${res.status}: ${(await res.text()).slice(0,300)}`);
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
async function waitForCard({ label, sinceSeq, matchAll = [], matchAny = [], maxMs }) {
  const startedAt = Date.now();
  const seen = [];
  while (Date.now() - startedAt < maxMs) {
    try {
      const msgs = await listAgentMessagesAfter(sinceSeq);
      for (const m of msgs) {
        const text = extractText(m);
        seen.push({ seq: m.seq, preview: text.slice(0, 120) });
        const allOk = matchAll.length === 0 || matchAll.every(p => text.includes(p));
        const anyOk = matchAny.length === 0 || matchAny.some(p => text.includes(p));
        if (allOk && anyOk) return { msg: m, text };
      }
    } catch (e) { log(`  · poll err (将重试): ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.error(`✗ timeout waiting for ${label} (${maxMs}ms, sinceSeq=${sinceSeq})`);
  console.error('  Recent agent messages:');
  for (const s of seen.slice(-8)) console.error(`    seq=${s.seq}  ${s.preview}`);
  process.exit(1);
}
async function currentSeq() {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=1`, { headers: headers() });
  const body = await res.json();
  const arr = unwrapList(body);
  return arr.length ? Math.max(...arr.map(m => Number(m.seq || 0))) : 0;
}

// -- KB helpers -----------------------------------------------------------
async function listKbNamespacedNodes(ns) {
  // Walk the tree from roots; return any node whose name includes ns.
  const roots = unwrapList(await kb('kb.tree_roots', { kbId: env.TEST_DEFAULT_KB_ID }));
  const found = [];
  async function walk(node) {
    if (node.name && node.name.includes(ns)) found.push(node);
    const children = unwrapList(await kb('kb.node_children', { kbId: env.TEST_DEFAULT_KB_ID, parentId: node.id }).catch(() => ({})));
    for (const c of children) await walk(c);
  }
  for (const r of roots) await walk(r);
  return found;
}

// -- Run ------------------------------------------------------------------
log(`=== Smoke 5 (NL): KB 研究工作区 ===  ns=${NS}`);
let cursor = await currentSeq();
log(`  starting seq cursor = ${cursor}`);

// -- Round 1: build workspace --------------------------------------------
const NL1 = `帮我做一个 ${NS} 的研究项目工作区:

1. 在默认知识库下建两个目录:research 和 notes(名字前面加上 ${NS}/ 前缀以便区分)
2. 在 notes 目录下写两个对比页面:
   - 第一页标题 "${NS} Cursor vs Windsurf",内容写一段功能对比的 markdown
   - 第二页标题 "${NS} Claude Code vs Codex",同样写一段对比
3. 全部建好之后,用关键词 "${NS}" 在默认知识库搜一下,把搜到的标题列出来给我确认
4. 每一步执行完用一行简短日志报给我,结束打印两个目录的 nodeId、两个 page 的 pageId`;

log('[Phase 1/2] round 1 NL → agent build workspace');
await sendInstruction(env, NL1);

const r1 = await waitForCard({
  label: 'round1 workspace built',
  sinceSeq: cursor,
  matchAll: ['research', 'notes'],
  matchAny: [NS],
  maxMs: 90 * 1000,
});
cursor = Number(r1.msg.seq);

const t1 = r1.text;
assertTrue(t1.includes('research') && t1.includes('notes'), '2. agent 回复含 research + notes');
const haveCursorWindsurf = t1.includes('Cursor') && t1.includes('Windsurf');
const haveClaudeCodex    = t1.includes('Claude') && t1.includes('Codex');
assertTrue(haveCursorWindsurf || haveClaudeCodex || /Page A.*Page B/.test(t1) || /两个.*页面|两.*page/i.test(t1),
    '3. agent 回复列出**两个** page(标题或数量)');
assertTrue(/搜|search|hits|命中/i.test(t1), '4. agent 回复含 search 命中语义');
ok('1. round1 回复已到达');

// Backing assertions (kb side)
log('[Phase 3] backing: walk default KB tree + search');
const nsNodes = await listKbNamespacedNodes(NS);
const folders = nsNodes.filter(n => (n.node_type || n.type || '').toLowerCase().includes('folder')
                                  || /research|notes|writeup/.test(n.name || ''));
assertTrue(folders.length >= 2, `11. KB 树里能找到 ${NS} 命名空间下 ≥ 2 个 folder (got ${folders.length})`);

// 找到 notes folder(可能已被叫 notes 或 Smoke5-/notes)
const notesFolder = folders.find(f => /notes/i.test(f.name || ''));
assertTrue(notesFolder, `12-pre. 找到 notes folder`);

const notesChildren = unwrapList(await kb('kb.node_children', { kbId: env.TEST_DEFAULT_KB_ID, parentId: notesFolder.id }));
assertTrue(notesChildren.length >= 2, `12. notes 下 children ≥ 2 (got ${notesChildren.length})`);

const childTitles = notesChildren.map(n => n.name || n.title || '');
const allMatch = childTitles.every(t => t.includes(NS));
assertTrue(allMatch || childTitles.filter(t => t.includes(NS)).length >= 2,
    `13. notes 下两个 child title 含 ${NS}`);

const searchResp = await kb('kb.search', { query: NS, kbId: env.TEST_DEFAULT_KB_ID });
const hits = unwrapList(searchResp);
assertTrue(hits.length >= 2, `14. kb.search "${NS}" hits ≥ 2 (got ${hits.length})`);

// -- Round 2: rename + move ----------------------------------------------
log('[Phase 4/5] round 2 NL → rename notes → writeup + move research under writeup');
const NL2 = `把刚才那个 ${NS}/notes 目录改名成 ${NS}/writeup,然后把 ${NS}/research 整个挪到 writeup 下面(变成 writeup/research)。改完后给我打印新的目录结构。`;
await sendInstruction(env, NL2);

const r2 = await waitForCard({
  label: 'round2 rename+move',
  sinceSeq: cursor,
  matchAll: ['writeup'],
  maxMs: 60 * 1000,
});
cursor = Number(r2.msg.seq);

assertTrue(r2.text.includes('writeup'), '6. round2 回复含 "writeup"');
// `.+` 不跨行,在 JS regex 里只匹配同一行;agent 自然回复常用多行 ASCII tree
// 表达层级(writeup 在某行,research 在另一行),用 `[\s\S]` 显式允许跨行,
// 这里只检查 agent 反映出了"writeup 包含 research"的事实。底层验证(实际
// 父子关系)在下面 assertion 15(`research.parent_id == writeup.id`)上 backing。
const hasNesting = r2.text.includes('writeup/research')
                || /writeup[\s\S]*?research/.test(r2.text);
assertTrue(hasNesting, '7. round2 回复反映出 writeup/research 新层级');
ok('5. round2 回复已到达');

// Backing: verify in KB
const nsNodesR2 = await listKbNamespacedNodes(NS);
const writeup = nsNodesR2.find(n => /writeup/i.test(n.name || ''));
const research = nsNodesR2.find(n => /research/i.test(n.name || ''));
assertTrue(writeup, '15-pre. KB 里能找到 writeup');
assertTrue(research, '15-pre. KB 里能找到 research');
const researchParent = research.parent_id || research.parentId;
assertEq(researchParent, writeup.id, '15. research.parent_id == writeup.id');

const bc = unwrapList(await kb('kb.node_breadcrumb', { kbId: env.TEST_DEFAULT_KB_ID, nodeId: research.id }));
const bcHasWriteup = bc.some(n => /writeup/i.test(n.name || ''));
assertTrue(bcHasWriteup, '16. node_breadcrumb(research) 含 writeup');

// -- Round 3: cleanup ----------------------------------------------------
log('[Phase 6/7] round 3 NL → cleanup');
const NL3 = `把刚才建的 ${NS} 那批东西全删掉:两个 page 永久删除,目录递归删除。删干净后跟我确认默认知识库里已经没有 ${NS} 命名空间下的任何节点了。`;
await sendInstruction(env, NL3);

const r3 = await waitForCard({
  label: 'round3 cleanup',
  sinceSeq: cursor,
  matchAny: ['已清理', '已删除', '清空', '删除完成', '清理完成'],
  maxMs: 60 * 1000,
});
cursor = Number(r3.msg.seq);

assertTrue(/已清理|已删除|清空|删除完成|清理完成/.test(r3.text), '9. round3 回复含已清理语义');
const denies = /没有|不再|0 个|已无/.test(r3.text);
assertTrue(denies, '10. round3 回复明确表达"已无残留"');
ok('8. round3 回复已到达');

// Backing: tree no longer contains the namespace
const nsNodesR3 = await listKbNamespacedNodes(NS);
assertEq(nsNodesR3.length, 0, `17. KB 树里 ${NS} 命名空间下节点数 == 0`);

const kbsAfter = unwrapList(await kb('kb.list', { limit: 50 }));
assertTrue(kbsAfter.some(k => k.id === env.TEST_DEFAULT_KB_ID), '18. 默认 KB 仍存在');

log('');
log(`✅ Smoke 5 (NL) PASS (18 / 18)`);
log(`   namespace = ${NS}`);
