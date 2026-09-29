/**
 * OpenMax owner line in the agent's memory/references.md.
 *
 * The agent's AI context learns who its owner is from `memory/references.md`
 * (loaded at every session start), not from config.json. This module keeps
 * one line per org there:
 *
 *   - Owner (OpenMax <org_name> <org_id>): member_id <id>, display <name>
 *
 * Two writers share the same formatter so the line is byte-identical:
 *   - hooks/post-install.js writes it directly (writeOwnerReferences).
 *   - comm-bridge.js, on an owner change, asks the agent to write it
 *     (formatOwnerChangedMessage) — the bridge never edits memory itself
 *     while the session is live.
 *
 * Rules: replace the existing line for this org_id if there is one; else
 * append inside `## Active IDs`; else append that heading at the end. Never
 * delete anything, never touch the generic `- Owner:` line or other
 * channels' owner lines.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const OWNER_LINE_MARKER = '- Owner (OpenMax ';
const ACTIVE_IDS_HEADING = '## Active IDs';

/** ZYLOS_DIR or ~/zylos — resolved the same way as agent-readiness.js. */
export function resolveZylosDir(env = process.env) {
  return env.ZYLOS_DIR || path.join(env.HOME || os.homedir(), 'zylos');
}

/** Collapse any value to a single trimmed line (no control chars / newlines). */
export function sanitizeLine(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The org-identity boundary: everything before the FIRST occurrence of this
// string is `<org_name> <org_id>`, and the org_id is the last token there.
// That parse is unambiguous only if neither the org name nor the org id can
// contain the boundary, so both are normalized to make that impossible
// (org names may contain `)`, `):`, `(`, quotes, Markdown — only the exact
// boundary sequence is broken up; org ids never contain whitespace).
const ID_BOUNDARY = '): member_id ';

function sanitizeOrgId(orgId) {
  return sanitizeLine(orgId).replace(/\s+/g, '');
}

function sanitizeOrgName(orgName) {
  return sanitizeLine(orgName).replace(/\):(?= member_id)/g, ') :');
}

/** `- Owner (OpenMax <org_name> <org_id>)` — org_name omitted when empty. */
export function ownerLinePrefix({ orgId, orgName }) {
  const name = sanitizeOrgName(orgName);
  return `${OWNER_LINE_MARKER}${name ? `${name} ` : ''}${sanitizeOrgId(orgId)})`;
}

/** The full owner line, exactly as post-install writes it. */
export function formatOwnerLine({ orgId, orgName, memberId, name }) {
  const display = sanitizeLine(name) || '(unknown)';
  return `${ownerLinePrefix({ orgId, orgName })}: member_id ${sanitizeLine(memberId)}, display ${display}`;
}

/** org_id of an OpenMax owner line, or null if the line is not one. */
export function parseOwnerLineOrgId(line) {
  if (!line.startsWith(OWNER_LINE_MARKER)) return null;
  const boundary = line.indexOf(ID_BOUNDARY, OWNER_LINE_MARKER.length);
  if (boundary < 0) return null;
  const inner = line.slice(OWNER_LINE_MARKER.length, boundary);
  const id = inner.slice(inner.lastIndexOf(' ') + 1);
  return id || null;
}

/**
 * Pure: return `content` with the owner line for `orgId` replaced or added.
 * Returns the input unchanged when the line is already present verbatim.
 */
export function upsertOwnerLine(content, owner) {
  const orgId = sanitizeOrgId(owner.orgId);
  const newLine = formatOwnerLine(owner);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  const idx = lines.findIndex((l) => parseOwnerLineOrgId(l) === orgId);
  if (idx >= 0) {
    if (lines[idx] === newLine) return content;
    lines[idx] = newLine;
    return lines.join(eol);
  }

  const headingIdx = lines.findIndex((l) => l.trim() === ACTIVE_IDS_HEADING);
  if (headingIdx >= 0) {
    let end = lines.length;
    for (let i = headingIdx + 1; i < lines.length; i++) {
      if (/^#{1,2}\s/.test(lines[i])) { end = i; break; }
    }
    let insertAt = headingIdx + 1;
    for (let i = headingIdx + 1; i < end; i++) {
      if (/^\s*[-*+]\s/.test(lines[i])) insertAt = i + 1;
    }
    lines.splice(insertAt, 0, newLine);
    return lines.join(eol);
  }

  // No Active IDs section: append one at the end of the file.
  let out = content;
  if (out.length && !out.endsWith('\n')) out += eol;
  if (out.length && !/(\r?\n){2}$/.test(out)) out += eol;
  return `${out}${ACTIVE_IDS_HEADING}${eol}${newLine}${eol}`;
}

/**
 * Write the owner line for every org in `orgs` (config.orgs) that has an
 * owner.member_id. Never throws; returns per-org results for logging/tests.
 */
export function writeOwnerReferences({ orgs, zylosDir = resolveZylosDir(), log = console.log } = {}) {
  const results = [];
  try {
    const owned = Object.values(orgs || {}).filter((o) => o?.org_id && o?.owner?.member_id);
    if (!owned.length) return results;

    const refPath = path.join(zylosDir, 'memory', 'references.md');
    if (!fs.existsSync(refPath)) {
      log(`[install] ${refPath} not found — skipping owner memory write`);
      return results;
    }

    const original = fs.readFileSync(refPath, 'utf8');
    let content = original;
    for (const org of owned) {
      const next = upsertOwnerLine(content, {
        orgId: org.org_id,
        orgName: org.org_name,
        memberId: org.owner.member_id,
        name: org.owner.name,
      });
      results.push({ orgId: org.org_id, changed: next !== content });
      content = next;
    }

    if (content === original) {
      log('[install] references.md owner line(s) already up to date');
      return results;
    }
    const tmp = `${refPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, refPath);
    log(`[install] references.md owner line(s) written for ${results.filter((r) => r.changed).map((r) => r.orgId).join(', ')}`);
  } catch (err) {
    log(`[install] owner memory write failed (non-fatal): ${err.message}`);
  }
  return results;
}

/**
 * `[OWNER-CHANGED]` control message: an English instruction naming the exact
 * line to write, followed by the JSON payload.
 */
export function formatOwnerChangedMessage({ orgId, orgName, memberId, name, previousOwnerId, payload }) {
  const line = formatOwnerLine({ orgId, orgName, memberId, name });
  const prefix = ownerLinePrefix({ orgId, orgName });
  const orgLabel = sanitizeOrgName(orgName) || sanitizeOrgId(orgId);
  const display = sanitizeLine(name) || '(unknown)';
  const prev = sanitizeLine(previousOwnerId) || 'none';
  const instruction =
    `OpenMax owner of org "${orgLabel}" (${sanitizeOrgId(orgId)}) changed from ${prev} to ${display} (member_id ${sanitizeLine(memberId)}). ` +
    `Update ~/zylos/memory/references.md: under "${ACTIVE_IDS_HEADING}", replace (or add, if missing) the line starting with "${prefix}" with exactly: ${line}. ` +
    'Change only this line; do not modify other channels\' owner lines or the generic "- Owner:" line.';
  return `[OWNER-CHANGED] ${instruction} ${JSON.stringify(payload)}`;
}
