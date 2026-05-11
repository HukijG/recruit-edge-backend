import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveTimeWindow } from '../src/mcp/call-notes-time.js';

const NOW = new Date('2026-05-10T12:00:00Z').getTime(); // Sunday 12:00 UTC

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('resolveTimeWindow — defaults & ISO path', () => {
  it('returns 7-day default when nothing is set', () => {
    const out = resolveTimeWindow({});
    expect(out.source).toBe('default');
    expect(out.startedBeforeMs).toBe(NOW);
    expect(out.startedAfterMs).toBe(NOW - 7 * DAY);
    expect(out.warnings).toEqual([]);
  });

  it('honours started_after + started_before as ISO; source=iso', () => {
    const out = resolveTimeWindow({
      started_after: '2026-05-03T00:00:00Z',
      started_before: '2026-05-09T00:00:00Z',
    });
    expect(out.source).toBe('iso');
    expect(out.startedAfterMs).toBe(Date.parse('2026-05-03T00:00:00Z'));
    expect(out.startedBeforeMs).toBe(Date.parse('2026-05-09T00:00:00Z'));
    expect(out.warnings).toEqual([]);
  });

  it('started_after only → started_before defaults to now', () => {
    const out = resolveTimeWindow({ started_after: '2026-05-03T00:00:00Z' });
    expect(out.source).toBe('iso');
    expect(out.startedBeforeMs).toBe(NOW);
  });

  it('ISO wins when both ISO and time_query are passed; warning emitted', () => {
    const out = resolveTimeWindow({
      started_after: '2026-05-03T00:00:00Z',
      time_query: 'yesterday',
    });
    expect(out.source).toBe('iso');
    expect(out.warnings.some((w) => /dropped time_query/i.test(w))).toBe(true);
  });

  it('invalid ISO falls through to time_query when set', () => {
    const out = resolveTimeWindow({ started_after: 'not-iso', time_query: 'yesterday' });
    expect(out.source).toBe('time_query');
    expect(out.warnings.some((w) => /invalid started_after/i.test(w))).toBe(true);
  });

  it('invalid ISO with no time_query falls back to default', () => {
    const out = resolveTimeWindow({ started_after: 'not-iso' });
    expect(out.source).toBe('default');
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});

describe('resolveTimeWindow — time_query patterns', () => {
  const cases = [
    ['most recent', NOW - 7 * DAY, NOW],
    ['recent', NOW - 7 * DAY, NOW],
    ['last hour', NOW - 1 * HOUR, NOW],
    ['last 3 hours', NOW - 3 * HOUR, NOW],
    ['today', NOW - 24 * HOUR, NOW],
    ['yesterday', NOW - 48 * HOUR, NOW - 24 * HOUR],
    ['this morning', NOW - 12 * HOUR, NOW],
    ['this afternoon', NOW - 8 * HOUR, NOW],
    ['this evening', NOW - 4 * HOUR, NOW],
    ['yesterday afternoon', NOW - 32 * HOUR, NOW - 24 * HOUR],
    ['yesterday evening', NOW - 28 * HOUR, NOW - 20 * HOUR],
    ['last week', NOW - 7 * DAY, NOW],
    ['past week', NOW - 7 * DAY, NOW],
    ['last 3 days', NOW - 3 * DAY, NOW],
    ['last 2 weeks', NOW - 14 * DAY, NOW],
  ];
  for (const [input, expectedAfter, expectedBefore] of cases) {
    it(`"${input}" → window matches`, () => {
      const out = resolveTimeWindow({ time_query: input });
      expect(out.source).toBe('time_query');
      expect(out.startedAfterMs).toBe(expectedAfter);
      expect(out.startedBeforeMs).toBe(expectedBefore);
    });
  }

  it('"this week" → last Monday 00:00 UTC → now (today is Sunday)', () => {
    const out = resolveTimeWindow({ time_query: 'this week' });
    expect(out.source).toBe('time_query');
    expect(out.startedAfterMs).toBe(Date.parse('2026-05-04T00:00:00Z'));
    expect(out.startedBeforeMs).toBe(NOW);
  });

  it('weekday name (Monday) → most recent occurrence ±36h', () => {
    const out = resolveTimeWindow({ time_query: 'Monday' });
    expect(out.source).toBe('time_query');
    const monday = Date.parse('2026-05-04T00:00:00Z');
    expect(out.startedAfterMs).toBe(monday - 36 * HOUR);
    expect(out.startedBeforeMs).toBe(monday + 36 * HOUR);
  });

  it('YYYY-MM-DD → that day 00:00 → 24:00 UTC', () => {
    const out = resolveTimeWindow({ time_query: '2026-05-08' });
    expect(out.source).toBe('time_query');
    expect(out.startedAfterMs).toBe(Date.parse('2026-05-08T00:00:00Z'));
    expect(out.startedBeforeMs).toBe(Date.parse('2026-05-09T00:00:00Z'));
  });

  it('garbage string → default with warning', () => {
    const out = resolveTimeWindow({ time_query: 'around 3pm yesterday' });
    expect(out.source).toBe('default');
    expect(out.startedAfterMs).toBe(NOW - 7 * DAY);
    expect(out.warnings.some((w) => /unrecognised time_query/i.test(w) && /around 3pm yesterday/.test(w))).toBe(true);
  });

  it('case-insensitive: "YESTERDAY" matches "yesterday"', () => {
    const out = resolveTimeWindow({ time_query: 'YESTERDAY' });
    expect(out.source).toBe('time_query');
    expect(out.startedAfterMs).toBe(NOW - 48 * HOUR);
  });
});
