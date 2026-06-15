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
import { get, post, del, getForOrg, apiPath } from '../lib/client.js';
import { looksLikeMarkdown } from '../lib/message.js';
import { loadConfig, updateConfig, enabledOrgs, getOrgByOrgId, setOwner } from '../lib/config.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

function ensureClientMsgId(id) {
  return id || `cmsg_${randomUUID()}`;
}

/**
 * Resolve the target org block for owner commands. Accepts `org` as a config
 * slug or an org UUID; with neither, defaults to the single enabled org.
 * Returns { slug, org_id, self, owner } or throws a helpful error.
 */
function resolveOrgConfig(p) {
  const key = p.org || p.orgSlug || p.orgId || p.org_id;
  const enabled = enabledOrgs();
  if (key) {
    const bySlug = enabled.find((o) => o.slug === key);
    if (bySlug) return bySlug;
    const byId = getOrgByOrgId(key);
    if (byId) return byId;
    throw new Error(`org not found in config: "${key}" (known slugs: ${enabled.map((o) => o.slug).join(', ') || 'none'})`);
  }
  if (enabled.length === 1) return enabled[0];
  if (enabled.length === 0) throw new Error('no enabled orgs in config.orgs');
  throw new Error(`multiple enabled orgs — pass {"org":"<slug>"} (one of: ${enabled.map((o) => o.slug).join(', ')})`);
}

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
 *     }
 *   }
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
  return {
    client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
    type:          msgType,
    content:       { content_type: contentType, body, attachments },
    ...(params.replyTo ? { parent_id: params.replyTo } : {}),
  };
}

function resolveOrg(p) {
  const cfg = loadConfig();
  const orgs = cfg.orgs || {};
  if (p.org) {
    if (orgs[p.org]) return { slug: p.org, org: orgs[p.org] };
    const byId = Object.entries(orgs).find(([, o]) => o.org_id === p.org);
    if (byId) return { slug: byId[0], org: byId[1] };
    throw new Error(`Org not found: ${p.org}`);
  }
  const enabled = enabledOrgs();
  if (enabled.length === 1) return { slug: enabled[0].slug, org: orgs[enabled[0].slug] };
  if (enabled.length === 0) throw new Error('No enabled orgs in config');
  throw new Error(`Multiple orgs enabled — specify org slug: ${enabled.map(o => o.slug).join(', ')}`);
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
  'comm.get_conversation': () => get(apiPath(`/conversations/${params.conversationId}`)),

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
  'comm.mark_read': () => post(apiPath(`/conversations/${params.conversationId}/read`), {}),

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
    const { slug, org } = resolveOrg(params);
    const access = org.access || {};
    if (params.policy) {
      const valid = ['open', 'allowlist', 'owner'];
      if (!valid.includes(params.policy)) throw new Error(`Invalid policy: ${params.policy}. Must be one of: ${valid.join(', ')}`);
      updateConfig(cfg => { cfg.orgs[slug].access = { ...cfg.orgs[slug].access, dmPolicy: params.policy }; });
      return { org: slug, dmPolicy: params.policy, applied: true };
    }
    return { org: slug, dmPolicy: access.dmPolicy || 'owner', dmAllowFrom: access.dmAllowFrom || [] };
  },

  'comm.dm_list': () => {
    const { slug, org } = resolveOrg(params);
    const access = org.access || {};
    return { org: slug, dmPolicy: access.dmPolicy || 'owner', dmAllowFrom: access.dmAllowFrom || [] };
  },

  'comm.dm_allow': () => {
    const ids = params.memberIds || params.memberId
      ? [].concat(params.memberIds || params.memberId)
      : [];
    if (!ids.length) throw new Error('memberIds (or memberId) required');
    const { slug } = resolveOrg(params);
    const result = updateConfig(cfg => {
      const access = cfg.orgs[slug].access = cfg.orgs[slug].access || {};
      const list = new Set(access.dmAllowFrom || []);
      for (const id of ids) list.add(id);
      access.dmAllowFrom = [...list];
    });
    return { org: slug, dmAllowFrom: result.orgs[slug].access.dmAllowFrom, added: ids };
  },

  'comm.dm_revoke': () => {
    const ids = params.memberIds || params.memberId
      ? [].concat(params.memberIds || params.memberId)
      : [];
    if (!ids.length) throw new Error('memberIds (or memberId) required');
    const { slug } = resolveOrg(params);
    const result = updateConfig(cfg => {
      const access = cfg.orgs[slug].access = cfg.orgs[slug].access || {};
      const remove = new Set(ids.map(String));
      access.dmAllowFrom = (access.dmAllowFrom || []).filter(id => !remove.has(String(id)));
    });
    return { org: slug, dmAllowFrom: result.orgs[slug].access.dmAllowFrom, removed: ids };
  },
};

function printUsage() {
  console.log(`Comm CLI — IM operations on cws-core (contract-v5)

Usage: node src/cli/comm.js <command> '<json-params>'

Conversations
  comm.list_conversations   {cursor?, limit?, includeArchived?}
  comm.create_dm            {peerMemberId}                           # POST /conversations/dm
  comm.create_group         {name, memberIds, description?}          # POST /conversations/groups
  comm.get_conversation     {conversationId}

Messages
  comm.send                 {conversationId, content, replyTo?, clientMsgId?}
                            # content: string | {text|body, markdown?} | {type,body} | [{type,body}]
  comm.get_messages         {conversationId, afterSeq?, beforeSeq?, limit?}
  comm.get_message          {conversationId, messageId}

Read receipts
  comm.unread               {conversationId}                         # GET  /conversations/{id}/unread
  comm.mark_read            {conversationId}                         # POST /conversations/{id}/read

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
