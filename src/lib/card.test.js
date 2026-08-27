import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDisplayCard,
  readCardChoice,
  CardError,
  CARD_SCHEMA_V1,
  MAX_ACTIONS,
  MAX_TITLE_RUNES,
  MAX_BLOCK_FALLBACK_RUNES,
} from './card.js';

const yesNo = () => buildDisplayCard({
  title: '需要确认',
  summary: '是否继续部署?',
  options: ['是', '否'],
});

test('a yes/no card carries the exact shape the validator requires', () => {
  const body = yesNo();
  assert.equal(body.schema, CARD_SCHEMA_V1);
  assert.equal(body.mode, 'display');
  assert.equal(body.kind, 'agent.prompt');
  assert.equal(body.title, '需要确认');
  assert.equal(body.summary, '是否继续部署?');
  assert.deepEqual(body.blocks, [
    { type: 'text', text: '是否继续部署?', fallback_text: '是否继续部署?' },
  ]);
  assert.equal(body.actions.length, 2);
  for (const action of body.actions) {
    assert.equal(action.kind, 'ui');
    assert.equal(action.operation, 'ui.quick_reply');
    assert.equal(typeof action.params.text, 'string');
  }
});

test('every action id matches the validator id pattern', () => {
  // Positive control: an ASCII option derives a readable slug, so the pattern
  // check below is not passing merely because ids are always positional.
  const ascii = buildDisplayCard({ title: 't', summary: 's', options: ['Yes please', 'No'] });
  assert.deepEqual(ascii.actions.map((a) => a.id), ['yes-please', 'no']);

  // CJK carries no [a-z0-9_-] runes, so the derived slug would be empty —
  // it must fall back to a positional id rather than emit an invalid one.
  const cjk = yesNo();
  assert.deepEqual(cjk.actions.map((a) => a.id), ['option-1', 'option-2']);
  for (const action of [...ascii.actions, ...cjk.actions]) {
    assert.match(action.id, /^[a-z0-9_-]{1,64}$/);
  }
});

test('option text reaches the button as the quick_reply text param', () => {
  const body = yesNo();
  assert.deepEqual(body.actions.map((a) => a.params.text), ['是', '否']);
  // The label defaults to the option text but is a separate field: rewording
  // the label must not silently change what the user's reply says.
  assert.deepEqual(body.actions.map((a) => a.label), ['是', '否']);
});

test('the long option form carries label, id and style through', () => {
  const body = buildDisplayCard({
    title: 't',
    summary: 's',
    options: [{ text: '批准', label: '批准', id: 'approve', style: 'primary' }],
  });
  assert.deepEqual(body.actions[0], {
    id: 'approve',
    label: '批准',
    kind: 'ui',
    operation: 'ui.quick_reply',
    params: { text: '批准' },
    style: 'primary',
  });
});

test('a card with no options is still valid and carries no actions key', () => {
  const body = buildDisplayCard({ title: '进度', summary: '构建完成' });
  assert.equal('actions' in body, false);
  assert.equal(body.blocks[0].text, '构建完成');
});

test('two options may not share one option text (validator rule 11)', () => {
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', options: ['是', '是'] }),
    (err) => err instanceof CardError && err.field === 'options[1].text',
  );
});

test('two options may not share one id', () => {
  assert.throws(
    () => buildDisplayCard({
      title: 't',
      summary: 's',
      options: [{ text: 'a', id: 'same' }, { text: 'b', id: 'same' }],
    }),
    (err) => err instanceof CardError && err.field === 'options[1].id',
  );
});

test('more than five options is rejected before the request goes out', () => {
  const five = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(buildDisplayCard({ title: 't', summary: 's', options: five }).actions.length, MAX_ACTIONS);
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', options: [...five, 'f'] }),
    (err) => err instanceof CardError && err.field === 'options',
  );
});

test('title and summary are required', () => {
  assert.throws(() => buildDisplayCard({ summary: 's' }), (e) => e.field === 'title');
  assert.throws(() => buildDisplayCard({ title: 't' }), (e) => e.field === 'summary');
  assert.throws(() => buildDisplayCard({ title: '', summary: 's' }), (e) => e.field === 'title');
});

test('caps count code points, not bytes — a CJK title is not three times as long', () => {
  // 200 CJK code points = 600 UTF-8 bytes. A byte-based cap would reject this.
  const atCap = '字'.repeat(MAX_TITLE_RUNES);
  assert.equal(buildDisplayCard({ title: atCap, summary: 's' }).title, atCap);
  assert.throws(
    () => buildDisplayCard({ title: '字'.repeat(MAX_TITLE_RUNES + 1), summary: 's' }),
    (err) => err instanceof CardError && err.field === 'title',
  );
});

test('an over-long fallback is truncated rather than rejected', () => {
  const long = '字'.repeat(MAX_BLOCK_FALLBACK_RUNES + 50);
  const body = buildDisplayCard({ title: 't', summary: 's', text: long });
  const fallback = body.blocks[0].fallback_text;
  assert.equal([...fallback].length, MAX_BLOCK_FALLBACK_RUNES);
  assert.ok(fallback.endsWith('…'));
  // The block text itself is left intact — only its plain-text projection is cut.
  assert.equal(body.blocks[0].text, long);
});

test('an invalid kind is rejected with the field named', () => {
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', kind: 'Agent.Prompt' }),
    (err) => err instanceof CardError && err.field === 'kind',
  );
});

test('an unknown style is rejected', () => {
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', options: [{ text: 'a', style: 'huge' }] }),
    (err) => err instanceof CardError && err.field === 'options[0].style',
  );
});

test('readCardChoice returns the action id, and undefined while unanswered', () => {
  assert.equal(readCardChoice({ card_state: { action_id: 'approve' } }), 'approve');
  assert.equal(readCardChoice({ content: { card_state: { action_id: 'reject' } } }), 'reject');
  assert.equal(readCardChoice({ card_state: null }), undefined);
  assert.equal(readCardChoice(undefined), undefined);
});
