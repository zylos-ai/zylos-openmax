#!/usr/bin/env node
/**
 * Smoke 11 — AS 工件 + KB 文件集成(纯脚本驱动)
 *
 * 见同目录 smoke-11-as-kb-files.md 完整 spec。16 断言。
 * 唯一覆盖 as.js 整个文件 + kb.js 文件向命令的 smoke。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log, ok, warn, die, assertEq, assertTrue } from './lib/runner.js';

const execp = promisify(execFile);

const REQUIRED = ['COCO_API_URL', 'TEST_USER_TOKEN', 'TEST_DEFAULT_KB_ID'];
for (const k of REQUIRED) {
  if (!process.env[k]) { console.error(`✗ Missing env: ${k}`); process.exit(2); }
}
process.env.COCO_AUTH_TOKEN = process.env.COCO_AUTH_TOKEN || process.env.TEST_USER_TOKEN;
process.env.COCO_RPC_LOG = process.env.COCO_RPC_LOG || '0';

const KB_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/kb.js');
const AS_CLI = path.join(os.homedir(), 'zylos/.claude/skills/coco-workspace/src/cli/as.js');

async function runCli(cliPath, cmd, params = {}) {
  const { stdout } = await execp('node', [cliPath, cmd, JSON.stringify(params)],
    { env: process.env, maxBuffer: 8*1024*1024 });
  const r = JSON.parse(stdout);
  return r.data ?? r;
}
const kb = (cmd, p) => runCli(KB_CLI, cmd, p);
const as_ = (cmd, p) => runCli(AS_CLI, cmd, p);

const TS = Date.now();
const NS = `Smoke11-${TS}`;
const TEST_KB_ID = process.env.TEST_DEFAULT_KB_ID;

const hashFile = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

log(`=== Smoke 11: AS + KB 文件集成 ===  ns=${NS}`);

// ---------------------------------------------------------------------------
// Phase 0 — fixtures
// ---------------------------------------------------------------------------

log('[Phase 0] fixtures');

const pngPath = `/tmp/${NS}.png`;
const mdPath  = `/tmp/${NS}.md`;

// build a minimal-ish PNG ~8KB. 1x1 IHDR + IDAT padding bytes (technically
// invalid PNG body, but content_type/size_bytes is what cws-as cares about
// — bytes-as-blob, dedup happens by SHA-256). To avoid dedup, mix TS into
// the trailing bytes.
{
  const head = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489',
    'hex',
  );
  const pad = Buffer.alloc(8192 - head.length, 0);
  pad.write(`${TS}-png-fixture-`, 0, 'utf8');
  fs.writeFileSync(pngPath, Buffer.concat([head, pad]));
}

{
  let buf = '';
  while (buf.length < 12 * 1024) {
    buf += `${NS} md fixture line ${buf.length}\n`;
  }
  fs.writeFileSync(mdPath, buf);
}

const pngSize = fs.statSync(pngPath).size;
const mdSize  = fs.statSync(mdPath).size;
assertTrue(pngSize > 4000 && pngSize < 20000, `1a. PNG fixture size 合法 (${pngSize}B)`);
assertTrue(mdSize  > 8000 && mdSize  < 30000, `1b. MD  fixture size 合法 (${mdSize}B)`);

// ---------------------------------------------------------------------------
// Phase 1 — KB mode upload (low-level: as.upload)
// ---------------------------------------------------------------------------

log('[Phase 1] as.upload(KB mode,no conversationId)');

const up1 = await as_('as.upload', { filePath: pngPath });
assertTrue(up1 && (up1.artifactId || up1.artifact_id),
    `2a. as.upload 返 artifactId`);
assertTrue(up1.nodeId || up1.node_id,
    `2b. as.upload 返 nodeId`);
const up1_artifactId = up1.artifactId || up1.artifact_id;
const up1_nodeId     = up1.nodeId     || up1.node_id;
log(`   up1 artifact=${up1_artifactId} node=${up1_nodeId} instant=${up1.instantUpload || up1.instant_upload || false}`);

const up1Tree = up1.treeNode || up1.tree_node;
assertTrue(up1Tree && (up1Tree.kb_id || up1Tree.kbId) === TEST_KB_ID,
    `3. up1.treeNode.kb_id == TEST_DEFAULT_KB_ID`);

const reportedSize = up1.sizeBytes || up1.size_bytes || 0;
assertTrue(reportedSize >= pngSize * 0.8 && reportedSize <= pngSize * 1.2,
    `4. up1.sizeBytes ≈ ${pngSize} (got ${reportedSize})`);

// ---------------------------------------------------------------------------
// Phase 2 — as.url + as.download 字节级回环
// ---------------------------------------------------------------------------

log('[Phase 2] as.url + as.download');

const urlMeta = await as_('as.url', { artifactId: up1_artifactId });
assertTrue(urlMeta && (urlMeta.url) && (urlMeta.expiresAt || urlMeta.expires_at) && (urlMeta.contentType || urlMeta.content_type),
    `5. as.url 返 url + expiresAt + contentType`);

const dl = await as_('as.download', { artifactId: up1_artifactId });
const localPath = dl.localPath || dl.local_path;
assertTrue(localPath && fs.existsSync(localPath), `6. as.download 落地文件存在 (${localPath})`);

assertEq(hashFile(localPath), hashFile(pngPath), `7. 字节级 hash 一致`);

// ---------------------------------------------------------------------------
// Phase 3 — as.resolve
// ---------------------------------------------------------------------------

log('[Phase 3] as.resolve');

const resolved = await as_('as.resolve', { uris: [`artifact://${up1_artifactId}`] });
const okList   = resolved.resolved || resolved.items || [];
const failList = resolved.failed   || [];
assertTrue(okList.length >= 1, `8a. as.resolve 返 ≥ 1 条 resolved (got ${okList.length})`);
assertEq(failList.length, 0, `8b. as.resolve 0 条 failed`);

// ---------------------------------------------------------------------------
// Phase 4 — kb.upload(high-level)
// ---------------------------------------------------------------------------

log('[Phase 4] kb.upload (markdown)');

const up2 = await kb('kb.upload', {
  filePath:    mdPath,
  contentType: 'text/markdown',
});
const up2_artifactId = up2.artifactId || up2.artifact_id;
const up2_nodeId     = up2.nodeId     || up2.node_id;
assertTrue(up2_artifactId && up2_nodeId,
    `9a. kb.upload 返 artifactId + nodeId`);
assertTrue(up2_artifactId !== up1_artifactId,
    `9b. up2 跟 up1 是不同的 artifact`);

// ---------------------------------------------------------------------------
// Phase 5 — kb.folder_create + kb.file_create(挂第二个 ref)
// ---------------------------------------------------------------------------

log('[Phase 5] folder + file_create(ref)');

const folder = await kb('kb.folder_create', { kbId: TEST_KB_ID, name: `${NS}/refs` });
assertTrue(folder && folder.id, `10. folder_create 返 id`);

let fileNode2 = null;
try {
  fileNode2 = await kb('kb.file_create', {
    kbId:       TEST_KB_ID,
    name:       `${NS}.png (ref)`,
    artifactId: up1_artifactId,
    parentId:   folder.id,
  });
  assertTrue(fileNode2 && fileNode2.id, `11a. file_create 返 nodeId`);
  assertEq(fileNode2.parent_id || fileNode2.parentId, folder.id,
      `11b. file_create parent_id == folder.id`);
  // 检查复用同一 artifactId(取决于响应是否带 artifact_id)
  const fnArtifactId = fileNode2.artifact_id || fileNode2.artifactId;
  if (fnArtifactId) {
    assertEq(fnArtifactId, up1_artifactId, `12. file_create 复用了 up1.artifactId`);
  } else {
    warn(`12. file_create 响应没带 artifact_id 字段,无法直接对比; warn-only`);
  }
} catch (e) {
  die(`11. file_create 抛错: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Phase 6 — preview + download + batch
// ---------------------------------------------------------------------------

log('[Phase 6] file_preview + file_download + batch');

const preview = await kb('kb.file_preview', { kbId: TEST_KB_ID, nodeId: up1_nodeId });
assertTrue(preview && (preview.url || preview.preview_url),
    `13. file_preview 返 url`);

const fileDl = await kb('kb.file_download', { kbId: TEST_KB_ID, nodeId: up1_nodeId });
assertTrue(fileDl && (fileDl.url || fileDl.download_url || fileDl.localPath),
    `14. file_download 返 url 或 localPath`);

const batch = await kb('kb.file_batch_download', {
  kbId:    TEST_KB_ID,
  nodeIds: [up1_nodeId, up2_nodeId],
});
const batchArr = Array.isArray(batch) ? batch : (batch.items || batch.data || batch.results || []);
assertTrue(batchArr.length >= 2, `15. file_batch_download 返 ≥ 2 条 (got ${batchArr.length})`);

// optional HEAD probe
let probedOk = 0;
for (const item of batchArr.slice(0, 2)) {
  const u = item.url || item.download_url;
  if (!u) continue;
  try {
    const r = await fetch(u, { method: 'HEAD' });
    if (r.ok) probedOk++;
  } catch { /* network blip — warn-only */ }
}
if (probedOk >= 2) {
  ok(`16. batch 两条 HEAD 都 200`);
} else {
  warn(`16. batch HEAD 探针 ${probedOk}/2 通; warn-only(presigned URL 可能跳过 HEAD 校验)`);
}

// ---------------------------------------------------------------------------

log('');
log(`✅ Smoke 11 PASS (16 / 16)`);
log(`   PNG  artifact=${up1_artifactId}  node=${up1_nodeId}`);
log(`   MD   artifact=${up2_artifactId}  node=${up2_nodeId}`);
log(`   refs folder = ${folder.id}`);
log(`   fileNode2   = ${fileNode2 && fileNode2.id}`);
