import assert from 'node:assert/strict';
import test from 'node:test';

import { isSelfNameMentionedInText, isSelfMentioned } from './self-mention.js';

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

// ── isSelfMentioned: structured mention IDs are authoritative ────────────────

const SELF = '019fa13e-5542-73cd-abd0-0bd4a0f65a67';
const OTHER = '019f8d18-e558-7ce4-84d0-b2ec4e776d27';

test('structured mention matching our member_id → mentioned', () => {
  assert.equal(isSelfMentioned({
    mentionIds: [SELF], selfMemberId: SELF, selfNames: ['gavin222'], msg: msg('@luna.coco hi'),
  }), true);
});

test('#85: structured mentions present but NOT us → NOT mentioned (no text fallback)', () => {
  // The incident: "@luna.coco" carries luna.coco's member_id; a bare "luna"
  // agent must not be woken, and the text "@luna.coco" must NOT rescue it.
  assert.equal(isSelfMentioned({
    mentionIds: [OTHER], selfMemberId: SELF, selfNames: ['luna'], msg: msg('@luna.coco 请把 felix 移出群聊'),
  }), false);
});

test('no structured mentions at all → text fallback decides', () => {
  // legacy/edge payload with no mentions[]: fall back to text (dot-safe).
  assert.equal(isSelfMentioned({
    mentionIds: [], selfMemberId: SELF, selfNames: ['luna'], msg: msg('@luna 你好'),
  }), true);
  assert.equal(isSelfMentioned({
    mentionIds: [], selfMemberId: SELF, selfNames: ['luna'], msg: msg('@luna.coco 你好'),
  }), false);
});

test('missing selfMemberId falls through to text when no structured mentions', () => {
  assert.equal(isSelfMentioned({
    mentionIds: [], selfMemberId: undefined, selfNames: ['luna'], msg: msg('@luna hi'),
  }), true);
  // but structured mentions present and no id to match → not mentioned
  assert.equal(isSelfMentioned({
    mentionIds: [OTHER], selfMemberId: undefined, selfNames: ['luna'], msg: msg('@luna hi'),
  }), false);
});
