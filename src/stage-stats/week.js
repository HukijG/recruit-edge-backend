/**
 * London-aware Mon–Sun week windows, DST-correct, dependency-free.
 *
 * The dashboard computes the same boundary with chrono-tz; both are IANA-driven
 * so they agree except within the DST-transition instant itself, which never
 * coincides with a London midnight (UK transitions happen at 01:00 GMT).
 *
 * All functions take/return UTC epoch milliseconds.
 */

const LONDON_PARTS_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** London wall-clock fields at the given instant. */
function londonWallClock(ms) {
  const parts = {};
  for (const p of LONDON_PARTS_FMT.formatToParts(ms)) {
    if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  }
  return parts;
}

/**
 * The UTC instant at which the London wall clock reads `YYYY-MM-DD 00:00:00`.
 *
 * Guess UTC midnight, measure how far the London wall clock at the guess is
 * from the target, and correct. London midnight never falls inside a DST gap
 * (transitions are at 01:00 GMT), so two iterations always converge.
 */
function londonMidnightUtcMs(year, month, day) {
  const target = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const w = londonWallClock(guess);
    const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    const diff = wallAsUtc - target;
    if (diff === 0) return guess;
    guess -= diff;
  }
  return guess;
}

/** The Monday (as {year, month, day}) of the London local date containing `ms`. */
function mondayOfLondonDate(ms) {
  const w = londonWallClock(ms);
  // Pure date arithmetic on the London calendar date (safe at UTC: no tz here,
  // just walking a y/m/d triple back to its Monday).
  const dateUtc = Date.UTC(w.year, w.month - 1, w.day);
  const sinceMonday = (new Date(dateUtc).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(dateUtc - sinceMonday * 86_400_000);
  return {
    year: monday.getUTCFullYear(),
    month: monday.getUTCMonth() + 1,
    day: monday.getUTCDate(),
  };
}

/** Shift a {year, month, day} triple by whole days (calendar-date arithmetic). */
function shiftDate({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * The Mon–Sun week containing `nowMs`: Monday 00:00 Europe/London through the
 * NEXT Monday 00:00 Europe/London, both as UTC epoch ms. The end boundary is
 * re-resolved through the timezone (not start + 7×24h) so DST-transition weeks
 * are 167h/169h as appropriate.
 *
 * @param {number} nowMs
 * @returns {{ startMs: number, endMs: number }}
 */
export function currentWeekWindowLondon(nowMs) {
  const monday = mondayOfLondonDate(nowMs);
  const next = shiftDate(monday, 7);
  return {
    startMs: londonMidnightUtcMs(monday.year, monday.month, monday.day),
    endMs: londonMidnightUtcMs(next.year, next.month, next.day),
  };
}

/**
 * Monday 00:00 Europe/London of the week BEFORE the one containing `nowMs`,
 * as UTC epoch ms.
 *
 * @param {number} nowMs
 * @returns {number}
 */
export function previousWeekStartLondon(nowMs) {
  const monday = mondayOfLondonDate(nowMs);
  const prev = shiftDate(monday, -7);
  return londonMidnightUtcMs(prev.year, prev.month, prev.day);
}

/**
 * The London local calendar date containing `ms`, as `YYYY-MM-DD`. Used as the
 * day-granular `last_activity after` floor for RF candidate/search walks.
 *
 * @param {number} ms
 * @returns {string}
 */
export function londonDateString(ms) {
  const w = londonWallClock(ms);
  const mm = String(w.month).padStart(2, '0');
  const dd = String(w.day).padStart(2, '0');
  return `${w.year}-${mm}-${dd}`;
}
