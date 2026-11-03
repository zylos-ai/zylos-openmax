import assert from 'node:assert/strict';
import test from 'node:test';
import { automationAuthorizationPreview, automationAuthorizationProposal, automationConfiguration, automationMutation } from './automation-configuration.js';

const base = { lead_member_id: 'agent', owner_member_id: 'human', spec: { project_id: 'project', title: 'Task' } };
const cardID = '01000000-0000-4000-8000-000000000002';

test('result notification policy preserves presence through proposal and mutation', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      for (const policy of [undefined, 'every', 'failure_only', 'none']) {
        const configuration = { ...base, ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}),
          ...(policy === undefined ? {} : { result_notification_policy: policy }) };
        const params = { source_kind, operation, request_id: cardID, configuration,
          ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}) };
        const proposal = automationAuthorizationProposal(params);
        const body = automationMutation({ source_kind, configuration,
          id: 'binding', expected_version: 7,
          authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID }, source_kind, operation);
        for (const result of [proposal.configuration, body,
          automationConfiguration({ ...configuration, source_kind }, source_kind)]) {
          assert.equal(Object.hasOwn(result, 'result_notification_policy'), policy !== undefined);
          assert.equal(result.result_notification_policy, policy);
        }
      }
    }
  }
});

test('invalid notification policy and readonly migration marker cannot reach a write', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const fields of [
      ...['', null, undefined, 'all', 'EVERY', false, 0, {}, []].map(result_notification_policy => ({ result_notification_policy })),
      { result_notification_policy_migrated: false },
    ]) {
      const configuration = { ...base, timezone: 'Asia/Singapore', ...fields };
      if (source_kind === 'webhook') delete configuration.timezone;
      const params = { source_kind, operation: 'create', request_id: cardID, configuration };
      assert.throws(() => automationAuthorizationProposal(params), /result_notification_policy/);
      assert.throws(() => automationMutation({ source_kind, configuration }, source_kind), /result_notification_policy/);
      assert.throws(() => automationConfiguration({ source_kind, ...configuration }, source_kind), /result_notification_policy/);
    }
  }
});

test('requester UUID case does not change self identity or erase a distinct confirmer', () => {
  const requester = 'abcdefab-0000-4000-8000-000000000003';
  for (const [human, owner] of [[requester.toUpperCase(), requester], [requester, requester.toUpperCase()]]) {
    const params = { source_kind: 'timer', operation: 'create', request_id: cardID,
      requester_member_id: human, configuration: { ...base, owner_member_id: owner, timezone: 'Asia/Singapore' } };
    assert.equal(Object.hasOwn(automationAuthorizationProposal(params), 'requester_member_id'), false);
    assert.equal(automationAuthorizationProposal({ ...params,
      configuration: { ...params.configuration, owner_member_id: 'abcdefab-0000-4000-8000-000000000004' } }).requester_member_id, human);
  }
});

test('self-owned proposals omit redundant requester for the legacy strict schema', () => {
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      const params = { source_kind, operation, request_id: cardID,
        configuration: { ...base, owner_member_id: cardID, ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}) },
        ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}) };
      const legacy = automationAuthorizationProposal(params);
      assert.equal(Object.hasOwn(legacy, 'requester_member_id'), false);
      assert.deepEqual(automationAuthorizationProposal({ ...params, requester_member_id: cardID }), legacy);
    }
  }
});

test('assignment proposal keeps confirming requester separate from target Owner', () => {
  const requester = '01000000-0000-4000-8000-000000000003';
  const configuration = { ...base, owner_member_id: 'target-human', timezone: 'Asia/Singapore' };
  const params = { source_kind: 'timer', operation: 'create', request_id: cardID,
    requester_member_id: requester, configuration };
  const proposal = automationAuthorizationProposal(params);
  assert.equal(proposal.requester_member_id, requester);
  assert.equal(proposal.configuration.owner_member_id, 'target-human');
  assert.equal(Object.hasOwn(proposal.configuration, 'requester_member_id'), false);
  for (const source_kind of ['timer', 'webhook']) {
    for (const operation of ['create', 'update']) {
      const plan = automationAuthorizationProposal({ ...params, source_kind, operation,
        configuration: { ...base, owner_member_id: 'target-human', ...(source_kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}) },
        ...(operation === 'update' ? { target_binding_id: 'binding', expected_version: 7 } : {}) });
      assert.equal(plan.requester_member_id, requester);
      assert.equal(plan.configuration.owner_member_id, 'target-human');
    }
  }
  for (const value of ['', null, 42, 'not-a-member', '00000000-0000-0000-0000-000000000000']) {
    assert.throws(() => automationAuthorizationProposal({ ...params, requester_member_id: value }), /requester_member_id/);
  }
  assert.throws(() => automationConfiguration({ source_kind: 'timer',
    configuration: { ...configuration, requester_member_id: requester } }, 'timer'), /unsupported/);
});

for (const kind of ['timer', 'webhook']) {
  test(`${kind} Lead replacement keeps target and exact proof without injecting a delivery DM`, () => {
    const configuration = { ...base, lead_member_id: 'new-agent', ...(kind === 'timer' ? { timezone: 'Asia/Singapore' } : {}) };
    const proposal = automationAuthorizationProposal({ source_kind: kind, operation: 'update',
      target_binding_id: 'binding', expected_version: 7, request_id: cardID, configuration });
    assert.equal(proposal.configuration.lead_member_id, 'new-agent');
    assert.equal(proposal.expected_version, 7);
    const result = automationMutation({ id: 'binding', expected_version: 7, source_kind: kind,
      configuration, authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID }, kind, 'update');
    assert.equal(result.lead_member_id, 'new-agent');
    assert.equal(result.owner_member_id, 'human');
    assert.equal(result.expected_version, 7);
    assert.equal(result.authorization_card_interaction_id, cardID);
    assert.throws(() => automationMutation({ id: 'binding', expected_version: 7, source_kind: kind,
      configuration: { ...configuration, spec: { ...base.spec, delivery_conversation_id: 'forged-dm' } },
      authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID }, kind, 'update'), /unsupported/);
  });
}

for (const kind of ['timer', 'webhook']) {
  test(`${kind} card consent is exclusive transport metadata for create and update`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_card_interaction_id: cardID };
    const params = { id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof };
    for (const operation of ['create', 'update']) {
      const result = automationMutation(params, kind, operation);
      assert.equal(result.authorization_card_interaction_id, cardID);
      assert.equal(result.authorization_confirmation_message_id, undefined);
      assert.throws(() => automationMutation({ ...params, authorization_confirmation_message_id: '1790220732845' }, kind, operation), /exactly one/);
      for (const value of ['', null, 1, '1790220732845', cardID.replaceAll('-', ''), '00000000-0000-0000-0000-000000000000']) {
        assert.throws(() => automationMutation({ ...params, authorization_card_interaction_id: value }, kind, operation), /canonical nonzero UUID/);
      }
      assert.throws(() => automationMutation({ ...params, authorization_proposal_message_id: undefined }, kind, operation), /requires both/);
    }
    assert.throws(() => automationMutation({ source_kind: kind, configuration: { ...base, ...proof } }, kind), /unsupported/);
  });
}

test('replacement names one previous proposal without altering the configuration', () => {
  const params = { source_kind: 'timer', operation: 'create', request_id: cardID,
    configuration: { ...base, timezone: 'Asia/Singapore' }, replaces_proposal_message_id: '1790220732844' };
  assert.equal(automationAuthorizationProposal(params).replaces_proposal_message_id, '1790220732844');
  assert.equal(automationAuthorizationProposal(params).configuration, params.configuration);
  for (const value of ['', null, 1, '01', 'not-a-message']) {
    assert.throws(() => automationAuthorizationProposal({ ...params, replaces_proposal_message_id: value }), /canonical decimal/);
  }
});
test('readable proposal binds its request UUID to the unchanged final configuration and scope', () => {
  const request_id = '01000000-0000-4000-8000-000000000001';
  const configuration = { ...base, timezone: 'Asia/Singapore' };
  const params = { org: 'org', source_kind: 'timer', operation: 'update', target_binding_id: 'binding', expected_version: 2, configuration, request_id };
  assert.deepEqual(automationAuthorizationProposal(params), {
    source_kind: 'timer', operation: 'update', target_binding_id: 'binding', expected_version: 2, configuration, request_id,
  });
  assert.deepEqual(automationAuthorizationProposal({ ...params, operation: 'create', target_binding_id: '', expected_version: 0 }), {
    source_kind: 'timer', operation: 'create', configuration, request_id,
  });
  for (const value of [undefined, null, 42, '', 'some-key', '00000000-0000-0000-0000-000000000000', ` ${request_id}`, request_id.replaceAll('-', '')]) {
    assert.throws(() => automationAuthorizationProposal({ ...params, request_id: value }), /request_id must be a UUID/);
  }
  assert.throws(() => automationAuthorizationProposal({ ...params, operation: 'delete' }), /operation/);
  assert.throws(() => automationAuthorizationProposal({ ...params, expected_version: 0 }), /preview requires/);
  assert.throws(() => automationAuthorizationProposal({ ...params, configuration: { ...base, request_id } }), /unsupported/);
  for (const timezone of [undefined, null, '', '   ', 0]) {
    assert.throws(() => automationAuthorizationProposal({ ...params, configuration: { ...base, timezone } }), /explicit timezone/);
  }
  assert.equal(automationAuthorizationProposal({ ...params, source_kind: 'webhook', configuration: base }).configuration, base);
});
for (const kind of ['timer', 'webhook']) {
  test(`${kind} rejects missing or mismatched route discriminator`, () => {
    assert.throws(() => automationConfiguration({ configuration: base }, kind), /source_kind is required/);
    assert.throws(() => automationConfiguration({ source_kind: kind === 'timer' ? 'webhook' : 'timer', configuration: base }, kind), /source_kind must be/);
  });
  test(`${kind} rejects unsupported configuration and spec fields`, () => {
    for (const configuration of [{ ...base, enabled: false }, { ...base, spec: { ...base.spec, priority: 1 } }]) {
      assert.throws(() => automationConfiguration({ source_kind: kind, configuration }, kind), /unsupported/);
    }
  });
}
test('wrong-route fields cannot silently disappear, including legacy calls', () => {
  for (const field of ['schedule_kind', 'cron_expr', 'timezone', 'run_at', 'interval_seconds', 'anchor_at']) {
    assert.throws(() => automationConfiguration({ source_kind: 'webhook', configuration: { ...base, [field]: 'value' } }, 'webhook'), /unsupported/);
    assert.throws(() => automationConfiguration({ ...base, [field]: 'value' }, 'webhook'), /unsupported/);
  }
  assert.throws(() => automationConfiguration({ source_kind: 'timer', configuration: { ...base, event_filter: '' } }, 'timer'), /unsupported/);
});

test('authorization preview keeps final configuration and operation separate', () => {
  const configuration = { ...base, cron_expr: '0 9 * * *' };
  assert.deepEqual(automationAuthorizationPreview({ org: 'org', source_kind: 'timer', operation: 'create', configuration }), {
    source_kind: 'timer', operation: 'create', target_binding_id: '', expected_version: 0, configuration,
  });
  assert.throws(() => automationAuthorizationPreview({ source_kind: 'timer', operation: 'delete', configuration }), /operation/);
});

test('preview rejects ambiguous scope and lossy update versions', () => {
  for (const scope of [
    { operation: 'create', target_binding_id: 'binding' },
    { operation: 'create', expected_version: 1 },
    { operation: 'update' },
    { operation: 'update', target_binding_id: ' ', expected_version: 1 },
    { operation: 'update', target_binding_id: 'binding', expected_version: '1' },
    { operation: 'update', target_binding_id: 'binding', expected_version: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(() => automationAuthorizationPreview({ source_kind: 'timer', configuration: base, ...scope }), /preview requires/);
  }
});

for (const kind of ['timer', 'webhook']) {
  test(`${kind} updates require both proofs and creates reject partial proof`, () => {
    const params = { id: 'binding', expected_version: 2, source_kind: kind, configuration: base };
    assert.deepEqual(automationMutation(params, kind), base);
    assert.throws(() => automationMutation(params, kind, 'update'), /requires both authorization/);
    for (const proof of [
      { authorization_proposal_message_id: '1790220732844' },
      { authorization_confirmation_message_id: '1790220732845' },
    ]) {
      for (const operation of ['create', 'update']) {
        assert.throws(() => automationMutation({ ...params, ...proof }, kind, operation), /requires both authorization/);
      }
    }
  });
  test(`${kind} authorization proof is transport metadata, never form configuration`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
    assert.deepEqual(automationMutation({ source_kind: kind, configuration: base, ...proof }, kind), { ...base, ...proof });
    assert.throws(() => automationMutation({ source_kind: kind, configuration: { ...base, ...proof } }, kind), /unsupported/);
    for (const field of Object.keys(proof)) {
      for (const value of [1790220732844, '001', '', ' ', null, 'fake', '1'.repeat(129)]) {
        for (const operation of ['create', 'update']) {
          assert.throws(() => automationMutation({ id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof, [field]: value }, kind, operation), /canonical decimal/);
        }
      }
    }
  });
  test(`${kind} update preserves expected version and prevents malformed targets`, () => {
    const proof = { authorization_proposal_message_id: '1790220732844', authorization_confirmation_message_id: '1790220732845' };
    assert.equal(automationMutation({ id: 'binding', expected_version: 2, source_kind: kind, configuration: base, ...proof }, kind, 'update').expected_version, 2);
    assert.throws(() => automationMutation({ source_kind: kind, configuration: base, ...proof }, kind, 'update'), /update requires/);
  });
}
