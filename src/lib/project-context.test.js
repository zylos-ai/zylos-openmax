import assert from 'node:assert/strict';
import test from 'node:test';

import { formatInboundForC4 } from './message.js';
import { extractProjectContext } from './project-context.js';

const PROJECT_ID = '018f0f8e-7b4a-7a91-bc42-2f4d16f3f201';

test('extractProjectContext reads the authoritative nested message snapshot', () => {
  const context = extractProjectContext({
    message: {
      metadata: {
        project_context: {
          schema_version: 1,
          project_id: PROJECT_ID,
          project_name_snapshot: 'Workspace',
          selected_by_member_id: 'member-1',
          selected_explicitly: true,
          validated_at: '2026-07-24T12:00:00Z',
        },
      },
    },
  });

  assert.deepEqual(context, {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    projectName: 'Workspace',
    selectedByMemberId: 'member-1',
    validatedAt: '2026-07-24T12:00:00Z',
  });
});

test('extractProjectContext rejects unvalidated or unsupported snapshots', () => {
  assert.equal(extractProjectContext({
    message: { metadata: { project_context: {
      schema_version: 1,
      project_id: PROJECT_ID,
      selected_explicitly: false,
    } } },
  }), null);
  assert.equal(extractProjectContext({
    message: { metadata: { project_context: {
      schema_version: 2,
      project_id: PROJECT_ID,
      selected_explicitly: true,
    } } },
  }), null);
});

test('formatInboundForC4 injects a compact selected Project context', () => {
  const output = formatInboundForC4(
    { type: 'dm', id: 'conv-1' },
    { displayName: 'Stephanie' },
    { content: 'What is the status?', type: 'text' },
    [],
    {
      projectContext: { projectId: PROJECT_ID, projectName: 'Workspace "API" <release> & ops' },
      originConversationId: 'conv-1',
      originMessageId: 'msg-1',
    },
  );

  assert.match(output, new RegExp(`<project-context schema-version="1" id="${PROJECT_ID}"`));
  assert.match(output, /name="Workspace &quot;API&quot; &lt;release&gt; &amp; ops"/);
  assert.match(output, /origin-conversation-id="conv-1" origin-message-id="msg-1"/);
});

test('formatInboundForC4 omits Project XML and origin IDs when Project is not selected', () => {
  const output = formatInboundForC4(
    { type: 'dm', id: 'conv-1' },
    { displayName: 'Stephanie' },
    { content: 'Build a release dashboard', type: 'text' },
    [],
    { originConversationId: 'conv-1', originMessageId: 'msg-2' },
  );

  assert.doesNotMatch(output, /<project-context/);
  assert.doesNotMatch(output, /origin-conversation-id/);
  assert.doesNotMatch(output, /origin-message-id/);
  assert.match(output, /<current-message>/);
});
