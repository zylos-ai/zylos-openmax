#!/usr/bin/env node

/**
 * Task Management CLI.
 *
 * Thin stateless wrapper around the cws-work TM HTTP API. Each command
 * maps to a single HTTP call; no business logic lives here.
 *
 * Usage:
 *   node src/cli/tm.js <command> '<json-params>'
 *   node src/cli/tm.js issue.create '{"projectId":"proj-1","title":"竞品分析","mode":"light","leadAgentId":"agent-1"}'
 *
 * Output: success → JSON to stdout, exit 0; failure → JSON error to stderr, exit 1.
 *
 * Origin: this file replaces the standalone `cws-work/zylos-tm/src/cli.js`
 * per DESIGN.md §1.2 ("zylos-tm 开发阶段独立迭代，成熟后合入 cli/tm.js").
 * The HTTP client is now the shared `src/lib/client.js`, which reads
 * COCO_API_URL / COCO_AUTH_TOKEN per DESIGN.md §6.2.
 */

import { get, post, patch, put, del } from '../lib/client.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

const COMMANDS = {
  // Project
  'project.create':    () => post('/api/projects', {
    workspace_id: params.workspaceId,
    team_id:      params.teamId,
    name:         params.name,
    slug:         params.slug,
    is_inbox:     params.isInbox,
  }),
  'project.get':       () => get(`/api/projects/${params.id}`),
  'project.list':      () => get('/api/projects', {
    workspace_id: params.workspaceId,
    status:       params.status,
    limit:        params.limit,
    offset:       params.offset,
  }),
  'project.archive':   () => post(`/api/projects/${params.id}/archive`),
  'project.unarchive': () => post(`/api/projects/${params.id}/unarchive`),

  // Issue
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

  // Task
  'task.create': () => post('/api/tasks', {
    issueId:         params.issueId,
    title:           params.title,
    description:     params.description || '',
    assigneeId:      params.assigneeId,
    skillTags:       params.skillTags,
    blueprintStepId: params.blueprintStepId,
    dependsOn:       params.dependsOn,
    contextPageIds:  params.contextPageIds,
  }),
  'task.get':        () => get(`/api/tasks/${params.id}`),
  'task.list':       () => get('/api/tasks', {
    issue_id: params.issueId,
    status:   params.status,
    limit:    params.limit,
    offset:   params.offset,
  }),
  'task.claim':      () => post(`/api/tasks/${params.id}/claim`,      { assigneeId: params.assigneeId }),
  'task.transition': () => post(`/api/tasks/${params.id}/transition`, { status:     params.status     }),
  'task.reassign':   () => post(`/api/tasks/${params.id}/reassign`,   { assigneeId: params.assigneeId }),

  // TaskBoard
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

Project
  project.create        {workspaceId, teamId, name, slug, isInbox?}
  project.get           {id}
  project.list          {workspaceId, status?, limit?, offset?}
  project.archive       {id}
  project.unarchive     {id}

Issue
  issue.create          {projectId, title, description?, mode, leadAgentId, originConversationId?, originMessageId?}
  issue.get             {id}
  issue.list            {projectId, status?, limit?, offset?}
  issue.update          {id, title?, description?}
  issue.transition      {id, status}
  issue.move_project    {id, projectId}
  issue.set_acceptance  {id, accepted, source}

Task
  task.create           {issueId, title, description?, assigneeId?, skillTags?, blueprintStepId?, dependsOn?, contextPageIds?}
  task.get              {id}
  task.list             {issueId, status?, limit?, offset?}
  task.claim            {id, assigneeId}
  task.transition       {id, status}
  task.reassign         {id, assigneeId}

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
                   In dev with cws-work standalone, set to http://127.0.0.1:18080.
  COCO_AUTH_TOKEN  Bearer token for authenticated endpoints (optional).
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
