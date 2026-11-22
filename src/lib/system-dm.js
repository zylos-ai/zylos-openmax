/**
 * System private-chat exit: send one message to an OpenMax member's DM by
 * member id, from any thread (scripts/system-dm.js).
 *
 * 1. Resolve the DM: POST /conversations/dm {peer_member_id} (returns the
 *    existing DM or creates it) and store its org and type (conv-org-map.json).
 * 2. Send through `c4-send.js openmax '<conversation id>|type:dm'` with the
 *    caller's session identity removed (ZYLOS_SESSION_GROUP / ZYLOS_RUN_ID),
 *    as Core's own system notifications do. Core then makes no ownership
 *    comparison (no CROSS_SESSION_OUTBOUND), still asks session-group.js and
 *    records the message under the DM's own group (`openmax:dm-<id>`), so the
 *    thread that receives the member's reply has it in its C4 history.
 * 3. Return the OpenMax message id: scripts/send.js prints its result JSON
 *    (message_ids / id / action_ids) on stdout, which c4-send passes through.
 *
 * The body is anything c4-send takes: text, [MEDIA:…], [CARD]{…}, [STRUCTURED]{…}.
 */

import { execFile } from 'node:child_process';

import { postForOrg, apiPath } from './client.js';
import { resolveDefaultOrgId, getOrgByOrgId } from './config.js';
import { convRecordFields, registerConvOrg } from './conv-org.js';
import { formatEndpoint } from './message.js';
import { sentMessageId } from './dm-seen-watch.js';
import { DEFAULT_C4_SEND } from './im-owner-notice.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A media upload goes through the same child; give it room. */
const C4_SEND_TIMEOUT_MS = 180_000;

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** The environment c4-send runs with: no session identity, the DM's org. */
export function systemSendEnv(env, orgId) {
  const out = { ...env, COCO_ORG_ID: orgId };
  delete out.ZYLOS_SESSION_GROUP;
  delete out.ZYLOS_RUN_ID;
  return out;
}

/** The conversation record in a POST /conversations/dm answer ({conversation, created} or a bare record). */
export function dmRecord(answer) {
  const body = answer?.data && !answer.id && !answer.conversation ? answer.data : answer;
  const record = body?.conversation && typeof body.conversation === 'object' ? body.conversation : body;
  if (!record?.id || !UUID_RE.test(String(record.id))) return null;
  return { record, created: body?.created === true };
}

/**
 * The last JSON object line scripts/send.js printed (its result). c4-send's
 * own lines (`[C4] …`) and RPC log lines are skipped.
 */
export function parseSendResult(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* not JSON */ }
  }
  return null;
}

/** Run c4-send with `message` on stdin; never rejects. */
export function runC4Send(endpoint, message, { env, script = DEFAULT_C4_SEND, timeoutMs = C4_SEND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, 'openmax', endpoint],
      { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(message);
  });
}

/**
 * @param {{memberId:string, message:string}} input
 * @param {object} [deps] injectable for tests
 * @returns {Promise<{ok:true, member_id, conversation_id, created, message_id, result}>}
 */
export async function sendSystemDm({ memberId, message }, deps = {}) {
  const {
    env = process.env,
    resolveOrgId = resolveDefaultOrgId,
    selfMemberId = (orgId) => getOrgByOrgId(orgId)?.self?.member_id || '',
    createDm = (orgId, peerMemberId) => postForOrg(orgId, apiPath('/conversations/dm'), { peer_member_id: peerMemberId }),
    remember = registerConvOrg,
    c4Send = runC4Send,
  } = deps;

  if (typeof memberId !== 'string' || !UUID_RE.test(memberId)) {
    throw fail('INVALID_ARGS', 'member id must be an OpenMax member UUID');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw fail('INVALID_ARGS', 'message is empty');
  }
  const orgId = resolveOrgId();
  if (!orgId) {
    throw fail('ORG_REQUIRED', 'cannot tell which org to use: set COCO_ORG_ID to the member\'s org');
  }
  if (selfMemberId(orgId) === memberId) {
    throw fail('SELF_DM', 'member id is this Agent itself');
  }

  let dm;
  try {
    dm = dmRecord(await createDm(orgId, memberId));
  } catch (e) {
    throw fail('DM_RESOLVE_FAILED', `could not open the DM with ${memberId}: ${e.message}. Nothing was sent.`, e.status ? { status: e.status } : {});
  }
  if (!dm) throw fail('DM_RESOLVE_FAILED', `the platform returned no DM for ${memberId}. Nothing was sent.`);
  const conversationId = dm.record.id;
  try { remember(conversationId, orgId, convRecordFields(dm.record) || { type: 'DM' }); } catch { /* best-effort */ }

  const endpoint = formatEndpoint({ conversationId, endpointType: 'dm' });
  const run = await c4Send(endpoint, message, { env: systemSendEnv(env, orgId) });
  const result = parseSendResult(run.stdout);
  if (run.code !== 0 || result?.ok === false || result?.error) {
    throw fail('SEND_FAILED', `c4-send to ${endpoint} failed (exit ${run.code}); see stderr; check the DM before resending`,
      { conversation_id: conversationId, stderr: run.stderr.trim().slice(-2000), stdout: run.stdout.trim().slice(-2000) });
  }
  return {
    ok: true,
    member_id: memberId,
    conversation_id: conversationId,
    created: dm.created,
    // null only if send.js printed no result line (it always does on success)
    message_id: (result && sentMessageId(result)) || null,
    result,
  };
}
