#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage: node send.js <endpoint> <message>');
  console.error('');
  console.error('Endpoint format:');
  console.error('  [COCO DM]/<conversationId>');
  console.error('  [COCO GROUP]/<conversationId>|reply:<messageId>');
  console.error('  [COCO THREAD]/<conversationId>|thread:<threadConvId>|parent:<parentMsgId>');
  process.exit(1);
}

const [endpoint, ...messageParts] = args;
const message = messageParts.join(' ');

// TODO: implement endpoint parsing
// TODO: implement text message sending via cws-comm API
// TODO: implement media upload (→ AS) + message sending
// TODO: implement thread reply routing
console.error('[zylos-coco-workspace] send.js not yet implemented');
process.exit(1);
