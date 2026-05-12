import { describe, it, expect } from 'vitest';
import { normalize, tokens, scoreString, prepareTarget, recencyBoost } from '../src/mcp/fuzzy.js';

describe('fuzzy', () => {
  it('normalize lowercases + strips diacritics', () => {
    expect(normalize('Café Münich')).toBe('cafe munich');
  });
  it('exact match scores 1.0', () => {
    expect(scoreString('jerry smith', 'jerry smith')).toBe(1);
  });
  it('prefix match scores high', () => {
    expect(scoreString('jer', 'jerry smith')).toBeGreaterThan(0.7);
  });
  it('typo via Levenshtein still matches', () => {
    expect(scoreString('jery', 'jerry')).toBeGreaterThan(0.55);
  });
  it('prepareTarget produces normalized + tokens', () => {
    const p = prepareTarget('Jerry Smith');
    expect(p.normalized).toBe('jerry smith');
    expect(p.tokens).toEqual(['jerry', 'smith']);
  });
  it('recencyBoost is bounded', () => {
    expect(recencyBoost({ last_activity_at: new Date().toISOString() })).toBeGreaterThan(0.15);
    expect(recencyBoost({ last_activity_at: '2020-01-01T00:00:00Z' })).toBe(0);
  });
  it('recencyBoost decays over a 30-day window', () => {
    const now = new Date('2026-05-07T12:00:00Z');
    const day = (n) => new Date(now.getTime() - n * 86400_000).toISOString();
    // Today → ~0.2 (max).
    expect(recencyBoost({ last_activity_at: day(0) }, now)).toBeCloseTo(0.2, 2);
    // 15 days → ~0.1 (half).
    expect(recencyBoost({ last_activity_at: day(15) }, now)).toBeCloseTo(0.1, 1);
    // 31 days → 0 (just past the window).
    expect(recencyBoost({ last_activity_at: day(31) }, now)).toBe(0);
    // 60 days → 0 (long out of window).
    expect(recencyBoost({ last_activity_at: day(60) }, now)).toBe(0);
  });

  it('prefix-exact first-name match beats Levenshtein near-miss even with max recency', () => {
    // Smoke-test regression: query="jerry" was returning "Bill Ferry" /
    // "Chris Perry" / "Devlin Berry" (Levenshtein "one edit away" names)
    // above actual Jerrys when those look-alikes happened to be more
    // recent. The prefix-exact floor / Lev ceiling rebalancing guarantees
    // a stale Jerry still outranks a recently-active Ferry / Perry / Berry.
    const now = new Date('2026-05-12T12:00:00Z');
    const day = (n) => new Date(now.getTime() - n * 86400_000).toISOString();

    const jerryStaleScore = scoreString('jerry', 'jerry kara');
    const billRecentScore = scoreString('jerry', 'bill ferry');
    // Recency on the look-alike (max boost) ; nothing on the real match.
    const jerryBoosted = jerryStaleScore * (1 + recencyBoost({ last_activity_at: day(45) }, now));
    const billBoosted = billRecentScore * (1 + recencyBoost({ last_activity_at: day(0) }, now));
    expect(jerryBoosted).toBeGreaterThan(billBoosted);
  });
});
