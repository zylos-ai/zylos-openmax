/**
 * WebSocket runtime-state persistence.
 *
 * In this architecture REST always uses the agent's api_key (via cws-core),
 * so the cws-comm session_token is NOT a cross-process REST credential.
 * It only authenticates WebSocket frames on the direct cws-comm link.
 *
 * We still persist a small amount of runtime state across restarts so a
 * warm-restart can present `last_seq` in its ConnectRequest and avoid
 * re-syncing the full backlog.
 *
 * State is stored as JSON at:
 *   ~/zylos/components/coco-workspace/runtime/session.json
 *
 * Schema:
 *   {
 *     user_id:       string,   // own participant id (from connect_response)
 *     workspace_id:  string,
 *     server_time:   number,   // server epoch ms at last handshake
 *     received_at:   number,   // local epoch ms at last handshake
 *     last_seq:      number,   // updated as comm-bridge processes frames
 *     session_token: string    // optional, opaque to other processes; kept
 *                              // only for diagnostic / future WS reuse
 *   }
 *
 * Best-effort atomic writes via tmp + rename. Single-writer (comm-bridge),
 * occasional readers (send.js for diagnostics).
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
