# Comm Operations Guide

**Purpose**: Agent-initiated IM operations — creating conversations, sending messages, pulling history, checking unread, WS reconnect gap-fill, page search. All commands go through the cws-core BFF down to cws-comm.

> The reply-vs-proactive-send behavioral rule — **replies always go through the C4 `c4-send` reply path, `comm.send` is for agent-initiated (proactive) sends only** — lives in `SKILL.md` ("How to Send a Message"), which is always loaded. This Layer-3 doc only covers `comm.send`'s call mechanics.

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
| ✅ | `comm.get_conversation` | Get details of a single conversation | `{conversationId, org?}` | `GET /api/v1/conversations/{id}` |

`participantIds` must be a UUID array. DM uses a single `participantId` (no `title`); group uses multiple + `title`.

### Conversation members

Manage group membership **after** creation. cws-core derives the caller from the JWT and enforces permissions server-side (only the conversation owner/admins may add/remove; non-self targets must be org members). These are the sanctioned CLI path for group-admin actions — never hand-roll the `/members` REST calls.

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comm.member_list` | List all members of a conversation (returns the full list — cws-core `ListMembers` is **not** paginated) | `{conversationId, org?}` | `GET /api/v1/conversations/{id}/members` |
| ✅ | `comm.member_add` | Add one (`memberId`) or many (`memberIds[]`) members | `{conversationId, memberId \| memberIds[], role?, org?}` | `POST .../members` (single) / `POST .../members:batch-add` (many) |
| ✅ | `comm.member_remove` | Remove a single member | `{conversationId, memberId, org?}` | `DELETE .../members/{member_id}` |
| ✅ | `comm.member_remove_batch` | Remove several members (partial-success envelope) | `{conversationId, memberIds[], org?}` | `POST .../members:batch-remove` |
| ✅ | `comm.leave` | Leave the group yourself (self-removal path) | `{conversationId, newOwnerId?, org?}` | `POST .../leave` |

- `role` ∈ `MEMBER \| ADMIN \| OWNER \| PUBLISHER \| SUBSCRIBER` (defaults to `MEMBER` server-side).
- **Owner can't just leave / remove self.** Removing yourself via `member_remove` / `member_remove_batch` is rejected (**400**) — use `comm.leave`. If the leaver is the group **owner**, cws-core requires a human successor: pass `{newOwnerId}` (a human member), or omit it to let cws-core pick a remaining human — self-removal by the owner is otherwise rejected with **409** while other human members remain (ownership must be transferred first). Remaining *agent* members do not block it; with only agents/nobody left the group is deleted.
- **Multi-org installs:** conversation-scoped commands resolve the org from the ambient (single-org) JWT by default; when more than one org is enabled, pass `{org}` (config key / org UUID / org_name) so the call routes through that org's token instead of yielding an identity-only-token **401**.

### Messages

| Status | Command | Description | Input | Real Endpoint |
| --- | --- | --- | --- | --- |
| ✅ | `comm.send` | Send a message; `content` supports string / markdown / array structure | `{conversationId, content, replyTo?, clientMsgId?, mentions?}` | `POST /api/v1/conversations/{id}/messages` |
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

`mentions` (cws-core `MentionInput[]`, the send-request shape: `{type:"member", member_id}` for one person, or `{type:"all"}` / `{type:"all_agents"}` to broadcast) makes an `@name` in the text actually wake its target — cws-comm only stores mentions the client explicitly supplies, it never parses `@name` out of the message text itself. (Don't confuse this with the read-path `MentionDisplay` shape a *received* message's own `mentions` field uses — `{mentioned_id, username?, is_mention_all}` — that's what a GET-message response returns after the server has already expanded a broadcast into one row per recipient; it is not what you send.)

- **Standard move before sending anything that @-mentions someone:** query that conversation's roster first — `comm.member_list {conversationId}` (or `core.member_list {search: "<name>"}` to search the whole org when you don't have a conversationId yet — see `core-operations.md`) — match your intended recipient's name against the returned list to get their `member_id`, then pass it explicitly as `mentions` (array of member_id strings, or `{type:"member", member_id}` objects).
- The exact literal broadcast labels `@所有人` / `@Everyone` (→ `all`, sweeps every human) or `@所有Agent` / `@所有agent` / `@All agents` (→ `all_agents`, sweeps every agent) need no lookup at all.
- The fullwidth `＠` (U+FF20) is accepted anywhere the ASCII `@` is, both for an individual name and the broadcast labels — a common CJK-input-method slip that would otherwise silently produce a mention-less message with no error.
- If `mentions` is omitted entirely, the CLI falls back to auto-resolving an individual `@name` against participants already seen in that conversation (`src/lib/mention.js`) — this is a best-effort convenience for the plain `c4-send.js` reply path (which has no parameter slot to carry an explicit id through), not the recommended way to compose an intentional mention, and it can't find someone who hasn't spoken in the conversation yet.

### Card messages (`type = CARD`) — buttons instead of a plain-text question

Cards are a first-class message type; **`comm.send` already supports them, no code change needed.** Reach for one whenever you'd otherwise ask the user to pick between a small set of answers (**yes/no, confirm/cancel, approve/reject**): send a **yes/no reply card** with buttons instead of a bare text question. The behavioral rule ("prefer a card for a choice") lives in `SKILL.md`; this section is the call mechanics.

**Two kinds of card — pick before you build:**

| | **Yes/No reply card** (`mode: "display"`) | **Business card** (`mode: "interactive"`) |
| --- | --- | --- |
| What a button does | posts an ordinary reply message on your behalf (`ui.quick_reply`) | drives a business object in another service via a registered `operation` |
| Who may send | anyone (human / agent / system) | **agent or system only** (human → 400) |
| Needs `context` | no | yes (`resource_type` + `resource_id` required) |
| Needs a registry entry | no (only the `ui` action set) | yes — the operation must be registered in cws-comm Go source |
| **Use this when** | **almost always — this is what you want for a yes/no / confirm prompt** | only when a click must mutate a real business object (e.g. `cws-work.issue.accept_plan`) |

**Three things named `type` — do not conflate them (most common mistake):**

| Level | Field | Card value |
| --- | --- | --- |
| message | `type` | `"CARD"` (uppercase — cws-core enum) |
| content | `content.content_type` | `"card"` (lowercase — cws-comm ContentType) |
| block | `content.body.blocks[i].type` | `text` / `markdown` / `fields` / … (unrelated to the two above) |

`type` and `content_type` **must be paired and are compared with exact case/whitespace** — `"Card"` or `"card "` are rejected. Uppercase `CARD` in your request and lowercase `card` in an error string are both correct; don't "fix" one to match the other.

**Minimal yes/no card (recommended form — `type` / `content` / `mentions` flat):**

```bash
node src/cli/comm.js comm.send '{"conversationId":"<conv-uuid>","type":"CARD",
  "content":{"content_type":"card","body":{
    "schema":"cws.card.v1",
    "kind":"demo.confirm",
    "mode":"display",
    "title":"Please confirm",
    "summary":"Continue with the deployment?",
    "blocks":[{"type":"text","text":"Staging verification passed. Continue deploying to production?"}],
    "actions":[
      {"id":"yes","label":"Yes","kind":"ui","operation":"ui.quick_reply","params":{"text":"Yes"},"style":"primary"},
      {"id":"no","label":"No","kind":"ui","operation":"ui.quick_reply","params":{"text":"No"}}
    ]
  }},
  "mentions":[{"type":"member","member_id":"<member-uuid-of-the-person-you-are-asking>"}]}'
```

`buildSendBody` copies `params.type` → message type, `params.content.content_type` / `params.content.body` through verbatim, and puts `params.mentions` (objects, or plain member_id strings) into the request (it also auto-adds `client_msg_id` and an empty `content.attachments`, both harmless). In a **group** the person you're asking must be in `mentions` or the card is just background noise; in a **DM** no mention is needed.

**`cws.card.v1` body — the 10 allowed top-level keys** (any extra key → 400):

| key | required | note |
| --- | --- | --- |
| `schema` | yes | literally `"cws.card.v1"` |
| `kind` | yes | your own business tag, `^[a-z][a-z0-9_.-]{2,63}$`; not registered, not interpreted |
| `mode` | yes | `display` or `interactive` |
| `title` | yes | non-empty, ≤ 200 code points |
| `summary` | yes | non-empty, ≤ 1000 code points |
| `blocks` | yes | 1–50 blocks (`text` ≤ 2000 cp, `markdown` ≤ 8192 **bytes** + restricted subset, `fields`, `divider`, `image`, `artifact_list`, `quote`) |
| `actions` | no | 0–5, each `id` unique on the card |
| `context` | interactive only | `resource_type` + `resource_id` required for `mode=interactive` |
| `layout` | no | only `{density: compact|normal}` |
| `supersedes` | no | replace an earlier interactive card (display cards ignore it) |

**`ui.quick_reply` action:** exactly one param `text` (≤ 200 cp) = the reply body posted as the user when they click. `label` (≤ 32 cp) is only the button caption and is **never** used to decide the answer — the answer is matched on `params.text`. Two `ui.quick_reply` on one card must have distinct `text` (trim + NFC, case-sensitive). The other `ui` actions are `ui.open_url` (https + host in `["app.coco.xyz"]`) and `ui.reply_with_context` (empty params).

**How you learn the user's answer** — the card link does **not** push an event to you. Two ways:
1. **Read it back:** `comm.get_message {conversationId, messageId}` → look at `card_state`. Present means answered; its **`action_id`** is the button id the user picked (compare `action_id`, not the label). Absent = not answered yet.
2. **Passive inbound:** clicking posts a normal reply whose text is the button's `params.text`, `parent_id` set to the card, and (because you're an agent) `@`-ing you — so it arrives as an ordinary inbound message. Method 1 is more reliable (it doesn't depend on the mention being delivered).

Reading `card_state` is also how you **confirm the send was stored as a card at all**: a 2xx + `id` alone doesn't prove it — only `card_body` (or `card_preview` + `card_truncated=true`) on read-back does. If neither is present, re-check that `type`/`content_type` were paired.

**⚠️ Current limitations (verify before relying — these move fast; re-checked 2026-08-20):**
- **cws-fe card rendering isn't merged to main yet** (MR !731). Until it is, a card degrades on screen to a single line of `fallback_text` with **no clickable buttons** — the user answers by typing (server-side, a typed `Yes` and a button click are identical, so a display card's quick-reply still resolves). Set a good `fallback_text` yourself for now.
- **Some deployed images may not yet accept the `CARD` enum** — cws-core then rejects at schema validation with **HTTP 422** `"validation failed"` (real reason only in `errors[]`, `location: body.type`), not the 400s in the card guide. If you hit that, the environment needs the newer cws-core/cws-comm images first.
- `fallback_text` is only settable via the **escape-hatch form** (the recommended flat form can't carry it): pass a pre-built object under `params.body` that has both `.type` and `.content`, and it's forwarded verbatim (only `client_msg_id` / `replyTo→parent_id` are added). **In this form `params.mentions` is ignored — put mentions inside `params.body.mentions`:**

```bash
node src/cli/comm.js comm.send '{"conversationId":"<conv-uuid>","body":{
  "type":"CARD",
  "content":{"content_type":"card","body":{ …cws.card.v1… }},
  "fallback_text":"[Please confirm] Continue with the deployment?",
  "mentions":[{"type":"member","member_id":"<member-uuid>"}]
}}'
```

Interactive/business cards, the full field-level spec (all seven block types, size table, the operation registry, error catalogue), and the pre-flight `comm.member_list` step to get `member_id` are documented in the card-message producer guide; the two verbs you need for the common yes/no case are exactly `comm.send` (above) and `comm.get_message` (read `card_state`).

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
