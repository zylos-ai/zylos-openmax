/**
 * Message parsing (COCO Message → C4 format) and formatting (C4 response → COCO Message).
 *
 * Inbound format (to C4 bridge):
 *   [COCO DM] 张三 said: message content
 *   [COCO GROUP] 张三 said: [Group context - recent messages:] ... [Current message:] ...
 *   [COCO THREAD] 张三 said: [Thread context:] ... [Current message:] ...
 *
 * Endpoint format:
 *   [COCO DM]/<conversationId>
 *   [COCO GROUP]/<conversationId>|reply:<messageId>
 *   [COCO THREAD]/<conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 */

// TODO: implement inbound message formatting (COCO Message → C4 text)
// TODO: implement outbound message parsing (C4 response → COCO API call params)
// TODO: implement context building (fetch recent messages for group/thread context)
