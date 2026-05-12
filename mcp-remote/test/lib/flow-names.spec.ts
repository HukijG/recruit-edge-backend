import { describe, it, expect } from 'vitest';
import { FLOWS, mcpToolFlow } from '../../src/lib/flow-names.js';

describe('FLOWS (mcp)', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(FLOWS)).toBe(true);
  });

  it('contains the closed set of mcp-remote flow keys', () => {
    expect(Object.keys(FLOWS).sort()).toEqual(['MCP_HEALTH', 'MCP_POST'].sort());
    expect(FLOWS.MCP_HEALTH).toBe('MCP/Health');
    expect(FLOWS.MCP_POST).toBe('MCP/Post');
  });

  it('mcpToolFlow returns MCP/<tool>', () => {
    expect(mcpToolFlow('rf_candidate_search')).toBe('MCP/rf_candidate_search');
    expect(mcpToolFlow('rf_candidate_get')).toBe('MCP/rf_candidate_get');
  });
});
