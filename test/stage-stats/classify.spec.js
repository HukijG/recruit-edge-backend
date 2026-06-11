import { describe, it, expect } from 'vitest';
import { classifyAgainstPipeline } from '../../src/stage-stats.js';
import { DEFAULT_PIPELINE } from '../helpers/rf-pipeline-mock.js';

const cls = (from, to, pipeline = DEFAULT_PIPELINE) =>
  classifyAgainstPipeline(pipeline, from, to);

describe('classifyAgainstPipeline — submitted territory is positional (MCP semantics)', () => {
  it('counts a pre-landmark → at/after-landmark move as a CV crossing', () => {
    expect(cls('Sourced', 'CV Sent')).toMatchObject({ isCvCross: true, isIvLanding: false });
    expect(cls('Shortlist', 'CV Sent').isCvCross).toBe(true);
    expect(cls('Call Booked', 'Offer').isCvCross).toBe(true); // stage-skipping jump
  });

  it('judges a CUSTOM stage by its position, not its name (the denylist bug case)', () => {
    // 'Client Review' sits BEFORE the landmark in this job's pipeline — the
    // old global denylist would have called it submitted (false CV count).
    const pipeline = ['Sourced', 'Client Review', 'CV Sent', 'Client Interview 1', 'Offer', 'Disqualified'];
    expect(cls('Sourced', 'Client Review', pipeline)).toMatchObject({
      isCvCross: false,
      isIvLanding: false,
    });
    expect(cls('Client Review', 'CV Sent', pipeline).isCvCross).toBe(true);
    // …and a custom stage AFTER the landmark is submitted territory.
    const pipeline2 = ['Sourced', 'CV Sent', 'Client Deep-Dive', 'Offer'];
    expect(cls('Sourced', 'Client Deep-Dive', pipeline2).isCvCross).toBe(true);
    expect(cls('CV Sent', 'Client Deep-Dive', pipeline2).isCvCross).toBe(false);
  });

  it('counts a missing/empty from as not-submitted, so null → CV Sent IS a crossing', () => {
    expect(cls(null, 'CV Sent').isCvCross).toBe(true);
    expect(cls(undefined, 'CV Sent').isCvCross).toBe(true);
    expect(cls('', 'CV Sent').isCvCross).toBe(true);
  });

  it('does not count submitted → submitted as a crossing (revert/wiggle)', () => {
    expect(cls('1st Interview', 'CV Sent').isCvCross).toBe(false);
    expect(cls('CV Sent', '2nd Interview').isCvCross).toBe(false);
  });

  it('treats Disqualified as off-ladder: never a crossing target, re-adds cross again', () => {
    expect(cls('CV Sent', 'Disqualified')).toMatchObject({ isCvCross: false, isIvLanding: false });
    expect(cls('Disqualified', 'CV Sent').isCvCross).toBe(true);
  });

  it('treats a missing destination as nothing', () => {
    expect(cls('Sourced', null)).toMatchObject({ isCvCross: false, isIvLanding: false });
    expect(cls('Sourced', '   ')).toMatchObject({ isCvCross: false, isIvLanding: false });
  });
});

describe('classifyAgainstPipeline — first-interview landing is the job’s first interview stage', () => {
  it('lands on the FIRST interview-named stage at/after the landmark, and only that one', () => {
    expect(cls('CV Sent', '1st Interview').isIvLanding).toBe(true);
    expect(cls('Sourced', '1st Interview')).toMatchObject({ isCvCross: true, isIvLanding: true }); // jump = both
    expect(cls('2nd Interview', '1st Interview').isIvLanding).toBe(true); // wiggle back is a landing
    expect(cls('1st Interview', '2nd Interview').isIvLanding).toBe(false);
  });

  it('derives the interview stage per job — custom labels need no allowlist', () => {
    const pipeline = ['Sourced', 'CV Sent', 'Client Interview 1', 'Client Interview 2', 'Offer'];
    expect(cls('CV Sent', 'Client Interview 1', pipeline).isIvLanding).toBe(true);
    expect(cls('CV Sent', 'Client Interview 2', pipeline).isIvLanding).toBe(false);
  });

  it('an interview-named stage BEFORE the landmark is never the IV stage', () => {
    const pipeline = ['Sourced', 'Internal Interview', 'CV Sent', '1st Interview', 'Offer'];
    expect(cls('Sourced', 'Internal Interview', pipeline)).toMatchObject({
      isCvCross: false,
      isIvLanding: false,
    });
    expect(cls('CV Sent', '1st Interview', pipeline).isIvLanding).toBe(true);
  });

  it('a pipeline with no interview-named stage after the landmark has no IV landings', () => {
    const pipeline = ['Sourced', 'CV Sent', 'Offer', 'Placed'];
    expect(cls('CV Sent', 'Offer', pipeline).isIvLanding).toBe(false);
  });
});

describe('classifyAgainstPipeline — structural anomalies surface, never fabricate', () => {
  it('flags a pipeline without the CV Sent landmark', () => {
    const r = cls('Sourced', 'Hired', ['Sourced', 'Screening', 'Hired']);
    expect(r).toMatchObject({ isCvCross: false, isIvLanding: false, noLandmark: true });
  });

  it('reports stage names absent from the pipeline and classifies them as nothing', () => {
    const r = cls('Old Renamed Stage', 'CV Sent');
    expect(r.isCvCross).toBe(true); // unknown from = not submitted → still a crossing
    expect(r.unknownStages).toEqual(['Old Renamed Stage']);

    const r2 = cls('Sourced', 'Another Ghost Stage');
    expect(r2).toMatchObject({ isCvCross: false, isIvLanding: false });
    expect(r2.unknownStages).toEqual(['Another Ghost Stage']);
  });
});
