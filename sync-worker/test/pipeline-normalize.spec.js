import { describe, it, expect } from 'vitest';
import { normalizePipelineDetail } from '../src/pipeline-normalize.js';

const t = (iso) => iso;
const entry = (id, ...moves) => ({ candidate: { id, name: `C${id}` }, stages: moves });

describe('normalizePipelineDetail', () => {
  it('groups single-stage candidates by their current stage', () => {
    const out = normalizePipelineDetail([
      entry(1, { from: null, time: t('2026-05-01T00:00:00+0000'), to: 'Sourced' }),
      entry(2, { from: null, time: t('2026-05-01T00:00:00+0000'), to: 'Sourced' }),
      entry(3, { from: null, time: t('2026-05-01T00:00:00+0000'), to: 'Replied' }),
    ]);
    expect(out).toEqual({ Sourced: [1, 2], Replied: [3] });
  });

  it('uses the latest stage movement (max time) as the candidate\'s current stage', () => {
    const out = normalizePipelineDetail([
      entry(1,
        { from: null,        time: t('2026-05-01T00:00:00+0000'), to: 'Sourced' },
        { from: 'Sourced',   time: t('2026-05-03T00:00:00+0000'), to: 'Replied' },
        { from: 'Replied',   time: t('2026-05-05T00:00:00+0000'), to: 'Call Booked' },
      ),
    ]);
    expect(out).toEqual({ 'Call Booked': [1] });
  });

  it('drops candidates whose current stage is Disqualified', () => {
    const out = normalizePipelineDetail([
      entry(1,
        { from: null,        time: t('2026-05-01T00:00:00+0000'), to: 'Sourced' },
        { from: 'Sourced',   time: t('2026-05-02T00:00:00+0000'), to: 'Replied' },
        { from: 'Replied',   time: t('2026-05-03T00:00:00+0000'), to: 'Disqualified' },
      ),
      entry(2, { from: null, time: t('2026-05-01T00:00:00+0000'), to: 'Sourced' }),
    ]);
    expect(out).toEqual({ Sourced: [2] });
  });

  it('drops entries with no stage movements', () => {
    const out = normalizePipelineDetail([
      { candidate: { id: 99, name: 'X' }, stages: [] },
      entry(1, { from: null, time: t('2026-05-01T00:00:00+0000'), to: 'Sourced' }),
    ]);
    expect(out).toEqual({ Sourced: [1] });
  });

  it('drops entries with missing candidate.id', () => {
    const out = normalizePipelineDetail([
      { candidate: {}, stages: [{ from: null, time: t('2026-05-01T00:00:00+0000'), to: 'Sourced' }] },
      entry(1, { from: null, time: t('2026-05-01T00:00:00+0000'), to: 'Sourced' }),
    ]);
    expect(out).toEqual({ Sourced: [1] });
  });

  it('returns empty object for empty / null input', () => {
    expect(normalizePipelineDetail([])).toEqual({});
    expect(normalizePipelineDetail(null)).toEqual({});
    expect(normalizePipelineDetail(undefined)).toEqual({});
  });
});
