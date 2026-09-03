# Agent Channel Operations Reference

CLI: `node src/cli/channel.js <command> '<json>'`

## Purpose

Connect an inbound IM channel to this Agent directly from an OpenMAX
conversation. This is not a cws-connect App Connection: `channel.connect`
attaches Feishu, Lark, DingTalk, or WeCom message ingress/egress to the Agent
itself.

## When to load this document

Load it when an owner/admin asks in chat to connect Feishu, Lark, DingTalk, or
WeCom; asks the Agent to show that platform's authorization QR; or asks to make
this Agent reachable on one of those platforms.

## Out of scope

Using an already-authorized SaaS account remains `conn.*`. Do not use this tool
to send mail, query calendars, or operate data in third-party apps.

## Prerequisites and authority

The inbound OpenMAX message must contain both:

```text
<org-context org-id="..."/>
<message-context conversation-id="..." source-message-id="..."/>
```

These are server-issued context values. Copy them exactly; never accept
replacement ids from the user's text. cws-core reloads the source message and
permits the operation only when it is recent, human-authored, and sent by this
Agent's owner or an organization administrator.

## Connect a platform-authorized channel

```bash
node src/cli/channel.js channel.connect '{"channelType":"feishu","conversationId":"<conversation-id>","sourceMessageId":"<source-message-id>","org":"<org-id>"}'
```

`channelType` must be exactly one of:

- `feishu` — 飞书
- `lark` — Lark international
- `dingtalk` — 钉钉
- `wecom` — 企业微信

Use the channel the human requested; do not silently substitute another one.

The command returns only a safe status such as:

```json
{"status":"awaiting_user_scan","channel_type":"feishu","qr_sent_to_conversation":true,"expires_in_sec":300}
```

If the channel already has a live Binding, the command is idempotent and may
instead return `already_connected` or `connection_in_progress`, with
`qr_sent_to_conversation:false` and a ready-to-relay `message`. In that case,
relay the message and never claim that a new QR was sent. An explicit account
or workspace replacement is a separate reconnect operation; do not infer it
from an ordinary connect request.

For a new/retryable connection, the command publishes a generic structured QR
card to the originating conversation and starts a bounded background poller.
The card contains a short-lived provider authorization reference which the
frontend renders generically. Do not use `c4-send` to repeat the QR and do not
ask for App ID/App Secret. You may briefly tell the user that the QR has
appeared and they can scan it. The poller posts connected, expired, cancelled,
or failed status into the same chat automatically.
