import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildChannelQRMessage,
  channelStatusMessage,
  channelStartResultWithoutQR,
  isRetryableChannelPollError,
  planChannelConnect,
  pollChannelUntilTerminal,
} from './channel.js';

const CONV = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

test('planChannelConnect builds self-scoped requests for every platform authorization channel', () => {
  for (const channelType of ['feishu', 'lark', 'dingtalk', 'wecom']) {
    const plan = planChannelConnect({
      channelType,
      conversationId: CONV,
      sourceMessageId: 'msg-123',
      agentMemberId: 'must-not-be-forwarded',
    });
    assert.deepEqual(plan.body, {
      channel_type: channelType,
      conversation_id: CONV,
      source_message_id: 'msg-123',
    });
    assert.equal('agent_member_id' in plan.body, false);
  }
});

test('planChannelConnect rejects unsupported channels and missing trusted context', () => {
  assert.throws(() => planChannelConnect({ channelType: 'wechat', conversationId: CONV, sourceMessageId: 'm' }), /must be one of/);
  assert.throws(() => planChannelConnect({ channelType: 'feishu', conversationId: 'fake', sourceMessageId: 'm' }), /must be a UUID/);
  assert.throws(() => planChannelConnect({ channelType: 'feishu', conversationId: CONV }), /sourceMessageId is required/);
});

test('channelStatusMessage uses provider-specific names', () => {
  assert.match(channelStatusMessage('dingtalk', 'connected'), /钉钉连接成功.*现在可以收发消息/);
  assert.match(channelStatusMessage('wecom', 'expired'), /企业微信授权二维码已过期/);
  assert.match(channelStatusMessage('lark', 'cancelled'), /Lark授权已取消/);
  assert.match(channelStatusMessage('feishu', 'error'), /飞书渠道连接失败/);
});

test('channelStartResultWithoutQR suppresses redundant QR sessions', () => {
  assert.deepEqual(channelStartResultWithoutQR('lark', { status: 'already_connected' }), {
    status: 'already_connected',
    channel_type: 'lark',
    qr_sent_to_conversation: false,
    message: 'Lark已连接，无需重复扫码。',
  });
  assert.deepEqual(channelStartResultWithoutQR('feishu', { status: 'connection_in_progress' }), {
    status: 'connection_in_progress',
    channel_type: 'feishu',
    qr_sent_to_conversation: false,
    message: '飞书正在连接中，无需重复扫码，请稍候。',
  });
  assert.equal(channelStartResultWithoutQR('dingtalk', { status: 'awaiting_user_scan' }), null);
});

test('buildChannelQRMessage emits one generic structured card for every platform', () => {
  for (const channelType of ['feishu', 'lark', 'dingtalk', 'wecom']) {
    const message = buildChannelQRMessage(channelType, 'https://example.test/authorize', '2026-09-03T12:00:00.000Z');
    assert.equal(message.type, 'AGENT_STRUCTURED');
    assert.equal(message.content.content_type, 'channel_qr');
    assert.deepEqual(message.content.body, {
      schema: 'openmax.channel-qr.v1',
      channel_type: channelType,
      qr_ref: 'https://example.test/authorize',
      expires_at: '2026-09-03T12:00:00.000Z',
    });
    assert.deepEqual(message.metadata.openmax_channel_qr, message.content.body);
  }
  assert.throws(() => buildChannelQRMessage('feishu', '', new Date().toISOString()), /no QR reference/);
});

test('pollChannelUntilTerminal retries transient 503 without replacing the QR session', async () => {
  let clock = 0;
  let calls = 0;
  const statuses = [
    Object.assign(new Error('temporary upstream failure'), { status: 503 }),
    { status: 'pending' },
    { status: 'connected', binding: { status: 'connected' } },
  ];
  const terminal = await pollChannelUntilTerminal({
    deadlineMs: 20_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    poll: async () => {
      const value = statuses[calls++];
      if (value instanceof Error) throw value;
      return value;
    },
  });
  assert.equal(terminal, 'connected');
  assert.equal(calls, 3);
});

test('pollChannelUntilTerminal waits for the OpenMAX connect-result after QR authorization', async () => {
  let clock = 0;
  let calls = 0;
  const statuses = [
    { status: 'connected', binding: { status: 'pending' } },
    { status: 'connected', binding: { status: 'pending' } },
    { status: 'connected', binding: { status: 'connected' } },
  ];
  const terminal = await pollChannelUntilTerminal({
    deadlineMs: 20_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    poll: async () => statuses[calls++],
  });
  assert.equal(terminal, 'connected');
  assert.equal(calls, 3);
});

test('pollChannelUntilTerminal fails when the dispatched Binding fails or never completes', async () => {
  for (const result of [
    { status: 'connected' },
    { status: 'connected', binding: { status: 'error' } },
    { status: 'connected', binding: { status: 'disconnected' } },
  ]) {
    const terminal = await pollChannelUntilTerminal({
      deadlineMs: 20_000,
      now: () => 0,
      sleep: async () => {},
      poll: async () => result,
    });
    assert.equal(terminal, 'error');
  }

  let clock = 0;
  const timeout = await pollChannelUntilTerminal({
    deadlineMs: 3_000,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    poll: async () => ({ status: 'connected', binding: { status: 'pending' } }),
  });
  assert.equal(timeout, 'error');
});

test('pollChannelUntilTerminal does not retry permanent request errors', async () => {
  let calls = 0;
  const terminal = await pollChannelUntilTerminal({
    deadlineMs: 20_000,
    now: () => 0,
    sleep: async () => {},
    poll: async () => {
      calls += 1;
      throw Object.assign(new Error('bad request'), { status: 400 });
    },
  });
  assert.equal(terminal, 'error');
  assert.equal(calls, 1);
});

test('retry classification is bounded to network and transient gateway failures', () => {
  assert.equal(isRetryableChannelPollError(new TypeError('fetch failed')), true);
  assert.equal(isRetryableChannelPollError({ status: 429 }), true);
  assert.equal(isRetryableChannelPollError({ status: 503 }), true);
  assert.equal(isRetryableChannelPollError({ status: 400 }), false);
  assert.equal(isRetryableChannelPollError({ status: 500 }), false);
});
