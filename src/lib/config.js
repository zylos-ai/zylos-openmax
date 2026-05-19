/**
 * Configuration loader with hot-reload support.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const CONFIG_PATH = path.join(HOME, 'zylos/components/coco-workspace/config.json');

export const DEFAULT_CONFIG = {
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

let currentConfig = null;

export function loadConfig() {
  if (currentConfig) return currentConfig;

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    currentConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    currentConfig = { ...DEFAULT_CONFIG };
  }

  return currentConfig;
}

export function watchConfig(onChange) {
  let debounce = null;
  let watcher;
  try {
    watcher = fs.watch(CONFIG_PATH, () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        currentConfig = null;
        const config = loadConfig();
        onChange?.(config);
      }, 100);
    });
  } catch (err) {
    // File may not exist yet (e.g. before post-install). The bridge can
    // still run on DEFAULT_CONFIG; we just skip hot-reload until the
    // operator creates the file and restarts the service.
    console.warn(`[config] cannot watch ${CONFIG_PATH}: ${err.message} — hot reload disabled`);
    return () => {};
  }
  return () => {
    clearTimeout(debounce);
    watcher.close();
  };
}
