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

import { get, apiPath } from '../lib/client.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

const COMMANDS = {
  // ✅ Current user / workspace identity
  'core.me': () => get(apiPath('/me')),

  // ✅ Members directory.
  // OpenAPI params: org_id, kind ("human"|"agent"|"all"), status, search, cursor, limit
  'core.member_list': () => get(apiPath('/members'), {
    org_id: params.orgId,
    kind:   params.kind || params.type,   // accept legacy `type` alias
    status: params.status,
    search: params.search || params.q,    // accept legacy `q` alias
    cursor: params.cursor,
    limit:  params.limit,
  }),
  // ✅ Single member.
  'core.member_get': () => get(apiPath(`/members/${params.memberId}`)),

  // ✅ Project member list — convenient for "who's on this project".
  'core.project_members': () => get(apiPath(`/projects/${params.projectId}/members`)),

  // ⏳ Teams collection — cws-core OpenAPI has no /teams endpoints yet.
  //    Closest workaround today: filter members by team_id is also NOT in
  //    /members params, so we cannot fake it. Listed for forward-compat.
  'core.team_list':    () => get(apiPath('/teams'), {
    cursor: params.cursor,
    limit:  params.limit,
  }),
  'core.team_get':     () => get(apiPath(`/teams/${params.teamId}`), {
    include: params.include,
  }),
  'core.team_members': () => get(apiPath(`/teams/${params.teamId}/members`)),

  // ✅ Agents list. OpenAPI params: page_size, page_token only.
  'core.agent_list': () => get(apiPath('/agents'), {
    page_size:  params.pageSize  ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),

  // ⏳ core MISSING: single-agent detail / skills / metrics.
  'core.agent_get':     () => get(apiPath(`/agents/${params.agentId}`)),
  'core.agent_skills':  () => get(apiPath(`/agents/${params.agentId}/skills`)),
  'core.agent_metrics': () => get(apiPath(`/agents/${params.agentId}/metrics`)),

  // ✅ Projects list. OpenAPI params: status, page_size, page_token.
  'core.project_list': () => get(apiPath('/projects'), {
    status:     params.status,
    page_size:  params.pageSize  ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),

  // ✅ Organizations.
  'core.org_list': () => get(apiPath('/organizations')),
  'core.org_get':  () => get(apiPath(`/organizations/${params.orgId}`)),
};

function printUsage() {
  console.log(`Core CLI — directory queries on cws-core

Usage: node src/cli/core.js <command> '<json-params>'

Identity
  ✅ core.me              {}

Members (humans + agents in one directory)
  ✅ core.member_list     {orgId?, kind?, status?, search?, cursor?, limit?}
                          # kind: human|agent|all (legacy alias: type)
                          # search legacy alias: q
  ✅ core.member_get      {memberId}
  ✅ core.project_members {projectId}

Teams
  ⏳ core.team_list       {cursor?, limit?}                # pending core
  ⏳ core.team_get        {teamId, include?}               # pending core
  ⏳ core.team_members    {teamId}                         # pending core

Agents
  ✅ core.agent_list      {pageSize?, pageToken?}
  ⏳ core.agent_get       {agentId}                        # pending core
  ⏳ core.agent_skills    {agentId}                        # pending core
  ⏳ core.agent_metrics   {agentId}                        # pending core

Projects (directory view — workflow ops live in tm.js)
  ✅ core.project_list    {status?, pageSize?, pageToken?}

Organizations
  ✅ core.org_list        {}
  ✅ core.org_get         {orgId}

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
