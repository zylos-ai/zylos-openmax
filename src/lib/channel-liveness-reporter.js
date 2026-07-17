/**
 * Channel-liveness reporter — enumerates the 13 IM channel components' pm2
 * online/offline status and PUTs it to cws-core
 * (`PUT /api/v1/agents/{member_id}/channel-liveness`, HTTP 202) on the same
 * ~60s periodic tick that drives runtime-metrics (see src/comm-bridge.js).
 *
 * pm2 enumeration + channel mapping
 * ---------------------------------
 * The channel → pm2-process mapping is the existing `CHANNEL_COMPONENT` table
 * from src/lib/channel-connector.js (the same table `defaultVerify` health-
 * checks against). Its keys ARE the cws-connect catalog `channel_type` strings
 * (lark, telegram, dingtalk, feishu, wecom, line, zalo, ms_teams, slack,
 * whatsapp_business, discord, wechat, whatsapp), and each entry's `pm2Service`
 * is the pm2 process name. pm2 status is read once per tick via the shared
 * `readPm2Statuses` helper (single `pm2 jlist`), NOT reinvented here.
 *
 * Org / member targeting — mirrors the runtime-metrics self-report
 * ----------------------------------------------------------------
 * A single PUT per tick to the PRIMARY org only — the same org/member that
 * runtime-metrics targets, resolved via the shared `selectPrimaryOrg` helper
 * (metrics-reporter.js) so the two reports stay consistent. The org's own
 * `self.member_id` is the path member id (cws-core derives identity from the
 * JWT; the path must be the caller's own member id — self-report). cws-connect
 * keys channel state on identity (cross-org-stable), so one report under the
 * primary org is sufficient — per-org would be redundant. Reuses the
 * authenticated org-scoped client (`putForOrg` / `apiPath` from client.js), so
 * there is no new HTTP or auth path. Identity is NOT placed in the body.
 *
 * Safety guard (required)
 * -----------------------
 * If `pm2 jlist` fails or returns nothing, the whole tick is SKIPPED (warned
 * once, re-armed on the next healthy read) — we never report "all 13 offline"
 * on a pm2 error, which would falsely flap every channel down.
 *
 * Best-effort: the report never throws into the metrics loop; every PUT is
 * individually guarded and a missing endpoint (404) is warned once then
 * skipped (mirrors runtime-metrics' 404 handling — E2E is pending the cws-core
 * channel-liveness endpoint being deployed to the targeted environment).
 *
 * Deps are injected so the logic is unit-testable without pm2, a live
 * cws-core, or the comm-bridge daemon (see channel-liveness-reporter.test.js).
 */

import { putForOrg as realPutForOrg, apiPath as realApiPath } from './client.js';
import { selectPrimaryOrg } from './metrics-reporter.js';
import {
  CHANNEL_COMPONENT,
  readPm2Statuses as realReadPm2Statuses,
} from './channel-connector.js';

// The 13 cws-connect catalog channel_type values (authoritative order). Each
// MUST exist in CHANNEL_COMPONENT — asserted at module load so a future
// catalog/table drift fails loudly rather than silently dropping a channel.
export const CHANNEL_TYPES = [
  'lark',
  'telegram',
  'dingtalk',
  'feishu',
  'wecom',
  'line',
  'zalo',
  'ms_teams',
  'slack',
  'whatsapp_business',
  'discord',
  'wechat',
  'whatsapp',
];

for (const ct of CHANNEL_TYPES) {
  if (!CHANNEL_COMPONENT[ct]?.pm2Service) {
    throw new Error(`channel-liveness: no CHANNEL_COMPONENT.pm2Service for "${ct}"`);
  }
}

export function createChannelLivenessReporter(activeOrgConfigs, {
  log,
  warn,
  putForOrg = realPutForOrg,
  apiPath = realApiPath,
  readPm2Statuses = realReadPm2Statuses,
} = {}) {
  let warnedPm2Unavailable = false; // pm2 jlist failing/empty — re-armed on success
  let warnedEndpoint404 = false;    // cws-core channel-liveness endpoint missing

  return async function reportChannelLiveness() {
    try {
      // Safety guard: null = pm2 unavailable / unparseable, empty = pm2 online
      // but reporting no processes. Either way, skip this tick — never report
      // "all offline" on a pm2 error.
      const byName = await readPm2Statuses();
      if (!byName || byName.size === 0) {
        if (!warnedPm2Unavailable) {
          warnedPm2Unavailable = true;
          warn('pm2 jlist unavailable/empty — channel-liveness not reported this tick');
        }
        return;
      }
      warnedPm2Unavailable = false; // recovered — re-arm the once-guard

      const channels = CHANNEL_TYPES.map((channel_type) => ({
        channel_type,
        online: byName.get(CHANNEL_COMPONENT[channel_type].pm2Service) === true,
      }));
      const payload = { channels };
      const onlineCount = channels.reduce((n, c) => n + (c.online ? 1 : 0), 0);

      // Self-report to the PRIMARY org only — same target as runtime-metrics.
      const primary = selectPrimaryOrg(activeOrgConfigs);
      if (!primary) {
        warn('no active org configured — channel-liveness not reported');
        return;
      }
      const { slug, orgConfig, selfMemberId } = primary;
      if (!selfMemberId) {
        warn(`[${slug}] primary org has no self.member_id — channel-liveness not reported`);
        return;
      }
      try {
        await putForOrg(
          orgConfig.org_id,
          apiPath(`/agents/${selfMemberId}/channel-liveness`),
          payload,
        );
        log?.(`[${slug}] channel-liveness reported: ${onlineCount}/${CHANNEL_TYPES.length} channels online`);
      } catch (err) {
        if (err.status === 404) {
          if (!warnedEndpoint404) {
            warn(`[${slug}] channel-liveness endpoint not available (404), skipping`);
            warnedEndpoint404 = true;
          }
        } else {
          warn(`[${slug}] channel-liveness report failed: ${err.message}`);
        }
      }
    } catch (err) {
      // Never throw into the shared metrics tick — best-effort only.
      warn(`channel-liveness report error: ${err?.message || err}`);
    }
  };
}
