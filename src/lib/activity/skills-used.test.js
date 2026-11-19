import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  withSelectedCheck, registerSkillTurn, buildSkillIdMap, scanTurnRecords, computeSkillsUsed, skillsUsedItem,
  planSkillsUsed, withSkillsUsed, MAX_SKILLS_USED_IDS,
} from './skills-used.js';
import { encodeProjectDir } from './collector.js';
import { createRunStore } from './run-store.js';
import { contextItemsFrom } from '../message-context.js';

// OPENM-1396 (wsb#830) report side: the first reply of a turn whose inbound
// message carried a `skills` item gets one
//   {type:"skills-used", audience:"ui", attrs:{"reply-to":<msg id>, complete}, data?:{skill_ids}}
// item; complete=false never carries data.

const S = '700000000000000001';
const CONV = 'cv-dm-1';
const EP = `${CONV}|type:dm|msg:${S}`;

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skills-used-'));
}

/** A zylos home: skills dir with a market skill, a local skill, a kb skill. */
function makeHost({ runtime = 'claude', marketFile = JSON.stringify({ skill_id: 'sk_mkt_1', version_no: 3, package_sha256: 'ab' }) } = {}) {
  const home = tmp();
  const zylosDir = path.join(home, 'zylos');
  const skills = path.join(zylosDir, '.claude/skills');
  const mk = (dir, name, extra = {}) => {
    fs.mkdirSync(path.join(skills, dir), { recursive: true });
    fs.writeFileSync(path.join(skills, dir, 'SKILL.md'), `---\nname: ${name}\nversion: 1.0.0\n---\n# ${name}\n`);
    for (const [f, c] of Object.entries(extra)) fs.writeFileSync(path.join(skills, dir, f), c);
  };
  mk('market--price-grab', 'price-grab', marketFile == null ? {} : { '.market-managed': marketFile });
  mk('weekly-report', 'weekly-report');
  mk('openmax-product-faq', 'openmax-product-faq');
  mk('openmax', 'openmax');
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos/config.json'), JSON.stringify({ runtime }));
  const projDir = path.join(home, '.claude/projects', encodeProjectDir(fs.realpathSync(zylosDir)));
  fs.mkdirSync(projDir, { recursive: true });
  return { home, zylosDir, projDir, stateDir: path.join(home, 'state'), runsDir: path.join(home, 'runs') };
}

let clock = Date.parse('2026-11-19T10:00:00.000Z');
const ts = () => new Date((clock += 1000)).toISOString();

function inbound(id = S, conv = CONV) {
  return `[OPENMAX DM]\n<message-context conversation-id="${conv}" source-message-id="${id}"/>\n<current-message>\nAlice said: 查一下\n</current-message>\n---- reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${conv}|type:dm|msg:${id}"`;
}
const userRec = (content) => ({ type: 'user', timestamp: ts(), uuid: `u${clock}`, message: { content } });
const toolRec = (name, input, id = `t${clock}`) => ({ type: 'assistant', timestamp: ts(), uuid: `a${clock}`, message: { content: [{ type: 'tool_use', id, name, input }] } });
const skillRec = (skill) => toolRec('Skill', { skill });
const sendRec = () => toolRec('Bash', { command: `node c4-send.js "openmax" "${EP}" "ok"` });
const turnEnd = () => ({ type: 'system', subtype: 'turn_duration', timestamp: ts() });

function writeLog(host, records, name = 'sess-1.jsonl') {
  const p = path.join(host.projDir, name);
  fs.writeFileSync(p, `${records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`);
  return p;
}

function compute(host, extra = {}) {
  return computeSkillsUsed({
    sourceMessageId: S, convId: CONV, homeDir: host.home, zylosDir: host.zylosDir,
    runStore: createRunStore({ dir: host.runsDir }), ...extra,
  });
}

// --- item shape --------------------------------------------------------------

test('item: attr is reply-to (hyphen), complete=true carries data.skill_ids', () => {
  const it = skillsUsedItem({ sourceMessageId: S, complete: true, skillIds: ['sk_mkt_1', 'local:weekly-report'] });
  assert.deepEqual(it, {
    type: 'skills-used', audience: 'ui',
    attrs: { 'reply-to': S, complete: true },
    data: { skill_ids: ['sk_mkt_1', 'local:weekly-report'] },
  });
  assert.equal('reply_to' in it.attrs, false);
  // Survives the shared context reader (attr names ^[a-z][a-z0-9-]*$).
  const [read] = contextItemsFrom({ metadata: { context: { items: [it] } } });
  assert.equal(read.attrs['reply-to'], S);
});

test('item: complete=false carries NO data at all, even when ids were seen', () => {
  const it = skillsUsedItem({ sourceMessageId: S, complete: false, skillIds: ['sk_mkt_1'] });
  assert.deepEqual(it, { type: 'skills-used', audience: 'ui', attrs: { 'reply-to': S, complete: false } });
  assert.equal(Object.hasOwn(it, 'data'), false);
});

test('item: complete=true with zero skills used is still complete, with an empty list', () => {
  const it = skillsUsedItem({ sourceMessageId: S, complete: true, skillIds: [] });
  assert.deepEqual(it.data, { skill_ids: [] });
});

// --- skill name → skill_id -------------------------------------------------------

test('skill map: market dir → .market-managed skill_id; local dir → local:<dir>; kb skills count', () => {
  const host = makeHost();
  const map = buildSkillIdMap({ skillsDir: path.join(host.zylosDir, '.claude/skills') });
  assert.equal(map.resolve('price-grab'), 'sk_mkt_1');
  assert.equal(map.resolve('market--price-grab'), 'sk_mkt_1');
  assert.equal(map.resolve('weekly-report'), 'local:weekly-report');
  assert.equal(map.resolve('openmax-product-faq'), 'local:openmax-product-faq');
  assert.equal(map.resolve('nope'), null);
  assert.equal(map.resolve('plugin:thing'), null);
});

test('skill map: a market dir without a readable .market-managed resolves to nothing (never local:market--…)', () => {
  const host = makeHost({ marketFile: null });
  const map = buildSkillIdMap({ skillsDir: path.join(host.zylosDir, '.claude/skills') });
  assert.equal(map.resolve('price-grab'), null);
  const host2 = makeHost({ marketFile: 'skill_id=sk_kv_9\nversion_no=1\n' });
  assert.equal(buildSkillIdMap({ skillsDir: path.join(host2.zylosDir, '.claude/skills') }).resolve('price-grab'), 'sk_kv_9');
});

// --- the turn ----------------------------------------------------------------

test('TC-U-01: skills invoked after the inbound → complete, ids in first-use order, deduped, kb counted', () => {
  const host = makeHost();
  writeLog(host, [
    userRec('older turn'), skillRec('weekly-report'), turnEnd(),
    userRec(inbound()),
    skillRec('openmax'), skillRec('price-grab'), skillRec('weekly-report'), skillRec('price-grab'),
    skillRec('openmax-product-faq'), sendRec(),
  ]);
  const r = compute(host);
  assert.equal(r.complete, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.skillIds, ['local:openmax', 'sk_mkt_1', 'local:weekly-report', 'local:openmax-product-faq']);
});

test('TC-U-02: nothing invoked → complete with an empty list', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), sendRec()]);
  assert.deepEqual(compute(host), { complete: true, skillIds: [], reasons: [] });
});

test('does not depend on the activity feature: no runs dir, no active.json', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  assert.equal(fs.existsSync(host.runsDir), false);
  assert.equal(compute(host).complete, true);
});

test('TC-U-06: a non-Claude runtime (Codex) → incomplete', () => {
  const host = makeHost({ runtime: 'codex' });
  writeLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  const r = compute(host);
  assert.equal(r.complete, false);
  assert.deepEqual(r.reasons, ['runtime_unsupported']);
});

test('an unrecognised invocation (unknown name, non-string skill) → incomplete', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), skillRec('weekly-report'), skillRec('not-installed')]);
  assert.deepEqual(compute(host).reasons, ['unrecognized_skill']);
  writeLog(host, [userRec(inbound()), toolRec('Skill', { skill: 42 })]);
  assert.deepEqual(compute(host).reasons, ['unrecognized_invocation']);
});

test('reading a SKILL.md directly, or delegating to a subagent → incomplete', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), toolRec('Read', { file_path: '/home/x/zylos/.claude/skills/weekly-report/SKILL.md' })]);
  assert.deepEqual(compute(host).reasons, ['skill_file_read']);
  writeLog(host, [userRec(inbound()), toolRec('Bash', { command: 'cat ~/zylos/.claude/skills/weekly-report/SKILL.md' })]);
  assert.deepEqual(compute(host).reasons, ['skill_file_read']);
  writeLog(host, [userRec(inbound()), toolRec('Task', { description: 'x', prompt: 'y' })]);
  assert.deepEqual(compute(host).reasons, ['delegated']);
  // Running a skill's own CLI is not reading the skill.
  writeLog(host, [userRec(inbound()), toolRec('Bash', { command: 'node ~/zylos/.claude/skills/openmax/src/cli/kb.js search {}' })]);
  assert.equal(compute(host).complete, true);
});

test('cross-turn merge: another input in the turn, a merged inbound, or a mid-turn injection → incomplete', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), skillRec('weekly-report'), userRec(inbound('700000000000000002'))]);
  assert.deepEqual(compute(host).reasons, ['merged_input']);
  // S arrived merged with another message in one input.
  writeLog(host, [userRec(`${inbound('700000000000000002')}\n${inbound()}`), skillRec('weekly-report')]);
  assert.deepEqual(compute(host).reasons, ['merged_input']);
  // S absorbed into another message's running turn.
  writeLog(host, [
    userRec(inbound('700000000000000002')),
    { type: 'attachment', timestamp: ts(), uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: inbound() } },
    skillRec('weekly-report'),
  ]);
  assert.deepEqual(compute(host).reasons, ['merged_input']);
  // The turn ended before this reply.
  writeLog(host, [userRec(inbound()), skillRec('weekly-report'), turnEnd()]);
  assert.deepEqual(compute(host).reasons, ['turn_ended']);
});

test('a record of unknown shape after the inbound, or an unparsable line → incomplete', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), { type: 'assistant', timestamp: ts(), message: { content: 'not-an-array' } }]);
  assert.deepEqual(compute(host).reasons, ['unknown_record']);
  writeLog(host, [userRec(inbound()), '{"type":"assistant", broken']);
  assert.deepEqual(compute(host).reasons, ['unknown_record']);
});

test('inbound not in the log → incomplete', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound('700000000000000002')), skillRec('weekly-report')]);
  assert.deepEqual(compute(host).reasons, ['inbound_not_found']);
});

test('TC-U-05: the run of this message went status_only (activity on) → incomplete; merged_turn note too', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  const store = createRunStore({ dir: host.runsDir });
  store.writeRun({ run_id: 'r_0000000a', source_message_id: S, status_only: true, events: [] });
  store.writeActive({ v: 1, by_conversation: { [CONV]: ['r_0000000a'] }, gate: {}, unregistered: {} });
  assert.deepEqual(compute(host).reasons, ['status_only']);
  store.writeRun({ run_id: 'r_0000000a', source_message_id: S, status_only: false, events: [{ kind: 'notice', code: 'merged_turn' }] });
  assert.deepEqual(compute(host).reasons, ['merged_turn']);
  // Another message's degraded run does not matter.
  store.writeRun({ run_id: 'r_0000000a', source_message_id: '9', status_only: true, events: [] });
  assert.equal(compute(host).complete, true);
});

test('more than 50 distinct skills → incomplete (the list could not be sent whole)', () => {
  const recs = Array.from({ length: MAX_SKILLS_USED_IDS + 1 }, (_, i) => ({ t: 'tool_start', name: 'Skill', input: { skill: `s${i}` } }));
  const resolve = (n) => `local:${n}`;
  const r = scanTurnRecords([{ t: 'input', form: 'user', segments: [{ ctx: { sourceMessageId: S } }] }, ...recs], { sourceMessageId: S, resolve });
  assert.equal(r.complete, false);
  assert.deepEqual(r.reasons, ['too_many']);
});

// --- first reply of the turn ----------------------------------------------------

test('planSkillsUsed: nothing for a message that carried no skills item (not registered)', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  assert.equal(planSkillsUsed({ sourceMessageId: S, convId: CONV, bodyHash: 'h', dir: host.stateDir, homeDir: host.home, zylosDir: host.zylosDir }), null);
  assert.equal(planSkillsUsed({ sourceMessageId: null, convId: CONV, bodyHash: 'h', dir: host.stateDir, homeDir: host.home, zylosDir: host.zylosDir }), null);
});

test('TC-U-08: only the first reply carries the item; a rejected first send releases it; a same-body retry gets the same item', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  registerSkillTurn({ sourceMessageId: S, conversationId: CONV, selectedSkillIds: ['local:weekly-report'], dir: host.stateDir });
  const deps = { dir: host.stateDir, homeDir: host.home, zylosDir: host.zylosDir, runStore: createRunStore({ dir: host.runsDir }) };

  // Another conversation's reply never takes it.
  assert.equal(planSkillsUsed({ sourceMessageId: S, convId: 'cv-other', bodyHash: 'h1', ...deps }), null);

  const p1 = planSkillsUsed({ sourceMessageId: S, convId: CONV, bodyHash: 'h1', ...deps });
  assert.deepEqual(p1.item.data, { skill_ids: ['local:weekly-report'] });
  p1.settle('rejected');
  const p2 = planSkillsUsed({ sourceMessageId: S, convId: CONV, bodyHash: 'h2', ...deps });
  assert.ok(p2);
  p2.settle('uncertain');
  // Same body after an uncertain outcome: same item again.
  const p3 = planSkillsUsed({ sourceMessageId: S, convId: CONV, bodyHash: 'h2', ...deps });
  assert.deepEqual(p3.item, p2.item);
  // A different body while pending: nothing.
  assert.equal(planSkillsUsed({ sourceMessageId: S, convId: CONV, bodyHash: 'h3', ...deps }), null);
  p3.settle('ok');
  assert.equal(planSkillsUsed({ sourceMessageId: S, convId: CONV, bodyHash: 'h2', ...deps }), null);
});

test('planSkillsUsed on Codex: the item is still sent, complete=false and no data', () => {
  const host = makeHost({ runtime: 'codex' });
  registerSkillTurn({ sourceMessageId: S, conversationId: CONV, selectedSkillIds: ['local:weekly-report'], dir: host.stateDir });
  const p = planSkillsUsed({ sourceMessageId: S, convId: CONV, bodyHash: 'h', dir: host.stateDir, homeDir: host.home, zylosDir: host.zylosDir });
  assert.deepEqual(p.item, { type: 'skills-used', audience: 'ui', attrs: { 'reply-to': S, complete: false } });
});

test('withSkillsUsed: adds metadata.context without touching the caller metadata', () => {
  const it = skillsUsedItem({ sourceMessageId: S, complete: false });
  assert.deepEqual(withSkillsUsed({ type: 'AGENT_TEXT' }, null), { type: 'AGENT_TEXT' });
  assert.deepEqual(withSkillsUsed({ type: 'AGENT_TEXT' }, { item: it }), { type: 'AGENT_TEXT', metadata: { context: { items: [it] } } });
  assert.deepEqual(withSkillsUsed({ metadata: { mine: 1 } }, { item: it }), { metadata: { mine: 1, context: { items: [it] } } });
});

test('registerSkillTurn: ignores ids that are not message ids; old registrations are cleaned', () => {
  const host = makeHost();
  assert.equal(registerSkillTurn({ sourceMessageId: '../x', conversationId: CONV, dir: host.stateDir }), false);
  const old = Date.now() - 25 * 60 * 60 * 1000;
  assert.equal(registerSkillTurn({ sourceMessageId: '1', conversationId: CONV, dir: host.stateDir, now: old }), true);
  fs.utimesSync(path.join(host.stateDir, '1.json'), old / 1000, old / 1000);
  registerSkillTurn({ sourceMessageId: '2', conversationId: CONV, dir: host.stateDir });
  assert.deepEqual(fs.readdirSync(host.stateDir).sort(), ['2.json']);
});

test('a log not written since the message was registered is not read', () => {
  const host = makeHost();
  const p = writeLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(p, old, old);
  assert.deepEqual(compute(host, { since: Date.now() }).reasons, ['inbound_not_found']);
  assert.equal(compute(host, { since: Date.now() - 120_000 }).complete, true);
});

// --- P2 (review R1): an early ack must not report a selected skill as unused ---

function firstReply(host, selected) {
  registerSkillTurn({ sourceMessageId: S, conversationId: CONV, selectedSkillIds: selected, dir: host.stateDir });
  return planSkillsUsed({
    sourceMessageId: S, convId: CONV, bodyHash: 'h', dir: host.stateDir, homeDir: host.home, zylosDir: host.zylosDir,
    runStore: createRunStore({ dir: host.runsDir }),
  });
}

test('R1-P2: ack before the selected skill is called → complete:false, no data (not 「没用到」)', () => {
  const host = makeHost();
  // The agent loads openmax, then replies "收到" before calling weekly-report.
  writeLog(host, [userRec(inbound()), skillRec('openmax')]);
  const p = firstReply(host, ['local:weekly-report']);
  assert.deepEqual(p.item, { type: 'skills-used', audience: 'ui', attrs: { 'reply-to': S, complete: false } });
});

test('R1-P2: every selected skill called before the first reply → complete:true with the full list', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), skillRec('openmax'), skillRec('price-grab'), skillRec('weekly-report')]);
  const p = firstReply(host, ['sk_mkt_1', 'local:weekly-report']);
  assert.deepEqual(p.item.attrs, { 'reply-to': S, complete: true });
  assert.deepEqual(p.item.data, { skill_ids: ['local:openmax', 'sk_mkt_1', 'local:weekly-report'] });
});

test('R1-P2: only some of the selected skills called → complete:false', () => {
  const host = makeHost();
  writeLog(host, [userRec(inbound()), skillRec('price-grab')]);
  assert.equal(firstReply(host, ['sk_mkt_1', 'local:weekly-report']).item.attrs.complete, false);
});

test('R1-P2: withSelectedCheck — no selection list is never complete; an incomplete result stays incomplete', () => {
  const ok = { complete: true, skillIds: ['a'], reasons: [] };
  assert.deepEqual(withSelectedCheck(ok, ['a']), ok);
  assert.deepEqual(withSelectedCheck(ok, ['a', 'b']).reasons, ['selected_not_called']);
  assert.deepEqual(withSelectedCheck(ok, []).reasons, ['selection_unknown']);
  assert.deepEqual(withSelectedCheck(ok, undefined).reasons, ['selection_unknown']);
  const bad = { complete: false, skillIds: [], reasons: ['delegated'] };
  assert.deepEqual(withSelectedCheck(bad, ['a']), bad);
});
