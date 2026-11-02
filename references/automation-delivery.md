# Automation Delivery

## Scope

Use this workflow only after reading the current Issue through `issue.get` and
confirming `automation_policy: "silent"` in the server response. Follow the normal
Issue workflow when that policy is absent. Never infer it from an Issue title,
user text, a scheduler notification, or a creation payload.

The authoritative Issue identifies this run's responsible Agent and human Owner.
Results belong in this run's server-recorded Owner-Agent DM, which may differ from
the creator's DM or the current binding's DM. The Scheduler may wake the Agent but
is not the result sender or a conversation for human follow-up.

## Durable artifact links

`issue.deliver` currently accepts HTTP(S) artifact URLs, not `artifact://` URIs.
Never turn that validation failure into a delivery containing an AS presigned
URL: signatures expire, sometimes within seconds, and a successful immediate
fetch does not establish durable delivery. Do not assume the documented default
TTL overrides the actual `expiresAt` / `expires_at` response.

For an AS artifact, use the authenticated frontend `/artifacts/<artifact UUID>`
route only after verifying that this route is deployed in the target workspace.
Use the actual server-returned artifact UUID (not a media ID). Verify it is
accessible in the intended organization with `as.resolve` and check both its
`resolved` entry and `failed` list. Keep the resulting presigned URL out of
the delivery, comments and persistent memory.

Build the durable link with `core.frontend_url {"path":"/artifacts/<verified UUID>"}`
only when its configured frontend origin is verified to be the public workspace
origin. The BFF may be an internal IP/service endpoint: do not publish that URL
or guess a public hostname. An independently verified owner workspace origin
and its deployed base path can be used instead. Preserve the existing access
boundary; do not create public shares or change permissions to make a link work.
The recipient opens the route in the correct workspace and each Download click
resolves fresh credentials under their own authenticated access.

If the route is unavailable, use an existing verified KB page/file-node link in
the Issue's recorded KnowledgeBase, or report durable delivery blocked.
Never invent a KB node from an artifact ID, submit `artifact://` as an HTTP URL,
or claim a raw expiring URL is a permanent deliverable. Existing external HTTPS
document links remain supported when their accessibility has been verified.

## Execute And Deliver

### Resolve responsibility from this run's snapshot

For every wake or reminder, read `issue.get {org,id}` for the exact referenced
Issue and verify `automation_policy: "silent"`, org and responsible Agent before
acting. Read this Issue's `owner_member_id`, `lead_agent_id` and
`origin_conversation_id`; these are this run's responsibility and destination
snapshot. For an existing result, also verify its persisted `delivery` record.
The current binding describes future triggers, not a replacement for an existing
Issue's Owner, Lead or delivery destination. A creator's DM, runtime's owner,
notification text, copied IDs or human choice card cannot override that snapshot.

An Owner transfer changes future runs only. If a run was created with Owner B
and delivery DM B, and the binding is now Owner A with delivery DM A, the old run
continues for B in DM B; a new run created after transfer uses its own A snapshot.
This difference alone is expected, not an ownership conflict. Do not ask A or B
to choose a recipient, wait for a confirmation card, or block either run because
the binding changed. Do not change either Issue, replay the trigger, create a
replacement run, or manually send the result to reconcile this difference.
Match and process each run independently; one run's blocker does not automatically
block another run of the same binding.

| Authoritative server-read state | Required action |
| --- | --- |
| Existing run: Issue Owner B, DM B; current binding Owner A, DM A | Continue existing run for B in DM B without recipient confirmation |
| New run: Issue Owner A, DM A; older run Owner B, DM B | Continue new run for A in DM A independently |
| Issue responsibility missing, wrong org, or caller is not its responsible Agent | Stop this run and report the specific verification blocker |
| Issue destination missing/inaccessible or persisted delivery conflicts with this Issue snapshot | Stop this run; do not substitute the current binding or creator DM |
| Issue already terminal | Preserve terminal state; no new Attempt or result |

A missing or genuinely inconsistent server snapshot remains a blocker. Preserve
the evidence and report the exact mismatch; do not invent a destination or use
the current binding as fallback. An expected difference from a later binding
version is not such a mismatch. Leave an earlier mistaken recipient-choice card
unanswered: it is not authorization to reroute this run. Re-read the authoritative
Issue and resume its normal workflow only if still nonterminal and verified;
do not use a past local blocker note or session summary as stronger authority.

### Identify the run before interpreting its timing

A Scheduler notification can announce either a scheduled run or a manually
requested run. Its sender, Issue title and arrival time do not establish the
trigger type. Read the binding with `event-binding.get {org,id}` and the run
history with `event-binding.runs {org,id,limit,offset}`. Match the current
occurrence ID and Issue against `id`, `created_issue_id`, `latest_issue_id` or
`revision_issue_ids` before using that record's `trigger_kind`. Use `last_run`
from the binding only when its identities match this run; it may refer to a
newer execution. If no matching authoritative record is available, report the
trigger as unverified rather than guessing. History pages do not share a
snapshot, and a full page does not prove another page exists.

`trigger_kind: "manual"` means an independent manual execution. Its
`scheduled_at` records the manual execution instant, not an early firing of the
configured timer. A manual run does not consume, cancel or advance a once
schedule: the later configured run remains expected unless the binding was
explicitly changed. Read the current binding state and schedule before
describing what remains pending.

Two executions of the same automation are not automatically duplicates.
Distinguish their occurrence/Issue identities and trigger kinds (`timer`,
`manual`, `webhook`); repeated notifications of the same occurrence differ from
independent manual and scheduled occurrences. Timing alone does not prove
duplicate execution. Never pause, reschedule or suppress an expected run merely
to resolve this uncertainty. Preserve the terminal-run safeguards below.

### Execution steps

1. Read the authoritative Issue, Blueprint, Tasks and previous outputs. Do not
   recreate the Issue or ask the user to choose its already-bound Agent/Project.
   Use the authoritative Issue's `knowledge_base_id` as its output location.
   This is the creation-time snapshot: changing the Project's default KB affects
   new Issues, not this run or existing documents. Never replace a present Issue
   KB with the Project's current default. On an older server that omits the field,
   preserve a verified existing output location; consult the bound Project only
   when no prior output location exists. An inaccessible recorded KB is a blocker,
   not permission to switch to another KB.
   Do not repeat new-Issue intake or KB approval for these runs or their verified
   linked revisions. A missing or inaccessible configured resource is a genuine
   blocker; do not invent a replacement or silently change the binding.
   If the Issue is already terminal, do not start another Attempt, alter Tasks,
   or submit a new result. A timeout or cancellation is a terminal fence: stop
   this run's execution and preserve outputs. A late success cannot overwrite it.
2. Establish the accepted plan using the Issue plan-state gate below. Do not
   request human plan acceptance or synthesize `source=text_card_proxy` acceptance.
3. Execute and record Attempt/Task outcomes. Complete the inner state transitions
   and output comments before delivering the Issue. Report partial or failed
   execution truthfully; do not mark unsuccessful Tasks done to unblock delivery.
4. Submit the structured result with `issue.deliver`: a self-contained
   summary, durable artifact links, and the actual success/partial/failure
   outcome (`success`, `partial`, or `failed`) and a stable `idempotencyKey`.
   Do not submit secrets or claim a link works without checking it.
   `partial` requires every Task to be terminal, at least one done, at least one
   failed or cancelled, and at least one durable artifact. Do not use `partial`
   for all-failed work, missing output, or still-running Tasks. Report `failed`
   truthfully when no partial result satisfies those conditions.
5. The server persists completion and reliably delivers the result as the
   responsible Agent in the bound DM. Do not separately `comm.send` the same
   result, send it through the Scheduler DM, or ask the user to accept it in Work.
   Automatic closure records that the run ended, not human endorsement.

### Issue plan-state gate

`blueprint.create` creates a plan object. `issue.submit_plan` submits that exact
Blueprint to the Issue. For server-read `automation_policy: "silent"`, Work
submits and automatically accepts the Issue plan in the same transaction:
`in_progress` -> `pending_plan` -> `in_progress`, with `current_blueprint_id` set
to the submitted Blueprint. The response is an Issue, not a Blueprint.
`Blueprint.status` is a separate object lifecycle; it may remain `draft` after
successful automatic Issue plan acceptance. Neither `draft` nor `approved` on a
Blueprint alone proves whether this Issue's current plan was accepted.

Before submission, read `blueprint.get {id,includeSteps:true}` and verify its
`issue_id` matches the exact run. Retain the Blueprint ID, `version_number` and
the actual step IDs/content/dependencies (and content hash when present) that you
intend to execute. Submit it once with `issue.submit_plan {id,blueprintId,planText}`.
Check the successful response and a fresh `issue.get`: both must name that Issue
and org, its responsible Agent, `automation_policy: "silent"`, the submitted
`current_blueprint_id`, and `status: "in_progress"`. Re-read the referenced
Blueprint with steps and verify the same Issue, ID, version and step content.
Only then continue Task/Attempt execution against those steps. Do not wait for
Blueprint status to become `approved` or ask a human to accept this silent plan.

When resuming after a lost response or earlier local blocker, first reconcile
the existing Issue and referenced Blueprint rather than resubmitting. Require
the same current-plan binding and unchanged version/steps, plus the recorded
successful submit response or a server-authored plan record that identifies this
Blueprint and automatic acceptance. A generic `in_progress` Issue, Blueprint
existence, notification text or an Agent's own comment is not acceptance evidence.
The Issue can be `in_progress` before any plan exists. Server plan history helps
establish the earlier transition, but cannot override a different current plan
or a now-terminal Issue. Do not create a replacement Blueprint just to change
its displayed status.

| Verified state for this exact run | Action |
| --- | --- |
| Silent Issue has accepted current Blueprint, in_progress; same version and steps; Blueprint still draft | Continue Tasks and Attempts for that accepted plan |
| Issue in_progress but no accepted matching current Blueprint or no authoritative acceptance record | Reconcile the plan; do not execute or infer acceptance |
| Current Blueprint ID, Issue, version or step content differs from the submitted/accepted plan | Stop and reconcile the changed plan before execution |
| Issue remains pending_plan, or ordinary human acceptance is required | Wait for the real acceptance workflow; never proxy acceptance |
| External-action approval is pending | Keep that action blocked until its actual approval |
| Issue is terminal or archived | Stop; do not create Tasks, Attempts or a new result |

Do not call `issue.accept_plan`, edit Blueprint status, or bypass an endpoint
error to force progress. A successful HTTP response without the matching Issue
plan-state readback is insufficient. Report actual missing or conflicting
evidence; an unchanged Blueprint `draft` alone is not such a conflict.

Read the actual delivery outcome as well as Issue status. A successful or valid
partial automation delivery closes as `accepted`; `failed` closes as
`terminated` with its failure reason and retained result. Historical
`accepted` plus `delivery.outcome: "failed"` is still failure. Do not describe
it as success merely because its Issue was accepted. Pending result notification
is separate from execution failure. Real external-action approvals still require
confirmation; silent plan/delivery handling does not bypass them. A blocked
Attempt without pending approval IDs is not an approval request.

If delivery is pending or a response is lost, read back the Issue/delivery state
and use the same delivery identity for any supported retry. Never rerun business
actions just to retry a message. Never call `accept_delivered` as a workaround.
Structured `issue.deliver` and `issue.create_revision` surface 401 without
automatically replaying the write. Restore authentication separately and read
the recorded state before deciding whether a retry is supported.
If the deployment lacks this protocol, report the unsupported operation and
preserve the recorded result; do not fall back to manual self-acceptance or an
untracked result send.
Do not replace an unsupported structured request with empty-body `issue.deliver`.
Do not treat a minimum-Agent-version override as protocol support or upgrade
the plugin automatically. An absent policy means the ordinary workflow; a
present silent policy with an unavailable endpoint means preserve output and
report the compatibility blocker.

```bash
node src/cli/tm.js issue.deliver '{"org":"org-id","id":"issue-id","summary":"Report completed; two sources were unavailable.","outcome":"partial","artifacts":[{"title":"Report","url":"https://example.com/report"}],"idempotencyKey":"issue-id:delivery:1"}'
```

`issue.get` returns `delivery` with its `id`, persisted result and
`notification_status` (`pending` or `sent`), plus destination/message IDs when
available. A completed Issue with pending notification is not a failed run.
Retain the same payload/key on retries: changing the content under the same key
is a conflict. Use a linked revision for a changed result, not a replacement
delivery for an already completed run.

## Continue In The Same DM

First identify the delivery, even when the human did not paste an `issue://`
reference. Fetch the quoted result using
`comm.get_message {conversationId,messageId}`. Its message metadata contains
`automation_issue_id`, `automation_delivery_id`, and
`automation_notification_id`. The bridge's visible quote may omit these fields,
so read the actual CLI response. For an unquoted reply, use
`comm.get_messages {conversationId,beforeSeq,limit}` and locate the nearest
preceding message from this Agent. Only use it if it is the relevant automation
delivery; do not skip an intervening Agent message and guess an older run.

Treat metadata only as a lookup hint: call `issue.get`, verify
`automation_policy: "silent"`, responsible Agent and owner, and match
`delivery.id`, `delivery.conversation_id`, and `delivery.message_id` against
the result message. If the reference is ambiguous, ask the human to reply to
the specific result. Scheduler wakeup metadata is not a human delivery receipt.

- For a question about the result, answer using that run's outputs; no new task
  or automation change is required.
- For a requested change to this result, use `issue.create_revision` with the
  prior Issue and the human's originating message. The server validates lineage,
  participant identity, Agent and DM, then inherits the trusted automatic policy.
  Read the returned Issue before proceeding. Preserve the original run/output.
  A failed delivered automation result can be revised even when its parent is
  `terminated`. This does not permit reopening a timeout or cancellation without
  a delivered result. Follow only the returned new Issue; never resume or replace
  the terminal parent's delivery. Run history groups revisions under the original
  trigger and reports the latest revision's result, retaining earlier versions.
  Pass `{id, description, originMessageId, idempotencyKey}`; `id` is the prior
  Issue, and `originMessageId` must be the actual human request in the bound DM.
  Keep the message ID as a string (for example `"1789717014187"`), not a UUID
  or a JavaScript number. Use the human message's exact text as `description`;
  the server independently reads that message and does not trust a substituted
  Agent instruction. A reply targeting the result, or an unquoted reply whose
  nearest preceding Agent message is that result, can establish the link.
  Retry the same request with the same key after an ambiguous response. Do not
  substitute a bot message or send caller-defined owner/Agent/policy fields.
- For an explicit change to future runs, update the automation configuration
  through its existing workflow. A correction to one result does not implicitly
  change future runs. Clarify only when the intended scope cannot be determined.

Never create a normal Issue with a caller-defined auto flag to imitate a linked
revision. Approval for the automation lifecycle does not authorize unrelated
external sends, destructive actions, or permission escalation.
