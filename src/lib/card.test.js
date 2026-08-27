import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDisplayCard,
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

test('an option longer than a label may be sent by passing an explicit label', () => {
  // 40 code points is a legal quick_reply text (cap 200) but not a legal label
  // (cap 32). The caller supplied neither a label nor an id, so an error about
  // `options[0].label` would name a field they never wrote — it has to point at
  // `text` and say what to do instead.
  const long = 'x'.repeat(40);
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', options: [long] }),
    (err) => err instanceof CardError
      && err.field === 'options[0].text'
      && /label/.test(err.message),
  );
  // …and that is the whole fix: give it a short label and the long text stays.
  const body = buildDisplayCard({ title: 't', summary: 's', options: [{ text: long, label: 'pick' }] });
  assert.equal(body.actions[0].params.text, long);
  assert.equal(body.actions[0].label, 'pick');
});

test('two distinct options whose slugs collide still get distinct ids', () => {
  // "Yes!" and "Yes?" both slugify to "yes". They are different options and the
  // caller chose no ids, so the builder disambiguates instead of rejecting.
  const body = buildDisplayCard({ title: 't', summary: 's', options: ['Yes!', 'Yes?'] });
  const ids = body.actions.map((a) => a.id);
  assert.equal(new Set(ids).size, 2, `ids must stay distinct, got ${JSON.stringify(ids)}`);
  for (const id of ids) assert.match(id, /^[a-z0-9_-]{1,64}$/);
  assert.deepEqual(body.actions.map((a) => a.params.text), ['Yes!', 'Yes?']);
});

test('an id the caller chose is never rewritten, so a duplicate is still an error', () => {
  assert.throws(
    () => buildDisplayCard({
      title: 't',
      summary: 's',
      options: [{ text: 'a', id: 'same' }, { text: 'b', id: 'same' }],
    }),
    (err) => err instanceof CardError && err.field === 'options[1].id',
  );
});

test('an explicitly supplied over-long fallbackText is rejected, not silently cut', () => {
  // Truncating a default we derived ourselves is fine; truncating what the
  // caller explicitly wrote changes their message without telling them.
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', fallbackText: '字'.repeat(MAX_BLOCK_FALLBACK_RUNES + 1) }),
    (err) => err instanceof CardError && err.field === 'fallbackText',
  );
});

test('no internal bookkeeping leaks into the wire body', () => {
  // idExplicit is a builder-internal flag; the validator rejects unknown keys
  // on an action, so it must never reach the request.
  const body = buildDisplayCard({ title: 't', summary: 's', options: ['是', '否'] });
  for (const action of body.actions) {
    assert.deepEqual(
      Object.keys(action).sort(),
      ['id', 'kind', 'label', 'operation', 'params'],
    );
  }
});

test('duplicate option text is caught after the same trim+NFC the backend applies', () => {
  // cws-comm compares quick_reply texts as NFC(TrimSpace(text)) — its own
  // comment calls out that "是" and "是 " would otherwise "pass here and
  // collide there". Comparing raw strings locally would let exactly that pair
  // through and turn into the 422 this validation exists to prevent.
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', options: ['是', '是 '] }),
    (err) => err instanceof CardError && err.field === 'options[1].text',
  );
  // NFC: a precomposed "é" and its decomposed form are the same option.
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', options: ['café', 'café'] }),
    (err) => err instanceof CardError && err.field === 'options[1].text',
  );
  // Positive control: genuinely different texts still pass.
  const ok = buildDisplayCard({ title: 't', summary: 's', options: ['是', '否'] });
  assert.equal(ok.actions.length, 2);
});


test('an id the caller chose wins even when a derived id got there first', () => {
  // "Yes!" derives `yes`; the SECOND option explicitly asks for `yes`. The
  // stated invariant is that a derived id yields and a chosen one is never
  // rewritten, so the derived one must move and the error must not blame the
  // option the caller actually chose.
  const body = buildDisplayCard({
    title: 't', summary: 's',
    options: ['Yes!', { text: 'OK', id: 'yes' }],
  });
  assert.deepEqual(body.actions.map((a) => a.id), ['option-1', 'yes']);
  assert.deepEqual(body.actions.map((a) => a.params.text), ['Yes!', 'OK']);
});

test('a double collision is refused rather than sent with a duplicate id', () => {
  assert.throws(
    () => buildDisplayCard({
      title: 't', summary: 's',
      options: [{ text: 'first', id: 'yes' }, { text: 'Yes!' }, { text: 'x', id: 'option-2' }],
    }),
    (err) => err instanceof CardError
      && err.field === 'options[1].id'
      && /cannot be derived/.test(err.message),
  );
});

test('a pure-CJK option derives a positional id, not an empty one', () => {
  // The first keeps only its ASCII "A"; the second keeps nothing at all and
  // must not produce an id the validator would reject.
  const body = buildDisplayCard({ title: 't', summary: 's', options: ['\u65b9\u6848A', '\u65b9\u6848\u4e00'] });
  assert.deepEqual(body.actions.map((a) => a.id), ['a', 'option-2']);
  for (const a of body.actions) assert.match(a.id, /^[a-z0-9_-]{1,64}$/);
});

test('astral characters count as one code point each, not two', () => {
  // 32 emoji is 32 code points but 64 UTF-16 units; counting .length rejects it.
  const label32 = '\u{1F600}'.repeat(32);
  const ok = buildDisplayCard({ title: 't', summary: 's', options: [{ text: 'x', label: label32 }] });
  assert.equal(ok.actions[0].label, label32);
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', options: [{ text: 'x', label: '\u{1F600}'.repeat(33) }] }),
    (err) => err instanceof CardError && err.field === 'options[0].label',
  );
});

test('the trim mirrors Go unicode.IsSpace, not JS String.trim', () => {
  const Y = '\u662f';
  // U+0085 (NEL): Go trims it, JS trim does not. Under JS semantics this
  // duplicate pair slips through and comes back as a 422 from cws-core.
  assert.throws(
    () => buildDisplayCard({ title: 't', summary: 's', options: [Y, '\u0085' + Y] }),
    (err) => err instanceof CardError && err.field === 'options[1].text',
  );
  // U+FEFF (BOM): JS trim strips it, Go does not. Under JS semantics these two
  // are rejected as duplicates while the caller sees two texts that differ.
  const distinct = buildDisplayCard({ title: 't', summary: 's', options: ['\uFEFF' + Y, Y] });
  assert.equal(distinct.actions.length, 2);
  assert.deepEqual(distinct.actions.map((a) => a.params.text), ['\uFEFF' + Y, Y]);
});

test('the option text on the wire is never normalized', () => {
  // Normalization decides equality only. The read path normalizes both the
  // stored option and the incoming reply in SQL before comparing, so rewriting
  // the payload would change the caller's words for no gain.
  const raw = '   \u662f  ';
  const body = buildDisplayCard({ title: 't', summary: 's', options: [{ text: raw, label: 'yes' }] });
  assert.equal(body.actions[0].params.text, raw);
});
