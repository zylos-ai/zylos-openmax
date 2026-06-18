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
 * All exposed commands are backed by an existing cws-core@contract-v2
 * forwarding endpoint — there are no placeholder / ⏳ entries anymore. The
 * earlier ⏳ batch (blueprint fine-grained ops + taskboard.list) was removed
 * because cws-core does not yet proxy them; re-add when forwarding ships.
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

// Backward-compat shim for the removed generic transition endpoint. cws-core
// no longer exposes POST /issues/{id}/transition; map the requested target
// status onto the corresponding semantic action endpoint. Note `reopened` is
// an old target name — it now lands the issue in `pending_start` via /reopen.
function issueTransitionCompat() {
  const target = params.status ?? params.targetStatus;
  switch (target) {
    case 'executing':
      return post(apiPath(`/issues/${params.id}/start-execution`));
    case 'delivered':
      return post(apiPath(`/issues/${params.id}/deliver`));
    case 'reopened':
    case 'pending_start':
      return post(apiPath(`/issues/${params.id}/reopen`));
    case 'archived':
      return post(apiPath(`/issues/${params.id}/archive`));
    case 'accepted':
      return post(apiPath(`/issues/${params.id}/accept-delivered`), {
        source: params.source ?? 'explicit',
      });
    case 'rejected':
      return post(apiPath(`/issues/${params.id}/reject-delivered`), {
        source:           params.source ?? 'explicit',
        rejection_reason: params.rejectionReason,
      });
    default:
      throw new Error(`issue.transition compatibility shim cannot map target status: ${target}`);
  }
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
    name:               params.name,
    description:        params.description,
    description_format: params.descriptionFormat || 'markdown',
    slug:               params.slug,
    is_default:         params.isDefault,
    lead_member_id:     params.leadMemberId,
  }),

  'project.get': () => get(apiPath(`/projects/${params.id}`)),

  // contract-v2 update-project body: { name?, description?, lead_member_id? }
  'project.update': () => patch(apiPath(`/projects/${params.id}`), {
    name:               params.name,
    description:        params.description,
    description_format: params.descriptionFormat || 'markdown',
    lead_member_id:     params.leadMemberId,
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
  //  ISSUE  (✅ all cws-core BFF issue commands — note issue write paths
  //  use the FLAT path /issues/{id}, not /projects/{pid}/issues/{id})
  // =========================================================================

  'issue.list_in_project': () => get(apiPath(`/projects/${params.projectId}/issues`), {
    status:   params.status,     // enum (backlog / pending_start / ... / archived)
    priority: params.priority,   // enum: low|medium|high
    ...pageParams(params),
  }),

  // Flat path, no project prefix.
  'issue.get': () => get(apiPath(`/issues/${params.id}`)),

  // contract-v2 create-issue body: requires title*, mode*, priority*,
  // lead_agent_id*; optional owner_member_id, context_page_ids,
  // input_artifact_ids, origin_conversation_id, origin_message_id,
  // due_date, disposition.
  'issue.create': () => post(apiPath(`/projects/${params.projectId}/issues`), {
    title:                  params.title,
    description:            params.description || '',
    description_format:     params.descriptionFormat || 'markdown',
    mode:                   params.mode,                  // light|heavy (required)
    disposition:            params.disposition,           // start|backlog (default: start)
    priority:               params.priority,              // low|medium|high (required)
    due_date:               params.dueDate,
    lead_agent_id:          params.leadAgentId,
    owner_member_id:        params.ownerMemberId,
    context_page_ids:       params.contextPageIds,
    input_artifact_ids:     params.inputArtifactIds,
    origin_conversation_id: params.originConversationId,
    origin_message_id:      params.originMessageId,
  }),

  // Flat path; body: { title?, description?, priority?, due_date? }.
  'issue.update': () => patch(
    apiPath(`/issues/${params.id}`),
    {
      title:              params.title,
      description:        params.description,
      description_format: params.descriptionFormat || 'markdown',
      priority:           params.priority,
      due_date:           params.dueDate,
    },
  ),

  // Semantic issue lifecycle actions (cws-core BFF). The generic
  // POST /issues/{id}/transition endpoint was removed; each state change is
  // now its own endpoint that enforces invariants and side effects.
  'issue.activate': () => post(
    apiPath(`/issues/${params.id}/activate`),
    { source: params.source ?? 'lead_chat' },
  ),
  'issue.start_execution': () => post(apiPath(`/issues/${params.id}/start-execution`)),
  'issue.deliver':         () => post(apiPath(`/issues/${params.id}/deliver`)),
  'issue.reopen':          () => post(apiPath(`/issues/${params.id}/reopen`)),
  'issue.archive':         () => post(apiPath(`/issues/${params.id}/archive`)),
  'issue.accept_delivered': () => post(
    apiPath(`/issues/${params.id}/accept-delivered`),
    { source: params.source ?? 'explicit' },
  ),
  'issue.reject_delivered': () => post(
    apiPath(`/issues/${params.id}/reject-delivered`),
    {
      source:           params.source ?? 'explicit',
      rejection_reason: params.rejectionReason,
    },
  ),

  // Backward-compat alias for older scripts. Prefer the semantic commands
  // above; cws-core no longer exposes POST /issues/{id}/transition.
  'issue.transition': issueTransitionCompat,

  // Flat path; body field is `new_project_id` (not `project_id`).
  'issue.move_project': () => post(
    apiPath(`/issues/${params.id}/move`),
    { new_project_id: params.targetProjectId ?? params.newProjectId },
  ),

  // Compatibility wrapper: POST /issues/{id}/acceptance. Prefer the semantic
  // issue.accept_delivered / issue.reject_delivered commands for new calls.
  'issue.set_acceptance': () => post(
    apiPath(`/issues/${params.id}/acceptance`),
    {
      accepted:         params.accepted,
      source:           params.source ?? 'explicit',
      rejection_reason: params.rejectionReason,
    },
  ),

  // 提前终止(v0.7): 把一个未结论 Issue 主动停下 → terminated。服务端会级联
  // 取消其下非终态 Task,并给 Lead 发 issue.terminated 事件做善后。
  // 不回滚已发生副作用——善后由 Lead 与人类共同决定(见 SKILL.md)。
  // POST /issues/{id}/terminate, body: { reason?, source? }
  'issue.terminate': () => post(
    apiPath(`/issues/${params.id}/terminate`),
    {
      reason: params.reason,
      source: params.source ?? 'lead_chat',
    },
  ),

  // =========================================================================
  //  TASK  (✅ all 8 on cws-core BFF; create uses the doubly-nested path
  //  /projects/{pid}/issues/{iid}/tasks. v0.7 claim/start split: claim only
  //  assigns, task.start begins work + opens the attempt + checks dependsOn.)
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
      title:              params.title,
      description:        params.description || '',
      description_format: params.descriptionFormat || 'markdown',
      assignee_id:        params.assigneeId,
      skill_tags:         params.skillTags,
      blueprint_step_id:  params.blueprintStepId,
      depends_on:         params.dependsOn,
      context_page_ids:   params.contextPageIds,
    },
  ),

  // v0.7 claim/start split: claim ONLY assigns the task to the caller
  // (pending → assigned). It does NOT start work or open an attempt — call
  // task.start next. POST /tasks/{id}/claim (no body; principal from auth header).
  'task.claim': () => post(apiPath(`/tasks/${params.id}/claim`)),

  // v0.7: start an assigned task (assigned → running) and open the attempt.
  // The dependency gate (depends_on all done) is enforced here, not at claim.
  // POST /tasks/{id}/start (no body; principal from auth header).
  'task.start': () => post(apiPath(`/tasks/${params.id}/start`)),

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
  //  BLUEPRINT  (✅ all 4 in contract-v2 — create / get / list / set-steps;
  //  blueprint.create and .list are issue-nested; blueprint.set_steps is
  //  PUT-and-replace, not POST-and-append.)
  // =========================================================================

  // contract-v2 create-blueprint:
  //   POST /api/v1/issues/{issue_id}/blueprints
  //   body: { steps[]*, estimated_budget?, notes? }
  // where each step is { temp_id, description, required_resources?,
  //                     depends_on_temp_ids? }.
  //
  // NOTE: cws-core's createBlueprintRequest body does NOT accept
  // `author_agent_id` — the server derives it from the auth principal
  // (data.author_agent_id in the response surfaces it). Sending
  // author_agent_id returns 422 "unexpected property". Keep
  // `authorAgentId` as a tm.js param for backward compat / readability
  // but do not forward to the body.
  'blueprint.create': () => post(
    apiPath(`/issues/${params.issueId}/blueprints`),
    {
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

  // Added 2026-06-05 (cws-core MR !118 / issue #77): BFF proxy to
  // cws-work BlueprintService.SubmitForApproval. After this returns 200
  // the parent issue's `current_blueprint_id` points at the submitted
  // blueprint and issue.status advances `draft → pending_approval` —
  // the previously-missing transition that left Smoke 2 #6 / Smoke 3
  // phase 2 forever stuck.
  'blueprint.submit_for_approval': () => post(
    apiPath(`/blueprints/${params.blueprintId ?? params.id}/submit-for-approval`),
    {},
  ),

  // =========================================================================
  //  ATTEMPT  (contract-v2: create / get / list / transition)
  // =========================================================================

  // contract-v2 create-attempt: POST /tasks/{task_id}/attempts
  // (attempt_number auto-increments server-side)
  'attempt.create': () => post(
    apiPath(`/tasks/${params.taskId}/attempts`),
  ),

  'attempt.get': () => get(apiPath(`/attempts/${params.id}`)),

  'attempt.list': () => get(
    apiPath(`/tasks/${params.taskId}/attempts`),
    pageParams(params),
  ),

  // contract-v2 transition-attempt: POST /attempts/{id}/transition
  'attempt.transition': () => post(
    apiPath(`/attempts/${params.id}/transition`),
    {
      target_status:                    params.status ?? params.targetStatus,
      failure_reason:                   params.failureReason,
      blocked_on_approval_request_ids:  params.blockedOnApprovalRequestIds,
    },
  ),

  // =========================================================================
  //  EVENT BINDING  (定时任务 / create-by-agent — cws-core /event-bindings)
  //  create-by-agent: agent 必须 leadMemberId=自己、ownerMemberId=对话人类;
  //  否则被 cws-work 护栏拒（lead≠自己 / owner 缺失或=自己）。见 SKILL.md。
  // =========================================================================

  // create-event-binding body: { cron_expr*, lead_member_id*,
  // owner_member_id?, spec{ project_id*, title*, description?, mode } }
  'event-binding.create': () => post(apiPath('/event-bindings'), {
    cron_expr:       params.cronExpr,
    lead_member_id:  params.leadMemberId,
    owner_member_id: params.ownerMemberId,
    spec: {
      project_id:  params.projectId,
      title:       params.title,
      description: params.description,
      mode:        params.mode ?? 'light',
    },
  }),

  'event-binding.list': () => get(apiPath('/event-bindings')),

  'event-binding.get': () => get(apiPath(`/event-bindings/${params.id}`)),

  // 删除 binding 只停止后续触发,不影响已触发生成的 Issue。
  'event-binding.delete': () => del(apiPath(`/event-bindings/${params.id}`)),

};

function printUsage() {
  console.log(`TM CLI — Task Management against cws-core@contract-v2

Usage: node src/cli/tm.js <command> '<json-params>'

PROJECT  (all ✅ on contract-v2)
  project.list           {status?, page?, pageSize?, orderBy?}
  project.create         {name, slug, leadMemberId, description?, descriptionFormat?, isDefault?}
  project.get            {id}
  project.update         {id, name?, description?, descriptionFormat?, leadMemberId?}
  project.archive        {id}
  project.restore        {id}                                                    # alias: project.unarchive
  project.members        {id, page?, pageSize?, orderBy?}

ISSUE  (all ✅ on contract-v2 — write paths use /issues/{id}, NOT /projects/{pid}/issues/{id})
  issue.list_in_project  {projectId, status?, priority?, page?, pageSize?, orderBy?}
  issue.get              {id}
  issue.create           {projectId, title, mode, priority, leadAgentId,
                          ownerMemberId?,
                          description?, descriptionFormat?, dueDate?, contextPageIds?,
                          inputArtifactIds?, originConversationId?, originMessageId?,
                          disposition?}                                      # ownerMemberId defaults to human caller; agent create-by-human must pass it
  issue.update           {id, title?, description?, descriptionFormat?, priority?, dueDate?}
  issue.activate         {id, source?}                                        # source: lead_chat|ui|event_binding|system
  issue.start_execution  {id}
  issue.deliver          {id}
  issue.reopen           {id}                                                 # rejected → pending_start
  issue.archive          {id}
  issue.accept_delivered {id, source?}                                        # source: im|explicit
  issue.reject_delivered {id, source?, rejectionReason?}
  issue.transition       {id, targetStatus (or 'status'), rejectionReason?}    # compatibility shim only
  issue.move_project     {id, newProjectId (or 'targetProjectId')}
  issue.set_acceptance   {id, accepted, source?, rejectionReason?}        # compat wrapper; prefer accept/reject_delivered
  issue.terminate        {id, reason?, source?}                           # 提前终止 → terminated; 级联取消 Task + 发善后事件

TASK  (all ✅ on contract-v2; create uses doubly-nested path)
  task.list              {projectId?, issueId?, status?, claimable?, agentSkills?,
                          page?, pageSize?, orderBy?}
  task.get               {id}
  task.create            {projectId, issueId, title, description?, descriptionFormat?,
                          assigneeId?, skillTags?, blueprintStepId?, dependsOn?, contextPageIds?}
  task.claim             {id}                                                    # 只分配 pending→assigned; no body
  task.start             {id}                                                    # assigned→running + 开 attempt; no body
  task.transition        {id, targetStatus}                                      # alias: task.status
  task.reassign          {id, newAssigneeId (or 'assigneeId')}

BLUEPRINT  (all ✅ on contract-v2)
  blueprint.create                  {issueId, authorAgentId, steps[], estimatedBudget?, notes?}
  blueprint.get                     {id, includeSteps?}
  blueprint.list                    {issueId, page?, pageSize?, orderBy?}
  blueprint.set_steps               {blueprintId (or 'id'), steps[]}             # replaces ALL steps
  blueprint.submit_for_approval     {blueprintId (or 'id')}                       # attaches blueprint to issue; advances issue draft→pending_approval

ATTEMPT  (all ✅ on contract-v2)
  attempt.create         {taskId}                                                # attempt_number auto-increments
  attempt.get            {id}
  attempt.list           {taskId, page?, pageSize?, orderBy?}
  attempt.transition     {id, targetStatus (or 'status'), failureReason?,
                          blockedOnApprovalRequestIds?}

EVENT BINDING  (定时任务 / create-by-agent)
  event-binding.create   {cronExpr, leadMemberId, ownerMemberId, projectId,
                          title, description?, mode?}                            # agent: leadMemberId=自己, ownerMemberId=对话人类
  event-binding.list     {}                                                     # 本 org 的定时任务
  event-binding.get      {id}
  event-binding.delete   {id}                                                   # 停止后续触发, 不影响已生成的 Issue

Environment:
  COCO_API_URL     cws-core base URL (default: http://127.0.0.1:8080)
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
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
