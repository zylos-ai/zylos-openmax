import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createSkillUsageReporter, isSkillUsageTurn, forwardDropsSkillTurn, skillTurnSessionGroup } from './skill-usage-reporter.js';
import { skillUsagePath, skillUsageBody, classifySkillUsageError, SKILL_USAGE_DISABLED_CODE } from './skill-usage-contract.js';
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
      if (next === 'off') throw Object.assign(new Error('HTTP 404'), { status: 404, body: DISABLED_BODY });
      throw Object.assign(new Error(`HTTP ${next}`), next === 'net' ? {} : { status: next, body: { error: { code: 'not_found' } } });
    },
    now: () => clockRef.t,
    ...opts,
  });
  return { r, puts, warns, clockRef };
}

// K3's feature-off answer, exactly as cws-core sends it (application/problem+json).
const DISABLED_BODY = {
  error: {
    type: 'https://openmax.ai/problems/SKILL_USAGE_DISABLED', title: 'Not Found', status: 404,
    detail: 'skill usage reporting is disabled for this organization', code: 'SKILL_USAGE_DISABLED',
  },
  request_id: 'req-1', server_time: '2026-11-27T12:00:00Z',
};

const exists = (host, id = S) => fs.existsSync(path.join(host.dir, `${id}.json`));

// --- contract ------------------------------------------------------------------

test('contract: PUT /agents/{member_id}/skill-usage with {source_message_id, reply_message_id, complete, skill_ids}', () => {
  assert.equal(skillUsagePath('agent-1'), '/agents/agent-1/skill-usage');
  assert.deepEqual(skillUsageBody({ sourceMessageId: S, replyMessageId: REPLY, complete: true, skillIds: ['local:a'] }),
    { source_message_id: S, reply_message_id: REPLY, complete: true, skill_ids: ['local:a'] });
  assert.deepEqual(skillUsageBody({ sourceMessageId: S, replyMessageId: REPLY, complete: false, skillIds: ['local:a'] }).skill_ids, [], 'incomplete never carries ids');
  assert.equal(SKILL_USAGE_DISABLED_CODE, 'SKILL_USAGE_DISABLED');
  assert.equal(classifySkillUsageError({ status: 404, body: DISABLED_BODY }), 'disabled');
  for (const code of ['skill_usage_disabled', 'Skill_Usage_Disabled', 'NOT_FOUND', '', undefined]) {
    assert.equal(classifySkillUsageError({ status: 404, body: { error: { ...DISABLED_BODY.error, code } } }), 'give_up', String(code));
  }
  assert.equal(classifySkillUsageError({ status: 404 }), 'give_up', 'a plain 404 is not feature-off');
  assert.equal(classifySkillUsageError({ status: 404, body: { error: { code: 'not_found' } } }), 'give_up');
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

test('disabled 404 → org paused (no PUT, no no-selection registrations), the record dropped; the next real record re-probes after reprobeMs', async () => {
  const host = makeHost();
  const clockRef = { t: Date.now() };
  endedTurn(host, { selected: ['local:weekly-report'], t: clockRef.t });
  const { r, puts, warns } = reporter(host, { responses: ['off', 'off', 200], clockRef, reprobeMs: 60_000 });
  await r.tick();
  assert.equal(puts.length, 1);
  assert.equal(exists(host), false, 'the record that got feature-off is dropped, not kept for 24 h');
  assert.equal(r.shouldRegister(ORG, false), false, 'no-selection turns paused');
  assert.equal(r.shouldRegister(ORG, true), true, 'turns with a selection still registered');
  assert.equal(r.shouldRegister('org-other', false), true, 'only that org');
  // A new record during the pause is not PUT.
  const S2 = '700000000000000021';
  endedTurn(host, { id: S2, selected: ['local:weekly-report'], t: clockRef.t, reply: '740000000000000021' });
  clockRef.t += 30_000;
  await r.tick();
  assert.equal(puts.length, 1, 'no PUT while paused');
  // After the pause the next real record is the probe; still off → paused again, record dropped.
  clockRef.t += 31_000;
  await r.tick();
  assert.equal(puts.length, 2);
  assert.equal(exists(host, S2), false);
  assert.equal(r.shouldRegister(ORG, false), false);
  assert.equal(warns.filter((w) => /SKILL_USAGE_DISABLED/.test(w)).length, 1, 'warned once');
  // Feature on: the next record after the pause goes through and resumes the org.
  const S3 = '700000000000000031';
  clockRef.t += 61_000;
  endedTurn(host, { id: S3, t: clockRef.t, reply: '740000000000000031' });
  await r.tick();
  assert.equal(puts.length, 3);
  assert.equal(exists(host, S3), false);
  assert.equal(r.shouldRegister(ORG, false), true, 'resumed');
});

test('disabled 404 on one record pauses the org: its other pending records are not PUT until the re-probe', async () => {
  const host = makeHost();
  const clockRef = { t: Date.now() };
  endedTurn(host, { id: S, selected: ['local:weekly-report'], t: clockRef.t });
  endedTurn(host, { id: '700000000000000012', selected: ['local:weekly-report'], t: clockRef.t, reply: '740000000000000012' });
  const { r, puts } = reporter(host, { responses: ['off'], clockRef, reprobeMs: 60_000 });
  await r.tick();
  assert.equal(puts.length, 1, 'the second record of the paused org is not PUT in the same tick');
  clockRef.t += 30_000;
  await r.tick();
  assert.equal(puts.length, 1);
  clockRef.t += 31_000;
  await r.tick();
  assert.equal(puts.length, 2, 'the waiting record is the probe');
  assert.equal(exists(host, '700000000000000012'), false);
});

test('plain 404 (no SKILL_USAGE_DISABLED code) → only that record is given up; the org is not paused', async () => {
  const host = makeHost();
  endedTurn(host);
  const S2 = '700000000000000022';
  endedTurn(host, { id: S2, reply: '740000000000000022' });
  const { r, puts } = reporter(host, { responses: [404, 200] });
  await r.tick();
  assert.equal(puts.length, 2, 'the other record of the same org is still PUT');
  assert.equal(exists(host), false);
  assert.equal(exists(host, S2), false);
  assert.equal(r.shouldRegister(ORG, false), true);
});

test('a poison record (rejected every time) cannot keep the org paused or be retried', async () => {
  const host = makeHost();
  const clockRef = { t: Date.now() };
  endedTurn(host, { t: clockRef.t });
  const { r, puts } = reporter(host, { responses: [404, 422], clockRef });
  await r.tick();
  assert.equal(puts.length, 1);
  assert.equal(exists(host), false, 'given up at once');
  assert.equal(r.isPaused(ORG), false);
  clockRef.t += 4 * 60 * 60 * 1000;
  await r.tick();
  assert.equal(puts.length, 1, 'never PUT again');
  const S2 = '700000000000000023';
  endedTurn(host, { id: S2, t: clockRef.t, reply: '740000000000000023' });
  await r.tick();
  assert.equal(puts.length, 2);
  assert.equal(exists(host, S2), false);
  assert.equal(r.isPaused(ORG), false);
});

test('the PUT is quiet on success (no [rpc] request/response pair per report)', async () => {
  const host = makeHost();
  endedTurn(host);
  const { r, puts } = reporter(host);
  await r.tick();
  assert.equal(puts[0].opts.quietOnSuccess, true);
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

test('real client: a problem+json 404 SKILL_USAGE_DISABLED body is parsed and classified as feature-off; lower-case code is not', async () => {
  const http = await import('node:http');
  const client = await import('./client.js');
  for (const [code, expected] of [['SKILL_USAGE_DISABLED', 'disabled'], ['skill_usage_disabled', 'give_up']]) {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/problem+json' });
      res.end(JSON.stringify({ ...DISABLED_BODY, error: { ...DISABLED_BODY.error, code } }));
    });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    client.setBaseUrl(`http://127.0.0.1:${server.address().port}`);
    client.setApiKey('test-token');
    try {
      // eslint-disable-next-line no-await-in-loop
      const err = await client.putForOrg('org-x', client.apiPath(skillUsagePath('agent-x')), {}, { timeoutMs: 5000 }).then(() => null, (e) => e);
      assert.equal(err?.status, 404);
      assert.equal(err.body?.error?.code, code, 'body parsed as JSON');
      assert.equal(classifySkillUsageError(err), expected, code);
    } finally {
      client.setBaseUrl(null);
      client.setApiKey(null);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

// --- review 11-27 (gavin P2-6 / P3, daniel P3) -------------------------------------

test('409 SKILL_USAGE_SOURCE_ALREADY_REPORTED (same source, other reply) → given up like any non-404 4xx; no retry, no pause', async () => {
  const conflict = Object.assign(new Error('HTTP 409'), {
    status: 409,
    body: { error: { code: 'SKILL_USAGE_SOURCE_ALREADY_REPORTED', status: 409, title: 'Conflict' } },
  });
  assert.equal(classifySkillUsageError(conflict), 'give_up');
  const host = makeHost();
  const OTHER = '700000000000000012';
  endedTurn(host);
  endedTurn(host, { id: OTHER, reply: '740000000000000012' });
  const puts = [];
  const { r, warns, clockRef } = reporter(host, {
    putForOrg: async (orgId, p, body) => {
      puts.push(body.source_message_id);
      if (body.source_message_id === S) throw conflict;
      return {};
    },
  });
  await r.tick();
  assert.deepEqual(puts.sort(), [S, OTHER].sort(), 'the other entry of the same org is still reported');
  assert.equal(exists(host), false, 'the 409 entry is dropped');
  assert.equal(exists(host, OTHER), false, 'the other one was reported and removed');
  assert.ok(warns.some((w) => /409/.test(w) && /giving up/.test(w)));
  assert.equal(r.isPaused(ORG, clockRef.t), false, 'the org is not paused');
  clockRef.t += 60 * 60 * 1000;
  await r.tick();
  assert.equal(puts.length, 2, 'never retried');
});

test('401 → token re-minted (force) and the PUT sent once more; success removes the record', async () => {
  const host = makeHost();
  endedTurn(host);
  const reacq = [];
  const { r, puts } = reporter(host, { responses: [401, 200], reacquireToken: async (orgId, o) => { reacq.push([orgId, o]); } });
  await r.tick();
  assert.equal(puts.length, 2);
  assert.deepEqual(puts[0].body, puts[1].body, 'the same report');
  assert.deepEqual(reacq, [[ORG, { force: true }]]);
  assert.equal(exists(host), false);
});

test('401 twice → given up after the one retry', async () => {
  const host = makeHost();
  endedTurn(host);
  let reacq = 0;
  const { r, puts, warns } = reporter(host, { responses: [401, 401, 200], reacquireToken: async () => { reacq += 1; } });
  await r.tick();
  assert.equal(puts.length, 2);
  assert.equal(reacq, 1);
  assert.equal(exists(host), false);
  assert.ok(warns.some((w) => /401/.test(w) && /giving up/.test(w)));
});

test('401 then 503 → kept for the usual backoff retry', async () => {
  const host = makeHost();
  endedTurn(host);
  const { r, puts } = reporter(host, { responses: [401, 503], reacquireToken: async () => {} });
  await r.tick();
  assert.equal(puts.length, 2);
  assert.equal(exists(host), true);
  assert.equal(readSkillTurn(S, { dir: host.dir }).report.attempts, 1);
});

test('P2-6: one global scan budget per tick across registrations; the start rotates so none starves', async () => {
  const host = makeHost();
  const ids = ['700000000000000021', '700000000000000022', '700000000000000023'];
  for (const id of ids) {
    assert.ok(registerSkillTurn({
      sourceMessageId: id, conversationId: CONV, orgId: ORG, memberId: AGENT, selectedSkillIds: [],
      dir: host.dir, homeDir: host.home, zylosDir: host.zylosDir,
    }));
  }
  // ~3 KiB of other traffic, then each turn.
  const pad = { type: 'user', timestamp: ts(), message: { content: 'x'.repeat(1000) } };
  log(host, [pad, pad, pad]);
  for (const id of ids) log(host, [userRec(inbound(id)), skillRec('weekly-report'), turnEnd()]);
  for (const id of ids) planFirstReply({ sourceMessageId: id, convId: CONV, dir: host.dir }).settle('ok', REPLY);
  const total = 1024;
  const scanned = [];
  const { r, puts } = reporter(host, { scanBytesPerTick: 1024, scanBytesPerTickTotal: total });
  const offsets = () => ids.map((id) => {
    const reg = readSkillTurn(id, { dir: host.dir });
    return reg ? Object.values(reg.scan.logs).reduce((a, l) => a + l.offset, 0) : null;
  });
  const before = offsets();
  await r.tick();
  const after = offsets();
  scanned.push(after.map((a, i) => (a ?? 0) - (before[i] ?? 0)));
  // Lines are ~1 KiB: at most the global budget plus one line read in all.
  const sum = scanned[0].reduce((a, b) => a + b, 0);
  assert.ok(sum <= total + 1100, `read ${sum} bytes in one tick`);
  assert.ok(scanned[0].filter((b) => b > 0).length < ids.length, 'not every registration read: the budget ran out');
  // Over enough ticks every registration finishes and is reported.
  for (let i = 0; i < 20 && puts.length < 3; i++) await r.tick(); // eslint-disable-line no-await-in-loop
  assert.equal(puts.length, 3);
});

test('P3: forward outcomes — only a sure non-delivery drops the turn; the session group comes from Core or the forward', () => {
  for (const o of ['not_stored', 'no_group']) assert.equal(forwardDropsSkillTurn(o), true, o);
  for (const o of ['sent', 'stored', 'uncertain', 'unknown', 'failed']) assert.equal(forwardDropsSkillTurn(o), false, o);
  assert.equal(skillTurnSessionGroup({ stdout: '{"ok":true,"sessionGroup":"openmax:dm-x","id":3}', sessionGroup: 'dm-x' }, 'openmax'), 'openmax:dm-x');
  assert.equal(skillTurnSessionGroup({ stdout: 'not json', sessionGroup: 'dm-x' }, 'openmax'), 'openmax:dm-x');
  assert.equal(skillTurnSessionGroup({ stdout: '{"ok":true}' }, 'openmax'), null, 'single-session Core');
  assert.equal(skillTurnSessionGroup(undefined, 'openmax'), null);
});
