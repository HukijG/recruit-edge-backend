import { describe, it, expect } from 'vitest';
import { FLOWS } from '../../src/lib/flow-names';

describe('FLOWS', () => {
  it('is a closed set', () => {
    expect(Object.keys(FLOWS).sort()).toEqual(['CRON_METRICS_TICK']);
  });
  it('is frozen', () => {
    expect(Object.isFrozen(FLOWS)).toBe(true);
  });
});
