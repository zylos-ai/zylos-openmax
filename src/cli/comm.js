#!/usr/bin/env node

/**
 * Communication CLI — IM operations against cws-core
 * (paths and shapes match the live OpenAPI at
 *  https://zylos01.jinglever.com/cws-core/openapi.json).
 *
 * Reactive IM (Agent replying to a user via the WebSocket frame) is handled
 * by `src/comm-bridge.js` automatically. This CLI is for proactive IM:
 * starting a new DM, sending into a non-current conversation, pulling
 * history, etc.
 *
 * WebSocket frames stay on the direct cws-comm link (src/lib/ws.js) —
 * this CLI is REST only.
 *
 * Usage:
 *   node src/cli/comm.js <command> '<json-params>'
 *   node src/cli/comm.js comm.send '{"conversationId":"cv-1","content":"hi"}'
 *
 * Status:
 *   ✅  available in cws-core today
 *   ⏳  not exposed by cws-core yet (call will 404); kept here so the
 *      surface is ready when core adds the endpoint
 */

import { randomUUID } from 'crypto';
import { getForOrg, postForOrg, delForOrg, apiPath } from '../lib/client.js';
import { looksLikeMarkdown } from '../lib/message.js';
import { buildMentions } from '../lib/mention.js';
import { loadConfig, updateConfig, enabledOrgs, getOrgByOrgId, setOwner } from '../lib/config.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

function ensureClientMsgId(id) {
  return id || `cmsg_${randomUUID()}`;
}

/**
 * Resolve the target org block. Accepts `org` as a config key (org_id),
 * org UUID, or org_name (case-insensitive); with neither, defaults to the
 * single enabled org.
 * Returns { slug, org_id, org_name, self, owner, ... } where `slug` is the
 * config key (used for config writes).
 */
function resolveOrgConfig(p) {
  const key = p.org || p.orgSlug || p.orgId || p.org_id;
  const enabled = enabledOrgs();
  if (key) {
    const byKey = enabled.find((o) => o.slug === key);
    if (byKey) return byKey;
    const byId = getOrgByOrgId(key);
    if (byId) return byId;
    const norm = (s) => s?.toLowerCase().replace(/[-_ ]/g, '');
    const keyNorm = norm(key);
    const byName = enabled.find((o) => norm(o.org_name) === keyNorm);
    if (byName) return byName;
    const names = enabled.map((o) => o.org_name || o.slug).join(', ');
    throw new Error(`org not found in config: "${key}" (known: ${names || 'none'})`);
  }
  if (enabled.length === 1) return enabled[0];
  if (enabled.length === 0) throw Object.assign(new Error('no enabled orgs in config.orgs'), { status: 400 });
  const names = enabled.map((o) => o.org_name || o.slug).join(', ');
  throw Object.assign(
    new Error(`multiple enabled orgs — pass {"org":"<name>"} (one of: ${names})`),
    { status: 400 },
  );
}

/**
 * HTTP helpers for an org-owned IM op. Every cws-core IM route is org-scoped:
 * cws-core resolves the org from the JWT principal and 403s on an identity-only
 * token. We ALWAYS route through the operating org's cached JWT via the *ForOrg
 * helpers — `resolveOrgConfig(p)` picks the explicit `{org}` (config key / org
 * UUID / org_name) or the single enabled org, and FAILS FAST (400) on a
 * multi-org install with no `{org}` instead of silently dropping to a bare,
 * identity-only call. Single-org / `COCO_ORG_ID` deployments resolve the one
 * org exactly as before.
 *
 * Bug B fix (#13): the previous no-`{org}` branch returned bare
 * `{ get, post, del }`, so on a multi-org agent the 6 conversation-member
 * commands (and the 10 formerly-bare commands below) went out identity-only and
 * 403'd. Resolving a default org here closes that leak.
 */
function convClient(p) {
  const org = resolveOrgConfig(p);
  return {
    get:  (path, query) => getForOrg(org.org_id, path, query),
    post: (path, body)  => postForOrg(org.org_id, path, body),
    del:  (path)        => delForOrg(org.org_id, path),
  };
}

// Org-scoped shadows of the bare verbs. Every IM REST command is org-owned, so
// each resolves the operating org (fail-fast in multi-org) and carries that
// org's JWT — see convClient above. This converts the 10 formerly-unconditionally
// -bare commands (list_conversations / create_dm / create_group / get_messages /
// send / get_message / unread / mark_read / search / sync) without touching each
// call site.
const get  = (path, query) => convClient(params).get(path, query);
const post = (path, body)  => convClient(params).post(path, body);
const del  = (path)        => convClient(params).del(path);

// Read this agent's own member record from cws-core for the given org; the
// authoritative owner_member_id lives here.
async function fetchSelfMember(org) {
  const selfId = org.self?.member_id;
  if (!selfId) throw new Error(`org "${org.slug}" has no self.member_id yet (token exchange not completed)`);
  return getForOrg(org.org_id, apiPath(`/members/${selfId}`));
}

/**
 * Build the cws-core v5 send-message body from caller input.
 *
 * cws-core schema (sendMessageRequest):
 *   {
 *     client_msg_id: "...",
 *     type: "TEXT" | "MARKDOWN" | "AGENT_TEXT" | "IMAGE" | "FILE" | "AGENT_STRUCTURED" | ...,
 *     content: {
 *       content_type: "text" | "markdown" | "image" | "file" | ...,
 *       body: { text, ... } | {},
 *       attachments: [{artifact_id, file_name, content_type, size_bytes}, ...]
 *     },
 *     mentions?: [{type: "member", member_id}, ...]
 *   }
 *
 * mentions is resolved automatically from `@name` tokens in the text body
 * against the conversation's known participants (src/lib/mention.js) —
 * required for a mention to actually wake its target; cws-comm does not
 * parse @-mentions out of text itself. Pass `params.mentions` explicitly
 * (array of `{type, member_id}`, or plain member_id strings) to override
 * auto-detection.
 *
 * Caller can pass:
 *   - string                                            → text/markdown auto-detect
 *   - {text} | {body}                                   → text/markdown auto-detect
 *   - {content_type, body, attachments?}                → pass-through (advanced)
 *   - already-built object with top-level type+content  → returned as-is
 */
function buildSendBody(params) {
  // Allow advanced caller to override completely
  if (params.body && params.body.content && params.body.type) {
    return {
      client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
      ...params.body,
      ...(params.replyTo ? { parent_id: params.replyTo } : {}),
    };
  }
  const c = params.content;
  let msgType = params.type;
  let contentType, body, attachments;
  if (c && typeof c === 'object' && c.content_type) {
    // pre-built content object
    contentType = c.content_type;
    body        = c.body ?? {};
    attachments = c.attachments ?? [];
    if (!msgType) msgType = contentType === 'image' ? 'IMAGE'
                       : contentType === 'file' ? 'FILE'
                       : 'AGENT_TEXT';
  } else {
    const text = (typeof c === 'string') ? c
              : (c && typeof c === 'object') ? (c.text ?? c.body ?? '')
              : '';
    contentType = looksLikeMarkdown(text) ? 'markdown' : 'text';
    body        = { text: String(text) };
    attachments = [];
    if (!msgType) msgType = 'AGENT_TEXT';
  }
  // Resolve `@name` tokens in the text body to a structured mentions[]
  // entry (cws-core MentionInput[]) against known conversation
  // participants, unless the caller already supplied one explicitly.
  // cws-comm never derives mentions from text itself — only the sending
  // client does (see src/lib/mention.js) — so without this an agent's
  // outbound @-mention never wakes its target.
  const explicitMentions = Array.isArray(params.mentions)
    ? params.mentions.map((m) => (typeof m === 'string' ? { type: 'member', member_id: m } : m))
    : undefined;
  const mentions = explicitMentions
    || (typeof body?.text === 'string' ? buildMentions(body.text, params.conversationId) : undefined);
  return {
    client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
    type:          msgType,
    content:       { content_type: contentType, body, attachments },
    ...(params.replyTo ? { parent_id: params.replyTo } : {}),
    ...(mentions ? { mentions } : {}),
  };
}


const COMMANDS = {
  // ---- Conversation collection -------------------------------------------------
  // ✅ GET /api/v1/conversations
  'comm.list_conversations': () => get(apiPath('/conversations'), {
    cursor:           params.cursor ?? params.pageToken,
    limit:            params.limit  ?? params.pageSize,
    include_archived: params.includeArchived,
  }),

  // ✅ POST /api/v1/conversations/dm    body {peer_member_id}
  // ✅ POST /api/v1/conversations/groups body {name, member_ids, description?, avatar_media_id?, metadata?}
  //   cws-core derives org_id and caller member_id from the JWT — do NOT send them.
  'comm.create_dm':    () => post(apiPath('/conversations/dm'), {
    peer_member_id: params.peerMemberId || params.participantId || params.peerId,
  }),
  'comm.create_group': () => post(apiPath('/conversations/groups'), {
    name:             params.name || params.title,
    member_ids:       params.memberIds || params.participantIds,
    description:      params.description,
    avatar_media_id:  params.avatarMediaId,
    metadata:         params.metadata,
  }),

  // ✅ GET /api/v1/conversations/{id}
  'comm.get_conversation': () => convClient(params).get(apiPath(`/conversations/${params.conversationId}`)),

  // ---- Conversation members ---------------------------------------------------
  // Group membership after creation. cws-core derives the caller from the JWT
  // and enforces permissions server-side (only conversation owner/admins may
  // add/remove; non-self targets must be org members). Pass {org} for multi-org.

  // ✅ GET /api/v1/conversations/{id}/members
  //   cws-core's ListMembers takes only conversation_id and returns the full
  //   member list — it is NOT paginated, so do not send cursor/limit (they'd be
  //   silently ignored and mislead callers into fake pagination loops).
  'comm.member_list': () => convClient(params).get(
    apiPath(`/conversations/${params.conversationId}/members`),
  ),

  // ✅ POST /api/v1/conversations/{id}/members            body {member_id, role?}   (single)
  // ✅ POST /api/v1/conversations/{id}/members:batch-add  body {member_ids, role?}  (many)
  //   Pass {memberId} for one, or {memberIds:[...]} for a batch (partial-success
  //   envelope). role ∈ MEMBER|ADMIN|OWNER|PUBLISHER|SUBSCRIBER (default MEMBER).
  'comm.member_add': () => {
    const cid = params.conversationId;
    const c = convClient(params);
    const many = params.memberIds != null;
    const ids = many ? [].concat(params.memberIds) : [];
    if (many) {
      if (!ids.length) throw new Error('memberIds must be a non-empty array');
      return c.post(apiPath(`/conversations/${cid}/members:batch-add`), {
        member_ids: ids, ...(params.role ? { role: params.role } : {}),
      });
    }
    if (!params.memberId) throw new Error('memberId (or memberIds) required');
    return c.post(apiPath(`/conversations/${cid}/members`), {
      member_id: params.memberId, ...(params.role ? { role: params.role } : {}),
    });
  },

  // ✅ DELETE /api/v1/conversations/{id}/members/{member_id}
  //   Removing yourself is rejected (400) — use comm.leave instead.
  'comm.member_remove': async () => {
    if (!params.memberId) throw new Error('memberId required');
    const r = await convClient(params).del(
      apiPath(`/conversations/${params.conversationId}/members/${params.memberId}`),
    );
    return r ?? { removed: params.memberId, conversationId: params.conversationId };
  },

  // ✅ POST /api/v1/conversations/{id}/members:batch-remove  body {member_ids}
  //   Rejects self-removal (400) — use comm.leave. Returns a partial-success envelope.
  'comm.member_remove_batch': () => {
    const ids = params.memberIds != null ? [].concat(params.memberIds) : [];
    if (!ids.length) throw new Error('memberIds must be a non-empty array');
    return convClient(params).post(
      apiPath(`/conversations/${params.conversationId}/members:batch-remove`),
      { member_ids: ids },
    );
  },

  // ✅ POST /api/v1/conversations/{id}/leave   body {new_owner_id?}
  //   Self-removal path. If the leaver is the group owner, cws-core requires a
  //   human successor: pass {newOwnerId}, or omit to let it pick a remaining
  //   human (or delete the group when only agents/nobody remain).
  'comm.leave': () => convClient(params).post(
    apiPath(`/conversations/${params.conversationId}/leave`),
    { ...(params.newOwnerId ? { new_owner_id: params.newOwnerId } : {}) },
  ),

  // ---- Messages ---------------------------------------------------------------
  // ✅ GET /api/v1/conversations/{id}/messages?after_seq=&before_seq=&limit=
  'comm.get_messages': () => get(apiPath(`/conversations/${params.conversationId}/messages`), {
    after_seq:  params.afterSeq,
    before_seq: params.beforeSeq,
    limit:      params.limit,
  }),

  // ✅ POST /api/v1/conversations/{id}/messages
  //   body: {client_msg_id, type, content:{content_type, body, attachments}, parent_id?}
  //   See buildSendBody() for the schema details.
  'comm.send': () => post(apiPath(`/conversations/${params.conversationId}/messages`), buildSendBody(params)),

  // ✅ GET /api/v1/conversations/{id}/messages/{msg_id}
  'comm.get_message': () => get(
    apiPath(`/conversations/${params.conversationId}/messages/${params.messageId}`),
  ),

  // ✅ GET /api/v1/conversations/{id}/unread
  'comm.unread': () => get(apiPath(`/conversations/${params.conversationId}/unread`)),

  // ✅ POST /api/v1/conversations/{id}/read
  'comm.mark_read': () => post(apiPath(`/conversations/${params.conversationId}/read`), { read_until_seq: params.seq }),

  // ✅ GET /api/v1/search/pages  — KB page search (only search surface in v5)
  'comm.search': () => get(apiPath('/search/pages'), {
    query:  params.query || params.q,
    kb_id:  params.kbId,
    limit:  params.limit  ?? params.pageSize,
    offset: params.offset,
    sort:   params.sort,
  }),

  // ✅ POST /api/v1/sync   body {since_seq, device_id, limit?}
  // Pull missed events after WS reconnect.
  'comm.sync': () => post(apiPath('/sync'), {
    since_seq: params.sinceSeq,
    device_id: params.deviceId,
    limit:     params.limit,
  }),

  // ---- Owner ------------------------------------------------------------------
  'comm.sync_owner': async () => {
    const org = resolveOrgConfig(params);
    const member = await fetchSelfMember(org);
    const coreOwnerId = member?.owner_member_id || '';
    const localOwnerId = org.owner?.member_id || '';
    if (!coreOwnerId) {
      return { org_slug: org.slug, synced: false, reason: 'core has no owner recorded; local binding left as-is', local_owner_id: localOwnerId };
    }
    if (coreOwnerId === localOwnerId) {
      return { org_slug: org.slug, synced: false, reason: 'already in sync', owner_id: coreOwnerId };
    }
    let name = '';
    try {
      const ownerMember = await getForOrg(org.org_id, apiPath(`/members/${coreOwnerId}`));
      name = ownerMember?.display_name || ownerMember?.username || '';
    } catch { /* name is cosmetic */ }
    setOwner(org.slug, coreOwnerId, name);
    return { org_slug: org.slug, synced: true, previous_owner_id: localOwnerId, owner: { member_id: coreOwnerId, name } };
  },

  // ---- DM access control (local config, hot-reloaded) -----------------------

  'comm.dm_policy': () => {
    const org = resolveOrgConfig(params);
    const access = org.access || {};
    if (params.policy) {
      const valid = ['open', 'allowlist', 'owner'];
      if (!valid.includes(params.policy)) throw new Error(`Invalid policy: ${params.policy}. Must be one of: ${valid.join(', ')}`);
      updateConfig(cfg => { cfg.orgs[org.slug].access = { ...cfg.orgs[org.slug].access, dmPolicy: params.policy }; });
      return { org: org.org_name || org.slug, dmPolicy: params.policy, applied: true };
    }
    return { org: org.org_name || org.slug, dmPolicy: access.dmPolicy || 'owner', dmAllowFrom: access.dmAllowFrom || [] };
  },

  'comm.dm_list': () => {
    const org = resolveOrgConfig(params);
    const access = org.access || {};
    return { org: org.org_name || org.slug, dmPolicy: access.dmPolicy || 'owner', dmAllowFrom: access.dmAllowFrom || [] };
  },

  'comm.dm_allow': () => {
    const ids = params.memberIds || params.memberId
      ? [].concat(params.memberIds || params.memberId)
      : [];
    if (!ids.length) throw new Error('memberIds (or memberId) required');
    const org = resolveOrgConfig(params);
    const result = updateConfig(cfg => {
      const access = cfg.orgs[org.slug].access = cfg.orgs[org.slug].access || {};
      const list = new Set(access.dmAllowFrom || []);
      for (const id of ids) list.add(id);
      access.dmAllowFrom = [...list];
    });
    return { org: org.org_name || org.slug, dmAllowFrom: result.orgs[org.slug].access.dmAllowFrom, added: ids };
  },

  'comm.dm_revoke': () => {
    const ids = params.memberIds || params.memberId
      ? [].concat(params.memberIds || params.memberId)
      : [];
    if (!ids.length) throw new Error('memberIds (or memberId) required');
    const org = resolveOrgConfig(params);
    const result = updateConfig(cfg => {
      const access = cfg.orgs[org.slug].access = cfg.orgs[org.slug].access || {};
      const remove = new Set(ids.map(String));
      access.dmAllowFrom = (access.dmAllowFrom || []).filter(id => !remove.has(String(id)));
    });
    return { org: org.org_name || org.slug, dmAllowFrom: result.orgs[org.slug].access.dmAllowFrom, removed: ids };
  },
};

function printUsage() {
  console.log(`Comm CLI — IM operations on cws-core (contract-v5)

Usage: node src/cli/comm.js <command> '<json-params>'

Conversations
  comm.list_conversations   {cursor?, limit?, includeArchived?}
  comm.create_dm            {peerMemberId}                           # POST /conversations/dm
  comm.create_group         {name, memberIds, description?}          # POST /conversations/groups
  comm.get_conversation     {conversationId, org?}

Conversation members (owner/admin only; pass {org} for multi-org installs)
  comm.member_list          {conversationId, org?}                                  # GET  .../members (full list; not paginated)
  comm.member_add           {conversationId, memberId | memberIds[], role?, org?}   # POST .../members (or :batch-add)
  comm.member_remove        {conversationId, memberId, org?}                        # DELETE .../members/{id}
  comm.member_remove_batch  {conversationId, memberIds[], org?}                     # POST .../members:batch-remove
  comm.leave                {conversationId, newOwnerId?, org?}                     # POST .../leave

Messages
  comm.send                 {conversationId, content, replyTo?, clientMsgId?, mentions?}
                            # content: string | {text|body, markdown?} | {type,body} | [{type,body}]
                            # mentions auto-resolved from @name in text if omitted (array of member_id or {type,member_id})
  comm.get_messages         {conversationId, afterSeq?, beforeSeq?, limit?}
  comm.get_message          {conversationId, messageId}

Read receipts
  comm.unread               {conversationId}                         # GET  /conversations/{id}/unread
  comm.mark_read            {conversationId, seq}                    # POST /conversations/{id}/read

Search (KB pages only)
  comm.search               {query, kbId?, limit?, offset?, sort?}   # GET /search/pages

Sync (WS reconnect catch-up)
  comm.sync                 {sinceSeq, deviceId, limit?}             # POST /sync

Owner (local cache ↔ cws-core authoritative)
  comm.sync_owner           {org?}                  # pull authoritative owner from core into config

DM access control (local config, hot-reloaded by running service)
  comm.dm_policy            {org?, policy?}                          # show or set dmPolicy (open|allowlist|owner)
  comm.dm_list              {org?}                                   # list current dmPolicy + dmAllowFrom
  comm.dm_allow             {memberId|memberIds, org?}               # add member(s) to dmAllowFrom
  comm.dm_revoke            {memberId|memberIds, org?}               # remove member(s) from dmAllowFrom

Environment:
  COCO_API_URL       cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX    Path prefix override (default: /api/v1)
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
