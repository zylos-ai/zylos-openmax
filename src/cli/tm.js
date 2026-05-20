#!/usr/bin/env node

/**
 * Task Management CLI.
 *
 * Thin stateless wrapper around the COCO TM HTTP surface. Each command maps
 * to a single HTTP call; no business logic lives here.
 *
 * Path routing (mixed during the gateway buildout):
 *
 *   - **Gateway-routed** (use `apiPath()`, default prefix `/api/gateway/v1`):
 *     Project basic CRUD + archive/restore, top-level Task CRUD + status/
 *     archive/subtasks. These match the cws-fe Gateway draft exactly.
 *
 *   - **cws-work direct** (raw `/api/*` paths, no prefix): Issue (flat shape
 *     doesn't fit gateway's nested `/projects/{pid}/issues/*`), TaskBoard,
 *     Attempt, Blueprint, Comment, Link, System. These currently only
 *     work against a cws-work standalone backend; the gateway will catch
 *     up incrementally and these can migrate later.
 *
 * Run against cws-work standalone in dev with:
 *   COCO_API_URL=http://127.0.0.1:18080  COCO_API_PREFIX=/api
 *
 * Run against the gateway (production-style):
 *   COCO_API_URL=http://127.0.0.1:8080   # default
 *   # COCO_API_PREFIX defaults to /api/gateway/v1
 *
 * Origin: this file replaces the standalone `cws-work/zylos-tm/src/cli.js`
 * per DESIGN.md §1.2.
 */

import { get, post, patch, put, del, apiPath } from '../lib/client.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

const COMMANDS = {
  // Project — gateway-routed
  'project.create':    () => post(apiPath('/projects'), {
    workspace_id: params.workspaceId,
    team_id:      params.teamId,
    name:         params.name,
    slug:         params.slug,
    is_inbox:     params.isInbox,
  }),
  'project.get':       () => get(apiPath(`/projects/${params.id}`)),
  'project.list':      () => get(apiPath('/projects'), {
    workspace_id: params.workspaceId,
    tab:          params.tab,
    status:       params.status,
    cursor:       params.cursor,
    limit:        params.limit,
    offset:       params.offset,   // cws-work direct fallback
  }),
  'project.archive':   () => post(apiPath(`/projects/${params.id}/archive`)),
  // Gateway names this `restore`; we keep `unarchive` as the command name
  // for backward compatibility with existing scripts.
  'project.unarchive': () => post(apiPath(`/projects/${params.id}/restore`)),
  'project.restore':   () => post(apiPath(`/projects/${params.id}/restore`)),

  // Issue — cws-work direct (gateway uses nested /projects/{pid}/issues/*,
  // shape-incompatible with this flat surface; gateway migration TBD)
  'issue.create': () => post('/api/issues', {
    projectId:            params.projectId,
    title:                params.title,
    description:          params.description || '',
    mode:                 params.mode,
    leadAgentId:          params.leadAgentId,
    originConversationId: params.originConversationId,
    originMessageId:      params.originMessageId,
  }),
  'issue.get':            () => get(`/api/issues/${params.id}`),
  'issue.list':           () => get('/api/issues', {
    project_id: params.projectId,
    status:     params.status,
    limit:      params.limit,
    offset:     params.offset,
  }),
  'issue.update':         () => patch(`/api/issues/${params.id}`, {
    title:       params.title,
    description: params.description,
  }),
  'issue.transition':     () => post(`/api/issues/${params.id}/transition`, { status: params.status }),
  'issue.move_project':   () => post(`/api/issues/${params.id}/move`,       { projectId: params.projectId }),
  'issue.set_acceptance': () => post(`/api/issues/${params.id}/acceptance`, {
    accepted: params.accepted,
    source:   params.source,
  }),

  // Task — gateway-routed for core CRUD; claim/reassign stay cws-work direct
  'task.create': () => post(apiPath('/tasks'), {
    issueId:         params.issueId,
    title:           params.title,
    description:     params.description || '',
    project_id:      params.projectId,
    assigneeId:      params.assigneeId,
    assignee_id:     params.assigneeId,         // gateway field name
    skillTags:       params.skillTags,
    blueprintStepId: params.blueprintStepId,
    dependsOn:       params.dependsOn,
    contextPageIds:  params.contextPageIds,
    mode:            params.mode,
    priority:        params.priority,
    status:          params.status,
  }),
  'task.get':        () => get(apiPath(`/tasks/${params.id}`)),
  'task.list':       () => get(apiPath('/tasks'), {
    issue_id:    params.issueId,
    project_id:  params.projectId,
    assignee_id: params.assigneeId,
    status:      params.status,
    mode:        params.mode,
    cursor:      params.cursor,
    limit:       params.limit,
    offset:      params.offset,                  // cws-work fallback
  }),
  // Gateway exposes /tasks/{id}/status — same body shape. `task.transition`
  // is kept as the command name; the path is the gateway one.
  'task.transition': () => post(apiPath(`/tasks/${params.id}/status`), { status: params.status }),
  'task.status':     () => post(apiPath(`/tasks/${params.id}/status`), { status: params.status }),
  'task.archive':    () => post(apiPath(`/tasks/${params.id}/archive`)),
  'task.subtask_create': () => post(apiPath(`/tasks/${params.id}/subtasks`), {
    title:       params.title,
    assignee_id: params.assigneeId,
    status:      params.status,
  }),
  // Not on the gateway draft — kept on cws-work direct paths.
  'task.claim':      () => post(`/api/tasks/${params.id}/claim`,    { assigneeId: params.assigneeId }),
  'task.reassign':   () => post(`/api/tasks/${params.id}/reassign`, { assigneeId: params.assigneeId }),

  // TaskBoard — cws-work direct
  'taskboard.list': () => get('/api/task-board', {
    workspace_id: params.workspaceId,
    skill_tags:   params.skillTags,
    status:       params.status,
    limit:        params.limit,
    offset:       params.offset,
  }),

  // Attempt
  'attempt.create':     () => post('/api/attempts', {
    taskId:     params.taskId,
    assigneeId: params.assigneeId,
  }),
  'attempt.get':        () => get(`/api/attempts/${params.id}`),
  'attempt.list':       () => get('/api/attempts', {
    task_id: params.taskId,
    limit:   params.limit,
    offset:  params.offset,
  }),
  'attempt.transition': () => post(`/api/attempts/${params.id}/transition`, {
    status:        params.status,
    failureReason: params.failureReason,
  }),

  // Blueprint
  'blueprint.create':  () => post('/api/blueprints', { issueId: params.issueId }),
  'blueprint.get':     () => get(`/api/blueprints/${params.id}`),
  'blueprint.list':    () => get('/api/blueprints', {
    issue_id: params.issueId,
    limit:    params.limit,
    offset:   params.offset,
  }),
  'blueprint.add_step': () => post(`/api/blueprints/${params.blueprintId}/steps`, {
    description:       params.description,
    sortOrder:         params.sortOrder,
    requiredResources: params.requiredResources,
    dependsOn:         params.dependsOn,
  }),
  'blueprint.update_step':         () => patch(`/api/blueprint-steps/${params.id}`, {
    description:       params.description,
    sortOrder:         params.sortOrder,
    requiredResources: params.requiredResources,
  }),
  'blueprint.delete_step':         () => del(`/api/blueprint-steps/${params.id}`),
  'blueprint.set_step_depends_on': () => put(`/api/blueprint-steps/${params.id}/depends-on`, {
    dependsOn: params.dependsOn,
  }),
  'blueprint.set_estimated_budget':() => put(`/api/blueprints/${params.id}/budget`, {
    estimatedBudget: params.estimatedBudget,
  }),
  'blueprint.set_notes':           () => put(`/api/blueprints/${params.id}/notes`, {
    notes: params.notes,
  }),
  'blueprint.render_markdown':     () => get(`/api/blueprints/${params.id}/markdown`),
  'blueprint.submit_for_approval': () => post(`/api/blueprints/${params.id}/submit`),
  'blueprint.create_amendment':    () => post('/api/blueprints/amend', { issueId: params.issueId }),

  // Comment
  'comment.append': () => post('/api/comments', {
    workType:     params.workType,
    workId:       params.workId,
    authorId:     params.authorId,
    bodyMarkdown: params.bodyMarkdown,
    eventType:    params.eventType,
    eventPayload: params.eventPayload,
  }),
  'comment.list':   () => get('/api/comments', {
    work_type: params.workType,
    work_id:   params.workId,
    limit:     params.limit,
    offset:    params.offset,
  }),

  // System
  'system.initialize_workspace': () => post('/api/system/initialize-workspace', {
    workspaceId: params.workspaceId,
    teamId:      params.teamId,
  }),
  'system.approval_decision':    () => post('/api/system/approval-decision', {
    blueprintId: params.blueprintId,
    approved:    params.approved,
  }),
  'system.auto_archive':         () => post('/api/system/auto-archive', {
    workspaceId: params.workspaceId,
  }),

  // WorkConversationLink
  'link.create': () => post('/api/links', {
    workType:        params.workType,
    workId:          params.workId,
    conversationId:  params.conversationId,
    linkRole:        params.linkRole,
    anchorMessageId: params.anchorMessageId,
  }),
  'link.list':   () => get('/api/links', {
    work_type:       params.workType,
    work_id:         params.workId,
    conversation_id: params.conversationId,
  }),
};

function printUsage() {
  console.log(`TM CLI — Task Management for COCO agents

Usage: node src/cli/tm.js <command> '<json-params>'

Project (gateway-routed)
  project.create        {workspaceId, teamId, name, slug, isInbox?}
  project.get           {id}
  project.list          {workspaceId, tab?, status?, cursor?, limit?, offset?}
  project.archive       {id}
  project.unarchive     {id}   # alias for project.restore
  project.restore       {id}

Issue
  issue.create          {projectId, title, description?, mode, leadAgentId, originConversationId?, originMessageId?}
  issue.get             {id}
  issue.list            {projectId, status?, limit?, offset?}
  issue.update          {id, title?, description?}
  issue.transition      {id, status}
  issue.move_project    {id, projectId}
  issue.set_acceptance  {id, accepted, source}

Task (gateway-routed except claim/reassign)
  task.create           {issueId?, projectId?, title, description?, assigneeId?, skillTags?, blueprintStepId?, dependsOn?, contextPageIds?, mode?, priority?, status?}
  task.get              {id}
  task.list             {issueId?, projectId?, assigneeId?, status?, mode?, cursor?, limit?, offset?}
  task.transition       {id, status}     # POSTs to /tasks/{id}/status
  task.status           {id, status}     # alias
  task.archive          {id}
  task.subtask_create   {id, title, assigneeId?, status?}
  task.claim            {id, assigneeId}   # cws-work direct (no gateway yet)
  task.reassign         {id, assigneeId}   # cws-work direct (no gateway yet)

TaskBoard
  taskboard.list        {workspaceId, skillTags?, status?, limit?, offset?}

Attempt
  attempt.create        {taskId, assigneeId}
  attempt.get           {id}
  attempt.list          {taskId, limit?, offset?}
  attempt.transition    {id, status, failureReason?}

Blueprint
  blueprint.create                 {issueId}
  blueprint.get                    {id}
  blueprint.list                   {issueId, limit?, offset?}
  blueprint.add_step               {blueprintId, description, sortOrder?, requiredResources?, dependsOn?}
  blueprint.update_step            {id, description?, sortOrder?, requiredResources?}
  blueprint.delete_step            {id}
  blueprint.set_step_depends_on    {id, dependsOn}
  blueprint.set_estimated_budget   {id, estimatedBudget}
  blueprint.set_notes              {id, notes}
  blueprint.render_markdown        {id}
  blueprint.submit_for_approval    {id}
  blueprint.create_amendment       {issueId}

Comment
  comment.append        {workType, workId, authorId, bodyMarkdown, eventType?, eventPayload?}
  comment.list          {workType, workId, limit?, offset?}

Link (WorkConversationLink)
  link.create           {workType, workId, conversationId, linkRole, anchorMessageId?}
  link.list             {workType?, workId?, conversationId?}

System
  system.initialize_workspace  {workspaceId, teamId}
  system.approval_decision     {blueprintId, approved}
  system.auto_archive          {workspaceId}

Environment:
  COCO_API_URL     COCO backend base URL (default: http://127.0.0.1:8080).
                   In dev with cws-work standalone, set to http://127.0.0.1:18080
                   AND set COCO_API_PREFIX=/api to bypass the gateway prefix.
  COCO_AUTH_TOKEN  Bearer token for authenticated endpoints (optional).
  COCO_API_PREFIX  Gateway path prefix (default: /api/gateway/v1).
                   Set to "/api" for cws-work standalone.

Routing notes:
  - Project + Task core CRUD route through the cws-fe Gateway
    (/api/gateway/v1/*).
  - Issue, Blueprint, Attempt, Comment, Link, System, TaskBoard, task.claim,
    task.reassign currently target cws-work direct paths (/api/*) until the
    gateway exposes equivalents.
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
