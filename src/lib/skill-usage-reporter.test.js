import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillUsageReporter, isSkillUsageTurn } from './skill-usage-reporter.js';
import { skillUsagePath, skillUsageBody, classifySkillUsageError } from './skill-usage-contract.js';
import { registerSkillTurn, planFirstReply, readSkillTurn, SKILL_TURN_RETENTION_MS } from './activity/skills-used.js';
import { encodeProjectDir } from './activity/collector.js';
import { createRunStore } from './activity/run-store.js';

// OPENM-1396 (tech-plan-delta 11-27 §3.3): the 'skill-usage' task reports a
// registered Web DM turn to cws-core K3 after its turn_end.

const S = '700000000000000011';
const REPLY = '740000000000000011';
const CONV = 'cv-dm-r';
const ORG = 'org-r';
const AGENT = 'agent-r';

let clock = Date.parse('2026-11-27T12:00:00.000Z');
const ts = () => new Date((clock += 1000)).toISOString();
const inbound = (id = S) => `[OPENMAX DM]\n<message-context conversation-id="${CONV}" source-message-id="${id}"/>\nhi\n---- reply via: node c4-send.js "openmax" "${CONV}|type:dm|msg:${id}"`;
const userRec = (content) => ({ type: 'user', timestamp: ts(), message: { content } });
const skillRec = (skill) => ({ type: 'assistant', timestamp: ts(), message: { content: [{ type: 'tool_use', id: `t${clock}`, name: 'Skill', input: { skill } }] } });
const turnEnd = () => ({ type: 'system', subtype: 'turn_duration', timestamp: ts() });

function makeHost() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-usage-'));
  const zylosDir = path.join(home, 'zylos');
  const sk = path.join(zylosDir, '.claude/skills/weekly-report');
  fs.mkdirSync(sk, { recursive: true });
  fs.writeFileSync(path.join(sk, 'SKILL.md'), '---\nname: weekly-report\n---\n');
  fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
  const projDir = path.join(home, '.claude/projects', encodeProjectDir(fs.realpathSync(zylosDir)));
  fs.mkdirSync(projDir, { recursive: true });
  return { home, zylosDir, projDir, dir: path.join(home, 'state'), runsDir: path.join(home, 'runs') };
}

const log = (host, recs) => fs.appendFileSync(path.join(host.projDir, 's.jsonl'), recs.map((r) => `${JSON.stringify(r)}\n`).join(''));

/** A turn registered at `t`, its log written up to turn_end, its first reply recorded. */
function endedTurn(host, { id = S, selected = [], skills = ['weekly-report'], t = Date.now(), reply = REPLY } = {}) {
  assert.ok(registerSkillTurn({
    sourceMessageId: id, conversationId: CONV, orgId: ORG, memberId: AGENT, selectedSkillIds: selected,
    dir: host.dir, homeDir: host.home, zylosDir: host.zylosDir, now: t,
  }));
  log(host, [userRec(inbound(id)), ...skills.map(skillRec), turnEnd()]);
  if (reply) planFirstReply({ sourceMessageId: id, convId: CONV, dir: host.dir }).settle('ok', reply);
}

function reporter(host, { responses = [], clockRef = { t: Date.now() }, ...opts } = {}) {
  const puts = [];
  const warns = [];
  const r = createSkillUsageReporter({
    log: () => {}, warn: (m) => warns.push(m),
    dir: host.dir,
    scanDeps: { homeDir: host.home, zylosDir: host.zylosDir },
    runStore: createRunStore({ dir: host.runsDir }),
    apiPath: (p) => `/api/v1${p}`,
    putForOrg: async (orgId, p, body, o) => {
      puts.push({ orgId, path: p, body, opts: o });
      const next = responses.shift();
      if (next == null || next === 200) return {};
      throw Object.assign(new Error(`HTTP ${next}`), next === 'net' ? {} : { status: next });
    },
    now: () => clockRef.t,
    ...opts,
  });
  return { r, puts, warns, clockRef };
}

const exists = (host, id = S) => fs.existsSync(path.join(host.dir, `${id}.json`));

// --- contract ------------------------------------------------------------------

test('contract: PUT /agents/{member_id}/skill-usage with {source_message_id, reply_message_id, complete, skill_ids}', () => {
  assert.equal(skillUsagePath('agent-1'), '/agents/agent-1/skill-usage');
  assert.deepEqual(skillUsageBody({ sourceMessageId: S, replyMessageId: REPLY, complete: true, skillIds: ['local:a'] }),
    { source_message_id: S, reply_message_id: REPLY, complete: true, skill_ids: ['local:a'] });
  assert.deepEqual(skillUsageBody({ sourceMessageId: S, replyMessageId: REPLY, complete: false, skillIds: ['local:a'] }).skill_ids, [], 'incomplete never carries ids');
  assert.equal(classifySkillUsageError({ status: 404 }), 'absent');
  for (const s of [503, 500, 429, undefined]) assert.equal(classifySkillUsageError({ status: s }), 'retry', String(s));
  for (const s of [400, 403, 409, 422]) assert.equal(classifySkillUsageError({ status: s }), 'give_up', String(s));
});

// --- who is registered -------------------------------------------------------------

test('isSkillUsageTurn: Web DM and DM topic from a human member only', () => {
  const human = { kind: 'human', memberId: 'u1' };
  assert.equal(isSkillUsageTurn({ endpointType: 'dm', senderMember: human }), true);
  assert.equal(isSkillUsageTurn({ endpointType: 'dm-topic', senderMember: human }), true);
  for (const endpointType of ['group', 'group-topic', 'sub', undefined]) {
    assert.equal(isSkillUsageTurn({ endpointType, senderMember: human }), false, String(endpointType));
  }
  assert.equal(isSkillUsageTurn({ endpointType: 'dm', senderMember: { kind: 'agent', memberId: 'a' } }), false);
  assert.equal(isSkillUsageTurn({ endpointType: 'dm', senderMember: undefined }), false);
  assert.equal(isSkillUsageTurn({ endpointType: 'dm', senderMember: human, systemSender: true }), false);
  assert.equal(isSkillUsageTurn({ endpointType: 'dm', senderMember: human, redirected: true }), false);
});

// --- reporting -------------------------------------------------------------------------

test('ended turn with a reply → one PUT to the turn\'s org as the Agent; registration removed', async () => {
  const host = makeHost();
  endedTurn(host);
  const { r, puts } = reporter(host);
  await r.tick();
  assert.equal(puts.length, 1);
  assert.equal(puts[0].orgId, ORG);
  assert.equal(puts[0].path, `/api/v1/agents/${AGENT}/skill-usage`);
  assert.deepEqual(puts[0].body, { source_message_id: S, reply_message_id: REPLY, complete: true, skill_ids: ['local:weekly-report'] });
  assert.equal(exists(host), false);
  assert.equal(fs.existsSync(path.join(host.dir, `${S}.reply`)), false);
  await r.tick();
  assert.equal(puts.length, 1);
});

test('turn still running → no PUT; reported on the tick after its turn_end', async () => {
  const host = makeHost();
  registerSkillTurn({ sourceMessageId: S, conversationId: CONV, orgId: ORG, memberId: AGENT, dir: host.dir, homeDir: host.home, zylosDir: host.zylosDir });
  log(host, [userRec(inbound()), skillRec('weekly-report')]);
  planFirstReply({ sourceMessageId: S, convId: CONV, dir: host.dir }).settle('ok', REPLY);
  const { r, puts } = reporter(host);
  await r.tick();
  assert.equal(puts.length, 0);
  log(host, [turnEnd()]);
  await r.tick();
  assert.equal(puts.length, 1);
});

test('no selection + zero Skill calls → nothing reported, registration removed', async () => {
  const host = makeHost();
  endedTurn(host, { skills: [] });
  const { r, puts } = reporter(host);
  await r.tick();
  assert.equal(puts.length, 0);
  assert.equal(exists(host), false);
});

test('selection + interrupted turn → reported complete:false, no ids', async () => {
  const host = makeHost();
  registerSkillTurn({ sourceMessageId: S, conversationId: CONV, orgId: ORG, memberId: AGENT, selectedSkillIds: ['local:weekly-report'], dir: host.dir, homeDir: host.home, zylosDir: host.zylosDir });
  log(host, [userRec(inbound()), skillRec('weekly-report'), userRec([{ type: 'text', text: '[Request interrupted by user]' }]), turnEnd()]);
  planFirstReply({ sourceMessageId: S, convId: CONV, dir: host.dir }).settle('ok', REPLY);
  const { r, puts } = reporter(host);
  await r.tick();
  assert.deepEqual(puts[0].body, { source_message_id: S, reply_message_id: REPLY, complete: false, skill_ids: [] });
});

test('404 → org paused: no PUT, no-selection turns not registered; re-probe after reprobeMs; success resumes', async () => {
  const host = makeHost();
  const clockRef = { t: Date.now() };
  endedTurn(host, { selected: ['local:weekly-report'], t: clockRef.t });
  const { r, puts, warns } = reporter(host, { responses: [404, 404, 200], clockRef, reprobeMs: 60_000 });
  await r.tick();
  assert.equal(puts.length, 1);
  assert.equal(exists(host), true, 'kept for the re-probe');
  assert.equal(r.shouldRegister(ORG, false), false, 'no-selection turns paused');
  assert.equal(r.shouldRegister(ORG, true), true, 'turns with a selection still registered');
  assert.equal(r.shouldRegister('org-other', false), true, 'only that org');
  clockRef.t += 30_000;
  await r.tick();
  assert.equal(puts.length, 1, 'no PUT while paused');
  clockRef.t += 31_000;
  await r.tick();
  assert.equal(puts.length, 2, 're-probe');
  assert.equal(warns.filter((w) => /404/.test(w)).length, 1, 'warned once');
  clockRef.t += 61_000;
  await r.tick();
  assert.equal(puts.length, 3);
  assert.equal(exists(host), false);
  assert.equal(r.shouldRegister(ORG, false), true, 'resumed');
});

test('503 / network error → kept and retried with backoff; success later removes it', async () => {
  const host = makeHost();
  const clockRef = { t: Date.now() };
  endedTurn(host, { t: clockRef.t });
  const { r, puts } = reporter(host, { responses: [503, 'net', 200], clockRef, retryBaseMs: 1000 });
  await r.tick();
  assert.equal(readSkillTurn(S, { dir: host.dir }).report.attempts, 1);
  await r.tick();
  assert.equal(puts.length, 1, 'not before next_at');
  clockRef.t += 1001;
  await r.tick();
  assert.equal(puts.length, 2);
  assert.equal(readSkillTurn(S, { dir: host.dir }).report.attempts, 2);
  clockRef.t += 1500;
  await r.tick();
  assert.equal(puts.length, 2, 'backoff doubled');
  clockRef.t += 600;
  await r.tick();
  assert.equal(puts.length, 3);
  assert.equal(exists(host), false);
});

test('other 4xx (403) → given up, registration removed', async () => {
  const host = makeHost();
  endedTurn(host);
  const { r, puts, warns } = reporter(host, { responses: [403] });
  await r.tick();
  assert.equal(puts.length, 1);
  assert.equal(exists(host), false);
  assert.ok(warns.some((w) => /giving up/.test(w)));
});

test('past retention → removed without a PUT (retries stop)', async () => {
  const host = makeHost();
  const clockRef = { t: Date.now() };
  endedTurn(host, { t: clockRef.t });
  const { r, puts } = reporter(host, { responses: [503], clockRef });
  await r.tick();
  clockRef.t += SKILL_TURN_RETENTION_MS + 1;
  await r.tick();
  assert.equal(puts.length, 1);
  assert.equal(exists(host), false);
});

test('ended turn without a Web reply → nothing reported after the reply wait', async () => {
  const host = makeHost();
  const clockRef = { t: Date.now() };
  endedTurn(host, { reply: null, t: clockRef.t });
  const { r, puts } = reporter(host, { clockRef });
  await r.tick();
  assert.equal(exists(host), true, 'waits for the reply id');
  clockRef.t += 6 * 60 * 1000;
  await r.tick();
  assert.equal(puts.length, 0);
  assert.equal(exists(host), false);
});

test('not gated on OPENMAX_ACTIVITY', async () => {
  const prev = process.env.OPENMAX_ACTIVITY;
  process.env.OPENMAX_ACTIVITY = '0';
  try {
    const host = makeHost();
    endedTurn(host);
    const { r, puts } = reporter(host);
    await r.tick();
    assert.equal(puts.length, 1);
  } finally {
    if (prev === undefined) delete process.env.OPENMAX_ACTIVITY; else process.env.OPENMAX_ACTIVITY = prev;
  }
});
