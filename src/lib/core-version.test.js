import test from 'node:test';
import assert from 'node:assert/strict';
import { readCoreVersion } from './core-version.js';

// In-memory installation observations only: no CLI, processes or host files.
function fixture() {
  const files = new Map(), commands = new Map();
  const env = { HOME: '/isolated/home', PATH: '/isolated/bin' };
  const record = '/isolated/home/zylos/.claude/skills/comm-bridge/.zylos/core-package.json';
  const io = {
    readFileSync(file) { if (!files.has(file)) throw new Error('missing'); return files.get(file); },
    statSync(file) { if (!commands.has(file)) throw new Error('missing'); return { isFile: () => true }; },
    accessSync(file) { if (!commands.has(file)) throw new Error('missing'); },
    realpathSync(file) { return commands.get(file); },
  };
  const pkg = (root, version) => files.set(`${root}/package.json`, JSON.stringify({ name: 'zylos', version }));
  return { env, io, record, files, commands, pkg, read: () => readCoreVersion({ env, io }) };
}

for (const version of ['0.9.9', '1.0.0-beta.8', '1.1.0']) {
  test(`installed Core ${version} is read from its installation record`, () => {
    const f = fixture();
    f.files.set(f.record, JSON.stringify({ v: 1, packageRoot: '/isolated/core' }));
    f.pkg('/isolated/core', version);
    assert.equal(f.read(), version);
  });
}

test('older installations resolve the executable package on PATH without running it', () => {
  const f = fixture();
  f.commands.set('/isolated/bin/zylos', '/isolated/core/cli/zylos.js');
  f.pkg('/isolated/core', '0.9.8');
  assert.equal(f.read(), '0.9.8');
});

test('existing explicit Core override wins, and an unreadable override stays unknown', () => {
  const f = fixture();
  f.env.ZYLOS_PACKAGE_ROOT = '/isolated/explicit';
  f.commands.set('/isolated/bin/zylos', '/isolated/core/cli/zylos.js');
  f.pkg('/isolated/core', '0.9.8');
  assert.equal(f.read(), null);
  f.pkg('/isolated/explicit', '1.0.0-beta.8');
  assert.equal(f.read(), '1.0.0-beta.8');
});

test('a stale installation record falls back to PATH and unknown packages remain unknown', () => {
  const f = fixture();
  f.files.set(f.record, JSON.stringify({ v: 1, packageRoot: '/isolated/removed' }));
  f.commands.set('/isolated/bin/zylos', '/isolated/core/cli/zylos.js');
  assert.equal(f.read(), null);
  f.pkg('/isolated/core', '1.0.0');
  assert.equal(f.read(), '1.0.0');
  f.files.set('/isolated/core/package.json', JSON.stringify({ name: 'another-package', version: '0.9.8' }));
  assert.equal(f.read(), null);
});
