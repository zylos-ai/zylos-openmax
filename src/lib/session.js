/**
 * Session token persistence — cross-process bridge between comm-bridge.js
 * (which performs the WebSocket handshake and receives the session token)
 * and scripts/send.js (which needs to authenticate without re-handshaking).
 *
 * State is stored as JSON at:
 *   ~/zylos/components/coco-workspace/runtime/session.json
 *
 * Schema:
 *   {
 *     session_token: string,
 *     user_id:       string,
 *     workspace_id:  string,
 *     server_time:   number,   // server epoch ms at handshake
 *     received_at:   number,   // local epoch ms at handshake
 *     last_seq:      number    // updated by comm-bridge as it processes frames
 *   }
 *
 * Concurrency note: this file is written by exactly one writer
 * (comm-bridge) and read by occasional callers (send.js). Best-effort
 * serialisation via atomic rename; if rename loses to a concurrent write,
 * the loser silently drops — both writers carry equivalent token state.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME || '/tmp';
const RUNTIME_DIR = path.join(HOME, 'zylos/components/coco-workspace/runtime');
const SESSION_PATH = path.join(RUNTIME_DIR, 'session.json');

export function loadSession() {
  try {
    const raw = fs.readFileSync(SESSION_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveSession(partial) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const current = loadSession() || {};
  const merged = { ...current, ...partial };
  const tmp = `${SESSION_PATH}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
    fs.renameSync(tmp, SESSION_PATH);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
  return merged;
}

export function clearSession() {
  try { fs.unlinkSync(SESSION_PATH); } catch {}
}

export { SESSION_PATH };
