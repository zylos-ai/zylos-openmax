import assert from 'node:assert/strict';
import test from 'node:test';

import { formatInboundForC4 } from './message.js';

// Focused coverage for the org header suffix rendered on the tag line.
// Four cases: both name+id present / name only / id only / neither.
// When BOTH are present the header exposes the org_id (UUID) so the agent can
// prefix COCO_ORG_ID onto each org-scoped task-CLI call (see SKILL.md).

const conv = { type: 'dm', id: 'cv-1' };
const sender = { displayName: 'Alice' };
const current = { content: 'hello' };

// The tag line is the first line of the output.
function firstLine(out) {
  return out.split('\n')[0];
}

test('org header: both name and org_id present → "(org: <name> · org_id: <uuid>)"', () => {
  const out = formatInboundForC4(conv, sender, current, [], {
    orgName: 'OpenMax',
    orgId: '019f6581-bd27-739e-aff1-4dd285e3324b',
  });
  assert.equal(
    firstLine(out),
    '[OPENMAX DM] (org: OpenMax · org_id: 019f6581-bd27-739e-aff1-4dd285e3324b)',
  );
});

test('org header: name only → single-value "(org: <name>)"', () => {
  const out = formatInboundForC4(conv, sender, current, [], { orgName: 'OpenMax' });
  assert.equal(firstLine(out), '[OPENMAX DM] (org: OpenMax)');
});

test('org header: org_id only → single-value "(org: <uuid>)"', () => {
  const out = formatInboundForC4(conv, sender, current, [], {
    orgId: '019f6581-bd27-739e-aff1-4dd285e3324b',
  });
  assert.equal(
    firstLine(out),
    '[OPENMAX DM] (org: 019f6581-bd27-739e-aff1-4dd285e3324b)',
  );
});

test('org header: neither present → no org suffix', () => {
  const out = formatInboundForC4(conv, sender, current, [], {});
  assert.equal(firstLine(out), '[OPENMAX DM]');
});

test('org header: name and id go through escapeXml (< and > escaped)', () => {
  const out = formatInboundForC4(conv, sender, current, [], {
    orgName: 'A<x>',
    orgId: '1<2>',
  });
  assert.equal(firstLine(out), '[OPENMAX DM] (org: A&lt;x&gt; · org_id: 1&lt;2&gt;)');
});
