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
});
