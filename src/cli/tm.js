#!/usr/bin/env node

/**
 * Task Management CLI.
 *
 * Thin stateless wrapper over cws-core's task/project/issue surface
 * (paths + bodies per OpenAPI at
 *  https://zylos01.jinglever.com/cws-core/openapi.json).
 *
 * Usage:
 *   node src/cli/tm.js <command> '<json-params>'
 *   node src/cli/tm.js project.create '{"name":"Growth","memberIds":["..."]}'
 *
 * Status legend:
 *   ✅  available in cws-core today (path + body match OpenAPI)
 *   ⏳  not exposed by cws-core yet (call will 404); kept here so the
 *      surface is ready when core adds the endpoint. Path follows the
 *      most-likely future shape; body shape is best-effort guess.
 *
 * Most "writeful" TM surface (Issue write, Task write, Blueprint,
 * Attempt, Comment, Link, System, TaskBoard) is currently ⏳ — core
 * exposes the read side only.
 */

import { get, post, patch, put, del, apiPath } from '../lib/client.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

const COMMANDS = {
  // =========================================================================
  //  PROJECT  (✅ all in core)
  // =========================================================================

  'project.list': () => get(apiPath('/projects'), {
    status:     params.status,
    page_size:  params.pageSize  ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),

  // CreateProjectRequestBody: {name (required), description?, icon?,
  //                            lead_ids?:[uuid], member_ids?:[uuid]}
  'project.create': () => post(apiPath('/projects'), {
    name:        params.name,
    description: params.description,
    icon:        params.icon,
    lead_ids:    params.leadIds,
    member_ids:  params.memberIds,
  }),

  'project.get': () => get(apiPath(`/projects/${params.id}`)),

  // UpdateProjectRequestBody: {description?, icon?, lead_ids?, member_ids?}
  // (name is not in the update schema — projects are renamed via a separate
  //  endpoint if/when added)
  'project.update': () => patch(apiPath(`/projects/${params.id}`), {
    description: params.description,
    icon:        params.icon,
    lead_ids:    params.leadIds,
    member_ids:  params.memberIds,
  }),

  'project.archive':   () => post(apiPath(`/projects/${params.id}/archive`)),
  'project.restore':   () => post(apiPath(`/projects/${params.id}/restore`)),
  // backward-compat alias for older scripts
  'project.unarchive': () => post(apiPath(`/projects/${params.id}/restore`)),

  'project.members': () => get(apiPath(`/projects/${params.id}/members`)),

  // =========================================================================
  //  ISSUE  (✅ read-only in core: global list + nested read; writes ⏳)
  // =========================================================================

  // Global list (cross-project)
  'issue.list': () => get(apiPath('/issues'), {
    status:      params.status,
    assignee_id: params.assigneeId,
    page_size:   params.pageSize  ?? params.limit,
    page_token:  params.pageToken ?? params.cursor,
  }),

  // Per-project nested list
  'issue.list_in_project': () => get(apiPath(`/projects/${params.projectId}/issues`), {
    status:     params.status,
    archived:   params.archived,
    page_size:  params.pageSize  ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),

  // Nested single-issue read.
  'issue.get': () => get(apiPath(`/projects/${params.projectId}/issues/${params.id}`)),

  // ⏳ Write side — core has not exposed these yet. Paths follow the most-
  //   likely future shape (nested under /projects/{pid}/issues/*).
  'issue.create': () => post(apiPath(`/projects/${params.projectId}/issues`), {
    title:                  params.title,
    description:            params.description || '',
    mode:                   params.mode,
    lead_agent_id:          params.leadAgentId,
    origin_conversation_id: params.originConversationId,
    origin_message_id:      params.originMessageId,
  }),
  'issue.update': () => patch(
    apiPath(`/projects/${params.projectId}/issues/${params.id}`),
    { title: params.title, description: params.description },
  ),
  'issue.transition': () => post(
    apiPath(`/projects/${params.projectId}/issues/${params.id}/transition`),
    { status: params.status },
  ),
  'issue.move_project': () => post(
    apiPath(`/projects/${params.projectId}/issues/${params.id}/move`),
    { project_id: params.targetProjectId },
  ),
  'issue.set_acceptance': () => post(
    apiPath(`/projects/${params.projectId}/issues/${params.id}/acceptance`),
    { accepted: params.accepted, source: params.source },
  ),

  // =========================================================================
  //  TASK  (✅ list only in core; single read + writes ⏳)
  // =========================================================================

  'task.list': () => get(apiPath('/tasks'), {
    project_id:  params.projectId,
    issue_id:    params.issueId,
    status:      params.status,
    assignee_id: params.assigneeId,
    page_size:   params.pageSize  ?? params.limit,
    page_token:  params.pageToken ?? params.cursor,
  }),

  // ⏳ Single-task read — core not yet exposed.
  'task.get': () => get(apiPath(`/tasks/${params.id}`)),

  // ⏳ Task writes — pending core.
  'task.create': () => post(apiPath('/tasks'), {
    issue_id:          params.issueId,
    project_id:        params.projectId,
    title:             params.title,
    description:       params.description || '',
    assignee_id:       params.assigneeId,
    skill_tags:        params.skillTags,
    blueprint_step_id: params.blueprintStepId,
    depends_on:        params.dependsOn,
    context_page_ids:  params.contextPageIds,
    mode:              params.mode,
    priority:          params.priority,
    status:            params.status,
  }),
  'task.transition': () => post(apiPath(`/tasks/${params.id}/status`), {
    status: params.status,
  }),
  'task.status':   () => post(apiPath(`/tasks/${params.id}/status`),   { status: params.status }),
  'task.archive':  () => post(apiPath(`/tasks/${params.id}/archive`)),
  'task.subtask_create': () => post(apiPath(`/tasks/${params.id}/subtasks`), {
    title:       params.title,
    assignee_id: params.assigneeId,
    status:      params.status,
  }),
  'task.claim':    () => post(apiPath(`/tasks/${params.id}/claim`),    { assignee_id: params.assigneeId }),
  'task.reassign': () => post(apiPath(`/tasks/${params.id}/reassign`), { assignee_id: params.assigneeId }),

  // =========================================================================
  //  BLUEPRINT / ATTEMPT / COMMENT / LINK / SYSTEM / TASKBOARD  (all ⏳)
  //  Kept as best-effort path placeholders so the agent surface is ready.
  // =========================================================================

  'blueprint.create':              () => post(apiPath('/blueprints'), { issue_id: params.issueId }),
  'blueprint.get':                 () => get(apiPath(`/blueprints/${params.id}`)),
  'blueprint.list':                () => get(apiPath('/blueprints'), {
    issue_id:   params.issueId,
    page_size:  params.pageSize ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),
  'blueprint.add_step':            () => post(apiPath(`/blueprints/${params.blueprintId}/steps`), {
    description:        params.description,
    sort_order:         params.sortOrder,
    required_resources: params.requiredResources,
    depends_on:         params.dependsOn,
  }),
  'blueprint.update_step':         () => patch(apiPath(`/blueprint-steps/${params.id}`), {
    description:        params.description,
    sort_order:         params.sortOrder,
    required_resources: params.requiredResources,
  }),
  'blueprint.delete_step':         () => del(apiPath(`/blueprint-steps/${params.id}`)),
  'blueprint.set_step_depends_on': () => put(apiPath(`/blueprint-steps/${params.id}/depends-on`), {
    depends_on: params.dependsOn,
  }),
  'blueprint.set_estimated_budget':() => put(apiPath(`/blueprints/${params.id}/budget`), {
    estimated_budget: params.estimatedBudget,
  }),
  'blueprint.set_notes':           () => put(apiPath(`/blueprints/${params.id}/notes`), {
    notes: params.notes,
  }),
  'blueprint.render_markdown':     () => get(apiPath(`/blueprints/${params.id}/markdown`)),
  'blueprint.submit_for_approval': () => post(apiPath(`/blueprints/${params.id}/submit`)),
  'blueprint.create_amendment':    () => post(apiPath('/blueprints/amend'), { issue_id: params.issueId }),

  'attempt.create':     () => post(apiPath('/attempts'), {
    task_id:     params.taskId,
    assignee_id: params.assigneeId,
  }),
  'attempt.get':        () => get(apiPath(`/attempts/${params.id}`)),
  'attempt.list':       () => get(apiPath('/attempts'), {
    task_id:    params.taskId,
    page_size:  params.pageSize ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),
  'attempt.transition': () => post(apiPath(`/attempts/${params.id}/transition`), {
    status:         params.status,
    failure_reason: params.failureReason,
  }),

  'comment.append': () => post(apiPath('/comments'), {
    work_type:     params.workType,
    work_id:       params.workId,
    author_id:     params.authorId,
    body_markdown: params.bodyMarkdown,
    event_type:    params.eventType,
    event_payload: params.eventPayload,
  }),
  'comment.list':   () => get(apiPath('/comments'), {
    work_type:  params.workType,
    work_id:    params.workId,
    page_size:  params.pageSize ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),

  'link.create': () => post(apiPath('/links'), {
    work_type:         params.workType,
    work_id:           params.workId,
    conversation_id:   params.conversationId,
    link_role:         params.linkRole,
    anchor_message_id: params.anchorMessageId,
  }),
  'link.list':   () => get(apiPath('/links'), {
    work_type:       params.workType,
    work_id:         params.workId,
    conversation_id: params.conversationId,
  }),

  'taskboard.list': () => get(apiPath('/task-board'), {
    workspace_id: params.workspaceId,
    skill_tags:   params.skillTags,
    status:       params.status,
    page_size:    params.pageSize ?? params.limit,
    page_token:   params.pageToken ?? params.cursor,
  }),

  'system.initialize_workspace': () => post(apiPath('/system/initialize-workspace'), {
    workspace_id: params.workspaceId,
    team_id:      params.teamId,
  }),
  'system.approval_decision':    () => post(apiPath('/system/approval-decision'), {
    blueprint_id: params.blueprintId,
    approved:     params.approved,
  }),
  'system.auto_archive':         () => post(apiPath('/system/auto-archive'), {
    workspace_id: params.workspaceId,
  }),
};

function printUsage() {
  console.log(`TM CLI — Task Management against cws-core

Usage: node src/cli/tm.js <command> '<json-params>'

PROJECT
  ✅ project.list           {status?, pageSize?, pageToken?}
  ✅ project.create         {name, description?, icon?, leadIds?, memberIds?}
  ✅ project.get            {id}
  ✅ project.update         {id, description?, icon?, leadIds?, memberIds?}
  ✅ project.archive        {id}
  ✅ project.restore        {id}   # alias: project.unarchive
  ✅ project.members        {id}

ISSUE
  ✅ issue.list             {status?, assigneeId?, pageSize?, pageToken?}     # global
  ✅ issue.list_in_project  {projectId, status?, archived?, pageSize?, pageToken?}
  ✅ issue.get              {projectId, id}                                    # nested
  ⏳ issue.create           {projectId, title, description?, mode, leadAgentId, ...}
  ⏳ issue.update           {projectId, id, title?, description?}
  ⏳ issue.transition       {projectId, id, status}
  ⏳ issue.move_project     {projectId, id, targetProjectId}
  ⏳ issue.set_acceptance   {projectId, id, accepted, source}

TASK
  ✅ task.list              {projectId?, issueId?, status?, assigneeId?, pageSize?, pageToken?}
  ⏳ task.get               {id}
  ⏳ task.create            {issueId?, projectId?, title, description?, assigneeId?, ...}
  ⏳ task.transition        {id, status}    # alias: task.status
  ⏳ task.archive           {id}
  ⏳ task.subtask_create    {id, title, assigneeId?, status?}
  ⏳ task.claim             {id, assigneeId}
  ⏳ task.reassign          {id, assigneeId}

BLUEPRINT / ATTEMPT / COMMENT / LINK / SYSTEM / TASKBOARD  — all ⏳
  blueprint.create / get / list / add_step / update_step / delete_step
  blueprint.set_step_depends_on / set_estimated_budget / set_notes
  blueprint.render_markdown / submit_for_approval / create_amendment
  attempt.create / get / list / transition
  comment.append / comment.list
  link.create / link.list
  taskboard.list
  system.initialize_workspace / approval_decision / auto_archive

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
