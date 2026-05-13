import { describe, it, expect } from 'vitest';
import { FLOWS, mcpToolFlow } from '../../src/lib/flow-names.js';

describe('FLOWS registry', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(FLOWS)).toBe(true);
  });

  it('contains all known entry-point flow names', () => {
    const expected = [
      'EXTENSION_ADD_CANDIDATE', 'EXTENSION_ADD_TO_JOB',
      'EXTENSION_MARK_INVALID', 'EXTENSION_FETCH_DETAILS',
      'EXTENSION_DIALPAD_USER_CONTEXT', 'EXTENSION_CALL_REQUEST',
      'EXTENSION_DIALPAD_SMS', 'EXTENSION_CALL_STATE_POLL',
      'EXTENSION_DIALPAD_HANGUP', 'EXTENSION_CALL_STATS',
      'EXTENSION_SMS_TEMPLATES_LIST', 'EXTENSION_SMS_TEMPLATES_UPSERT',
      'EXTENSION_SMS_TEMPLATES_DELETE',
      'MOBILE_MY_SOURCING_JOBS', 'MOBILE_JOB_PIPELINE',
      'WEBHOOK_RF', 'WEBHOOK_RF_MANUAL', 'WEBHOOK_DIALPAD_GENERAL',
      'WEBHOOK_DIALPAD_CALL', 'WEBHOOK_DIALPAD_EXT_CALL',
      'WEBHOOK_KRISP', 'WEBHOOK_CALENDAR', 'WEBHOOK_APOLLO_ENRICHMENT',
      'MCP_PROXY', 'HEALTH', 'TEST_COLD_CALL',
    ];
    for (const key of expected) {
      expect(FLOWS[key], `FLOWS.${key} should be defined`).toBeDefined();
      expect(typeof FLOWS[key]).toBe('string');
    }
    expect(Object.keys(FLOWS).sort()).toEqual([...expected].sort());
  });

  it('mcpToolFlow returns MCP/<tool_name> shape', () => {
    expect(mcpToolFlow('rf_candidate_search')).toBe('MCP/rf_candidate_search');
    expect(mcpToolFlow('rf_candidate_get')).toBe('MCP/rf_candidate_get');
  });
});
