import { describe, it, expect } from 'vitest';
import { FLOWS } from '../../src/lib/flow-names.js';

describe('FLOWS registry', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(FLOWS)).toBe(true);
  });

  it('contains all known entry-point flow names', () => {
    const expected = [
      'WORKFLOW_FULL_REBUILD',
      'WORKFLOW_PIPELINE_REBUILD',
      'WORKFLOW_CACHE_SEED',
      'CRON_TAIL_SYNC',
      'CRON_CANDIDATES_TICK',
      'CRON_JOBS_TICK',
      'CRON_CALLS_TICK',
      'ADMIN_TRIGGER_FULL_REBUILD',
      'ADMIN_TRIGGER_CACHE_REBUILD',
      'INTERNAL_CALLS_UPSERT',
    ];
    for (const key of expected) {
      expect(FLOWS[key], `FLOWS.${key} should be defined`).toBeDefined();
      expect(typeof FLOWS[key]).toBe('string');
    }
    expect(Object.keys(FLOWS).sort()).toEqual([...expected].sort());
  });
});
