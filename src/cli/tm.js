#!/usr/bin/env node

/**
 * Task Management CLI.
 *
 * Thin stateless wrapper over cws-core's task/project/issue surface, aligned
 * to the `contract-v2` tag of cws-core (which proxies all TM RPCs to
 * cws-work). See `docs/dependency-coverage/cws-tm.md` for the per-endpoint
 * mapping and Findings table.
 *
 * Usage:
 *   node src/cli/tm.js <command> '<json-params>'
 *   node src/cli/tm.js project.create '{"name":"Growth","slug":"growth","leadMemberId":"..."}'
 *
 * Status legend:
 *   ✅  path + method match cws-core@contract-v2; body/query also aligned
 *   ⏳  exists in cws-work HTTP but cws-core@contract-v2 has not added the
 *      forwarding yet — call will 404 today. Path follows the cws-work shape
 *      so it'll Just Work once cws-core ships the forward. Tracked in F3.
 *
 * Pagination convention (contract-v2 PageParams, offset-based):
 *   - User-facing camelCase: page, pageSize, orderBy
 *   - Wire snake_case:       page, page_size, order_by
 *   - (The old page_token / cursor / limit names are gone; cws-core uses
 *     offset paging via {page, page_size} now.)
 */

import { get, post, patch, put, del, apiPath } from '../lib/client.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Build the standard PageParams query block from user-supplied camelCase.
function pageParams(p) {
  return {
    page:      p.page,
    page_size: p.pageSize,
    order_by:  p.orderBy,
  };
}

const COMMANDS = {
  // =========================================================================
  //  PROJECT  (✅ all 7 in contract-v2)
  // =========================================================================

  'project.list': () => get(apiPath('/projects'), {
    status: params.status,       // enum: active|archived
    ...pageParams(params),
  }),

  // contract-v2 create-project body: { name*, description?, slug*,
  // is_default, lead_member_id* }
  'project.create': () => post(apiPath('/projects'), {
    name:           params.name,
    description:    params.description,
    slug:           params.slug,
    is_default:     params.isDefault,
    lead_member_id: params.leadMemberId,
  }),

  'project.get': () => get(apiPath(`/projects/${params.id}`)),

  // contract-v2 update-project body: { name?, description?, lead_member_id? }
  'project.update': () => patch(apiPath(`/projects/${params.id}`), {
    name:           params.name,
    description:    params.description,
    lead_member_id: params.leadMemberId,
  }),

  'project.archive':   () => post(apiPath(`/projects/${params.id}/archive`)),
  'project.restore':   () => post(apiPath(`/projects/${params.id}/restore`)),
  // backward-compat alias for older scripts.
  'project.unarchive': () => post(apiPath(`/projects/${params.id}/restore`)),

  'project.members': () => get(
    apiPath(`/projects/${params.id}/members`),
    pageParams(params),
  ),

  // =========================================================================
  //  ISSUE  (✅ all in contract-v2 — note `issue.get/update/transition/move`
  //  use the FLAT path /issues/{id}, not /projects/{pid}/issues/{id})
  // =========================================================================

  'issue.list_in_project': () => get(apiPath(`/projects/${params.projectId}/issues`), {
    status:   params.status,     // enum (draft / pending_approval / ... / archived)
    priority: params.priority,   // enum: low|medium|high
    ...pageParams(params),
  }),

  // Flat path, no project prefix.
  'issue.get': () => get(apiPath(`/issues/${params.id}`)),

  // contract-v2 create-issue body: requires title*, mode*, priority*,
  // lead_agent_id*; optional context_page_ids, input_artifact_ids,
  // origin_conversation_id, origin_message_id, due_date.
  'issue.create': () => post(apiPath(`/projects/${params.projectId}/issues`), {
    title:                  params.title,
    description:            params.description || '',
    mode:                   params.mode,                  // light|heavy (required)
    priority:               params.priority,              // low|medium|high (required)
    due_date:               params.dueDate,
    lead_agent_id:          params.leadAgentId,
    context_page_ids:       params.contextPageIds,
    input_artifact_ids:     params.inputArtifactIds,
    origin_conversation_id: params.originConversationId,
    origin_message_id:      params.originMessageId,
  }),

  // Flat path; body: { title?, description?, priority?, due_date? }.
  'issue.update': () => patch(
    apiPath(`/issues/${params.id}`),
    {
      title:       params.title,
      description: params.description,
      priority:    params.priority,
      due_date:    params.dueDate,
    },
  ),

  // Flat path; body field is `target_status` (not `status`).
  'issue.transition': () => post(
    apiPath(`/issues/${params.id}/transition`),
    {
      target_status:    params.status ?? params.targetStatus,
      rejection_reason: params.rejectionReason,
    },
  ),

  // Flat path; body field is `new_project_id` (not `project_id`).
  'issue.move_project': () => post(
    apiPath(`/issues/${params.id}/move`),
    { new_project_id: params.targetProjectId ?? params.newProjectId },
  ),

  // =========================================================================
  //  TASK  (✅ list/get/transition/reassign in contract-v2; create uses the
  //  doubly-nested path /projects/{pid}/issues/{iid}/tasks)
  // =========================================================================

  'task.list': () => get(apiPath('/tasks'), {
    project_id:   params.projectId,
    issue_id:     params.issueId,
    status:       params.status,           // pending|running|done|failed|cancelled
    claimable:    params.claimable,        // bool
    agent_skills: params.agentSkills,      // string[] (contract-v2 query repeats)
    ...pageParams(params),
  }),

  'task.get': () => get(apiPath(`/tasks/${params.id}`)),

  // contract-v2 create-task path: /projects/{pid}/issues/{iid}/tasks
  // body: { title*, description?, assignee_id?, skill_tags?,
  //         blueprint_step_id?, depends_on?, context_page_ids? }
  // (mode / priority / status are NOT accepted — those live on issue.)
  'task.create': () => post(
    apiPath(`/projects/${params.projectId}/issues/${params.issueId}/tasks`),
    {
      title:             params.title,
      description:       params.description || '',
      assignee_id:       params.assigneeId,
      skill_tags:        params.skillTags,
      blueprint_step_id: params.blueprintStepId,
      depends_on:        params.dependsOn,
      context_page_ids:  params.contextPageIds,
    },
  ),

  // Path is /transition (not /status); body field is target_status.
  'task.transition': () => post(
    apiPath(`/tasks/${params.id}/transition`),
    { target_status: params.status ?? params.targetStatus },
  ),
  // Backward-compat alias for older scripts.
  'task.status': () => post(
    apiPath(`/tasks/${params.id}/transition`),
    { target_status: params.status ?? params.targetStatus },
  ),

  // Body field is new_assignee_id (not assignee_id).
  'task.reassign': () => post(
    apiPath(`/tasks/${params.id}/reassign`),
    { new_assignee_id: params.assigneeId ?? params.newAssigneeId },
  ),

  // =========================================================================
  //  BLUEPRINT  (contract-v2 only has create / get / list / set-steps —
  //  blueprint.create and .list are issue-nested; blueprint.set_steps is
  //  PUT-and-replace, not POST-and-append.)
  // =========================================================================

  // contract-v2 create-blueprint:
  //   POST /api/v1/issues/{issue_id}/blueprints
  //   body: { author_agent_id*, steps[]*, estimated_budget?, notes? }
  // where each step is { temp_id, description, required_resources?,
  //                     depends_on_temp_ids? }.
  // tm.js historically just took { issue_id }; we now require author/steps too.
  'blueprint.create': () => post(
    apiPath(`/issues/${params.issueId}/blueprints`),
    {
      author_agent_id:  params.authorAgentId,
      steps:            params.steps,
      estimated_budget: params.estimatedBudget,
      notes:            params.notes,
    },
  ),

  'blueprint.get': () => get(
    apiPath(`/blueprints/${params.id}`),
    { include_steps: params.includeSteps },
  ),

  // contract-v2 path: GET /api/v1/issues/{issue_id}/blueprints (path-scoped,
  // not query-scoped).
  'blueprint.list': () => get(
    apiPath(`/issues/${params.issueId}/blueprints`),
    pageParams(params),
  ),

  // contract-v2 set-blueprint-steps: PUT (replace all). Replaces the legacy
  // tm.js `blueprint.add_step` which assumed POST-and-append semantics —
  // that surface does not exist in contract-v2.
  'blueprint.set_steps': () => put(
    apiPath(`/blueprints/${params.blueprintId ?? params.id}/steps`),
    { steps: params.steps },
  ),

  // -------------------------------------------------------------------------
  //  BLUEPRINT — cws-work HTTP has these, but cws-core@contract-v2 has not
  //  added forwarding yet. Calls will 404 today. Paths follow cws-work's
  //  /api/... surface (cws-core proxies it under /api/v1/... once it
  //  ships).  Tracked as F3 in docs/dependency-coverage/cws-tm.md.
  // -------------------------------------------------------------------------

  // ⏳ PATCH /blueprint-steps/{id}
  'blueprint.update_step': () => patch(apiPath(`/blueprint-steps/${params.id}`), {
    description:        params.description,
    sort_order:         params.sortOrder,
    required_resources: params.requiredResources,
  }),
  // ⏳ DELETE /blueprint-steps/{id}
  'blueprint.delete_step': () => del(apiPath(`/blueprint-steps/${params.id}`)),
  // ⏳ PUT /blueprint-steps/{id}/depends-on
  'blueprint.set_step_depends_on': () => put(apiPath(`/blueprint-steps/${params.id}/depends-on`), {
    depends_on: params.dependsOn,
  }),
  // ⏳ PUT /blueprints/{id}/budget
  'blueprint.set_estimated_budget': () => put(apiPath(`/blueprints/${params.id}/budget`), {
    estimated_budget: params.estimatedBudget,
  }),
  // ⏳ PUT /blueprints/{id}/notes
  'blueprint.set_notes': () => put(apiPath(`/blueprints/${params.id}/notes`), {
    notes: params.notes,
  }),
  // ⏳ GET /blueprints/{id}/markdown
  'blueprint.render_markdown': () => get(apiPath(`/blueprints/${params.id}/markdown`)),
  // ⏳ POST /blueprints/{id}/submit
  'blueprint.submit_for_approval': () => post(apiPath(`/blueprints/${params.id}/submit`)),
  // ⏳ POST /blueprints/amend
  'blueprint.create_amendment': () => post(apiPath('/blueprints/amend'), { issue_id: params.issueId }),

  // =========================================================================
  //  TASKBOARD  (⏳ — cws-work has /api/task-board; cws-core not forwarded)
  // =========================================================================

  'taskboard.list': () => get(apiPath('/task-board'), {
    workspace_id: params.workspaceId,
    skill_tags:   params.skillTags,
    status:       params.status,
    ...pageParams(params),
  }),

};

function printUsage() {
  console.log(`TM CLI — Task Management against cws-core@contract-v2

Usage: node src/cli/tm.js <command> '<json-params>'

PROJECT  (all ✅ on contract-v2)
  project.list           {status?, page?, pageSize?, orderBy?}
  project.create         {name, slug, leadMemberId, description?, isDefault?}
  project.get            {id}
  project.update         {id, name?, description?, leadMemberId?}
  project.archive        {id}
  project.restore        {id}                                                    # alias: project.unarchive
  project.members        {id, page?, pageSize?, orderBy?}

ISSUE  (all ✅ on contract-v2 — write paths use /issues/{id}, NOT /projects/{pid}/issues/{id})
  issue.list_in_project  {projectId, status?, priority?, page?, pageSize?, orderBy?}
  issue.get              {id}
  issue.create           {projectId, title, mode, priority, leadAgentId,
                          description?, dueDate?, contextPageIds?,
                          inputArtifactIds?, originConversationId?, originMessageId?}
  issue.update           {id, title?, description?, priority?, dueDate?}
  issue.transition       {id, targetStatus (or 'status'), rejectionReason?}
  issue.move_project     {id, newProjectId (or 'targetProjectId')}

TASK  (✅ list/get/transition/reassign on contract-v2; create uses doubly-nested path)
  task.list              {projectId?, issueId?, status?, claimable?, agentSkills?,
                          page?, pageSize?, orderBy?}
  task.get               {id}
  task.create            {projectId, issueId, title, description?, assigneeId?,
                          skillTags?, blueprintStepId?, dependsOn?, contextPageIds?}
  task.transition        {id, targetStatus}                                      # alias: task.status
  task.reassign          {id, newAssigneeId (or 'assigneeId')}

BLUEPRINT  (✅ create / get / list / set_steps on contract-v2;
            ⏳ rest exist in cws-work HTTP but cws-core has not added forwarding yet)
  blueprint.create                  {issueId, authorAgentId, steps[], estimatedBudget?, notes?}
  blueprint.get                     {id, includeSteps?}
  blueprint.list                    {issueId, page?, pageSize?, orderBy?}
  blueprint.set_steps               {blueprintId (or 'id'), steps[]}             # replaces ALL steps
  blueprint.update_step             {id, description?, sortOrder?, requiredResources?}     ⏳
  blueprint.delete_step             {id}                                                    ⏳
  blueprint.set_step_depends_on     {id, dependsOn}                                         ⏳
  blueprint.set_estimated_budget    {id, estimatedBudget}                                   ⏳
  blueprint.set_notes               {id, notes}                                             ⏳
  blueprint.render_markdown         {id}                                                    ⏳
  blueprint.submit_for_approval     {id}                                                    ⏳
  blueprint.create_amendment        {issueId}                                               ⏳

TASKBOARD
  taskboard.list                    {workspaceId?, skillTags?, status?, page?, pageSize?, orderBy?}  ⏳

Environment:
  COCO_API_URL     cws-core base URL (default: http://127.0.0.1:8080)
  COCO_AUTH_TOKEN  Bearer token
  COCO_API_PREFIX  Path prefix override (default: /api/v1)
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
