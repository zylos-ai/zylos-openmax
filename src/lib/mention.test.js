import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// mention.js resolves its registry path from process.env.HOME at import
// time, so point HOME at a scratch dir before importing (top-level await —
// this project is ESM-only, Node 20+).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-mention-test-'));
process.env.HOME = tmpHome;
const REG_PATH = path.join(tmpHome, 'zylos/components/openmax/mention-registry.json');
const { recordParticipants, resolveMentions, buildMentions } = await import('./mention.js');

const CONV = 'conv-1';
const LUNA_ID = '019f6a10-1af8-73ef-b9bb-08b28dcaa998';
const GAVIN_ID = '019f6587-ca6c-73fc-afe5-e1b8f9d6d345';

test('buildMentions resolves a known participant to a structured mention', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.deepEqual(buildMentions('@luna.coco ping', CONV), [
    { type: 'member', member_id: LUNA_ID },
  ]);
});

test('buildMentions returns undefined (not []) when nothing matches — mirrors cws-fe contract', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.equal(buildMentions('no mentions here', CONV), undefined);
  assert.equal(buildMentions('@totally-unknown-name hi', CONV), undefined);
  assert.equal(buildMentions('', CONV), undefined);
});

test('buildMentions dedupes repeated mentions of the same member', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.deepEqual(buildMentions('@luna.coco hi @luna.coco again', CONV), [
    { type: 'member', member_id: LUNA_ID },
  ]);
});

test('buildMentions matches multiple distinct participants, longest name first', () => {
  recordParticipants(CONV, [
    { name: 'luna.coco', memberId: LUNA_ID },
    { name: 'gavin.yang', memberId: GAVIN_ID },
  ]);
  const result = buildMentions('@gavin.yang and @luna.coco both here', CONV);
  const ids = result.map((m) => m.member_id).sort();
  assert.deepEqual(ids, [GAVIN_ID, LUNA_ID].sort());
});

test('buildMentions is case/spacing tolerant like resolveMentions', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.deepEqual(buildMentions('@LUNA.COCO ping', CONV), [
    { type: 'member', member_id: LUNA_ID },
  ]);
});

test('a participant recorded without a member_id (legacy string-only entry) canonicalizes text but yields no mention', () => {
  const conv = 'conv-legacy-string';
  recordParticipants(conv, 'Old Style Name');
  assert.equal(resolveMentions('@old style name hi', conv), '@Old Style Name hi');
  assert.equal(buildMentions('@old style name hi', conv), undefined);
});

test('a pre-existing on-disk registry written in the old plain-string shape still loads correctly', () => {
  const conv = 'conv-on-disk-legacy';
  fs.mkdirSync(path.dirname(REG_PATH), { recursive: true });
  fs.writeFileSync(REG_PATH, JSON.stringify({ [conv]: { 'luna.coco': 'luna.coco' } }));
  assert.equal(resolveMentions('@luna.coco hi', conv), '@luna.coco hi');
  assert.equal(buildMentions('@luna.coco hi', conv), undefined); // no member_id recorded → can't mention
});

test('recording a member_id later upgrades a previously string-only entry', () => {
  const conv = 'conv-upgrade';
  recordParticipants(conv, 'luna.coco');
  assert.equal(buildMentions('@luna.coco hi', conv), undefined);
  recordParticipants(conv, { name: 'luna.coco', memberId: LUNA_ID });
  assert.deepEqual(buildMentions('@luna.coco hi', conv), [
    { type: 'member', member_id: LUNA_ID },
  ]);
});

test('resolveMentions still canonicalizes case/spacing to the exact recorded display name', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.equal(resolveMentions('hey @Luna.Coco', CONV), 'hey @luna.coco');
});

test('recordParticipants ignores blank/empty names and is a no-op without a conversationId', () => {
  recordParticipants(CONV, ['', '   ', undefined, null]);
  recordParticipants(undefined, { name: 'x', memberId: 'y' });
  // no throw, and previously-recorded participants are unaffected
  assert.deepEqual(buildMentions('@luna.coco', CONV), [{ type: 'member', member_id: LUNA_ID }]);
});

// Regression: a shorter registered name must not fire on a longer name that
// merely starts with it — otherwise "@luna.coco" would wake a bare "luna".
test('a bare registered "luna" does NOT fire on "@luna.coco" text (prefix collision)', () => {
  const conv = 'conv-prefix-1';
  recordParticipants(conv, { name: 'luna', memberId: LUNA_ID });
  // "luna.coco" itself isn't registered here, so nothing should mention at all —
  // in particular NOT luna's member_id via a partial "@luna" prefix match.
  assert.equal(buildMentions('@luna.coco please check', conv), undefined);
  assert.equal(resolveMentions('@luna.coco please check', conv), '@luna.coco please check');
});

test('when BOTH "luna" and "luna.coco" are registered to different members, "@luna.coco" mentions only luna.coco', () => {
  const conv = 'conv-prefix-2';
  const LUNA_BARE_ID = '019f0000-0000-0000-0000-000000000001';
  recordParticipants(conv, [
    { name: 'luna', memberId: LUNA_BARE_ID },
    { name: 'luna.coco', memberId: LUNA_ID },
  ]);
  assert.deepEqual(buildMentions('@luna.coco please check', conv), [
    { type: 'member', member_id: LUNA_ID },
  ]);
  assert.equal(resolveMentions('@luna.coco please check', conv), '@luna.coco please check');
});

test('when BOTH "luna" and "luna.coco" are registered, a properly bounded "@luna " mentions only bare luna', () => {
  const conv = 'conv-prefix-3';
  const LUNA_BARE_ID = '019f0000-0000-0000-0000-000000000001';
  recordParticipants(conv, [
    { name: 'luna', memberId: LUNA_BARE_ID },
    { name: 'luna.coco', memberId: LUNA_ID },
  ]);
  assert.deepEqual(buildMentions('@luna please check', conv), [
    { type: 'member', member_id: LUNA_BARE_ID },
  ]);
});

test('a name match at the very end of the string (no trailing character at all) still counts as bounded', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.deepEqual(buildMentions('ping @luna.coco', CONV), [{ type: 'member', member_id: LUNA_ID }]);
});

test('buildMentions recognizes the @所有人/@Everyone broadcast sentinel (type: all)', () => {
  assert.deepEqual(buildMentions('@所有人 请查收', CONV), [{ type: 'all' }]);
  assert.deepEqual(buildMentions('@Everyone please check', CONV), [{ type: 'all' }]);
});

test('buildMentions recognizes the @所有Agent/@All agents broadcast sentinel (type: all_agents)', () => {
  assert.deepEqual(buildMentions('@所有agent 请查收', CONV), [{ type: 'all_agents' }]);
  assert.deepEqual(buildMentions('@所有Agent 请查收', CONV), [{ type: 'all_agents' }]);
  assert.deepEqual(buildMentions('@All agents please check', CONV), [{ type: 'all_agents' }]);
});

test('both broadcast sentinels can coexist on one message, and combine with a real member mention', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  const result = buildMentions('@所有人 @所有agent also @luna.coco', CONV);
  assert.deepEqual(result, [
    { type: 'all' },
    { type: 'all_agents' },
    { type: 'member', member_id: LUNA_ID },
  ]);
});

test('ordinary text containing the plain English word "all" does not spuriously trigger a broadcast', () => {
  assert.equal(buildMentions('thanks all, that covers all the cases', CONV), undefined);
});

// Regression (P2, re-review): the broadcast sentinels need the same
// post-label boundary as individual name matching — a longer word or an
// ordinary suffix that merely starts with the sentinel label must not
// upgrade to a real all/all_agents wake.
test('a longer word starting with the sentinel label does not trigger a broadcast (ASCII)', () => {
  assert.equal(buildMentions('@EveryoneElse should ignore this', CONV), undefined);
  assert.equal(buildMentions('@All agentship is a real word apparently', CONV), undefined);
});

test('a longer word starting with the sentinel label does not trigger a broadcast (CJK)', () => {
  assert.equal(buildMentions('@所有agent123 is not a real broadcast', CONV), undefined);
  assert.equal(buildMentions('@所有人类的智慧', CONV), undefined); // "所有人" + "类" (a CJK letter char) continues the word
});

test('the broadcast sentinels still fire correctly right before end-of-string / punctuation, not just before a space', () => {
  assert.deepEqual(buildMentions('cc @所有人', CONV), [{ type: 'all' }]);
  assert.deepEqual(buildMentions('cc @Everyone!', CONV), [{ type: 'all' }]);
  assert.deepEqual(buildMentions('cc @所有Agent,谢谢', CONV), [{ type: 'all_agents' }]);
});

// Regression: a fullwidth "＠" (U+FF20) is a common CJK-input-method typo
// for the ASCII "@" (U+0040) — treat it as an equally valid trigger rather
// than silently producing a mention-less message.
test('a fullwidth "＠" mentions an individual just like the ASCII "@"', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.deepEqual(buildMentions('＠luna.coco ping', CONV), [{ type: 'member', member_id: LUNA_ID }]);
});

test('a fullwidth "＠" triggers the broadcast sentinels just like the ASCII "@"', () => {
  assert.deepEqual(buildMentions('＠所有人 请查收', CONV), [{ type: 'all' }]);
  assert.deepEqual(buildMentions('＠所有Agent 请查收', CONV), [{ type: 'all_agents' }]);
  assert.deepEqual(buildMentions('＠Everyone please check', CONV), [{ type: 'all' }]);
});

test('the fullwidth trigger keeps the same boundary-awareness as the ASCII one', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.equal(buildMentions('＠luna.cocoa is not luna.coco', CONV), undefined);
  assert.equal(buildMentions('＠EveryoneElse should not broadcast', CONV), undefined);
});

test('resolveMentions canonicalizes a fullwidth "＠" trigger to the plain ASCII "@" in the output text', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  assert.equal(resolveMentions('＠luna.coco hi', CONV), '@luna.coco hi');
});

test('individual and broadcast mentions can mix ASCII and fullwidth triggers on the same message', () => {
  recordParticipants(CONV, { name: 'luna.coco', memberId: LUNA_ID });
  const result = buildMentions('＠所有人 @luna.coco ＠所有Agent', CONV);
  assert.deepEqual(result, [
    { type: 'all' },
    { type: 'all_agents' },
    { type: 'member', member_id: LUNA_ID },
  ]);
});
