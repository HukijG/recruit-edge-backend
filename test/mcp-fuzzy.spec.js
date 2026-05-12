import { describe, it, expect } from 'vitest';
import { normalize, tokens, scoreString, prepareTarget, recencyBoost, canonicalizeJobPhrase } from '../src/mcp/fuzzy.js';

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

  // ─── Phase 1 tightening (2026-05-12, second pass) ─────────────────
  describe('word-boundary substring (no Neon-Security leak for "Eon")', () => {
    it('does NOT match "neon" against query "eon"', () => {
      // Before the fix this scored 0.5+ via tNorm.includes("eon"). With the
      // word-boundary requirement "eon" must hit a token boundary in the
      // target — "neon" is one continuous run, so no match.
      expect(scoreString('eon', 'neon security')).toBe(0);
    });
    it('does match "eon" against word-bounded "Eon.io"', () => {
      // After normalize/tokenise, "Eon.io" becomes a token "eon" — clean
      // word boundary. Prefix-match path picks it up directly.
      expect(scoreString('eon', 'eon io')).toBeGreaterThan(0.7);
    });
    it('does match "eon" inside a multi-word target with proper boundary', () => {
      // "Joining Eon Tomorrow" → tokens ["joining","eon","tomorrow"]; "eon"
      // is a standalone token, prefix-match fires.
      expect(scoreString('eon', 'joining eon tomorrow')).toBeGreaterThan(0.7);
    });
  });

  describe('extension-word penalty (manager / vp / lead / senior etc.)', () => {
    it('penalises "sales engineering manager" when query is just "sales engineer"', () => {
      // canonicaliseJobPhrase folds "sales engineer(ing)" → "se", so the
      // raw form lands as "se manager" for "sales engineering manager" and
      // just "se" for "sales engineer". The extension-word penalty
      // ("manager" present in target, absent in query) knocks "se manager"
      // below "sales engineer" cleanly.
      const seManager = scoreString(canonicalizeJobPhrase('sales engineer'), canonicalizeJobPhrase('sales engineering manager'));
      const seBare = scoreString(canonicalizeJobPhrase('sales engineer'), canonicalizeJobPhrase('sales engineer'));
      expect(seBare).toBeGreaterThan(seManager);
      expect(seBare - seManager).toBeGreaterThanOrEqual(0.08); // ≥ UNIQUE_GAP
    });

    it('does NOT penalise when both query and target carry the extension word', () => {
      // "sales engineering manager" against the same target — manager is
      // in BOTH, so the penalty doesn't fire.
      const a = scoreString(canonicalizeJobPhrase('sales engineering manager'), canonicalizeJobPhrase('sales engineering manager'));
      // After canonicalisation both sides collapse to "se manager"; exact match → 1.
      expect(a).toBe(1);
    });

    it('penalises "VP Marketing" when query has no VP/Marketing terms', () => {
      // VP is an extension word. Query "sales engineer" has no VP → drop.
      // (Pre-canonicalisation: "vp marketing" stays as-is; "sales engineer"
      // folds to "se". The Lev fallback would have scored these around 0.6;
      // extension penalty pulls VP-tagged target below threshold.)
      const score = scoreString(canonicalizeJobPhrase('sales engineer'), canonicalizeJobPhrase('vp marketing'));
      expect(score).toBeLessThan(0.55); // below the Lev path's lower bound
    });
  });

  describe('exact-word-count bonus (2-word query → 2-word target wins over 3-word)', () => {
    it('"sales engineer" outranks "sales engineering manager" cleanly', () => {
      // Combination of extension penalty AND equal-length bonus widens the
      // gap. After canonicalize: query "se", targets "se" vs "se manager".
      const bareTarget = scoreString(canonicalizeJobPhrase('sales engineer'), canonicalizeJobPhrase('sales engineer'));
      const longTarget = scoreString(canonicalizeJobPhrase('sales engineer'), canonicalizeJobPhrase('sales engineering manager'));
      expect(bareTarget - longTarget).toBeGreaterThanOrEqual(0.08);
    });

    it('"sales engineer" still outranks "senior support engineer" (no SE alias collision)', () => {
      // Senior is an extension word + "support engineer" doesn't fold to SE.
      const seJob = scoreString(canonicalizeJobPhrase('sales engineer'), canonicalizeJobPhrase('sales engineer'));
      const seniorSupport = scoreString(canonicalizeJobPhrase('sales engineer'), canonicalizeJobPhrase('senior support engineer'));
      expect(seJob).toBeGreaterThan(seniorSupport);
      expect(seJob - seniorSupport).toBeGreaterThanOrEqual(0.08);
    });
  });

  describe('SE alias scope', () => {
    it('"sales engineer" canonicalises to "se"', () => {
      expect(canonicalizeJobPhrase('Sales Engineer')).toContain('se');
    });
    it('"solutions engineer" canonicalises to "se"', () => {
      expect(canonicalizeJobPhrase('Solutions Engineer')).toContain('se');
    });
    it('"pre-sales engineer" stays cleanly as "presales engineer"', () => {
      // Pre-sales is its own role; the canonicalisation collapses the
      // hyphen but does NOT swallow it into the sales-engineer "se" alias.
      const out = canonicalizeJobPhrase('Pre-Sales Engineer');
      expect(out).toContain('presales');
    });
    it('"software engineer" does NOT collapse to "se" (intentional scope cap)', () => {
      // Per operator: "SE" in our world is sales/pre-sales/solutions only.
      // Software engineers should stay distinct so a recruiter querying SE
      // doesn't pull engineering-IC roles into the sales-engineer pool.
      const out = canonicalizeJobPhrase('Software Engineer');
      // canonicalize folds "engineer" → "engineer" (no abbreviation), so
      // the result should still be "software engineer" — not "se".
      expect(out).toBe('software engineer');
    });
    it('"support engineer" also stays distinct from "se"', () => {
      const out = canonicalizeJobPhrase('Support Engineer');
      expect(out).toBe('support engineer');
    });
  });
});
