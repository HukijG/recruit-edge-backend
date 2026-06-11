import { describe, it, expect } from 'vitest';
import {
  currentWeekWindowLondon,
  previousWeekStartLondon,
  londonDateString,
} from '../../src/stage-stats.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const utc = (s) => Date.parse(s);

describe('currentWeekWindowLondon', () => {
  it('computes a BST week (Monday 00:00 London = Sunday 23:00 UTC)', () => {
    // Wed 2026-06-10 12:00 UTC — mid-BST. Week = Mon 2026-06-08 00:00 BST
    // (= 2026-06-07T23:00Z) → Mon 2026-06-15 00:00 BST (= 2026-06-14T23:00Z).
    const w = currentWeekWindowLondon(utc('2026-06-10T12:00:00Z'));
    expect(w.startMs).toBe(utc('2026-06-07T23:00:00Z'));
    expect(w.endMs).toBe(utc('2026-06-14T23:00:00Z'));
  });

  it('computes a GMT week (Monday 00:00 London = Monday 00:00 UTC)', () => {
    const w = currentWeekWindowLondon(utc('2026-01-14T12:00:00Z'));
    expect(w.startMs).toBe(utc('2026-01-12T00:00:00Z'));
    expect(w.endMs).toBe(utc('2026-01-19T00:00:00Z'));
  });

  it('handles the spring-forward week (2026-03-29): 167 hours, GMT start, BST end', () => {
    // Week of Mon 2026-03-23 contains the BST transition (Sun 2026-03-29 01:00 GMT).
    const w = currentWeekWindowLondon(utc('2026-03-25T12:00:00Z'));
    expect(w.startMs).toBe(utc('2026-03-23T00:00:00Z')); // GMT Monday
    expect(w.endMs).toBe(utc('2026-03-29T23:00:00Z')); // Mon 2026-03-30 00:00 BST
    expect(w.endMs - w.startMs).toBe(7 * DAY - HOUR);
  });

  it('handles the fall-back week (2026-10-25): 169 hours, BST start, GMT end', () => {
    // Week of Mon 2026-10-19 contains the GMT transition (Sun 2026-10-25 02:00 BST).
    const w = currentWeekWindowLondon(utc('2026-10-21T12:00:00Z'));
    expect(w.startMs).toBe(utc('2026-10-18T23:00:00Z')); // Mon 2026-10-19 00:00 BST
    expect(w.endMs).toBe(utc('2026-10-26T00:00:00Z')); // GMT Monday
    expect(w.endMs - w.startMs).toBe(7 * DAY + HOUR);
  });

  it('pins the boundary to LONDON midnight, not UTC midnight (Sunday-night edge)', () => {
    // 2026-06-14T22:30Z = Sunday 23:30 London — still the old week.
    const oldWeek = currentWeekWindowLondon(utc('2026-06-14T22:30:00Z'));
    expect(oldWeek.startMs).toBe(utc('2026-06-07T23:00:00Z'));
    // 2026-06-14T23:30Z = Monday 00:30 London — the new week.
    const newWeek = currentWeekWindowLondon(utc('2026-06-14T23:30:00Z'));
    expect(newWeek.startMs).toBe(utc('2026-06-14T23:00:00Z'));
  });
});

describe('previousWeekStartLondon', () => {
  it('is exactly the current week start minus one London week', () => {
    const now = utc('2026-06-10T12:00:00Z');
    expect(previousWeekStartLondon(now)).toBe(utc('2026-05-31T23:00:00Z'));
  });

  it('re-resolves through the timezone across the spring DST boundary', () => {
    // Now in BST week of Mon 2026-03-30; previous week started Mon 2026-03-23 00:00 GMT.
    const now = utc('2026-04-01T12:00:00Z');
    expect(previousWeekStartLondon(now)).toBe(utc('2026-03-23T00:00:00Z'));
  });

  it('re-resolves through the timezone across the autumn DST boundary', () => {
    // Now in GMT week of Mon 2026-10-26; previous week started Mon 2026-10-19 00:00 BST.
    const now = utc('2026-10-28T12:00:00Z');
    expect(previousWeekStartLondon(now)).toBe(utc('2026-10-18T23:00:00Z'));
  });
});

describe('londonDateString', () => {
  it('returns the London local date (rolls past UTC midnight under BST)', () => {
    expect(londonDateString(utc('2026-06-10T12:00:00Z'))).toBe('2026-06-10');
    // 23:30 UTC = 00:30 London next day under BST
    expect(londonDateString(utc('2026-06-10T23:30:00Z'))).toBe('2026-06-11');
    // Under GMT they agree
    expect(londonDateString(utc('2026-01-10T23:30:00Z'))).toBe('2026-01-10');
  });
});
