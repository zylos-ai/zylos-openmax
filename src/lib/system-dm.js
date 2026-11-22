/**
 * System private-chat exit: send one message to an OpenMax member's DM by
 * member id, from any thread (scripts/system-dm.js).
 *
 * An owner-approved exception to the one-thread-per-address rule (approved by
 * Noah 2026-11-22; see SKILL.md "Session Groups and Sending"). Every other
 * cross-conversation send still goes through an `internal` hand-off.
 *
 * 1. Org: the caller's own OpenMax conversation (from ZYLOS_SESSION_GROUP
 *    `openmax:<dm|group|sub>-<id>`, looked up in conv-org-map.json) decides
 *    it; a COCO_ORG_ID that disagrees is refused (ORG_MISMATCH). Outside an
 *    OpenMax conversation: COCO_ORG_ID or the single enabled org.
 * 2. Resolve the DM: POST /conversations/dm {peer_member_id} (returns the
 *    existing DM or creates it) and store its org and type.
 * 3. Audit: one line before the send and one after it, appended to
 *    ~/zylos/components/openmax/logs/system-dm-audit.jsonl (no message text).
 * 4. Send through `c4-send.js openmax '<conversation id>|type:dm'` without
 *    ZYLOS_SESSION_GROUP / ZYLOS_SYSTEM_SEND. Core then makes no ownership
 *    comparison (no CROSS_SESSION_OUTBOUND), still asks session-group.js and
 *    records the message under the DM's own group (`openmax:dm-<id>`), where
 *    the member's reply arrives. ZYLOS_RUN_ID is kept so Core never falls back
 *    to the legacy foreground-session.json for the row's session_id: it is
 *    the caller's session for Origin and null for any other thread.
 * 5. Return the OpenMax message id: scripts/send.js prints its result JSON
 *    on stdout, which c4-send passes through.
 *
 * The body is text, [MEDIA:…], [STRUCTURED]{…} or a display [CARD]{…}. A
 * question card (kind / askedOf) is refused: its answer lands in the DM's
 * thread, so it is handed to that thread with `internal`.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { postForOrg, apiPath } from './client.js';
import { resolveDefaultOrgId, getOrgByOrgId } from './config.js';
import { convRecordFields, registerConvOrg, lookupConvOrg } from './conv-org.js';
import { formatEndpoint } from './message.js';
import { sentMessageId } from './dm-seen-watch.js';
import { DEFAULT_C4_SEND } from './im-owner-notice.js';
import { parseCardMessage } from './card-message.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');
const CALLER_GROUP_RE = new RegExp(`^openmax:(?:dm|group|sub)-(${UUID})$`, 'i');
/** A media upload goes through the same child; give it room. */
const C4_SEND_TIMEOUT_MS = 180_000;

function fail(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/**
 * The environment c4-send runs with: no session group (no ownership
 * comparison), no system-notice flag, the DM's org. ZYLOS_RUN_ID stays (see
 * the file comment).
 */
export function systemSendEnv(env, orgId) {
  const out = { ...env, COCO_ORG_ID: orgId };
  delete out.ZYLOS_SESSION_GROUP;
  delete out.ZYLOS_SYSTEM_SEND;
  return out;
}

/** The OpenMax conversation id of the caller's thread, or '' (not an OpenMax thread). */
export function callerConversationId(sessionGroup) {
  const m = typeof sessionGroup === 'string' ? CALLER_GROUP_RE.exec(sessionGroup) : null;
  return m ? m[1].toLowerCase() : '';
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

/** ~/zylos/components/openmax/logs/system-dm-audit.jsonl (override: OPENMAX_SYSTEM_DM_AUDIT_FILE). */
export function auditFilePath(env = process.env) {
  if (env.OPENMAX_SYSTEM_DM_AUDIT_FILE) return env.OPENMAX_SYSTEM_DM_AUDIT_FILE;
  return path.join(env.HOME || os.homedir(), 'zylos', 'components', 'openmax', 'logs', 'system-dm-audit.jsonl');
}

const AUDIT_FIELDS = ['phase', 'audit_id', 'caller_session_group', 'caller_run_id', 'caller_member_id',
  'caller_conversation_id', 'target_member_id', 'org_id', 'conversation_id', 'outcome', 'message_id', 'error_code'];

/** Append one audit line; best-effort (a write failure never changes the send). */
export function appendAudit(fields, { file, now = new Date() } = {}) {
  const rec = { ts: now.toISOString() };
  for (const k of AUDIT_FIELDS) if (fields[k] !== undefined) rec[k] = fields[k] === '' ? null : fields[k];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
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
    lookupOrg = lookupConvOrg,
    selfMemberId = (orgId) => getOrgByOrgId(orgId)?.self?.member_id || '',
    createDm = (orgId, peerMemberId) => postForOrg(orgId, apiPath('/conversations/dm'), { peer_member_id: peerMemberId }),
    remember = registerConvOrg,
    c4Send = runC4Send,
    audit = (fields) => appendAudit(fields, { file: auditFilePath(env) }),
  } = deps;

  if (typeof memberId !== 'string' || !UUID_RE.test(memberId)) {
    throw fail('INVALID_ARGS', 'member id must be an OpenMax member UUID');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw fail('INVALID_ARGS', 'message is empty');
  }
  let card;
  try { card = parseCardMessage(message); } catch (e) { throw fail('INVALID_ARGS', e.message); }
  if (card && !card.display) {
    throw fail('QUESTION_CARD', 'a question card (kind / askedOf) is answered in the DM\'s thread: hand it to that thread with c4-send.js internal \'openmax:dm-<id>\' instead. Nothing was sent.');
  }

  // Org boundary: the caller's own OpenMax conversation decides it.
  const callerGroup = env.ZYLOS_SESSION_GROUP || '';
  const callerConv = callerConversationId(callerGroup);
  const callerOrg = callerConv ? lookupOrg(callerConv) : '';
  if (callerOrg && env.COCO_ORG_ID && env.COCO_ORG_ID !== callerOrg) {
    throw fail('ORG_MISMATCH', `COCO_ORG_ID (${env.COCO_ORG_ID}) is not the org of this thread's conversation (${callerOrg}). Cross-org sends are refused. Nothing was sent.`);
  }
  const orgId = callerOrg || resolveOrgId();
  if (!orgId) {
    throw fail('ORG_REQUIRED', 'cannot tell which org this send belongs to (this thread is not an OpenMax conversation and the Agent is in several orgs). Ask the requester; do not pick one. Nothing was sent.');
  }
  const self = selfMemberId(orgId);
  if (self === memberId) {
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

  const trail = {
    audit_id: crypto.randomUUID(),
    caller_session_group: callerGroup,
    caller_run_id: env.ZYLOS_RUN_ID || '',
    caller_member_id: self,
    caller_conversation_id: callerConv,
    target_member_id: memberId,
    org_id: orgId,
    conversation_id: conversationId,
  };
  audit({ phase: 'attempt', ...trail });

  const endpoint = formatEndpoint({ conversationId, endpointType: 'dm' });
  const run = await c4Send(endpoint, message, { env: systemSendEnv(env, orgId) });
  const result = parseSendResult(run.stdout);
  if (run.code !== 0 || result?.ok === false || result?.error) {
    audit({ phase: 'result', ...trail, outcome: 'failed', error_code: 'SEND_FAILED' });
    throw fail('SEND_FAILED', `c4-send to ${endpoint} failed (exit ${run.code}); see stderr; check the DM before resending`,
      { conversation_id: conversationId, stderr: run.stderr.trim().slice(-2000), stdout: run.stdout.trim().slice(-2000) });
  }
  // null only if send.js printed no result line (it always does on success)
  const messageId = (result && sentMessageId(result)) || null;
  audit({ phase: 'result', ...trail, outcome: 'sent', message_id: messageId });
  return {
    ok: true,
    member_id: memberId,
    conversation_id: conversationId,
    created: dm.created,
    message_id: messageId,
    result,
  };
}
