import assert from 'node:assert/strict';
import test from 'node:test';

import { isSelfNameMentionedInText } from './self-mention.js';

const msg = (text) => ({ content: { body: { text } } });

test('#85: a bare name is NOT woken by a dot-separated longer handle', () => {
  // The reported incident: Howard @luna.coco, but the `luna` agent responded.
  assert.equal(isSelfNameMentionedInText(msg('@luna.coco 请把 felix 移出群聊'), 'luna'), false);
  assert.equal(isSelfNameMentionedInText(msg('@Eric.He 看一下'), 'Eric'), false);
  assert.equal(isSelfNameMentionedInText(msg('cc @howard.zhou'), 'howard'), false);
});

test('the dot-separated handle itself IS matched', () => {
  assert.equal(isSelfNameMentionedInText(msg('@luna.coco 请把 felix 移出群聊'), 'luna.coco'), true);
  assert.equal(isSelfNameMentionedInText(msg('@Eric.He 看一下'), 'Eric.He'), true);
});

test('an exact @name mention still matches', () => {
  assert.equal(isSelfNameMentionedInText(msg('@luna 你好'), 'luna'), true);
  assert.equal(isSelfNameMentionedInText(msg('hey @Zylos can you help'), 'Zylos'), true);
});

test('a dot NOT followed by a word char is still a real mention', () => {
  // Sentence-final punctuation must not suppress a genuine mention.
  assert.equal(isSelfNameMentionedInText(msg('谢谢 @luna.'), 'luna'), true);
  assert.equal(isSelfNameMentionedInText(msg('ping @luna, 在吗'), 'luna'), true);
  assert.equal(isSelfNameMentionedInText(msg('@luna! 快看'), 'luna'), true);
});

test('word-char / hyphen boundary is preserved (pre-existing behavior)', () => {
  assert.equal(isSelfNameMentionedInText(msg('@Zylos-GavinBox hi'), 'Zylos'), false);
  assert.equal(isSelfNameMentionedInText(msg('@ZylosX hi'), 'Zylos'), false);
  assert.equal(isSelfNameMentionedInText(msg('@luna_coco hi'), 'luna'), false);
});

test('matching is case-insensitive', () => {
  assert.equal(isSelfNameMentionedInText(msg('@LUNA 你好'), 'luna'), true);
});

test('the name is treated as a literal (regex metachars escaped)', () => {
  // The "." in "luna.coco" must be a literal dot, not "any char".
  assert.equal(isSelfNameMentionedInText(msg('@lunaXcoco'), 'luna.coco'), false);
});

test('empty name / empty text / missing text short-circuit to false', () => {
  assert.equal(isSelfNameMentionedInText(msg('@luna'), ''), false);
  assert.equal(isSelfNameMentionedInText(msg(''), 'luna'), false);
  assert.equal(isSelfNameMentionedInText({}, 'luna'), false);
});

test('alternate message shapes are supported', () => {
  assert.equal(isSelfNameMentionedInText({ content: '@luna hi' }, 'luna'), true);
  assert.equal(isSelfNameMentionedInText({ content_text: '@luna hi' }, 'luna'), true);
  assert.equal(isSelfNameMentionedInText({ message: { content: '@luna hi' } }, 'luna'), true);
  // dot-boundary fix applies across shapes too
  assert.equal(isSelfNameMentionedInText({ content: '@luna.coco hi' }, 'luna'), false);
});
