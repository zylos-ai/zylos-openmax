/**
 * System skill directories (OPENM-1396), mirroring the market's exclusion
 * list in the M1 catalog contract v0.5.1 §6: skills the Agent needs to run
 * itself and to send and receive messages, matched by directory name, case
 * insensitive, `restart-` / `upgrade-` by prefix.
 *
 * ⚠️ This list ONLY decides whether a turn is judged complete: a direct read of
 * one of these SKILL.md files (the runtime reads comm-bridge's before its
 * first send, Memory Sync reads zylos-memory's) does not mark the turn's list
 * as possibly missing a skill. It NEVER filters what is reported — every
 * skill the turn called is sent, and cws-core K3 filters system skills with
 * the market's own list. If the two lists diverge, only the share of turns
 * judged complete changes, never what users see.
 */

const SYSTEM_SKILL_DIRS = new Set([
  // run / operate
  'activity-monitor', 'health-check', 'check-context', 'new-session',
  'component-management', 'http', 'dashboard', 'web-console', 'shell',
  // messaging, scheduling, memory
  'comm-bridge', 'scheduler', 'zylos-memory',
  // IM channel components
  'openmax', 'lark', 'feishu', 'telegram', 'wecom', 'dingtalk', 'whatsapp',
]);
const SYSTEM_SKILL_PREFIXES = ['restart-', 'upgrade-'];

/** Whether a skills/<dir> is a system skill (see the note above: completeness only). */
export function isSystemSkillDir(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  const d = dir.toLowerCase();
  return SYSTEM_SKILL_DIRS.has(d) || SYSTEM_SKILL_PREFIXES.some((p) => d.startsWith(p));
}
