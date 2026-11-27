import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  registerSkillTurn, dropSkillTurn, readSkillTurn, buildSkillIdMap, feedTurnEvents, advanceScan, finalizeScan,
  decideReport, planFirstReply, readFirstReply, listSkillTurns, sweepOrphans,
  MAX_SKILLS_USED_IDS, TURN_END_WAIT_MS, REPLY_WAIT_MS, SKILL_TURN_RETENTION_MS,
} from './skills-used.js';
import { encodeProjectDir } from './collector.js';
import { createRunStore } from './run-store.js';

// OPENM-1396 (wsb#830, tech-plan-delta 11-27 §3.3): every Web DM turn is
// registered; after its turn_end the skills it called are reported to
// cws-core (K3). Complete only with a turn_end and no degrading case.

const S = '700000000000000001';
const CONV = 'cv-dm-1';
const ORG = 'org-1';
const AGENT = 'agent-member-1';
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

let clock = Date.parse('2026-11-27T10:00:00.000Z');
const ts = () => new Date((clock += 1000)).toISOString();

function inbound(id = S, conv = CONV) {
  return `[OPENMAX DM]\n<message-context conversation-id="${conv}" source-message-id="${id}"/>\n<current-message>\nAlice said: 查一下\n</current-message>\n---- reply via: node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "openmax" "${conv}|type:dm|msg:${id}"`;
}
const userRec = (content) => ({ type: 'user', timestamp: ts(), uuid: `u${clock}`, message: { content } });
const toolRec = (name, input, id = `t${clock}`) => ({ type: 'assistant', timestamp: ts(), uuid: `a${clock}`, message: { content: [{ type: 'tool_use', id, name, input }] } });
const skillRec = (skill) => toolRec('Skill', { skill });
const sendRec = () => toolRec('Bash', { command: `node c4-send.js "openmax" "${EP}" "收到"` });
const turnEnd = () => ({ type: 'system', subtype: 'turn_duration', timestamp: ts() });
const line = (r) => `${typeof r === 'string' ? r : JSON.stringify(r)}\n`;

function appendLog(host, records, name = 'sess-1.jsonl') {
  const p = path.join(host.projDir, name);
  fs.appendFileSync(p, records.map(line).join(''));
  return p;
}

function register(host, { selected = [], id = S, now = Date.now() } = {}) {
  return registerSkillTurn({
    sourceMessageId: id, conversationId: CONV, orgId: ORG, memberId: AGENT, selectedSkillIds: selected,
    dir: host.stateDir, homeDir: host.home, zylosDir: host.zylosDir, now,
  });
}

function advance(host, id = S, extra = {}) {
  const reg = readSkillTurn(id, { dir: host.stateDir });
  const r = advanceScan(reg, { homeDir: host.home, zylosDir: host.zylosDir, ...extra });
  fs.writeFileSync(path.join(host.stateDir, `${id}.json`), JSON.stringify(reg));
  return { reg, ...r };
}

function outcome(host, reg) {
  return finalizeScan(reg, { runStore: createRunStore({ dir: host.runsDir }) });
}

/** Register, write the turn, advance until it ends; returns the finalized outcome. */
function runTurn(host, records, { selected = [] } = {}) {
  appendLog(host, [userRec('older turn'), skillRec('weekly-report'), turnEnd()]);
  assert.equal(register(host, { selected }), true);
  appendLog(host, records);
  const { reg, ended } = advance(host);
  return { reg, ended, out: ended ? outcome(host, reg) : null };
}

// --- skill name → skill_id -------------------------------------------------------

test('skill map: market dir → .market-managed skill_id; local dir → local:<dir>; kb skills count', () => {
  const host = makeHost();
  const map = buildSkillIdMap({ skillsDir: path.join(host.zylosDir, '.claude/skills') });
  assert.equal(map.resolve('price-grab'), 'sk_mkt_1');
  assert.equal(map.resolve('market--price-grab'), 'sk_mkt_1');
  assert.equal(map.resolve('weekly-report'), 'local:weekly-report');
  assert.equal(map.resolve('openmax-product-faq'), 'local:openmax-product-faq');
  assert.equal(map.resolve('nope'), null);
});

test('skill map: a market dir without a readable .market-managed resolves to nothing; key=value form is read', () => {
  const host = makeHost({ marketFile: null });
  assert.equal(buildSkillIdMap({ skillsDir: path.join(host.zylosDir, '.claude/skills') }).resolve('price-grab'), null);
  const host2 = makeHost({ marketFile: 'skill_id=sk_kv_9\nversion_no=1\n' });
  assert.equal(buildSkillIdMap({ skillsDir: path.join(host2.zylosDir, '.claude/skills') }).resolve('price-grab'), 'sk_kv_9');
});

// --- registration -----------------------------------------------------------------

test('register: records each recent log\'s end; a redelivery keeps the first registration; bad input → false', () => {
  const host = makeHost();
  const p = appendLog(host, [userRec('older'), turnEnd()]);
  assert.equal(register(host, { selected: [] }), true);
  const reg = readSkillTurn(S, { dir: host.stateDir });
  assert.deepEqual(reg.scan.logs, { [p]: { offset: fs.statSync(p).size } });
  assert.equal(reg.org_id, ORG);
  assert.equal(reg.member_id, AGENT);
  assert.deepEqual(reg.selected_skill_ids, []);
  // Redelivered: kept as is (not reset to the new log end).
  appendLog(host, [userRec('more')]);
  assert.equal(register(host, { selected: ['x'] }), true);
  assert.deepEqual(readSkillTurn(S, { dir: host.stateDir }).selected_skill_ids, []);
  assert.equal(registerSkillTurn({ sourceMessageId: '../x', conversationId: CONV, orgId: ORG, memberId: AGENT, dir: host.stateDir }), false);
  assert.equal(registerSkillTurn({ sourceMessageId: '2', conversationId: CONV, orgId: ORG, dir: host.stateDir }), false, 'no member id');
});

test('register on Codex: only a turn with a selection (nothing to report without one)', () => {
  const host = makeHost({ runtime: 'codex' });
  assert.equal(register(host, { selected: [] }), false);
  assert.equal(register(host, { selected: ['local:weekly-report'] }), true);
  const { reg, ended } = advance(host);
  assert.equal(ended, true);
  assert.deepEqual(outcome(host, reg), { complete: false, skillIds: [], reasons: ['runtime_unsupported'] });
});

// --- the turn: completeness ---------------------------------------------------------

test('TC-U-01: skills called after the inbound, then turn_end → complete, first-use order, deduped, kb counted', () => {
  const host = makeHost();
  const { ended, out } = runTurn(host, [
    userRec(inbound()),
    skillRec('openmax'), skillRec('price-grab'), skillRec('weekly-report'), skillRec('price-grab'),
    skillRec('openmax-product-faq'), sendRec(), turnEnd(),
  ]);
  assert.equal(ended, true);
  assert.deepEqual(out, { complete: true, skillIds: ['local:openmax', 'sk_mkt_1', 'local:weekly-report', 'local:openmax-product-faq'], reasons: [] });
});

test('early ack: a skill called AFTER the first reply (「收到」) is still in the list — complete at turn_end', () => {
  const host = makeHost();
  const { out } = runTurn(host, [userRec(inbound()), sendRec(), skillRec('weekly-report'), sendRec(), turnEnd()], { selected: ['local:weekly-report'] });
  assert.deepEqual(out, { complete: true, skillIds: ['local:weekly-report'], reasons: [] });
});

test('no turn_end yet → not ended (nothing decided); the turn_end ends it on a later tick', () => {
  const host = makeHost();
  const { ended } = runTurn(host, [userRec(inbound()), skillRec('weekly-report'), sendRec()]);
  assert.equal(ended, false);
  appendLog(host, [skillRec('price-grab'), turnEnd(), userRec('next turn'), skillRec('openmax'), turnEnd()]);
  const { reg, ended: ended2 } = advance(host);
  assert.equal(ended2, true);
  assert.deepEqual(outcome(host, reg).skillIds, ['local:weekly-report', 'sk_mkt_1'], 'the next turn is not counted');
});

test('a turn_end before the inbound (the previous turn) does not end this one', () => {
  const host = makeHost();
  assert.equal(register(host), true);
  appendLog(host, [skillRec('price-grab'), turnEnd(), userRec(inbound()), skillRec('weekly-report')]);
  const { reg, ended } = advance(host);
  assert.equal(ended, false);
  assert.deepEqual(reg.scan.ids, ['local:weekly-report']);
});

test('a queued message (enqueue) is anchored where it is delivered, not where it was queued', () => {
  const host = makeHost();
  assert.equal(register(host), true);
  appendLog(host, [
    userRec(inbound('700000000000000002')),
    { type: 'queue-operation', operation: 'enqueue', timestamp: ts(), content: inbound() },
    skillRec('price-grab'), turnEnd(),
    { type: 'queue-operation', operation: 'dequeue', timestamp: ts() },
    userRec(inbound()), skillRec('weekly-report'), turnEnd(),
  ]);
  const { reg, ended } = advance(host);
  assert.equal(ended, true);
  assert.deepEqual(outcome(host, reg), { complete: true, skillIds: ['local:weekly-report'], reasons: [] });
});

test('interrupted turn → incomplete (Claude interrupt input, interrupted tool result)', () => {
  let host = makeHost();
  let r = runTurn(host, [userRec(inbound()), skillRec('weekly-report'), userRec([{ type: 'text', text: '[Request interrupted by user]' }]), turnEnd()]);
  assert.deepEqual(r.out.reasons, ['interrupted']);
  assert.deepEqual(r.out.skillIds, [], 'incomplete never carries ids');
  host = makeHost();
  r = runTurn(host, [
    userRec(inbound()), toolRec('Bash', { command: 'sleep 100' }, 'tb1'),
    { type: 'user', timestamp: ts(), message: { content: [{ type: 'tool_result', tool_use_id: 'tb1', is_error: true, content: '[Request interrupted by user for tool use]' }] } },
    turnEnd(),
  ]);
  assert.deepEqual(r.out.reasons, ['interrupted']);
});

test('a Codex-shaped interrupted turn_end (codex-rollout.js) → incomplete; the Claude turn_end carries no flag', () => {
  const scan = { anchored: true, ids: [], reasons: [], ended: false };
  feedTurnEvents(scan, [{ t: 'turn_end', interrupted: true }], { sourceMessageId: S, resolve: () => null });
  assert.equal(scan.ended, true);
  assert.deepEqual(scan.reasons, ['interrupted']);
});

test('merged / injected input, or another input in the turn → incomplete', () => {
  let host = makeHost();
  assert.deepEqual(runTurn(host, [userRec(inbound()), skillRec('weekly-report'), userRec(inbound('700000000000000002')), turnEnd()]).out.reasons, ['merged_input']);
  host = makeHost();
  assert.deepEqual(runTurn(host, [userRec(`${inbound('700000000000000002')}\n${inbound()}`), skillRec('weekly-report'), turnEnd()]).out.reasons, ['merged_input']);
  host = makeHost();
  assert.deepEqual(runTurn(host, [
    userRec(inbound('700000000000000002')),
    { type: 'attachment', timestamp: ts(), uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: inbound() } },
    skillRec('weekly-report'), turnEnd(),
  ]).out.reasons, ['merged_input']);
});

test('unknown record / unparsable line, unrecognized Skill, SKILL.md read, subagent → incomplete', () => {
  const cases = [
    [[{ type: 'assistant', timestamp: ts(), message: { content: 'not-an-array' } }], 'unknown_record'],
    [['{"type":"assistant", broken'], 'unknown_record'],
    [[skillRec('not-installed')], 'unrecognized_skill'],
    [[toolRec('Skill', { skill: 42 })], 'unrecognized_invocation'],
    [[toolRec('Read', { file_path: '/home/x/zylos/.claude/skills/weekly-report/SKILL.md' })], 'skill_file_read'],
    [[toolRec('Bash', { command: 'cat ~/zylos/.claude/skills/weekly-report/SKILL.md' })], 'skill_file_read'],
    [[toolRec('Task', { description: 'x', prompt: 'y' })], 'delegated'],
  ];
  for (const [recs, reason] of cases) {
    const host = makeHost();
    assert.deepEqual(runTurn(host, [userRec(inbound()), ...recs, turnEnd()]).out.reasons, [reason], reason);
  }
  // Running a skill's own CLI is not reading the skill.
  const host = makeHost();
  assert.equal(runTurn(host, [userRec(inbound()), toolRec('Bash', { command: 'node ~/zylos/.claude/skills/openmax/src/cli/kb.js search {}' }), turnEnd()]).out.complete, true);
});

test('activity run of the message status_only / merged_turn → incomplete; another message\'s run does not matter', () => {
  const host = makeHost();
  const { reg } = runTurn(host, [userRec(inbound()), skillRec('weekly-report'), turnEnd()]);
  const store = createRunStore({ dir: host.runsDir });
  store.writeActive({ v: 1, by_conversation: { [CONV]: ['r_0000000a'] }, gate: {}, unregistered: {} });
  store.writeRun({ run_id: 'r_0000000a', source_message_id: S, status_only: true, events: [] });
  assert.deepEqual(outcome(host, reg).reasons, ['status_only']);
  store.writeRun({ run_id: 'r_0000000a', source_message_id: S, status_only: false, events: [{ kind: 'notice', code: 'merged_turn' }] });
  assert.deepEqual(outcome(host, reg).reasons, ['merged_turn']);
  store.writeRun({ run_id: 'r_0000000a', source_message_id: '9', status_only: true, events: [] });
  assert.equal(outcome(host, reg).complete, true);
});

test('more than 50 distinct skills → incomplete', () => {
  const reg = {
    runtime: 'claude', conversation_id: CONV, source_message_id: S,
    scan: { ids: Array.from({ length: MAX_SKILLS_USED_IDS + 1 }, (_, i) => `local:s${i}`), reasons: [], ended_at: 1 },
  };
  assert.deepEqual(finalizeScan(reg, { runStore: createRunStore({ dir: tmp() }) }), { complete: false, skillIds: [], reasons: ['too_many'] });
});

test('no turn_end within TURN_END_WAIT_MS → ended incomplete (turn_end_not_seen)', () => {
  const host = makeHost();
  const t0 = Date.now();
  register(host, { now: t0 });
  appendLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  assert.equal(advance(host, S, { now: t0 + 1000 }).ended, false);
  const { reg, ended } = advance(host, S, { now: t0 + TURN_END_WAIT_MS + 1 });
  assert.equal(ended, true);
  assert.deepEqual(outcome(host, reg).reasons, ['turn_end_not_seen']);
});

// --- incremental reading ------------------------------------------------------------

test('cost: only bytes written after the registration are read; each byte once across ticks', () => {
  const host = makeHost();
  // A large pre-existing log (the old 8 MiB tail read would read all of it).
  const filler = Array.from({ length: 2000 }, () => userRec('x'.repeat(500)));
  appendLog(host, filler);
  register(host);
  const part1 = [userRec(inbound()), skillRec('weekly-report')];
  appendLog(host, part1);
  const a = advance(host);
  assert.equal(a.bytes, Buffer.byteLength(part1.map(line).join('')));
  const b = advance(host);
  assert.equal(b.bytes, 0, 'nothing new → nothing read');
  const part2 = [skillRec('price-grab'), turnEnd()];
  appendLog(host, part2);
  const c = advance(host);
  assert.equal(c.bytes, Buffer.byteLength(part2.map(line).join('')));
  assert.equal(c.ended, true);
  assert.deepEqual(outcome(host, c.reg).skillIds, ['local:weekly-report', 'sk_mkt_1']);
});

test('a partial last line is left for the next tick; a per-tick budget spreads a long turn over ticks', () => {
  const host = makeHost();
  register(host);
  const p = appendLog(host, [userRec(inbound())]);
  const half = JSON.stringify(skillRec('weekly-report'));
  fs.appendFileSync(p, half.slice(0, 20));
  let r = advance(host);
  assert.equal(r.reg.scan.ids.length, 0);
  fs.appendFileSync(p, `${half.slice(20)}\n`);
  r = advance(host);
  assert.deepEqual(r.reg.scan.ids, ['local:weekly-report']);
  // Budget: 3 records per tick at most.
  appendLog(host, Array.from({ length: 9 }, () => skillRec('price-grab')).concat([turnEnd()]));
  let ticks = 0;
  do {
    r = advance(host, S, { budget: 3 * 200 });
    assert.ok(r.bytes <= 3 * 200, `tick read ${r.bytes} bytes`);
    ticks++;
  } while (!r.ended && ticks < 50);
  assert.ok(ticks > 2, `took ${ticks} ticks`);
  assert.deepEqual(outcome(host, r.reg).skillIds, ['local:weekly-report', 'sk_mkt_1']);
});

test('a line over the line limit after the inbound is skipped and makes the turn incomplete', () => {
  const host = makeHost();
  register(host);
  appendLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  appendLog(host, [JSON.stringify({ type: 'user', timestamp: ts(), message: { content: 'y'.repeat(5 * 1024 * 1024) } }), turnEnd()]);
  let r;
  let ticks = 0;
  do { r = advance(host); ticks++; } while (!r.ended && ticks < 10);
  assert.equal(r.ended, true);
  assert.deepEqual(outcome(host, r.reg).reasons, ['unknown_record']);
});

test('a session log started after the registration (restart / new session) is read from its start', () => {
  const host = makeHost();
  appendLog(host, [userRec('old session'), turnEnd()], 'old.jsonl');
  register(host);
  appendLog(host, [userRec(inbound()), skillRec('weekly-report'), turnEnd()], 'new.jsonl');
  const { reg, ended } = advance(host);
  assert.equal(ended, true);
  assert.equal(path.basename(reg.scan.anchor_log), 'new.jsonl');
  assert.deepEqual(Object.keys(reg.scan.logs).map((p) => path.basename(p)), ['new.jsonl'], 'other logs dropped once found');
  assert.deepEqual(outcome(host, reg).skillIds, ['local:weekly-report']);
});

test('the anchored log rewritten (shorter) under the scan → incomplete', () => {
  const host = makeHost();
  register(host);
  const p = appendLog(host, [userRec(inbound()), skillRec('weekly-report')]);
  advance(host);
  fs.writeFileSync(p, '');
  const { reg, ended } = advance(host);
  assert.equal(ended, true);
  assert.ok(outcome(host, reg).reasons.includes('log_rewritten'));
});

// --- the first reply -----------------------------------------------------------------

test('planFirstReply: unregistered / other conversation → null; first delivered reply wins; failures record nothing', () => {
  const host = makeHost();
  const dir = host.stateDir;
  assert.equal(planFirstReply({ sourceMessageId: S, convId: CONV, dir }), null);
  register(host);
  assert.equal(planFirstReply({ sourceMessageId: S, convId: 'cv-other', dir }), null);
  assert.equal(planFirstReply({ sourceMessageId: null, convId: CONV, dir }), null);
  const p1 = planFirstReply({ sourceMessageId: S, convId: CONV, dir });
  p1.settle('rejected', '7400000000000000001');
  p1.settle('uncertain');
  p1.settle('ok', 'not-a-message-id');
  assert.equal(readFirstReply(S, { dir }), null);
  const p2 = planFirstReply({ sourceMessageId: S, convId: CONV, dir });
  const p3 = planFirstReply({ sourceMessageId: S, convId: CONV, dir }); // a concurrent sender
  p2.settle('ok', '7400000000000000002');
  p3.settle('ok', '7400000000000000003');
  assert.equal(readFirstReply(S, { dir }), '7400000000000000002');
  assert.equal(planFirstReply({ sourceMessageId: S, convId: CONV, dir }), null, 'recorded → no further plan');
});

// --- report decision ---------------------------------------------------------------------

const regOf = ({ selected = [], ended = 1000, reasons = [], runtime = 'claude' } = {}) => ({
  runtime, selected_skill_ids: selected, scan: { ended_at: ended, reasons, ids: [] },
});
const R = '7400000000000000009';

test('decide: turn not over → wait (even with the reply known)', () => {
  assert.deepEqual(decideReport({ reg: regOf({ ended: null }), outcome: { complete: false, skillIds: [], reasons: [] }, replyMessageId: R }), { action: 'wait' });
});

test('decide: no selection + complete + skills → report ④ (Agent 自己用了)', () => {
  const d = decideReport({ reg: regOf(), outcome: { complete: true, skillIds: ['local:a'], reasons: [] }, replyMessageId: R, now: 2000 });
  assert.deepEqual(d, { action: 'report', complete: true, skillIds: ['local:a'], replyMessageId: R, reasons: [] });
});

test('decide: no selection + zero Skill calls → not reported', () => {
  assert.equal(decideReport({ reg: regOf(), outcome: { complete: true, skillIds: [], reasons: [] }, replyMessageId: R }).action, 'drop');
});

test('decide: no selection + incomplete → not reported, dropped as soon as a reason appears (before turn_end)', () => {
  const d = decideReport({ reg: regOf({ ended: null, reasons: ['delegated'] }), outcome: { complete: false, skillIds: [], reasons: ['delegated'] }, replyMessageId: null });
  assert.deepEqual(d, { action: 'drop', why: 'incomplete_no_selection' });
});

test('decide: selection + incomplete → reported complete:false with no ids (UI falls back to ③)', () => {
  const d = decideReport({ reg: regOf({ selected: ['local:a'], reasons: ['interrupted'] }), outcome: { complete: false, skillIds: [], reasons: ['interrupted'] }, replyMessageId: R });
  assert.equal(d.action, 'report');
  assert.equal(d.complete, false);
  assert.deepEqual(d.skillIds, []);
});

test('decide: selection + complete + nothing used → reported (② 指定的技能这次都没用到)', () => {
  const d = decideReport({ reg: regOf({ selected: ['local:a'] }), outcome: { complete: true, skillIds: [], reasons: [] }, replyMessageId: R });
  assert.equal(d.action, 'report');
  assert.deepEqual(d.skillIds, []);
});

test('decide: no Web reply → wait REPLY_WAIT_MS after turn_end, then drop; Codex waits the whole retention', () => {
  const o = { complete: true, skillIds: ['local:a'], reasons: [] };
  assert.equal(decideReport({ reg: regOf({ ended: 1000 }), outcome: o, replyMessageId: null, now: 1000 + REPLY_WAIT_MS - 1 }).action, 'wait');
  assert.deepEqual(decideReport({ reg: regOf({ ended: 1000 }), outcome: o, replyMessageId: null, now: 1000 + REPLY_WAIT_MS + 1 }), { action: 'drop', why: 'no_reply' });
  const codex = regOf({ runtime: 'codex', selected: ['local:a'], reasons: ['runtime_unsupported'] });
  const oc = { complete: false, skillIds: [], reasons: ['runtime_unsupported'] };
  assert.equal(decideReport({ reg: codex, outcome: oc, replyMessageId: null, now: 1000 + REPLY_WAIT_MS + 1 }).action, 'wait');
  assert.equal(decideReport({ reg: codex, outcome: oc, replyMessageId: R }).action, 'report');
});

// --- housekeeping --------------------------------------------------------------------------

test('dropSkillTurn removes registration and reply; sweepOrphans removes only stale replies with no registration', () => {
  const host = makeHost();
  register(host);
  planFirstReply({ sourceMessageId: S, convId: CONV, dir: host.stateDir }).settle('ok', '7400000000000000001');
  assert.deepEqual(listSkillTurns({ dir: host.stateDir }), [S]);
  dropSkillTurn(S, { dir: host.stateDir });
  assert.deepEqual(fs.readdirSync(host.stateDir), []);
  fs.writeFileSync(path.join(host.stateDir, '5.reply'), '{}');
  const old = (Date.now() - SKILL_TURN_RETENTION_MS - 1000) / 1000;
  fs.utimesSync(path.join(host.stateDir, '5.reply'), old, old);
  fs.writeFileSync(path.join(host.stateDir, '6.reply'), '{}');
  // A stale reply of a LIVE registration stays (removed with the registration).
  register(host, { id: '7' });
  fs.writeFileSync(path.join(host.stateDir, '7.reply'), '{}');
  fs.utimesSync(path.join(host.stateDir, '7.reply'), old, old);
  sweepOrphans({ dir: host.stateDir });
  assert.deepEqual(fs.readdirSync(host.stateDir).sort(), ['6.reply', '7.json', '7.reply']);
});
