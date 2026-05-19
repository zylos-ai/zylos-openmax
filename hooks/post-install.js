#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { DEFAULT_CONFIG } from '../src/lib/config.js';

const HOME = process.env.HOME;
const DATA_DIR = path.join(HOME, 'zylos/components/coco-workspace');

const dirs = ['logs', 'media'];

for (const dir of dirs) {
  const p = path.join(DATA_DIR, dir);
  fs.mkdirSync(p, { recursive: true });
}

const configPath = path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  console.log('[zylos-coco-workspace] created default config.json');
}

console.log('[zylos-coco-workspace] post-install complete');
