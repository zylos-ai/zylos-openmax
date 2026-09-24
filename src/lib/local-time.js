/**
 * Render an instant in the agent's configured timezone.
 *
 * Every timestamp this process handles arrives as UTC — the server sends
 * `settled_at` as ISO-8601 with a `Z`, and `new Date().toISOString()` produces
 * the same. Printed as-is, a receipt says `12:30` for something that happened
 * at 20:30 where the person reading it lives, and the reader either does the
 * arithmetic or, more often, misreads the answer as hours older than it is.
 *
 * 🔴 This is for DISPLAY only. The machine-readable copies stay UTC and stay
 * ISO: `<interaction-receipt settled-at="…"/>`, the `askedAt` written into
 * pending-questions.json, and anything compared against `Date.now()`. A local
 * rendering is ambiguous the moment it leaves the machine that made it (no
 * offset survives a `2026-09-24 20:30` string), so the two must not be swapped
 * for each other — which is why every call site here keeps the raw value
 * alongside rather than replacing it.
 *
 * The zone comes from `TZ` in the process environment, which zylos sets from
 * its own `.env` (`TZ=Asia/Singapore` at the time of writing) and pm2 passes
 * through. When `TZ` is unset, `Intl` falls back to the host zone, which is the
 * best available guess and is what every other tool on the box already prints.
 */

/**
 * `2026-09-24 20:30:12 (+08:00)`, or null when the input is not a time.
 *
 * The offset is part of the output on purpose: without it the string is a wall
 * clock with no zone, and a reader who is not on this machine cannot tell which
 * one it is. Returning null (rather than throwing or echoing the input) lets a
 * caller decide between the local form and the raw one.
 */
export function formatLocalTime(value, { timeZone = process.env.TZ } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    const at = (type) => parts.find((p) => p.type === type)?.value || '';
    const offset = at('timeZoneName').replace(/^GMT/, '') || '+00:00';
    const hour = at('hour') === '24' ? '00' : at('hour');
    return `${at('year')}-${at('month')}-${at('day')} ${hour}:${at('minute')}:${at('second')} (${offset})`;
  } catch {
    // An invalid TZ name makes Intl throw. A wrong-looking clock is worse than
    // no clock, so fall back to the caller's raw value by saying nothing.
    return null;
  }
}

/**
 * `<local> (<raw ISO>)` for a line a person reads, or the raw value alone when
 * it cannot be parsed. Both halves stay, because the local half is the readable
 * one and the raw half is the one that can be pasted somewhere else and still
 * mean the same instant.
 */
export function formatLocalWithRaw(value) {
  const local = formatLocalTime(value);
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (!local) return raw;
  return `${local} · ${raw}`;
}
