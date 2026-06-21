import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSiblingAgentSender } from './dm-access.js';

test('isSiblingAgentSender: 同 owner 的 agent 发件人命中', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'AGENT', senderOwnerId: 'owner-1', selfOwnerId: 'owner-1' }),
    true,
  );
});

test('isSiblingAgentSender: sender_type 大小写不敏感', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'agent', senderOwnerId: 'owner-1', selfOwnerId: 'owner-1' }),
    true,
  );
});

test('isSiblingAgentSender: owner 不同不命中', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'AGENT', senderOwnerId: 'owner-2', selfOwnerId: 'owner-1' }),
    false,
  );
});

test('isSiblingAgentSender: 人类发件人不命中（即便恰好共享 id）', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'HUMAN', senderOwnerId: 'owner-1', selfOwnerId: 'owner-1' }),
    false,
  );
});

test('isSiblingAgentSender: 自身无 owner（未绑定）不命中', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'AGENT', senderOwnerId: 'owner-1', selfOwnerId: '' }),
    false,
  );
});

test('isSiblingAgentSender: 发件人 owner 未知不命中', () => {
  assert.equal(
    isSiblingAgentSender({ senderType: 'AGENT', senderOwnerId: '', selfOwnerId: 'owner-1' }),
    false,
  );
});

test('isSiblingAgentSender: 缺省入参安全返回 false', () => {
  assert.equal(isSiblingAgentSender(), false);
  assert.equal(isSiblingAgentSender({}), false);
});
