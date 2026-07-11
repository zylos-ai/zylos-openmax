import assert from 'node:assert/strict';
import test from 'node:test';

import { formatInboundForC4 } from './message.js';
import { extractWorkReferences, formatWorkReferenceContext } from './work-reference.js';

const PROJECT_ID = '018f0f8e-7b4a-7a91-bc42-2f4d16f3f201';
const ISSUE_ID = '018f0f8e-8c5b-7bb2-ae53-3a5e27a4f312';

test('extractWorkReferences parses canonical Markdown and bare URIs', () => {
  const text = `Discuss [#Workspace / API docs](issue://${ISSUE_ID}) with proj://${PROJECT_ID}.`;
  assert.deepEqual(extractWorkReferences(text), [
    {
      kind: 'issue',
      id: ISSUE_ID,
      uri: `issue://${ISSUE_ID}`,
      label: 'Workspace / API docs',
    },
    {
      kind: 'project',
      id: PROJECT_ID,
      uri: `proj://${PROJECT_ID}`,
      label: '',
    },
  ]);
});

test('extractWorkReferences deduplicates repeated canonical URIs', () => {
  const uri = `issue://${ISSUE_ID}`;
  assert.equal(extractWorkReferences(`[one](${uri}) and ${uri}`).length, 1);
});

test('formatWorkReferenceContext escapes labels and states non-authorizing semantics', () => {
  const context = formatWorkReferenceContext([{
    kind: 'issue',
    id: ISSUE_ID,
    uri: `issue://${ISSUE_ID}`,
    label: 'API "docs" <urgent>',
  }]);
  assert.match(context, /context only; it does not start work or grant access/);
  assert.match(context, /label="API &quot;docs&quot; &lt;urgent&gt;"/);
});

test('formatInboundForC4 injects normalized references and preserves user text', () => {
  const text = `Check [#Workspace / API docs](issue://${ISSUE_ID}) status`;
  const output = formatInboundForC4(
    { type: 'dm' },
    { displayName: 'Stephanie' },
    { content: text, type: 'text' },
  );
  assert.ok(output.includes(`<issue id="${ISSUE_ID}"`));
  assert.ok(output.includes(`Stephanie said: ${text}`));
});
