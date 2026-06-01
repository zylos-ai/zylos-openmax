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

import { get, post, del, apiPath } from '../lib/client.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

const COMMANDS = {
  // ✅ Current user / workspace identity
  'core.me': () => get(apiPath('/me')),

  // ✅ Members directory.
  'core.member_list': () => get(apiPath('/members'), {
    kind:      params.kind || params.type,
    status:    params.status,
    search:    params.search || params.q,
    cursor:    params.cursor,
    limit:     params.limit,
    order_by:  params.orderBy,
  }),
  'core.member_get': () => get(apiPath(`/members/${params.memberId}`)),

  // ✅ Project member list
  'core.project_members': () => get(apiPath(`/projects/${params.projectId}/members`)),

  // ✅ Platform agents — manage agent member lifecycle.
  // POST /api/v1/platform-agents      body {display_name, ...}
  // DELETE /api/v1/platform-agents/{member_id}
  'core.platform_agent_create': () => post(apiPath('/platform-agents'), {
    display_name: params.displayName || params.name,
    description:  params.description,
    metadata:     params.metadata,
  }),
  'core.platform_agent_delete': () => del(apiPath(`/platform-agents/${params.memberId}`)),

  // ✅ Projects list.
  'core.project_list': () => get(apiPath('/projects'), {
    status:    params.status,
    cursor:    params.cursor,
    limit:     params.limit,
    order_by:  params.orderBy,
  }),

  // ✅ Organizations.
  'core.org_list':   () => get(apiPath('/organizations'), {
    order_by: params.orderBy,
  }),
  'core.org_get':    () => get(apiPath(`/organizations/${params.orgId}`)),
  'core.org_create': () => post(apiPath('/organizations'), {
    name: params.name,
    slug: params.slug,
  }),
  // POST /api/v1/organizations/{org_id}/switch  — swap principal's active org
  'core.org_switch': () => post(apiPath(`/organizations/${params.orgId}/switch`)),

  // ✅ Roles
  'core.role_list': () => get(apiPath('/roles'), { scope: params.scope }),

  // ✅ Invitations
  // POST /api/v1/invitations — org_id (required), email?, role_id (required), message?
  'core.invitation_create': () => post(apiPath('/invitations'), {
    org_id:  params.orgId,
    email:   params.email,
    role_id: params.roleId,
    message: params.message,
  }),
  // GET /api/v1/invitations — org_id (required), status?, cursor?, limit?
  'core.invitation_list': () => get(apiPath('/invitations'), {
    org_id: params.orgId,
    status: params.status,
    cursor: params.cursor,
    limit:  params.limit,
  }),
  // POST /api/v1/invitations/{invitation_id}/accept — token? (in body)
  'core.invitation_accept': () => post(apiPath(`/invitations/${params.invitationId}/accept`), {
    token: params.token,
  }),
  // DELETE /api/v1/invitations/{invitation_id}
  'core.invitation_revoke': () => del(apiPath(`/invitations/${params.invitationId}`)),
};

function printUsage() {
  console.log(`Core CLI — directory queries on cws-core (contract-v5)

Usage: node src/cli/core.js <command> '<json-params>'

Identity
  core.me                  {}

Members (humans + agents in one directory)
  core.member_list         {kind?, status?, search?, cursor?, limit?, orderBy?}
                           # kind: human|agent|all (legacy alias: type)
                           # search legacy alias: q
  core.member_get          {memberId}
  core.project_members     {projectId}

Platform agents (lifecycle)
  core.platform_agent_create  {displayName, description?, metadata?}
  core.platform_agent_delete  {memberId}

Projects (directory view — workflow ops live in tm.js)
  core.project_list        {status?, cursor?, limit?, orderBy?}

Organizations
  core.org_list            {orderBy?}
  core.org_get             {orgId}
  core.org_create          {name, slug}
  core.org_switch          {orgId}      # principal's active org swap

Roles
  core.role_list           {scope?}

Invitations
  core.invitation_create   {orgId, roleId, email?, message?}
  core.invitation_list     {orgId, status?, cursor?, limit?}
  core.invitation_accept   {invitationId, token?}
  core.invitation_revoke   {invitationId}

Environment:
  COCO_API_URL       cws-core base URL (default: http://127.0.0.1:8080)
  COCO_AUTH_TOKEN    Bearer token
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
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
