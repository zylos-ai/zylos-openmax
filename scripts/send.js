#!/usr/bin/env node

/**
 * C4 standard send interface.
 * Called by c4-send to deliver Agent responses back to COCO Workspace.
 *
 * Usage: node send.js <endpoint> <message>
 *
 * Endpoint format:
 *   [COCO DM]/<conversationId>
 *   [COCO GROUP]/<conversationId>|reply:<messageId>
 *   [COCO THREAD]/<conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 *
 * Message may contain media prefix:
 *   [MEDIA:image]/path/to/file.png
 *   [MEDIA:file]/path/to/doc.pdf
 */

// TODO: implement endpoint parsing
// TODO: implement text message sending via cws-comm API
// TODO: implement media upload (→ AS) + message sending
// TODO: implement thread reply routing
