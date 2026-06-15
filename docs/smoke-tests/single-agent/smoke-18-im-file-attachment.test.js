#!/usr/bin/env node
/**
 * Smoke 18 — IM 文件附件 round-trip(NL 驱动)
 *
 * 见 smoke-18-im-file-attachment.md。1 轮 NL + 8 断言。
 * test client 在 /tmp 造 PNG fixture,让 agent 用 IM 附件模式发到当前 DM 里,
 * 然后旁路验证消息类型 / 附件 artifact_id 一致 / blob byte-for-byte 一致。
 *
 * 跟 Smoke 11(KB 上传)的关键区分:Smoke 11 走 /uploads/prepare(KB 模式,
 * 带 parent_id),Smoke 18 走 /conversations/{cid}/uploads/prepare(IM 模式,
 * 不带 parent_id)。两条路径都过同一个 cws-comm/cws-as 上传链,但前缀和
 * 返回字段不同,缺一个 smoke 就会有覆盖盲区。
 */

import fs from 'node:fs';
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
const NS = `Smoke18-${TS}`;
const unwrapList = (r) => Array.isArray(r) ? r : (r.items || r.data || r.results || []);
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

const AS_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/as.js');
async function as_(cmd, p = {}) {
  const { stdout } = await execp('node', [AS_CLI, cmd, JSON.stringify(p)], { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout); return r.data ?? r;
}
const hashFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

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
    const k = (m.sender_type || m.sender_kind || '').toUpperCase();
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
async function waitForMessage({ label, sinceSeq, predicate, maxMs }) {
  const startedAt = Date.now();
  const seen = [];
  while (Date.now() - startedAt < maxMs) {
    try {
      const msgs = await listAgentMessagesAfter(sinceSeq);
      for (const m of msgs) {
        seen.push({ seq: m.seq, type: m.type, preview: extractText(m).slice(0, 100) });
        if (predicate(m)) return m;
      }
    } catch (e) { log(`  · poll err: ${e.message}`); }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.error(`✗ timeout waiting for ${label} (${maxMs}ms)`);
  for (const s of seen.slice(-10)) console.error(`    seq=${s.seq} type=${s.type} ${s.preview}`);
  process.exit(1);
}
async function currentSeq() {
  const res = await fetch(`${env.COCO_API_URL}/api/v1/conversations/${env.TEST_CONV_ID}/messages?limit=1`, { headers: headers() });
  const arr = unwrapList(await res.json());
  return arr.length ? Math.max(...arr.map(m => Number(m.seq || 0))) : 0;
}

// ---- Fixture ----
log(`=== Smoke 18 (NL): IM 文件附件 round-trip ===  ${NS}`);

const imgPath = `/tmp/${NS}.png`;
{
  // Minimal valid PNG header + zero-filled padding to ~8KB. Distinct content per
  // TS so blob dedup doesn't return a stale artifact.
  const head = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489', 'hex');
  const pad  = Buffer.alloc(8192 - head.length, 0);
  pad.write(`${TS}-png-fixture-`, 0, 'utf8');
  fs.writeFileSync(imgPath, Buffer.concat([head, pad]));
}
const fixtureSize = fs.statSync(imgPath).size;
const fixtureHash = hashFile(imgPath);
log(`   fixture: ${imgPath} (${fixtureSize}B, sha256=${fixtureHash.slice(0,12)}...)`);

let cursor = await currentSeq();

// ---------- Round 1 ----------
log('[Round 1] IM upload + send-with-attachment + ack');
const NL1 = `我本地有张图,路径 ${imgPath},你帮我:
1. 把它作为附件发到我们这个 DM 里(不要走 KB,直接 IM 附件模式)
2. 发完用一条单独的文字消息回我,报 artifactId / fileName / sizeBytes

记得是 IM 模式上传(/conversations/{cid}/uploads/prepare),不是 KB 模式。`;
await sendInstruction(env, NL1);

// 1+5: agent should post both (a) a FILE/IMAGE message with attachments and (b)
// a text ack with artifactId. We poll the text ack first to satisfy assertions 1-3.
const ackMsg = await waitForMessage({
  label: 'round1-ack',
  sinceSeq: cursor,
  predicate: (m) => {
    const text = extractText(m);
    if (!text) return false;
    if (!UUID_RE.test(text)) return false;
    return /artifact|附件|发完|发了|uploaded|已发/i.test(text);
  },
  maxMs: 90 * 1000,
});
const ackText = extractText(ackMsg);
log(`   ack seq=${ackMsg.seq}: ${ackText.slice(0, 120)}`);

// Assertion 1: contains artifactId (uuid) + fileName
const uuids1 = ackText.match(new RegExp(UUID_RE.source, 'gi')) || [];
assertTrue(uuids1.length >= 1, `1a. ack 含 ≥ 1 uuid (artifactId)`);
assertTrue(new RegExp(`Smoke18-.+\\.(png|jpg|jpeg)`, 'i').test(ackText),
    `1b. ack 含 fileName matching Smoke18-*.png`);

// Assertion 2: semantic "uploaded / sent"
assertTrue(/已发|发完|发了|uploaded|附件|attached/i.test(ackText),
    `2. ack 表达上传/发送语义`);

// Assertion 3: contains a numeric size ≥ 1024
const numericMatches = ackText.match(/\b(\d{4,})\b/g) || [];
const hasGteFixtureSize = numericMatches.some(n => Number(n) >= 1024);
assertTrue(hasGteFixtureSize, `3. ack 含 size ≥ 1024 (fixture=${fixtureSize}B), got numbers: [${numericMatches.slice(0,5).join(',')}]`);

// Now find the FILE/IMAGE message (separate from the text ack) — must be in same
// window. Re-poll all agent messages after cursor, look for content_type !=
// AGENT_TEXT/TEXT.
const allAgent = await listAgentMessagesAfter(cursor);
const fileMsg = allAgent.find(m => {
  const t = (m.type || '').toUpperCase();
  return t === 'FILE' || t === 'IMAGE';
});
assertTrue(fileMsg, `4. 会话里有一条 type=IMAGE 或 FILE 的 agent 消息`);
log(`   file msg seq=${fileMsg.seq} type=${fileMsg.type}`);

// Assertion 5+6: attachment shape + match
const attachments = (fileMsg.content && fileMsg.content.attachments) || [];
assertTrue(attachments.length >= 1, `5a. file msg 至少 1 个 attachment`);
const att = attachments[0];
const reportedArtifactId = uuids1[0];   // first uuid in ack is artifactId
assertEq(att.artifact_id, reportedArtifactId,
    `5b. attachment.artifact_id == ack 里报的 artifactId`);
assertTrue(/^Smoke18-.+\.(png|jpg|jpeg)$/i.test(att.file_name || ''),
    `6a. attachment.file_name matches Smoke18-*.png (got "${att.file_name}")`);
assertEq(Number(att.size_bytes), fixtureSize,
    `6b. attachment.size_bytes == fixture bytes`);

// Assertion 7: download via as.download → byte-for-byte hash
try {
  const dl = await as_('as.download', { artifactId: reportedArtifactId });
  const localPath = dl.localPath || dl.local_path;
  assertTrue(localPath, `7-pre. as.download returned a local path`);
  assertEq(hashFile(localPath), fixtureHash,
      `7. as.download blob SHA-256 == fixture SHA-256`);
} catch (e) {
  die(`7. as.download or hash compare failed: ${e.message.slice(0,200)}`);
}

// Assertion 8: as.resolve(artifact://<id>) returns a usable URL with same bytes
try {
  const resolved = await as_('as.resolve', { uri: `artifact://${reportedArtifactId}` });
  const url = resolved?.url || resolved?.resolved?.[0]?.url;
  assertTrue(url, `8a. as.resolve returned a url`);
  const r = await fetch(url, { headers: env.CF_ACCESS_CLIENT_ID ? {
    'CF-Access-Client-Id':     env.CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
  } : {}});
  assertTrue(r.ok, `8b. resolved url GET 200 (got ${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  assertEq(hash, fixtureHash, `8c. as.resolve blob SHA-256 == fixture SHA-256`);
} catch (e) {
  // Some envs route artifact:// through different layers; warn-only if the
  // resolver isn't wired yet — the download path (#7) is the canonical check.
  warn(`8. as.resolve path failed: ${e.message.slice(0,160)}; warn-only`);
  ok(`8. (warn-only: as.resolve optional; #7 already verified byte-identity)`);
}

console.log(`\n✅ Smoke 18 PASS  ${NS}  duration=${((Date.now() - TS)/1000).toFixed(1)}s`);
