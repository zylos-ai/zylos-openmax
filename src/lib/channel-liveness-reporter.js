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
 * individually guarded. A 404 is NOT transient (the route isn't deployed on
 * this host), so after `disable404Threshold` consecutive 404s the reporter
 * STOPS issuing the PUT — warned ONCE — and re-probes only every
 * `reprobeEveryTicks` ticks, so a doomed call no longer makes the HTTP client
 * log an `[rpc]` request+response pair every ~60s (see issue #72). A later
 * successful probe re-enables it. Transient/other errors (5xx, network) keep
 * retrying unchanged.
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
  // Endpoint-absent backoff (issue #72). A 404 on the channel-liveness endpoint
  // is NOT transient — it means cws-core hasn't deployed the route on this host.
  // After this many consecutive 404s, stop issuing the PUT entirely so the
  // shared HTTP client stops logging an `[rpc]` request+response pair every
  // tick (the actual error.log flood). Default 1 = disable on the first 404.
  disable404Threshold = 1,
  // While disabled, re-probe once every this many ticks so the reporter
  // self-heals when the endpoint is eventually deployed. At the ~60s tick, 30
  // ≈ once every 30 min (a single log pair per probe, vs a pair every 60s).
  // Set to 0 to disable re-probing (stay off until the process restarts).
  reprobeEveryTicks = 30,
} = {}) {
  let warnedPm2Unavailable = false; // pm2 jlist failing/empty — re-armed on success
  let consecutive404 = 0;           // consecutive 404s seen (reset by any non-404 outcome)
  let disabledFor404 = false;       // endpoint declared absent → PUT suppressed
  let ticksSinceDisabled = 0;       // re-probe counter while disabled

  return async function reportChannelLiveness() {
    try {
      // Endpoint-absent backoff: once the endpoint has consistently 404'd we
      // STOP calling it (not just muting our own warn) — the HTTP client logs
      // an `[rpc]` request+response pair on every call, so continuing to fire a
      // doomed PUT every ~60s is what floods error.log. Re-probe sparsely so the
      // reporter recovers on its own once cws-core ships the endpoint.
      if (disabledFor404) {
        ticksSinceDisabled += 1;
        if (reprobeEveryTicks <= 0 || ticksSinceDisabled < reprobeEveryTicks) return;
        ticksSinceDisabled = 0; // this tick is a re-probe attempt
      }

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
        // Success — clear any 404 backoff. If we were disabled, this was a
        // re-probe that found the endpoint newly deployed: announce recovery.
        if (disabledFor404) {
          log?.(`[${slug}] channel-liveness endpoint recovered — resuming reports`);
        }
        disabledFor404 = false;
        consecutive404 = 0;
        log?.(`[${slug}] channel-liveness reported: ${onlineCount}/${CHANNEL_TYPES.length} channels online`);
      } catch (err) {
        if (err.status === 404) {
          consecutive404 += 1;
          // Cross the threshold once → disable + log ONCE (info/warn, not the
          // per-tick error pair). Further 404s while disabled stay silent.
          if (!disabledFor404 && consecutive404 >= disable404Threshold) {
            disabledFor404 = true;
            ticksSinceDisabled = 0;
            const reprobeNote = reprobeEveryTicks > 0
              ? ` — will re-probe every ${reprobeEveryTicks} ticks`
              : ' — will not re-probe until restart';
            warn(`[${slug}] channel-liveness endpoint returns 404 (not deployed?); disabling reporter after ${consecutive404} attempt(s)${reprobeNote}`);
          }
        } else {
          // Transient / other error (5xx, network) → keep retrying as before,
          // and reset the 404 streak so a later 404 run starts counting fresh.
          consecutive404 = 0;
          warn(`[${slug}] channel-liveness report failed: ${err.message}`);
        }
      }
    } catch (err) {
      // Never throw into the shared metrics tick — best-effort only.
      warn(`channel-liveness report error: ${err?.message || err}`);
    }
  };
}
