import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readIndex, upsertConnection, removeConnection, replaceIndexFromList, findConnectionByApp,
  readCatalog, writeCatalog, invalidateCatalog, catalogPath, indexPathForOrg,
} from './connect-store.js';

function tmpIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-idx-'));
  return path.join(dir, 'connections-index.json');
}
function tmpCatalogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'connect-cat-'));
}

// --- connections index ------------------------------------------------------

test('缺失索引文件读出空结构，不抛错', () => {
  const idx = tmpIndex();
  assert.deepEqual(readIndex(idx), { connections: {} });
});

test('upsert 后可按 slug 与 applicationId 反查到连接', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_id: 'app-1', application_slug: 'notion', status: 'active' }, idx);
  assert.equal(findConnectionByApp('notion', idx)?.id, 'c1');
  assert.equal(findConnectionByApp('app-1', idx)?.id, 'c1');
  assert.equal(findConnectionByApp('nope', idx), null);
});

test('upsert 叠加填充：稀疏事件先写、后续富记录补 application_id 且不清空已知值', () => {
  const idx = tmpIndex();
  // 事件来源：只有 connection_id + slug（provider），没有 application_id
  upsertConnection({ connection_id: 'c1', provider: 'notion', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.applicationId, null);
  // conn.list 富记录补上 application_id
  upsertConnection({ connection_id: 'c1', application_id: 'app-1', application_slug: 'notion', application_name: 'Notion', status: 'active' }, idx);
  const e = readIndex(idx).connections.c1;
  assert.equal(e.applicationId, 'app-1');
  assert.equal(e.name, 'Notion');
  // 再来一条稀疏事件不应把 application_id 清回 null
  upsertConnection({ connection_id: 'c1', provider: 'notion', status: 'active' }, idx);
  assert.equal(readIndex(idx).connections.c1.applicationId, 'app-1');
});

test('findConnectionByApp 优先返回 active 的连接', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c-old', application_slug: 'x', status: 'revoked' }, idx);
  upsertConnection({ connection_id: 'c-new', application_slug: 'x', status: 'active' }, idx);
  assert.equal(findConnectionByApp('x', idx)?.id, 'c-new');
});

test('removeConnection 幂等，撤销后反查不到', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'c1', application_slug: 'notion', status: 'active' }, idx);
  assert.equal(removeConnection('c1', idx), true);
  assert.equal(removeConnection('c1', idx), false); // 幂等
  assert.equal(findConnectionByApp('notion', idx), null);
});

test('replaceIndexFromList 整体重建（conn.list 权威刷新）', () => {
  const idx = tmpIndex();
  upsertConnection({ connection_id: 'stale', application_slug: 'gone', status: 'active' }, idx);
  replaceIndexFromList([
    { id: 'c1', application_id: 'app-1', application_slug: 'notion', application_name: 'Notion', status: 'active' },
    { id: 'c2', application_id: 'app-2', application_slug: 'x_twitter', status: 'active' },
  ], idx);
  const index = readIndex(idx);
  assert.equal(Object.keys(index.connections).length, 2);
  assert.equal(findConnectionByApp('gone', idx), null); // 旧的被清掉
  assert.equal(findConnectionByApp('notion', idx)?.id, 'c1');
});

test('index 按 org 隔离：不同 org 的同 slug 连接互不串（多 org 防串关键）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-org-'));
  const orgA = indexPathForOrg('org-a', dir);
  const orgB = indexPathForOrg('org-b', dir);
  upsertConnection({ connection_id: 'cA', application_slug: 'notion', status: 'active' }, orgA);
  upsertConnection({ connection_id: 'cB', application_slug: 'notion', status: 'active' }, orgB);
  // 各自查各自的文件，拿到本 org 的连接，不会串到另一个 org
  assert.equal(findConnectionByApp('notion', orgA)?.id, 'cA');
  assert.equal(findConnectionByApp('notion', orgB)?.id, 'cB');
  // 两个不同的物理文件
  assert.notEqual(orgA, orgB);
});

// --- action catalog ---------------------------------------------------------

test('写入后可读回动作目录，带 fetchedAt', () => {
  const dir = tmpCatalogDir();
  const actions = [{ toolkit: 'notion-pages', action: 'notion-pages/create', method: 'POST', input_schema: '{}' }];
  writeCatalog('app-1', actions, { dir, now: 1000 });
  const rec = readCatalog('app-1', { dir });
  assert.equal(rec.applicationId, 'app-1');
  assert.equal(rec.fetchedAt, 1000);
  assert.equal(rec.actions.length, 1);
  assert.equal(rec.actions[0].action, 'notion-pages/create');
});

test('缺失/损坏目录读出 null', () => {
  const dir = tmpCatalogDir();
  assert.equal(readCatalog('missing', { dir }), null);
  fs.writeFileSync(catalogPath('broken', dir), '{ not json');
  assert.equal(readCatalog('broken', { dir }), null);
});

test('TTL 过期视为 miss（返回 null），未过期正常返回', () => {
  const dir = tmpCatalogDir();
  writeCatalog('app-1', [{ action: 'a' }], { dir, now: 1000 });
  // now=1000+5000, ttl=10000 → 新鲜
  assert.ok(readCatalog('app-1', { dir, ttlMs: 10000, now: 6000 }));
  // now=1000+20000, ttl=10000 → 过期
  assert.equal(readCatalog('app-1', { dir, ttlMs: 10000, now: 21000 }), null);
});

test('invalidateCatalog 幂等删除', () => {
  const dir = tmpCatalogDir();
  writeCatalog('app-1', [{ action: 'a' }], { dir });
  assert.equal(invalidateCatalog('app-1', dir), true);
  assert.equal(readCatalog('app-1', { dir }), null);
  assert.equal(invalidateCatalog('app-1', dir), false); // 幂等
});
