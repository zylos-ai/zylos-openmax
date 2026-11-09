import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ');
const docs = {
  delivery: read('../../references/automation-delivery.md'),
  common: read('../../references/automation-common.md'),
  webhook: read('../../references/automation-webhook.md'),
  update: read('../../references/automation-update.md'),
  tm: read('../../references/tm-operations.md'),
  skill: read('../../SKILL.md'),
};

// These check written guardrails for OPENM-1164 (held webhook events replayed
// on the human Owner's decision), not whether a model follows them.
const required = [
  /A webhook run with `replay_state: "replay"` is a replayed event/,
  /it arrived while the automation was paused or the organization was suspended, was held, and the human Owner chose to replay it when resuming/,
  /Its `trigger_kind` stays `webhook`, and its `scheduled_at` is the time the event was received, not the time the replay ran/,
  /Read `replay_state` from the matching run record; a `Replayed event:` line in the Issue description is only a hint/,
  /The event may be outdated: before acting, check the current state of the external object it refers to \(for example, the merge request may already be merged\)/,
  /act on that state, not on the payload alone/,
  /Only the human Owner decides, when resuming, whether held events are replayed; the Agent cannot replay or decline them/,
  /Holding applies to webhooks only: a timer automation still does not catch up runs missed while it was paused or the organization was suspended/,
];
// The 09-19 rule ("suspended deliveries never replay") is reversed for
// webhooks; no reference may state it again.
const forbidden = [
  /(?:paused|suspended|held|cancelled)[^.]*\b(?:never|not|no longer) (?:be )?(?:replayed|re-?run)/i,
  /`scheduled_at` is the time the replay ran/,
  /[Tt]he Agent (?:may|can) replay/,
  /timer automation (?:also )?catches up/,
];

function verify(texts) {
  const section = texts.delivery.split('### Identify the run before interpreting its timing')[1]?.split('### Execution steps')[0];
  assert.ok(section, 'missing reachable run-identification section');
  for (const pattern of required) assert.match(section, pattern);
  for (const [name, text] of Object.entries(texts)) {
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${name}: ${pattern}`);
  }
}

test('replayed webhook runs are identified by replay_state and checked for staleness', () => {
  verify(docs);
});

test('webhook replay instructions reject removed guardrails and the reversed rule', () => {
  for (const [before, after] of [
    ['`scheduled_at` is the time the event was received, not the time the replay ran', '`scheduled_at` is the time the replay ran'],
    ['The event may be outdated', 'The event is current'],
    ['before acting, check the current state of the external object', 'act on the payload directly'],
    ['the human Owner chose to replay it', 'the Agent chose to replay it'],
    ['the Agent cannot replay or decline them', 'the Agent can replay them'],
    ['a timer automation still does not catch up', 'a timer automation also catches up'],
    ['Its `trigger_kind` stays `webhook`', 'Its `trigger_kind` becomes `replay`'],
  ]) {
    assert.ok(docs.delivery.includes(before), `delivery contains: ${before}`);
    assert.throws(() => verify({ ...docs, delivery: docs.delivery.replace(before, after) }), before);
  }
  for (const addition of [
    'Webhook deliveries received while the automation is suspended are never replayed.',
    'Events received while paused are not replayed.',
  ]) {
    for (const name of Object.keys(docs)) {
      assert.throws(() => verify({ ...docs, [name]: `${docs[name]} ${addition}` }), `${name}: ${addition}`);
    }
  }
});
