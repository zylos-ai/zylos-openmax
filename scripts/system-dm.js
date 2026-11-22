#!/usr/bin/env node
/**
 * System private-chat exit: send a message to an OpenMax member's DM by member
 * id, from any thread. See src/lib/system-dm.js.
 *
 * Usage:
 *   node scripts/system-dm.js <member_id> <<'EOF'
 *   <text | [MEDIA:…] | [CARD]{…} | [STRUCTURED]{…}>
 *   EOF
 *   node scripts/system-dm.js <member_id> '<message>'
 *
 * COCO_ORG_ID selects the org when the Agent is in more than one.
 * Success: one JSON line on stdout
 *   {ok, member_id, conversation_id, created, message_id, result}, exit 0.
 * Failure: {error, code, …} on stderr, nothing on stdout, exit 1.
 */
import { sendSystemDm } from '../src/lib/system-dm.js';

// stdout carries only the result line: route HTTP client logs to stderr.
const writeOut = (line) => process.stdout.write(`${line}\n`);
console.log = console.info = console.debug = (...args) => console.error(...args);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const [memberId, ...rest] = process.argv.slice(2);
if (!memberId) {
  console.error('Usage: node scripts/system-dm.js <member_id> [message]   (message on stdin when omitted)');
  process.exit(1);
}
try {
  const message = rest.length ? rest.join(' ') : (process.stdin.isTTY ? '' : await readStdin());
  writeOut(JSON.stringify(await sendSystemDm({ memberId, message })));
  // Exit explicitly: the HTTP client may keep sockets or timers alive.
  process.exit(0);
} catch (e) {
  const payload = { error: e.message };
  for (const k of ['code', 'status', 'conversation_id', 'stderr', 'stdout']) if (e[k]) payload[k] = e[k];
  console.error(JSON.stringify(payload));
  process.exit(1);
}
