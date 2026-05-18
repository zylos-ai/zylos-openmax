#!/usr/bin/env node

/**
 * Communication bridge: WebSocket connection to cws-comm, forwarding messages to C4 bridge.
 * This is the PM2 service entry point.
 */

import { loadConfig } from './lib/config.js';

const config = loadConfig();

// TODO: implement WebSocket connection to cws-comm
// TODO: implement message receive → c4-receive forwarding
// TODO: implement reconnection with exponential backoff
// TODO: implement heartbeat and sync:request for gap recovery

console.log('[zylos-workspace] comm-bridge starting...');
console.log('[zylos-workspace] not yet implemented');
