import { describe, it, expect } from 'vitest';
import { stageRecencyBoost } from '../src/mcp/live-rerank.js';

describe('stageRecencyBoost', () => {
  const NOW = new Date('2026-05-12T12:00:00Z');
  const day = (n) => new Date(NOW.getTime() - n * 86400_000).toISOString();

  it('returns 0 for an empty candidate', () => {
    expect(stageRecencyBoost(null, NOW)).toBe(0);
    expect(stageRecencyBoost({}, NOW)).toBe(0);
    expect(stageRecencyBoost({ jobs: [] }, NOW)).toBe(0);
  });

  it('returns 0 when every job sits in Sourced', () => {
    // Hundreds of new candidates land in Sourced each week — they must
    // NOT carry a recency boost or the resolver floods top results with
    // freshly-sourced rows. This was the exact failure mode the operator
    // flagged in the 2026-05-12 smoke test.
    const c = {
      jobs: [
        { stage_name: 'Sourced', stage_moved: day(0) },
        { stage_name: 'Sourced', stage_moved: day(1) },
      ],
    };
    expect(stageRecencyBoost(c, NOW)).toBe(0);
  });

  it('returns 0 when every job is Disqualified', () => {
    // DQ'd candidates are dead — no recency lift regardless of when they
    // were DQ'd.
    const c = {
      jobs: [
        { stage_name: 'Disqualified', stage_moved: day(0) },
      ],
    };
    expect(stageRecencyBoost(c, NOW)).toBe(0);
  });

  it('returns max boost when a non-inert stage moved today', () => {
    // Jane Doe's actual smoke-test profile: jobs[0].stage_name = "Hired",
    // stage_moved within hours. Maximum recency lift.
    const c = {
      jobs: [
        { stage_name: 'Hired', stage_moved: day(0) },
      ],
    };
    const b = stageRecencyBoost(c, NOW);
    expect(b).toBeCloseTo(0.25, 2);
  });

  it('decays linearly across the 60-day window', () => {
    const c30 = { jobs: [{ stage_name: 'CV Sent', stage_moved: day(30) }] };
    const c45 = { jobs: [{ stage_name: 'CV Sent', stage_moved: day(45) }] };
    const c60 = { jobs: [{ stage_name: 'CV Sent', stage_moved: day(60) }] };
    expect(stageRecencyBoost(c30, NOW)).toBeCloseTo(0.125, 2);
    expect(stageRecencyBoost(c45, NOW)).toBeCloseTo(0.0625, 2);
    expect(stageRecencyBoost(c60, NOW)).toBe(0);
  });

  it('picks the MOST RECENT non-inert stage across jobs', () => {
    // If a candidate sits on three jobs — one stale active, one fresh
    // active, one fresh Sourced — the fresh active should anchor the
    // boost. The Sourced job is ignored (inert) and the stale active is
    // ignored in favour of the fresh one.
    const c = {
      jobs: [
        { stage_name: 'CV Sent', stage_moved: day(30) }, // stale active
        { stage_name: 'Sourced', stage_moved: day(0) },  // inert — skipped
        { stage_name: 'Replied', stage_moved: day(2) },  // fresh active — wins
      ],
    };
    const b = stageRecencyBoost(c, NOW);
    const expected = 0.25 * (1 - 2 / 60);
    expect(b).toBeCloseTo(expected, 2);
  });

  it('ignores jobs with missing or unparseable stage_moved', () => {
    const c = {
      jobs: [
        { stage_name: 'CV Sent', stage_moved: undefined },
        { stage_name: 'CV Sent', stage_moved: 'not-a-date' },
        { stage_name: 'CV Sent', stage_moved: day(5) }, // only this one counts
      ],
    };
    const b = stageRecencyBoost(c, NOW);
    const expected = 0.25 * (1 - 5 / 60);
    expect(b).toBeCloseTo(expected, 2);
  });

  it('is case-insensitive on stage_name (Sourced/sourced/SOURCED all inert)', () => {
    const c1 = { jobs: [{ stage_name: 'sourced', stage_moved: day(0) }] };
    const c2 = { jobs: [{ stage_name: 'SOURCED', stage_moved: day(0) }] };
    const c3 = { jobs: [{ stage_name: 'Disqualified', stage_moved: day(0) }] };
    expect(stageRecencyBoost(c1, NOW)).toBe(0);
    expect(stageRecencyBoost(c2, NOW)).toBe(0);
    expect(stageRecencyBoost(c3, NOW)).toBe(0);
  });

  it('treats a slightly-future stage_moved (within a week) as max boost (clock skew tolerant)', () => {
    // RF timestamps can drift by minutes / hours; tolerate small forward
    // skew by treating as "today".
    const inAFewHours = new Date(NOW.getTime() + 3 * 3600_000).toISOString();
    const c = { jobs: [{ stage_name: 'Hired', stage_moved: inAFewHours }] };
    expect(stageRecencyBoost(c, NOW)).toBeCloseTo(0.25, 2);
  });

  it('treats a far-future stage_moved (>7 days ahead) as 0 — corrupt data, not skew', () => {
    // 2030 timestamps aren't clock skew, they're garbage. Don't reward
    // them with a max boost — that hands the resolver a wrong winner on
    // bad data.
    const c = { jobs: [{ stage_name: 'Hired', stage_moved: '2030-01-01T00:00:00Z' }] };
    expect(stageRecencyBoost(c, NOW)).toBe(0);
  });
});
