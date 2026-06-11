import { describe, it, expect } from 'vitest';
import {
  isSubmittedStage,
  classifyTransition,
  PRE_SUBMISSION_STAGES,
  FIRST_INTERVIEW_STAGES,
} from '../../src/stage-stats.js';

describe('isSubmittedStage', () => {
  it('denylists every configured pre-submission stage (case-insensitive, trimmed)', () => {
    for (const stage of PRE_SUBMISSION_STAGES) {
      expect(isSubmittedStage(stage)).toBe(false);
      expect(isSubmittedStage(stage.toUpperCase())).toBe(false);
      expect(isSubmittedStage(`  ${stage}  `)).toBe(false);
    }
  });

  it('treats empty / whitespace-only / missing names as NOT submitted', () => {
    expect(isSubmittedStage('')).toBe(false);
    expect(isSubmittedStage('   ')).toBe(false);
    expect(isSubmittedStage('\t\n')).toBe(false);
    expect(isSubmittedStage(null)).toBe(false);
    expect(isSubmittedStage(undefined)).toBe(false);
  });

  it('treats any disqualif* stage as NOT submitted', () => {
    expect(isSubmittedStage('Disqualified')).toBe(false);
    expect(isSubmittedStage('disqualified - client')).toBe(false);
    expect(isSubmittedStage('DISQUALIFY')).toBe(false);
  });

  it('treats unknown stages as submitted (denylist errs toward counting)', () => {
    expect(isSubmittedStage('CV Sent')).toBe(true);
    expect(isSubmittedStage('1st Interview')).toBe(true);
    expect(isSubmittedStage('Offer')).toBe(true);
    expect(isSubmittedStage('Some Brand New Stage')).toBe(true);
  });
});

describe('classifyTransition', () => {
  it('counts a pre-submission → submitted move as a CV crossing', () => {
    expect(classifyTransition('Sourced', 'CV Sent')).toEqual({
      isCvCross: true,
      isIvLanding: false,
    });
    expect(classifyTransition('Shortlist', 'CV Sent').isCvCross).toBe(true);
  });

  it('counts a null/missing from as not-submitted, so null → CV Sent IS a crossing', () => {
    expect(classifyTransition(null, 'CV Sent').isCvCross).toBe(true);
    expect(classifyTransition(undefined, 'CV Sent').isCvCross).toBe(true);
    expect(classifyTransition('', 'CV Sent').isCvCross).toBe(true);
  });

  it('counts stage-skipping jumps (Sourced → 1st Interview) as BOTH crossing and landing', () => {
    expect(classifyTransition('Sourced', '1st Interview')).toEqual({
      isCvCross: true,
      isIvLanding: true,
    });
  });

  it('does not count submitted → submitted as a crossing (revert/wiggle)', () => {
    expect(classifyTransition('1st Interview', 'CV Sent').isCvCross).toBe(false);
    expect(classifyTransition('CV Sent', '2nd Interview').isCvCross).toBe(false);
  });

  it('counts an IV landing whenever the destination is a first-interview stage', () => {
    for (const stage of FIRST_INTERVIEW_STAGES) {
      expect(classifyTransition('CV Sent', stage).isIvLanding).toBe(true);
      expect(classifyTransition('CV Sent', stage.toUpperCase()).isIvLanding).toBe(true);
    }
    // …even from another submitted stage (the 2nd → 1st wiggle is a landing)
    expect(classifyTransition('2nd Interview', '1st Interview').isIvLanding).toBe(true);
  });

  it('does not count a move into disqualified or pre-submission as anything', () => {
    expect(classifyTransition('CV Sent', 'Disqualified')).toEqual({
      isCvCross: false,
      isIvLanding: false,
    });
    expect(classifyTransition('CV Sent', 'Sourced')).toEqual({
      isCvCross: false,
      isIvLanding: false,
    });
  });

  it('treats a missing destination as nothing', () => {
    expect(classifyTransition('Sourced', null)).toEqual({
      isCvCross: false,
      isIvLanding: false,
    });
    expect(classifyTransition('Sourced', '   ')).toEqual({
      isCvCross: false,
      isIvLanding: false,
    });
  });
});
