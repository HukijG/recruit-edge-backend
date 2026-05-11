/**
 * Resolve a Dialpad-call time window from the body of /mcp/candidate-call-notes
 * step=list_calls.
 *
 * Primary path: explicit ISO bounds (started_after / started_before). The MCP
 * tool description tells Claude to prefer this — Claude is excellent at
 * computing windows from natural language, knows the user's TZ, and can
 * interpret phrases this parser deliberately does NOT cover (e.g. "around
 * 3pm yesterday").
 *
 * Fallback path: time_query — a small, well-defined natural-language pattern
 * set. Anything outside the patterns falls back to the 7-day default with a
 * warning so Claude can decide whether to retry with ISO bounds.
 *
 * Returns {startedAfterMs, startedBeforeMs, source: 'iso'|'time_query'|'default', warnings: string[]}.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const DEFAULT_DAYS = 7;

const WEEKDAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function isValidIsoMs(s) {
  if (typeof s !== 'string' || !s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

function ymdMidnightUtcMs(y, mZeroBased, d) {
  return Date.UTC(y, mZeroBased, d, 0, 0, 0, 0);
}

function mostRecentWeekdayMidnightUtcMs(now, targetIdx) {
  const d = new Date(now);
  const day = d.getUTCDay();
  let delta = day - targetIdx;
  if (delta <= 0) delta += 7;       // "Monday" said on Monday means the previous Monday
  const target = ymdMidnightUtcMs(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - delta * DAY;
  return target;
}

function parseTimeQuery(raw, now) {
  if (typeof raw !== 'string') return null;
  const q = raw.trim().toLowerCase();
  if (!q) return null;

  if (q === 'most recent' || q === 'recent') {
    return { startedAfterMs: now - DEFAULT_DAYS * DAY, startedBeforeMs: now };
  }

  // last hour / last N hour(s)
  let m = q.match(/^last (\d+) hours?$/);
  if (m) return { startedAfterMs: now - Number(m[1]) * HOUR, startedBeforeMs: now };
  if (q === 'last hour') return { startedAfterMs: now - HOUR, startedBeforeMs: now };

  if (q === 'today') return { startedAfterMs: now - 24 * HOUR, startedBeforeMs: now };
  if (q === 'yesterday') return { startedAfterMs: now - 48 * HOUR, startedBeforeMs: now - 24 * HOUR };
  if (q === 'this morning') return { startedAfterMs: now - 12 * HOUR, startedBeforeMs: now };
  if (q === 'this afternoon') return { startedAfterMs: now - 8 * HOUR, startedBeforeMs: now };
  if (q === 'this evening') return { startedAfterMs: now - 4 * HOUR, startedBeforeMs: now };
  if (q === 'yesterday afternoon') return { startedAfterMs: now - 32 * HOUR, startedBeforeMs: now - 24 * HOUR };
  if (q === 'yesterday evening') return { startedAfterMs: now - 28 * HOUR, startedBeforeMs: now - 20 * HOUR };

  if (q === 'this week') {
    // Last Monday 00:00 UTC → now.
    const monday = mostRecentWeekdayMidnightUtcMs(now, 1);
    return { startedAfterMs: monday, startedBeforeMs: now };
  }

  if (q === 'last week' || q === 'past week') {
    return { startedAfterMs: now - 7 * DAY, startedBeforeMs: now };
  }

  m = q.match(/^last (\d+) days?$/) || q.match(/^(\d+) days? ago$/);
  if (m) return { startedAfterMs: now - Number(m[1]) * DAY, startedBeforeMs: now };

  m = q.match(/^last (\d+) weeks?$/);
  if (m) return { startedAfterMs: now - Number(m[1]) * 7 * DAY, startedBeforeMs: now };

  if (q in WEEKDAY_INDEX) {
    const wd = mostRecentWeekdayMidnightUtcMs(now, WEEKDAY_INDEX[q]);
    return { startedAfterMs: wd - 36 * HOUR, startedBeforeMs: wd + 36 * HOUR };
  }

  // YYYY-MM-DD
  m = q.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const [, y, mo, d] = m;
    const start = ymdMidnightUtcMs(Number(y), Number(mo) - 1, Number(d));
    return { startedAfterMs: start, startedBeforeMs: start + 24 * HOUR };
  }

  return null; // unrecognised
}

export function resolveTimeWindow(body) {
  const now = Date.now();
  const warnings = [];

  const afterMs = isValidIsoMs(body?.started_after);
  const beforeMs = isValidIsoMs(body?.started_before);

  // Invalid ISO surfaces as a warning whether or not we fall through.
  if (typeof body?.started_after === 'string' && body.started_after && afterMs === null) {
    warnings.push(`invalid started_after "${body.started_after}" — not a parseable ISO 8601 string`);
  }
  if (typeof body?.started_before === 'string' && body.started_before && beforeMs === null) {
    warnings.push(`invalid started_before "${body.started_before}" — not a parseable ISO 8601 string`);
  }

  if (afterMs !== null) {
    if (typeof body?.time_query === 'string' && body.time_query.trim()) {
      warnings.push('dropped time_query — explicit started_after wins');
    }
    return {
      startedAfterMs: afterMs,
      startedBeforeMs: beforeMs ?? now,
      source: 'iso',
      warnings,
    };
  }

  const fromQuery = parseTimeQuery(body?.time_query, now);
  if (fromQuery) {
    return { ...fromQuery, source: 'time_query', warnings };
  }

  if (typeof body?.time_query === 'string' && body.time_query.trim()) {
    warnings.push(`unrecognised time_query "${body.time_query.trim()}" — defaulted to last 7 days; pass started_after/started_before for an exact window`);
  }

  return {
    startedAfterMs: now - DEFAULT_DAYS * DAY,
    startedBeforeMs: now,
    source: 'default',
    warnings,
  };
}
