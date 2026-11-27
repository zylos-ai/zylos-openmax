import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const flat = path => readFileSync(new URL(path, root), 'utf8').replace(/\s+/g, ' ');

// Checks the written guardrail for failed connector writes (OPENM-1364 S12:
// an Agent re-cancelled an order with another reason after the first cancel
// failed), not whether a model follows it.
test('conn-operations.md: a failed write is reported as-is, never retried with changed inputs', () => {
  const text = flat('references/conn-operations.md');
  for (const pattern of [
    /\*\*A failed write: report it as-is, never retry with changed inputs\.\*\*/,
    /tell the user the error exactly as returned \(status and the provider's message, in plain words\) and ask how to proceed/,
    /Do \*\*not\*\* retry it on your own with different parameters: no other reason code, amount, recipient, ID, option or action that the user did not give/,
    /A changed retry is a new operation the user never asked for/,
    /Retrying the \*\*identical\*\* call is fine only for a transient failure \(timeout, 429 \/ 5xx, `confirmation_required` after the user confirmed\)/,
    /a failure that names a parameter or business rule is never transient/,
  ]) {
    assert.match(text, pattern);
  }
  // It sits in the universal flow, right after the conn.invoke step.
  assert.ok(text.indexOf('**A failed write: report it as-is') > text.indexOf('3. **`conn.invoke {app, action, params}`**'));
  assert.ok(text.indexOf('**A failed write: report it as-is') < text.indexOf('**Large catalogs'));
});
