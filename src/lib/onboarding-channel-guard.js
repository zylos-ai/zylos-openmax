/**
 * Guard for the onboarding IM card (`cardKind: "onboarding.channel"`): the card
 * must offer EVERY channel `core.onboarding_profile_options` returns.
 *
 * 🔴 Why this exists. Each `im_channels` entry carries `visible: true|false`
 * (the first 5 true). That flag is only the client's DISPLAY hint for the
 * 「默认露 5 个 + 其他 N 个渠道」 collapse — the card renderer already collapses
 * any list to 5 + an expander on its own. An Agent read `visible:false` as
 * "don't show" and sent the card with 5 channels + 「都不用」, so the owner
 * could never pick the other 7. The skill text says so now; this makes it
 * deterministic: the send is refused, naming the missing channels, before
 * anything is posted.
 *
 * The check is a SET check — order is the caller's (and imOrder only changes
 * order), so the list is fetched without `im_order`. Labels are matched
 * against any of `label` / `label_zh` / `label_en`, so the card's language
 * does not matter either.
 *
 * cws-comm caps `onboarding.channel` at 16 options. When `im_channels` + the
 * decline option would exceed that, the documented rule is: the first 15
 * channels in the given order, then 「都不用」. That case is checked by count
 * (15 distinct channels present) since which 15 depends on the order.
 *
 * A failed fetch never blocks the send: the guard warns and lets the card go.
 */

export const ONBOARDING_CHANNEL_KIND = 'onboarding.channel';
export const ONBOARDING_CHANNEL_MAX_OPTIONS = 16;
const MAX_CHANNEL_OPTIONS = ONBOARDING_CHANNEL_MAX_OPTIONS - 1; // one slot for 「都不用」

export class OnboardingChannelGuardError extends Error {
  constructor(message, missing = []) {
    super(message);
    this.name = 'OnboardingChannelGuardError';
    this.field = 'options';
    this.missing = missing;
  }
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

function channelNames(ch) {
  return [ch?.label, ch?.label_zh, ch?.label_en, ch?.labelZh, ch?.labelEn]
    .map(norm)
    .filter(Boolean);
}

function displayName(ch) {
  return ch?.label || ch?.label_zh || ch?.label_en || ch?.type || '?';
}

/** Pull `im_channels` out of a profile-options response (enveloped or not). */
export function extractImChannels(res) {
  const list = res?.im_channels ?? res?.data?.im_channels;
  return Array.isArray(list) ? list : null;
}

/**
 * Throw if an `onboarding.channel` request leaves out any `im_channels` entry.
 *
 * @param {object} request  the built interaction-request body (buildChoiceRequest
 *   output, `{interaction_type, choice:{kind, options, …}}`), or a bare choice
 * @param {object} deps
 * @param {() => Promise<any>} deps.fetchProfileOptions  GET /onboarding/profile-options
 * @param {(msg:string) => void} [deps.warn]
 * @param {string} [verb]  name used in the error ("comm.ask_card" / "[CARD]")
 * @returns {Promise<{checked:boolean, reason?:string}>}
 */
export async function assertAllImChannels(request, deps = {}, verb = 'comm.ask_card') {
  const choice = request?.choice ?? request;
  if (choice?.kind !== ONBOARDING_CHANNEL_KIND) return { checked: false, reason: 'not an onboarding.channel card' };
  const warn = deps.warn || ((m) => console.warn(m));

  let channels;
  try {
    channels = extractImChannels(await deps.fetchProfileOptions());
  } catch (err) {
    warn(`[${verb}] onboarding.channel guard skipped: could not fetch im_channels (${err?.message || err}); sending the card unchecked`);
    return { checked: false, reason: 'fetch failed' };
  }
  if (!channels || channels.length === 0) {
    warn(`[${verb}] onboarding.channel guard skipped: profile-options returned no im_channels; sending the card unchecked`);
    return { checked: false, reason: 'no im_channels' };
  }

  const offered = new Set(
    (choice.options || [])
      .filter((o) => o && o.decline !== true)
      .map((o) => norm(o.label)),
  );
  const isOffered = (ch) => channelNames(ch).some((n) => offered.has(n));

  const present = channels.filter(isOffered);
  const missing = channels.filter((ch) => !isOffered(ch));
  const required = Math.min(channels.length, MAX_CHANNEL_OPTIONS);
  if (present.length >= required) return { checked: true };

  const missingNames = missing.map(displayName);
  const capNote = channels.length > MAX_CHANNEL_OPTIONS
    ? ` (im_channels has ${channels.length}; over the ${ONBOARDING_CHANNEL_MAX_OPTIONS}-option cap, send the first ${MAX_CHANNEL_OPTIONS} in the given order, then the decline option)`
    : '';
  throw new OnboardingChannelGuardError(
    `${verb}: onboarding.channel card refused — it offers ${present.length} of the ${channels.length} im_channels; missing: ${missingNames.join(', ')}${capNote}. `
      + 'Send EVERY im_channels entry from core.onboarding_profile_options (visible:true AND visible:false), in the given order, '
      + 'then 「都不用，就在这儿聊」 with decline:true last. `visible` is only the client\'s display hint for the '
      + '「5 + 其他 N 个渠道」 collapse — the card collapses the list itself; it never means "leave this channel out". Nothing was sent.',
    missingNames,
  );
}
