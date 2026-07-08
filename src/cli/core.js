#!/usr/bin/env node

/**
 * Core CLI — read-mostly directory queries against cws-core
 * (paths and params per the live OpenAPI at
 *  https://zylos01.jinglever.com/cws-core/openapi.json).
 *
 * Usage:
 *   node src/cli/core.js <command> '<json-params>'
 *   node src/cli/core.js core.me            '{}'
 *   node src/cli/core.js core.member_list   '{"kind":"agent","limit":50}'
 *
 * Status:
 *   ✅  available in cws-core today
 *   ⏳  not exposed by cws-core yet (call will 404); kept here so the
 *      surface is ready when core adds the endpoint
 */

import { get, post, del, patch, apiPath, frontendUrl } from '../lib/client.js';
import { enabledOrgs, updateConfig } from '../lib/config.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

/** Normalize a scalar-or-array param into an array (drops null/undefined). */
const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Rename the agent itself (self-service display name change).
 *
 * Two sides are kept in sync:
 *   1. cws-core — `PATCH /api/v1/me {display_name}`. display_name is an
 *      identity-level attribute (managed by cws-core Identities, per D15),
 *      so a single /me PATCH updates how the agent appears in EVERY org it
 *      has joined. We deliberately do NOT use the admin-only
 *      `PATCH /api/v1/members/{id}` here — the agent runs as an org-member,
 *      not an org-admin, so that route would 403.
 *   2. local config — mirror the new name into `orgs.<slug>.self.name` for
 *      every enabled org so the runtime's notion of its own name stays
 *      consistent with cws-core.
 *
 * Prints only the new name + which orgs were synced. No tokens/secrets are
 * ever emitted (the RPC logger logs body+url only, never auth headers).
 */
async function selfRename(newName) {
  const name = typeof newName === 'string' ? newName.trim() : '';
  if (!name) {
    const err = new Error('self_rename requires a non-empty {name}');
    err.status = 400;
    throw err;
  }

  const updated = await patch(apiPath('/me'), { display_name: name });

  const orgs = enabledOrgs();
  if (orgs.length) {
    updateConfig((cfg) => {
      for (const { slug } of orgs) {
        const org = cfg.orgs?.[slug];
        if (!org) continue;
        org.self = { ...(org.self || {}), name };
      }
    });
  }

  return {
    display_name: updated?.display_name ?? name,
    identity_id:  updated?.identity_id,
    orgs_synced:  orgs.map((o) => o.slug),
  };
}

const COMMANDS = {
  // ✅ Current user / workspace identity
  'core.me': () => get(apiPath('/me')),

  // ✅ Rename self (display name). Updates cws-core identity via PATCH /me
  // (works for org-member agents — no admin needed) AND mirrors the new
  // name into local config's per-org `self.name`. See selfRename() above.
  'core.self_rename': () => selfRename(params.name || params.displayName || params.display_name),

  // ✅ Members directory.
  // cws-core uses PageParams (envelope.go) — `page` + `page_size`, NOT cursor/limit.
  // Legacy callers passing `limit` continue to work via the alias.
  'core.member_list': () => get(apiPath('/members'), {
    kind:      params.kind || params.type,
    status:    params.status,
    search:    params.search || params.q,
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),
  'core.member_get': () => get(apiPath(`/members/${params.memberId}`)),

  // ✅ Project member list
  'core.project_members': () => get(apiPath(`/projects/${params.projectId}/members`)),

  // ✅ Agent capability profiles — cws-core BFF aggregation a Lead reads to
  // pick a candidate agent for dispatch. A scope is REQUIRED: pass projectId
  // (resolved to the project's agents via cws-work) and/or memberIds
  // (repeatable agent member IDs). `include:["capabilities"]` (or the
  // `capabilities:true` shorthand) loads skills (agent self-reported) + tags
  // (human-declared); omit for the lightweight view. online_status is always
  // enriched. Open-ended org-wide capability search is intentionally NOT here.
  'core.agent_profiles': () => get(apiPath('/agent-profiles'), {
    project_id: params.projectId || params.project_id,
    member_id:  toArray(params.memberIds ?? params.memberId ?? params.member_id),
    include:    params.capabilities
      ? Array.from(new Set([...toArray(params.include), 'capabilities']))
      : toArray(params.include),
  }),

  // ✅ Platform agents — manage agent member lifecycle.
  // POST /api/v1/platform-agents      body {display_name, ...}
  // DELETE /api/v1/platform-agents/{member_id}
  'core.platform_agent_create': () => post(apiPath('/platform-agents'), {
    display_name: params.displayName || params.name,
    description:  params.description,
    metadata:     params.metadata,
  }),
  'core.platform_agent_delete': () => del(apiPath(`/platform-agents/${params.memberId}`)),

  // ✅ Onboarding session — the org's onboarding lifecycle record. A Lead
  // agent woken by the welcome DM reads this to locate the onboarding
  // structure: `core_issue_id` is the guided-conversation Issue to drive
  // (read it + its blueprint via tm.js), `project_id` the onboarding project.
  // 404 = this org never started onboarding.
  'core.onboarding_session': () => get(apiPath('/onboarding/session')),

  // ✅ Onboarding funnel event report. Caller must be the in-flight session's
  // lead agent. Self-reportable types: d1_activation (user replied ≥1 round
  // in the core-issue icebreaker), d3_im_connected (third-party IM linked).
  // Duplicates are absorbed server-side (idempotent 200, recorded=false) —
  // safe to fire without checking first. d7_first_delivery is server-observed
  // on issue accept and cannot be self-reported.
  'core.onboarding_event': () => post(apiPath('/onboarding/events'), {
    event_type:  params.eventType || params.event_type,
    occurred_at: params.occurredAt || params.occurred_at,
    meta:        params.meta,
  }),

  // ✅ Projects list. Defaults to active projects: resolving a project by name
  // (e.g. picking where to register an Issue) must not match ARCHIVED ones — a
  // human refers to a live project, and archived duplicates would make the match
  // ambiguous. Pass status:"archived" explicitly to list archived projects.
  // cws-core uses PageParams — `page` + `page_size`, NOT cursor/limit.
  'core.project_list': () => get(apiPath('/projects'), {
    status:    params.status ?? 'active',
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),

  // ✅ Organizations.
  'core.org_list':   () => get(apiPath('/organizations'), {
    order_by: params.orderBy,
  }),
  'core.org_get':    () => get(apiPath(`/organizations/${params.orgId}`)),
  // POST /api/v1/organizations  — create a new org and become its owner.
  // Server requires {name, slug, display_name}: display_name is the
  // caller's display name *within the new org* (the caller is auto-added
  // as org-owner member, and that membership row needs a display_name).
  // Response includes a fresh `access_token` already scoped to the new
  // org's `member_id`, so callers can immediately act in the new context
  // without a separate `org_switch`.
  'core.org_create': () => post(apiPath('/organizations'), {
    name: params.name,
    slug: params.slug,
    display_name: params.displayName || params.display_name,
  }),
  // POST /api/v1/organizations/{org_id}/switch  — swap principal's active org.
  // Server requires a body to be present (empty `{}` is fine; any
  // additional property is rejected as `unexpected property` 422 — the
  // request schema is closed). Returns a fresh `access_token` scoped to
  // the target org (used by callers that need to act under the new org
  // context immediately).
  'core.org_switch': () => post(apiPath(`/organizations/${params.orgId}/switch`), {}),

  // ✅ Roles
  'core.role_list': () => get(apiPath('/roles'), { scope: params.scope }),

  // ✅ Invitations
  // POST /api/v1/invitations — body {email?, display_name, role_id, message?}
  //   org_id is resolved server-side from the caller's JWT — do NOT send it.
  //   `display_name` (the invitee's org-level member name) is REQUIRED since
  //   cws-core #86 / MR !138 moved naming to create-time: the name is stored
  //   on the invitation and becomes members.display_name on accept. Server
  //   rejects a blank display_name with 400. Accept either camel or snake.
  'core.invitation_create': () => post(apiPath('/invitations'), {
    email:        params.email,
    display_name: params.displayName ?? params.display_name,
    role_id:      params.roleId,
    message:      params.message,
  }),
  // GET /api/v1/invitations — query {status?, page?, page_size?, order_by?}
  //   org_id is resolved server-side from the caller's JWT — do NOT send it.
  //   cws-core uses PageParams — `page` + `page_size`, NOT cursor/limit.
  'core.invitation_list': () => get(apiPath('/invitations'), {
    status:    params.status,
    page:      params.page,
    page_size: params.pageSize ?? params.limit,
    order_by:  params.orderBy,
  }),
  // POST /api/v1/invitations/{invitation_id}/accept
  // Body is just `{token}` since cws-core #86 / MR !138: the invitee display
  // name now comes from the invitation (set at create time), so accept no
  // longer takes display_name — sending it would be schema-invalid.
  'core.invitation_accept': () => post(apiPath(`/invitations/${params.invitationId}/accept`), {
    token: params.token,
  }),
  // DELETE /api/v1/invitations/{invitation_id}
  'core.invitation_revoke': () => del(apiPath(`/invitations/${params.invitationId}`)),

  // Local helper — build a browser-navigable frontend URL. Not an API call.
  // Uses server.frontend_base_path (default /cws) + bff_url origin.
  'core.frontend_url': () => {
    const p = params.path || params.p || '';
    if (!p) throw Object.assign(new Error('path is required'), { status: 400 });
    return { url: frontendUrl(p) };
  },
};

function printUsage() {
  console.log(`Core CLI — directory queries on cws-core (contract-v5)

Usage: node src/cli/core.js <command> '<json-params>'

Identity
  core.me                  {}
  core.self_rename         {name}    # change own display_name (cws-core /me + local config self.name)

Members (humans + agents in one directory)
  core.member_list         {kind?, status?, search?, page?, pageSize?, orderBy?}
                           # kind: human|agent|all (legacy alias: type)
                           # search legacy alias: q;  pageSize legacy alias: limit
  core.member_get          {memberId}
  core.project_members     {projectId}
  core.agent_profiles      {projectId?, memberIds?, include?, capabilities?}
                           # agent 能力画像聚合（派发前选候选）。scope 必填：projectId 和/或 memberIds(可数组)
                           # capabilities:true 或 include:["capabilities"] → 含 skills(自报)+tags(人工标注)；不带则轻量视图

Platform agents (lifecycle)
  core.platform_agent_create  {displayName, description?, metadata?}
  core.platform_agent_delete  {memberId}

Projects (directory view — workflow ops live in tm.js)
  core.project_list        {status?, page?, pageSize?, orderBy?}    # default status=active (pass status:"archived" for archived); pageSize legacy alias: limit

Onboarding (Lead agent — see SKILL.md "Onboarding Lead" section)
  core.onboarding_session  {}                                  # org 的 onboarding 会话；core_issue_id=核心对话 Issue，404=从未开始
  core.onboarding_event    {eventType, occurredAt?, meta?}     # 漏斗埋点上报（d1_activation|d3_im_connected）；重复上报幂等，放心发

Organizations
  core.org_list            {orderBy?}
  core.org_get             {orgId}
  core.org_create          {name, slug, displayName}  # creates org + auto-becomes org-owner; returns access_token scoped to new org
  core.org_switch          {orgId}      # principal's active org swap — returns new access_token scoped to target org

Roles
  core.role_list           {scope?}

Invitations
  core.invitation_create   {roleId, displayName, email?, message?}   # displayName REQUIRED (invitee's org member name); accepts display_name
  core.invitation_list     {status?, page?, pageSize?, orderBy?}    # pageSize legacy alias: limit
  core.invitation_accept   {invitationId, token}                    # no display_name — name comes from the invitation
  core.invitation_revoke   {invitationId}

Helpers
  core.frontend_url        {path}   # build browser-navigable URL: bff_url + frontend_base_path + path
                           # e.g. {path:"/knowledge?kb=xxx&node=yyy"} → https://cws-int.coco.xyz/cws/knowledge?...

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
