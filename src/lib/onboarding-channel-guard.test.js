import assert from 'node:assert/strict';
import test from 'node:test';

import { assertAllImChannels, OnboardingChannelGuardError } from './onboarding-channel-guard.js';

// cws-core's CN-order list as int returned it (12 channels, first 5 visible).
const IM = [
  ['wecom', '企业微信', 'WeCom'], ['wechat', '个人微信', 'WeChat'], ['feishu', '飞书', 'Feishu'],
  ['dingtalk', '钉钉', 'DingTalk'], ['lark', 'Lark', 'Lark'], ['whatsapp', 'WhatsApp', 'WhatsApp'],
  ['telegram', 'Telegram', 'Telegram'], ['slack', 'Slack', 'Slack'], ['discord', 'Discord', 'Discord'],
  ['teams', 'Microsoft Teams', 'Microsoft Teams'], ['line', 'LINE', 'LINE'], ['email', '邮箱', 'Email'],
].map(([type, zh, en], i) => ({ type, label: zh, label_zh: zh, label_en: en, visible: i < 5 }));

const DECLINE = { label: '都不用，就在这儿聊', decline: true };
const card = (channels, extra = {}) => ({
  kind: 'onboarding.channel', title: 't', blocks: [], ...extra,
  options: [...channels.map((c) => ({ label: c.label })), DECLINE],
});
const fetchOk = (list = IM) => async () => ({ im_channels: list });
const silent = { warn() {} };

test('🔴 rejects an IM card that drops the visible:false channels', async () => {
  const fivePlusDecline = card(IM.filter((c) => c.visible));
  await assert.rejects(
    () => assertAllImChannels(fivePlusDecline, { fetchProfileOptions: fetchOk(), ...silent }),
    (err) => {
      assert.ok(err instanceof OnboardingChannelGuardError);
      assert.equal(err.missing.length, 7);
      assert.match(err.message, /offers 5 of the 12/);
      assert.match(err.message, /WhatsApp/);
      assert.match(err.message, /`visible` is only the client's display hint/);
      assert.match(err.message, /Nothing was sent/);
      return true;
    },
  );
});

test('rejects a card missing even one channel, and names it', async () => {
  await assert.rejects(
    () => assertAllImChannels(card(IM.slice(0, 11)), { fetchProfileOptions: fetchOk(), ...silent }),
    /missing: 邮箱/,
  );
});

test('passes with all 12 channels + decline', async () => {
  const r = await assertAllImChannels(card(IM), { fetchProfileOptions: fetchOk(), ...silent });
  assert.deepEqual(r, { checked: true });
});

test('matches labels in either language (label / label_zh / label_en), any order', async () => {
  const en = { kind: 'onboarding.channel', options: [...IM].reverse().map((c) => ({ label: c.label_en })).concat(DECLINE) };
  const r = await assertAllImChannels(en, { fetchProfileOptions: fetchOk(), ...silent });
  assert.equal(r.checked, true);
});

test('the decline option does not count as a channel', async () => {
  // A decline whose label happens to equal a channel label must not satisfy it.
  const req = card(IM.slice(0, 11));
  req.options.push({ label: '邮箱', decline: true });
  await assert.rejects(() => assertAllImChannels(req, { fetchProfileOptions: fetchOk(), ...silent }), /missing: 邮箱/);
});

test('accepts the enveloped {data:{im_channels}} shape', async () => {
  const r = await assertAllImChannels(card(IM), { fetchProfileOptions: async () => ({ data: { im_channels: IM } }), ...silent });
  assert.equal(r.checked, true);
});

test('🔴 a failed fetch never blocks the send — it warns and passes', async () => {
  const warnings = [];
  const r = await assertAllImChannels(card(IM.slice(0, 5)), {
    fetchProfileOptions: async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
    warn: (m) => warnings.push(m),
  });
  assert.equal(r.checked, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not fetch im_channels/);
});

test('an empty / missing im_channels list warns and passes', async () => {
  const warnings = [];
  const r = await assertAllImChannels(card(IM.slice(0, 5)), { fetchProfileOptions: async () => ({}), warn: (m) => warnings.push(m) });
  assert.equal(r.checked, false);
  assert.equal(warnings.length, 1);
});

test('other card kinds are not checked and nothing is fetched', async () => {
  let fetched = false;
  const r = await assertAllImChannels({ kind: 'onboarding.task', options: [{ label: 'x' }] }, {
    fetchProfileOptions: async () => { fetched = true; return { im_channels: IM }; },
  });
  assert.equal(r.checked, false);
  assert.equal(fetched, false);
});

test('consistent with the 16-option cap: over 15 channels, the first 15 + decline passes', async () => {
  const many = Array.from({ length: 18 }, (_, i) => ({ type: `c${i}`, label: `C${i}`, label_zh: `C${i}`, label_en: `C${i}`, visible: i < 5 }));
  const ok = await assertAllImChannels(card(many.slice(0, 15)), { fetchProfileOptions: fetchOk(many), ...silent });
  assert.equal(ok.checked, true);
  await assert.rejects(
    () => assertAllImChannels(card(many.slice(0, 14)), { fetchProfileOptions: fetchOk(many), ...silent }),
    /first 15 in the given order/,
  );
});
