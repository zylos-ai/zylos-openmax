#!/usr/bin/env node

/**
 * Communication CLI.
 * Wraps cws-comm HTTP API for proactive communication operations.
 * (Passive message receive/send is handled by comm-bridge.js)
 *
 * Usage: node comm.js <command> '<json>'
 * Example: node comm.js comm.send '{"conversationId":"conv-1","content":"hello"}'
 */

// TODO: implement comm.send, comm.create_dm, comm.create_thread,
//       comm.list_conversations, comm.get_messages, comm.update_read_cursor
