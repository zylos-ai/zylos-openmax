import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  saveCredentialCache,
  deleteCredentialCache,
  listCachedCredentials,
  clearCachedCredentials,
  credentialPath,
} from './credential-cache.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cred-cache-'));
}

test('保存 direct 凭证时文件权限为 0600、目录为 0700（避免同机其他用户读到 token）', () => {
  const dir = tmpDir();
  const connId = 'conn-1';
  saveCredentialCache(connId, { credential_mode: 'direct', access_token: 'secret-token' }, 'github', dir);

  const file = credentialPath(connId, dir);
  // 删掉 0600 那个写入模式，这条断言就会红——钉住机制本身。
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'credential file must be 0600');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'credentials dir must be 0700');
});

test('provider slug 被叠加进缓存，可按第三方组件识别', () => {
  const dir = tmpDir();
  saveCredentialCache('conn-2', { credential_mode: 'proxy', proxy_ref: 'conn-2' }, 'gitlab', dir);
  const saved = JSON.parse(fs.readFileSync(credentialPath('conn-2', dir), 'utf8'));
  assert.equal(saved.provider, 'gitlab');
  assert.equal(saved.credential_mode, 'proxy');
});

test('已带 provider 的记录不被覆盖；缺省 provider 时按原样写', () => {
  const dir = tmpDir();
  // 记录自带 provider，传入的 provider 不应覆盖它
  saveCredentialCache('conn-3', { credential_mode: 'direct', provider: 'from-record' }, 'from-arg', dir);
  assert.equal(JSON.parse(fs.readFileSync(credentialPath('conn-3', dir), 'utf8')).provider, 'from-record');
  // 无 provider 传入时不注入该字段
  saveCredentialCache('conn-4', { credential_mode: 'direct' }, undefined, dir);
  assert.equal('provider' in JSON.parse(fs.readFileSync(credentialPath('conn-4', dir), 'utf8')), false);
});

test('listCachedCredentials 返回元数据（含 provider），不泄漏 token 明文', () => {
  const dir = tmpDir();
  saveCredentialCache('conn-5', { credential_mode: 'direct', access_token: 'top-secret' }, 'notion', dir);
  const [entry] = listCachedCredentials(dir);
  assert.equal(entry.connection_id, 'conn-5');
  assert.equal(entry.provider, 'notion');
  assert.equal(entry.has_access_token, true);
  assert.equal('access_token' in entry, false, 'must not surface the raw token');
});

test('clear / delete 移除缓存文件', () => {
  const dir = tmpDir();
  saveCredentialCache('conn-6', { credential_mode: 'proxy' }, 'stripe', dir);
  saveCredentialCache('conn-7', { credential_mode: 'proxy' }, 'jira', dir);

  assert.deepEqual(clearCachedCredentials('conn-6', dir), ['conn-6']);
  assert.equal(fs.existsSync(credentialPath('conn-6', dir)), false);

  deleteCredentialCache('conn-7', dir);
  assert.equal(fs.existsSync(credentialPath('conn-7', dir)), false);
  assert.deepEqual(listCachedCredentials(dir), []);
});

test('对不存在的目录 list/clear 优雅降级为空', () => {
  const dir = path.join(os.tmpdir(), 'cred-cache-does-not-exist-xyz');
  assert.deepEqual(listCachedCredentials(dir), []);
  assert.deepEqual(clearCachedCredentials(undefined, dir), []);
});
