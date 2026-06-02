/**
 * WebSocket runtime-state persistence (multi-org).
 *
 * Each enabled org has its own WS connection and its own `last_seq`. We
 * persist them as a single file keyed by org slug so warm-restarts can
 * resume each org's stream without re-syncing the full backlog.
 *
 * File: ~/zylos/components/coco-workspace/runtime/session.json
 *
 * Schema:
 *   {
 *     "<orgSlug>": {
 *       org_id:     string,
 *       last_seq:   number,
 *       updated_at: number    // local epoch ms
 *     }
 *   }
 *
 * Best-effort atomic writes via tmp + rename.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/tmp';
const RUNTIME_DIR = path.join(HOME, 'zylos/components/coco-workspace/runtime');
const SESSION_PATH = path.join(RUNTIME_DIR, 'session.json');

function readAll() {
  try {
    const raw = fs.readFileSync(SESSION_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeAll(state) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const tmp = `${SESSION_PATH}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, SESSION_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

export function loadOrgSession(orgSlug) {
  const all = readAll();
  return all[orgSlug] || null;
}

export function saveOrgSession(orgSlug, partial) {
  const all = readAll();
  const current = all[orgSlug] || {};
  all[orgSlug] = { ...current, ...partial, updated_at: Date.now() };
  writeAll(all);
  return all[orgSlug];
}

export function clearOrgSession(orgSlug) {
  const all = readAll();
  if (!(orgSlug in all)) return;
  delete all[orgSlug];
  writeAll(all);
}

export { SESSION_PATH };
