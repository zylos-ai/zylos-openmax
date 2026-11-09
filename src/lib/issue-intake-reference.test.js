import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { formatInboundForC4 } from './message.js';

// Shipped instructions are the contract here: no code decides whether an
// inbound request gets the Issue-intake card — the Agent does, from the
// Trigger in SKILL.md and the inbound <openmax-instruction>. These guards
// protect that wording (wsb#747 AC1–AC5); they do not simulate an Agent.

const rawSkill = readFileSync(new URL('../../SKILL.md', import.meta.url), 'utf8');
const flat = s => s.replace(/\s+/g, ' ');
const skill = flat(rawSkill);

function boundedSection(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing instruction section: ${start}`);
  return source.slice(from, to);
}

const trigger = boundedSection(skill, '**Trigger (do this for every message)**', '### New-Issue Intake');
const triggerRaw = boundedSection(rawSkill, '**Trigger (do this for every message)**', '### New-Issue Intake');
const intake = boundedSection(skill, '### New-Issue Intake', '### Simple Task Flow');
const cardRule = boundedSection(skill,
  'is what I need back one of a few fixed options?',
  '🔴 **Never merge a text answer with an unrelated card.**');
const frontmatter = flat(rawSkill.split('\n---')[0]);

function bullet(section, label) {
  const start = section.indexOf(`- **${label}**`);
  assert.ok(start >= 0, `Trigger has no "${label}" bullet`);
  const next = section.indexOf(' - **', start + 1);
  return section.slice(start, next > start ? next : undefined);
}

// Rows of the classification example table: `| 「…」 | Kind | What to do |`.
function exampleRows(kind) {
  return triggerRaw.split('\n')
    .filter(line => line.startsWith('| 「'))
    .map(line => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
    .filter(([, k]) => k === kind)
    .map(([said]) => said);
}

test('Trigger sorts by collaboration and time span into chat, quick, tracked and unsure', () => {
  assert.ok(trigger.includes('collaboration and time span, not the type of output'));
  for (const label of ['Chat / Q&A', 'Quick single-Agent work', 'Cross-team or cross-time work', 'Unsure which']) {
    bullet(trigger, label);
  }
  assert.ok(trigger.includes('An explicit "create an Issue" / "do not create an Issue" from the human always wins'));
});

test('quick single-Agent work is done directly, with no time limit and no intake card', () => {
  const quick = bullet(trigger, 'Quick single-Agent work');
  for (const phrase of [
    '**no intake card**',
    'without waiting on anyone',
    'short report',
    'small code fix together with its PR',
    'no time limit',
  ]) {
    assert.ok(quick.includes(phrase), `Quick bullet lost: ${phrase}`);
  }
});

test('AC4: quick work ends with at most one plain-text tracking offer, never a card', () => {
  const quick = bullet(trigger, 'Quick single-Agent work');
  assert.ok(quick.includes('**at most one plain-text line**'));
  assert.ok(quick.includes('never a card'));
  assert.ok(quick.includes('「需要的话我建 Issue 跟踪」'));
});

test('cross-team or cross-time work keeps New-Issue Intake, including a PR another team must review', () => {
  const tracked = bullet(trigger, 'Cross-team or cross-time work');
  for (const phrase of [
    'New-Issue Intake',
    'several people, or several Agents',
    'spans time',
    'same-team code review',
    'needs review by another team',
  ]) {
    assert.ok(tracked.includes(phrase), `tracked bullet lost: ${phrase}`);
  }
  assert.ok(trigger.includes('**Cross-team or cross-time work that does not reference an existing Issue** → run the new-Issue intake'));
});

test('unsure requests do the doable part first, then make the same one-line offer', () => {
  const unsure = bullet(trigger, 'Unsure which');
  assert.ok(unsure.includes('do the part you can finish now first'));
  assert.ok(unsure.includes('the same one-line offer'));
  assert.ok(unsure.includes('Do not block on the intake card first'));
  assert.ok(trigger.includes('Uncertain classification follows "Unsure which" above.'));
  assert.ok(!trigger.includes('(task classification,'), 'uncertain classification must not route to "consult the user first"');
});

test('AC5: the example table covers at least 3 quick and 3 tracked requests', () => {
  const quick = exampleRows('Quick');
  const tracked = exampleRows('Tracked');
  assert.ok(quick.length >= 3 && tracked.length >= 3, `quick=${quick.length} tracked=${tracked.length}`);
  for (const said of ['阅读一下这个开发文档', '总结一下这段', '这个功能怎么用', '帮我写一份竞品调研」', '把这个 bug 修了提个 PR」']) {
    assert.ok(quick.some(row => row.includes(said)), `no quick example: ${said}`);
  }
  for (const said of ['帮我做一份竞品调研报告，周五给我', '这个需求拆给几个 Agent 一起做', '整理一份接入方案，下周评审', '要 X 团队 review']) {
    assert.ok(tracked.some(row => row.includes(said)), `no tracked example: ${said}`);
  }
  assert.ok(exampleRows('Unsure').some(row => row.includes('帮我把这个模块重构一下')));
});

test('🔴 card rule carries the tracking-offer exemption, bound to handed-back quick work only', () => {
  const exemption = cardRule.slice(cardRule.indexOf('**One exception, bound to one situation only:**'));
  assert.ok(cardRule.includes('**One exception, bound to one situation only:**'), 'exemption must live inside the 🔴 card rule');
  for (const phrase of [
    'handed back',
    'finished quick single-Agent work',
    'the part of an unsure request you could finish now',
    '「需要的话我建 Issue 跟踪」',
    'Nothing else is exempt',
  ]) {
    assert.ok(exemption.includes(phrase), `exemption lost: ${phrase}`);
  }
});

test('🔴 card rule itself is unchanged by the exemption', () => {
  assert.ok(cardRule.includes('`要不要 Z?`'));
  assert.ok(cardRule.includes('a defect here'));
  assert.ok(cardRule.indexOf('`要不要 Z?`') < cardRule.indexOf('**One exception'));
});

test('"A card asks only about its content" matches the 🔴 exemption', () => {
  const rule = boundedSection(skill, '**A card asks only about its content.**', '**Do not write `required`.**');
  assert.ok(rule.includes('after the work is done and handed back'));
  assert.ok(rule.includes('never a card'));
  assert.ok(rule.includes('see the exception under 🔴 "Replying"'));
});

test('old "every output is a task / ask even when simple" wording is gone', () => {
  assert.ok(!skill.includes('is a task even when the output is short'));
  assert.ok(!skill.includes('simple enough to finish in the conversation'));
  assert.ok(!skill.includes('Is a task and does not reference an existing Issue'));
  assert.ok(intake.includes('ordinary wording, not an Issue decision'));
  assert.ok(intake.includes('"直接做"'), '"直接做" is listed as ordinary wording, not special-cased');
  assert.ok(intake.includes('Applies only to new **cross-team or cross-time work**'));
});

test('AC3: explicit decisions and the no-repeat rule are unchanged', () => {
  assert.ok(intake.includes('**Do not ask twice.**'));
  for (const row of [
    '| Create an Issue | Yes | Nothing; proceed with the confirmed Project |',
    '| Do not create an Issue | Irrelevant | Nothing; do not create an Issue or any other Work object |',
    '| Not stated | No | In one intake turn, ask whether to create an Issue and recommend a Project for confirmation |',
  ]) {
    assert.ok(intake.includes(row), `intake table lost: ${row}`);
  }
  assert.ok(intake.includes('**The intake is its own card.**'));
});

test('frontmatter description no longer sends every new task through intake', () => {
  assert.ok(frontmatter.includes('finish quickly'));
  assert.ok(frontmatter.includes('spans time'));
  assert.ok(!frontmatter.includes('if it is a new task, resolve'));
  assert.ok(frontmatter.includes('before generic Issue intake'), 'automation handoffs still route first');
});

test('Simple Task Flow is introduced as Issue-backed work, not every research report', () => {
  const heading = rawSkill.split('\n').find(line => line.startsWith('### Simple Task Flow'));
  assert.ok(heading);
  assert.ok(!heading.endsWith('e.g. research report)'));
  assert.ok(heading.includes('Issue-backed'));
});

test('inbound instruction classifies before intake, after the automation routes', () => {
  const out = formatInboundForC4({ type: 'dm', id: 'cv-1' }, { displayName: 'Alice' }, { content: '阅读一下这个开发文档' }, [], {});
  const instruction = boundedSection(out, '<openmax-instruction>', '</openmax-instruction>');
  for (const phrase of ['finish quickly', 'spans time', 'New-Issue Intake']) {
    assert.ok(instruction.includes(phrase), `instruction lost: ${phrase}`);
  }
  assert.ok(!instruction.includes('For other new tasks, complete New-Issue Intake'));
  const classify = instruction.indexOf('Otherwise classify the message per the skill');
  assert.ok(classify > instruction.indexOf('Automation Update workflow before generic Issue intake'));
  assert.ok(classify > instruction.indexOf('Automation Creation workflow before generic Issue intake'));
});

test('automation handoffs still route before generic Issue intake', () => {
  assert.ok(skill.includes('[Automation Update](references/automation-update.md) before generic Issue intake'));
});
