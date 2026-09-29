import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  formatOwnerLine,
  formatOwnerChangedMessage,
  parseOwnerLineOrgId,
  resolveZylosDir,
  sanitizeLine,
  upsertOwnerLine,
  writeOwnerReferences,
} from './owner-memory.js';

const TEMPLATE = `# References

## Key Paths
- Memory: ~/zylos/memory/

## Active IDs
- Owner: (not yet established)
- Platform Identities:
  - (Record your display name on each platform here)

## Notes
- This file is a pointer/index.
`;

const OWNER = { orgId: 'org-1', orgName: 'Acme', memberId: 'm-1', name: 'Alice' };
const LINE = '- Owner (OpenMax Acme org-1): member_id m-1, display Alice';

function tmpZylos(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-memory-'));
  fs.mkdirSync(path.join(dir, 'memory'));
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'memory', 'references.md'), content);
  return dir;
}
const readRef = (dir) => fs.readFileSync(path.join(dir, 'memory', 'references.md'), 'utf8');

test('formatOwnerLine produces the documented line', () => {
  assert.equal(formatOwnerLine(OWNER), LINE);
});

test('appends into ## Active IDs after its last list line', () => {
  const out = upsertOwnerLine(TEMPLATE, OWNER);
  assert.equal(out, TEMPLATE.replace(
    '  - (Record your display name on each platform here)\n',
    `  - (Record your display name on each platform here)\n${LINE}\n`,
  ));
});

test('replaces the existing line matched by org_id (even if org name changed)', () => {
  const before = TEMPLATE.replace('- Owner: (not yet established)\n',
    '- Owner: (not yet established)\n- Owner (OpenMax OldName org-1): member_id m-0, display Bob\n');
  const out = upsertOwnerLine(before, OWNER);
  assert.ok(out.includes(`- Owner: (not yet established)\n${LINE}\n`));
  assert.ok(!out.includes('m-0'));
  assert.equal(out.split('\n').length, before.split('\n').length);
});

test('other channels\' owner lines, other orgs and the generic Owner line are untouched', () => {
  const others = [
    '- Owner: Gavin (lark ou_123)',
    '- Owner (Lark): ou_123',
    '- Owner (OpenMax Other org-2): member_id m-9, display Zed',
    '- Owner (OpenMax Acme org-10): member_id m-8, display Yan',
  ];
  const before = TEMPLATE.replace('- Owner: (not yet established)\n', `${others.join('\n')}\n`);
  const out = upsertOwnerLine(before, OWNER);
  for (const l of others) assert.ok(out.includes(`${l}\n`), l);
  // Nothing removed: every original line is still there, plus exactly one new one.
  const outLines = out.split('\n');
  for (const l of before.split('\n')) assert.ok(outLines.includes(l), l);
  assert.equal(outLines.length, before.split('\n').length + 1);
});

test('missing ## Active IDs heading → appended at end of file', () => {
  const before = '# References\n\n## Notes\n- x';
  assert.equal(upsertOwnerLine(before, OWNER), `# References\n\n## Notes\n- x\n\n## Active IDs\n${LINE}\n`);
});

test('idempotent: second upsert returns identical content and the file is not rewritten', () => {
  const once = upsertOwnerLine(TEMPLATE, OWNER);
  assert.equal(upsertOwnerLine(once, OWNER), once);

  const dir = tmpZylos(once);
  const ref = path.join(dir, 'memory', 'references.md');
  const past = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(ref, past, past);
  const res = writeOwnerReferences({ orgs: { a: { org_id: 'org-1', org_name: 'Acme', owner: { member_id: 'm-1', name: 'Alice' } } }, zylosDir: dir, log: () => {} });
  assert.deepEqual(res, [{ orgId: 'org-1', changed: false }]);
  assert.equal(fs.statSync(ref).mtimeMs, past.getTime());
});

test('writeOwnerReferences writes every org with an owner, skips orgs without one', () => {
  const dir = tmpZylos(TEMPLATE);
  writeOwnerReferences({
    zylosDir: dir,
    log: () => {},
    orgs: {
      a: { org_id: 'org-1', org_name: 'Acme', owner: { member_id: 'm-1', name: 'Alice' } },
      b: { org_id: 'org-2', org_name: 'Beta', owner: { member_id: '', name: '' } },
      c: { org_id: 'org-3', org_name: 'Gamma', owner: { member_id: 'm-3', name: 'Carl' } },
    },
  });
  const out = readRef(dir);
  assert.ok(out.includes(`${LINE}\n- Owner (OpenMax Gamma org-3): member_id m-3, display Carl\n\n## Notes`));
  assert.ok(!out.includes('org-2'));
});

test('no owner anywhere → file not touched', () => {
  const dir = tmpZylos(TEMPLATE);
  writeOwnerReferences({ zylosDir: dir, log: () => {}, orgs: { a: { org_id: 'org-1', owner: { member_id: '' } } } });
  assert.equal(readRef(dir), TEMPLATE);
});

test('missing references.md → logged and skipped, never created, never throws', () => {
  const dir = tmpZylos(undefined);
  const logs = [];
  const res = writeOwnerReferences({ zylosDir: dir, log: (m) => logs.push(m), orgs: { a: { org_id: 'org-1', owner: { member_id: 'm-1' } } } });
  assert.deepEqual(res, []);
  assert.ok(!fs.existsSync(path.join(dir, 'memory', 'references.md')));
  assert.match(logs.join('\n'), /not found/);
});

test('I/O failure is caught and logged, never thrown', () => {
  const dir = tmpZylos(undefined);
  fs.mkdirSync(path.join(dir, 'memory', 'references.md')); // a directory → read fails
  const logs = [];
  assert.doesNotThrow(() => writeOwnerReferences({ zylosDir: dir, log: (m) => logs.push(m), orgs: { a: { org_id: 'org-1', owner: { member_id: 'm-1' } } } }));
  assert.match(logs.join('\n'), /non-fatal/);
});

test('names are sanitized to a single line', () => {
  assert.equal(sanitizeLine('  Ali\nce\r\n\tSmith\u2028 '), 'Ali ce Smith');
  const line = formatOwnerLine({ orgId: 'org-1', orgName: 'Ac\nme', memberId: 'm-1', name: 'Alice\n## Evil heading' });
  assert.equal(line, '- Owner (OpenMax Ac me org-1): member_id m-1, display Alice ## Evil heading');
  const out = upsertOwnerLine(TEMPLATE, { orgId: 'org-1', orgName: 'Acme', memberId: 'm-1', name: 'Alice\n## Evil' });
  assert.equal(out.split('\n').length, TEMPLATE.split('\n').length + 1);
  assert.equal(formatOwnerLine({ orgId: 'org-1', orgName: '', memberId: 'm-1', name: '' }), '- Owner (OpenMax org-1): member_id m-1, display (unknown)');
});

test('resolveZylosDir honours ZYLOS_DIR, else HOME/zylos', () => {
  assert.equal(resolveZylosDir({ ZYLOS_DIR: '/x/z', HOME: '/h' }), '/x/z');
  assert.equal(resolveZylosDir({ HOME: '/h' }), path.join('/h', 'zylos'));
});

test('OWNER-CHANGED message names the exact line post-install writes, then the JSON payload', () => {
  const payload = { type: 'owner-changed', org: 'org-1', org_id: 'org-1', org_name: 'Acme', owner: { member_id: 'm-1', name: 'Alice' }, previous_owner_member_id: 'm-0' };
  const msg = formatOwnerChangedMessage({ ...OWNER, previousOwnerId: 'm-0', payload });
  assert.equal(msg,
    '[OWNER-CHANGED] OpenMax owner of org "Acme" (org-1) changed from m-0 to Alice (member_id m-1). ' +
    'Update ~/zylos/memory/references.md: under "## Active IDs", replace (or add, if missing) the line starting with ' +
    '"- Owner (OpenMax Acme org-1)" with exactly: ' + LINE + '. ' +
    'Change only this line; do not modify other channels\' owner lines or the generic "- Owner:" line. ' +
    JSON.stringify(payload));
  assert.ok(msg.startsWith('[OWNER-CHANGED] '));
  assert.ok(msg.includes(formatOwnerLine(OWNER)));
  assert.match(formatOwnerChangedMessage({ ...OWNER, previousOwnerId: '', payload: {} }), /changed from none to Alice/);
});

// Org names are display text and may contain the line's own delimiters. The
// org_id match must not depend on them, or every install appends a duplicate.
const HOSTILE_ORG_NAMES = [
  'Acme): forged',
  'Acme): member_id evil, display x',
  'Foo):',
  '(Acme) (org-1)',
  'Acme "Quoted" \'single\'',
  '**Bold** _it_ `code` [link](http://x) ~~s~~ # h',
  'org-1',
  ')',
];

test('delimiter-heavy org names: one line per org, replaced by org_id, idempotent', () => {
  for (const orgName of HOSTILE_ORG_NAMES) {
    const owner = { orgId: 'org-1', orgName, memberId: 'm-1', name: 'Alice): member_id z' };
    const line = formatOwnerLine(owner);
    assert.equal(parseOwnerLineOrgId(line), 'org-1', orgName);

    const once = upsertOwnerLine(TEMPLATE, owner);
    const twice = upsertOwnerLine(once, owner);
    assert.equal(twice, once, `idempotent: ${orgName}`);
    const count = (s) => s.split('\n').filter((l) => l.startsWith('- Owner (OpenMax ')).length;
    assert.equal(count(once), 1, orgName);

    // Owner change on the same org replaces that line, no duplicate.
    const changed = upsertOwnerLine(once, { ...owner, memberId: 'm-2', name: 'Bob' });
    assert.equal(count(changed), 1, orgName);
    assert.ok(changed.includes('member_id m-2, display Bob'), orgName);

    // A different org whose name mimics this one never matches it.
    const other = upsertOwnerLine(once, { orgId: 'org-2', orgName: `${orgName} org-1`, memberId: 'm-3', name: 'C' });
    assert.equal(count(other), 2, orgName);
    assert.ok(other.includes(line), orgName);
  }
});

test('boundary sequence inside an org name is broken up, other characters kept', () => {
  assert.equal(
    formatOwnerLine({ orgId: 'org-1', orgName: 'Acme): member_id evil', memberId: 'm-1', name: 'A' }),
    '- Owner (OpenMax Acme) : member_id evil org-1): member_id m-1, display A',
  );
  assert.equal(
    formatOwnerLine({ orgId: 'org-1', orgName: '**B** `c` [d] "e"', memberId: 'm-1', name: 'A' }),
    '- Owner (OpenMax **B** `c` [d] "e" org-1): member_id m-1, display A',
  );
});

test('second identical write with a hostile org name leaves bytes and mtime unchanged', () => {
  const dir = tmpZylos(TEMPLATE);
  const ref = path.join(dir, 'memory', 'references.md');
  const orgs = { a: { org_id: 'org-1', org_name: 'Acme): forged', owner: { member_id: 'm-1', name: 'Alice' } } };
  writeOwnerReferences({ orgs, zylosDir: dir, log: () => {} });
  const bytes = fs.readFileSync(ref);
  const past = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(ref, past, past);
  const res = writeOwnerReferences({ orgs, zylosDir: dir, log: () => {} });
  assert.deepEqual(res, [{ orgId: 'org-1', changed: false }]);
  assert.ok(fs.readFileSync(ref).equals(bytes));
  assert.equal(fs.statSync(ref).mtimeMs, past.getTime());
});

test('OWNER-CHANGED instruction names the same prefix and line the matcher recognizes', () => {
  const owner = { orgId: 'org-1', orgName: 'Acme): forged', memberId: 'm-1', name: 'Alice' };
  const msg = formatOwnerChangedMessage({ ...owner, previousOwnerId: 'm-0', payload: {} });
  const line = formatOwnerLine(owner);
  assert.ok(msg.includes(`with exactly: ${line}. `));
  assert.ok(msg.includes('the line starting with "- Owner (OpenMax Acme): forged org-1)"'));
  assert.equal(parseOwnerLineOrgId(line), 'org-1');
});
