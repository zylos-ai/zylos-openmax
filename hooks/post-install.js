#!/usr/bin/env node

/**
 * Post-install hook for zylos-workspace.
 * Creates runtime data directories and initial config.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/workspace');

const INITIAL_CONFIG = {
  enabled: true,
  comm: {
    ws_url: 'ws://127.0.0.1:8080/ws',
    reconnect_max_delay: 30000,
    heartbeat_interval: 30000,
  },
  agent: {
    id: '',
    participant_id: '',
  },
  message: {
    context_messages: 10,
    dedup_ttl: 300000,
  },
};

const dirs = ['logs', 'media'];

for (const dir of dirs) {
  const p = path.join(DATA_DIR, dir);
  fs.mkdirSync(p, { recursive: true });
}

const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify(INITIAL_CONFIG, null, 2) + '\n');
  console.log('[zylos-workspace] created default config.json');
}

console.log('[zylos-workspace] post-install complete');
