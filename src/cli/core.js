#!/usr/bin/env node

/**
 * Core CLI — organization / team / member / agent / project directory queries.
 *
 * Wraps the read-mostly endpoints on the cws-core Gateway that Lead agents
 * use during context assembly (figure out who's on the team, what skills
 * are available, which projects exist).
 *
 * Usage:
 *   node src/cli/core.js <command> '<json-params>'
 *   node src/cli/core.js core.me            '{}'
 *   node src/cli/core.js core.member_list   '{"type":"agent","limit":50}'
 *   node src/cli/core.js core.agent_skills  '{"agentId":"agt-1"}'
 */

import { get, apiPath } from '../lib/client.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

const COMMANDS = {
  // Current user / workspace identity
  'core.me': () => get(apiPath('/me')),

  // Members directory (humans + agents unified)
  'core.member_list': () => get(apiPath('/members'), {
    type:    params.type,        // 'all' | 'human' | 'agent'
    q:       params.q,
    team_id: params.teamId,
    status:  params.status,
    cursor:  params.cursor,
    limit:   params.limit,
  }),
  'core.member_get':  () => get(apiPath(`/members/${params.memberId}`)),

  // Teams
  'core.team_list':    () => get(apiPath('/teams'), {
    cursor: params.cursor,
    limit:  params.limit,
  }),
  'core.team_get':     () => get(apiPath(`/teams/${params.teamId}`), {
    include: params.include,     // e.g. "members,activity"
  }),
  // Convenience wrapper — equivalent to `member_list {teamId}` but with a
  // name that matches how Lead agents think about it.
  'core.team_members': () => get(apiPath('/members'), {
    team_id: params.teamId,
    type:    params.type,
    cursor:  params.cursor,
    limit:   params.limit,
  }),

  // Agents (digital employees)
  'core.agent_list':    () => get(apiPath('/agents'), {
    cursor: params.cursor,
    limit:  params.limit,
  }),
  'core.agent_get':     () => get(apiPath(`/agents/${params.agentId}`)),
  'core.agent_skills':  () => get(apiPath(`/agents/${params.agentId}/skills`)),
  'core.agent_metrics': () => get(apiPath(`/agents/${params.agentId}/metrics`)),

  // Projects (Core view = metadata + membership; TM view = task workflow)
  'core.project_list': () => get(apiPath('/projects'), {
    tab:    params.tab,          // 'all' | 'mine' | 'archived' | ...
    view:   params.view,         // 'grid' | 'list'
    mode:   params.mode,
    status: params.status,
    cursor: params.cursor,
    limit:  params.limit,
  }),
};

function printUsage() {
  console.log(`Core CLI — organization / member / agent / project directory

Usage: node src/cli/core.js <command> '<json-params>'

Identity
  core.me              {}

Members (humans + agents in one directory)
  core.member_list     {type?, q?, teamId?, status?, cursor?, limit?}    # type: all|human|agent
  core.member_get      {memberId}

Teams
  core.team_list       {cursor?, limit?}
  core.team_get        {teamId, include?}                                 # include: "members,activity,..."
  core.team_members    {teamId, type?, cursor?, limit?}                   # alias for member_list {teamId}

Agents
  core.agent_list      {cursor?, limit?}
  core.agent_get       {agentId}
  core.agent_skills    {agentId}
  core.agent_metrics   {agentId}

Projects (directory view — workflow ops live in tm.js)
  core.project_list    {tab?, view?, mode?, status?, cursor?, limit?}

Environment:
  COCO_API_URL       Gateway base URL (default: http://127.0.0.1:8080).
  COCO_AUTH_TOKEN    Bearer token for authenticated endpoints.
  COCO_API_PREFIX    Path prefix override (default: /api/gateway/v1).

Not yet exposed by the gateway:
  core.skill_list    # global skill registry — skills currently only enumerable
                     #   per-agent via core.agent_skills
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
