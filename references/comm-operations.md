# Comm Operations Guide

**Purpose**: Agent-initiated IM operations — creating conversations, sending messages, pulling history, checking unread, WS reconnect gap-fill, page search. All commands go through the cws-core BFF down to cws-comm.

**When to load this document**:

- Want to proactively DM / create a group to communicate with a person or a group of people (`comm.create_dm` / `comm.create_group` → `comm.send`)
- Need to send a message into a known conversationId (`comm.send`)
- Pull historical message context (`comm.get_messages` / `comm.get_message`)
- Check a conversation's unread count or fill gaps after a WS reconnect (`comm.unread` / `comm.sync`)
- Keyword-search pages in a KB (`comm.search`, the sole search entry point in v5)

**Out of scope for this document**:

- **Passively receiving messages** (human sends in → Agent replies) goes through the C4 bridge's automatic routing; no manual CLI call needed
- Message attachments / media upload → `references/as-operations.md` (`as.upload` with conversationId)
- Task management / state machine → `references/tm-operations.md`
- KB page content read/write → `references/kb-operations.md`
- Member / role directory queries → `references/core-operations.md`

**Prerequisites**:

- Before calling, first run `core.me` to get the current `member_id`; when creating a DM / Group it is the implicit "me"
- Before a DM, first run `core.member_list` to find the other party's member_id
- Before referencing a message attachment, first run `as.upload` to get the `media_id`
- Full parameter dependency tree, see [`SKILL.md` Efficiency Shortcuts > Parameter Resolution](../SKILL.md)

---

> Layer 3 operations reference. This document maintains a 1:1 correspondence with the `src/cli/comm.js` dispatch table.
> The authoritative paths are per the cws-core OpenAPI: `https://zylos01.jinglever.com/cws-core/openapi.json`

CLI location: `src/cli/comm.js`
Invocation: `node src/cli/comm.js <command> '<json>'`

Real-time event push (`message.created`, etc.) goes over WebSocket, handled by `src/comm-bridge.js`, and is outside the scope of this CLI.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `COCO_API_URL` | `http://127.0.0.1:8080` | cws-core BFF base address |
| `COCO_AUTH_TOKEN` | (empty) | Bearer token |
| `COCO_API_PREFIX` | `/api/v1` | Path prefix |

## Command List

### Conversations

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comm.list_conversations` | List all conversations I participate in (paginated) | `{pageSize?, pageToken?}` | `GET /api/v1/conversations` |
| ✅ | `comm.create_dm` | Open a DM with a single person (returns directly if it already exists, idempotent) | `{participantId}` | `POST /api/v1/conversations/dm` |
| ✅ | `comm.create_group` | Create a group; self + participantIds form the member list | `{title, participantIds[]}` | `POST /api/v1/conversations/groups` |
| ✅ | `comm.get_conversation` | Get details of a single conversation | `{conversationId}` | `GET /api/v1/conversations/{id}` |

`participantIds` must be a UUID array. DM uses a single `participantId` (no `title`); group uses multiple + `title`.

### Messages

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comm.send` | Send a message; `content` supports string / markdown / array structure | `{conversationId, content, replyTo?, clientMsgId?}` | `POST /api/v1/conversations/{id}/messages` |
| ✅ | `comm.get_messages` | Pull the historical message list (seq-based range) | `{conversationId, afterSeq?, beforeSeq?, limit?}` | `GET /api/v1/conversations/{id}/messages` |
| ✅ | `comm.get_message` | Get details of a single message (expands content) | `{conversationId, messageId}` | `GET /api/v1/conversations/{id}/messages/{message_id}` |

`content` accepts four kinds of input, which the CLI automatically normalizes into cws-core's `MessageContent[]`:

```text
"hello"                              → [{type:"text",     body:"hello"}]
"# header\n..."                      → [{type:"markdown", body:"# header\n..."}]   (heuristic)
{text:"hi", markdown:true}           → [{type:"markdown", body:"hi"}]
{type:"image", body:"<media_id>"}    → [{type:"image",    body:"<media_id>"}]
[{type:"text", body:"..."}, ...]     → passed through as-is (already in array form)
```

`clientMsgId` is used for server-side 5-minute idempotent deduplication; if not provided, `cmsg_<uuid>` is auto-generated. For retries of the same logical message, use the same id.

### Read / Unread

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comm.unread` | Query a conversation's unread message count | `{conversationId}` | `GET /api/v1/conversations/{id}/unread` |
| ✅ | `comm.mark_read` | Mark a conversation as read (advance the read cursor) | `{conversationId, seq}` | `POST /api/v1/conversations/{id}/read` |

### Sync

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comm.sync` | After a WS disconnect/reconnect, pull the missed events by `sinceSeq` | `{sinceSeq, deviceId, limit?}` | `POST /api/v1/sync` |

### Search

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comm.search` | KB page full-text search (the sole search entry point in v5; the `comm` in the name is historical baggage) | `{query, kbId?, limit?, offset?, sort?}` | `GET /api/v1/search/pages` |

### Owner (ownership owner; cws-core is the authoritative source)

cws-core is the authoritative source for the agent owner (can be transferred via `POST /api/v1/platform-agents/{member_id}/transfer-owner`).
The local `config.json` `orgs.<slug>.owner` is only a cache. **comm-bridge automatically pulls from core and syncs on every WS (re)connect**
(no restart needed); the commands below are for manual / trigger use. The `org` input can be filled with the slug from config
or the org UUID; for single-org deployments it can be omitted.

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comm.get_owner` | Compare the local cached owner with core's authoritative owner | `{org?}` | `GET /api/v1/members/{self}` |
| ✅ | `comm.set_owner` | Override the local owner cache (memberId passed empty = clear, revert to unbound → first DM auto-binding fallback) | `{memberId, name?, org?}` | writes local config only |
| ✅ | `comm.sync_owner` | Pull the authoritative owner from core and write it into config (a running service takes effect immediately via config watcher); does not touch local when core has no owner | `{org?}` | `GET /api/v1/members/{self}` |

> Note: the **authoritative change** of the owner happens in cws-core (the transfer endpoint), not locally. `comm.set_owner` only changes the local cache,
> and will be overwritten by core's authoritative value on the next reconnect. To persistently change ownership, go through core's transfer-owner (performed by the owner themselves or an org-admin).

## Typical Flows

### Agent proactively contacts a person

```bash
# 1. Establish a DM conversation (returns directly if it already exists)
node src/cli/comm.js comm.create_dm '{"participantId":"<member-uuid>"}'
# -> {data:{id:"<conversation-uuid>", type:"dm", ...}}

# 2. Send a message
node src/cli/comm.js comm.send '{
  "conversationId":"<conversation-uuid>",
  "content":"The weekly report is ready; take a look when you get a chance"
}'
```

### Sending a message with an attachment in a group

```bash
# 1. First upload the attachment (IM mode, with conversationId), get the media_id
node src/cli/as.js as.upload '{
  "conversationId":"<conv-uuid>",
  "filePath":"/tmp/weekly.pdf",
  "mediaType":"file"
}'
# -> {mediaId:"<media-uuid>", ...}

# 2. Send a message referencing the media_id
node src/cli/comm.js comm.send '{
  "conversationId":"<conv-uuid>",
  "content":[{"type":"text","body":"This week's weekly report"},
             {"type":"file","body":"<media-uuid>"}]
}'
```

### Filling gaps after a WS reconnect

```bash
# Use the last known seq + device_id to pull the missed events
node src/cli/comm.js comm.sync '{
  "sinceSeq":12345,
  "deviceId":"<device-id>",
  "limit":100
}'

# Check how many unread remain in a conversation
node src/cli/comm.js comm.unread '{"conversationId":"<conv-uuid>"}'
```

## Relationship with SKILL.md

This document is the Layer 3 sub-skill of [`SKILL.md`](../SKILL.md), responsible only for the **command mechanics** of the Comm CLI. The behavioral-surface content below is **in SKILL.md**; this document does not repeat it:

| What you want to see | Which section of SKILL.md to go to |
|---|---|
| When to communicate proactively vs. respond passively via the C4 bridge | [Role Model](../SKILL.md) (Lead can communicate with humans / Worker cannot) |
| Parameter dependency tree / context anchoring | [Efficiency Shortcuts](../SKILL.md) |
| General error safeguards (e.g. don't bypass the CLI to curl directly) | [Behavioral Guardrails > Common Mistakes](../SKILL.md) |

## Comm-Specific Notes

- DM goes through `/conversations/dm`, Group goes through `/conversations/groups`, **not** the same generic POST entry point
- When retrying a failed message send, **keep the same `clientMsgId`**; the server does 5-minute idempotency based on it
- cws-core's `SendMessageRequestBody` is `additionalProperties:false` — do not pass fields outside the schema (they will be rejected)
- The actual response is wrapped in `{data:{...}, ...}`; this CLI does not unwrap it, so the caller should take `.data` as needed
- `comm.search` has `comm` in its name but is actually a KB page search (`/api/v1/search/pages`); v5 has no standalone full-message search

## DM Permission Management CLI

Manage DM access policy and allowlist; after modification a running service hot-reloads the changes (no restart needed).

| Command | Description | Parameters |
|---|---|---|
| `comm.dm_policy` | View or set the DM policy | `{org?, policy?}` policy: open/allowlist/owner |
| `comm.dm_list` | List the current policy and allowlist | `{org?}` |
| `comm.dm_allow` | Add a member to the DM allowlist | `{memberId\|memberIds, org?}` |
| `comm.dm_revoke` | Remove a member from the DM allowlist | `{memberId\|memberIds, org?}` |

- `org` is optional — auto-resolved for single-org deployments; multi-org requires specifying the slug or org_id
- Modifications are written directly into `config.json`; the running comm-bridge hot-reloads the `access.*` fields via `watchConfig`
- Under `dmPolicy=owner` mode the allowlist has no effect (only the owner can DM); the allowlist only becomes meaningful after switching to `allowlist`

Examples:
```bash
# View the current policy
node src/cli/comm.js comm.dm_list '{}'

# Open access to a specific member
node src/cli/comm.js comm.dm_allow '{"memberId":"019ea63f-b7ff-..."}'

# Batch add
node src/cli/comm.js comm.dm_allow '{"memberIds":["id1","id2"]}'

# Revoke
node src/cli/comm.js comm.dm_revoke '{"memberId":"019ea63f-b7ff-..."}'

# Switch policy
node src/cli/comm.js comm.dm_policy '{"policy":"allowlist"}'
```
