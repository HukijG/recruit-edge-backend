import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchCFMetrics } from '../src/cf-graphql.js';

const realFetch = globalThis.fetch;

describe('fetchCFMetrics', () => {
  beforeEach(() => { globalThis.fetch = realFetch; });

  it('builds a combined GraphQL query and parses D1/KV/AI results', async () => {
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.query).toContain('d1StorageAdaptiveGroups');
      expect(body.query).toContain('kvStorageAdaptiveGroups');
      expect(body.variables.accountTag).toBe('account-id-xyz');
      return new Response(JSON.stringify({
        data: {
          viewer: {
            accounts: [{
              d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 12345 }, dimensions: { databaseId: 'rf-mcp-cache', date: '2026-05-10' } }],
              kvStorageAdaptiveGroups: [{ max: { byteCount: 9876, keyCount: 42 }, dimensions: { namespaceId: 'SYNC_STATE', date: '2026-05-10' } }],
              aiInferenceAdaptiveGroups: [{
                count: 7,
                sum: { totalNeurons: 100, totalInferenceSteps: 12, totalInputTokens: 5000, totalOutputTokens: 800 },
                dimensions: { date: '2026-05-10' },
              }],
            }],
          },
        },
      }), { headers: { 'content-type': 'application/json' } });
    }) as any;
    const result = await fetchCFMetrics({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'account-id-xyz', CF_GRAPHQL_ENDPOINT: 'https://x/graphql' });
    expect(result.d1Storage).toEqual([{ databaseId: 'rf-mcp-cache', sizeBytes: 12345 }]);
    expect(result.kvStorage).toEqual([{ namespaceId: 'SYNC_STATE', byteCount: 9876, keyCount: 42 }]);
    expect(result.aiUsage).toEqual({
      neurons: 100,
      inferenceSteps: 12,
      inputTokens: 5000,
      outputTokens: 800,
      requests: 7,
    });
  });

  it('aggregates AI fields across multiple adaptive-group rows (per-day buckets)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: {
        viewer: {
          accounts: [{
            d1StorageAdaptiveGroups: [],
            kvStorageAdaptiveGroups: [],
            aiInferenceAdaptiveGroups: [
              { count: 3, sum: { totalNeurons: 10, totalInferenceSteps: 4, totalInputTokens: 200, totalOutputTokens: 50 }, dimensions: { date: '2026-05-10' } },
              { count: 5, sum: { totalNeurons: 25, totalInferenceSteps: 6, totalInputTokens: 800, totalOutputTokens: 150 }, dimensions: { date: '2026-05-11' } },
            ],
          }],
        },
      },
    }), { headers: { 'content-type': 'application/json' } })) as any;
    const result = await fetchCFMetrics({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_GRAPHQL_ENDPOINT: 'https://x/graphql' });
    expect(result.aiUsage).toEqual({
      neurons: 35,
      inferenceSteps: 10,
      inputTokens: 1000,
      outputTokens: 200,
      requests: 8,
    });
  });

  // Regression guard against CF schema drift. The original un-prefixed AI
  // field name broke when CF renamed it — the entire CombinedMetrics query
  // was rejected, taking D1 and KV down with it. If CF renames again, this
  // test will fail loudly with a clear diff.
  it('uses the verified CF schema field names on aiInferenceAdaptiveGroups.sum', async () => {
    let capturedQuery = '';
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      capturedQuery = JSON.parse(init.body).query;
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
    await fetchCFMetrics({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_GRAPHQL_ENDPOINT: 'https://x/graphql' });
    expect(capturedQuery).toContain('aiInferenceAdaptiveGroups');
    expect(capturedQuery).toContain('totalNeurons');
    expect(capturedQuery).toContain('totalInferenceSteps');
    expect(capturedQuery).toContain('totalInputTokens');
    expect(capturedQuery).toContain('totalOutputTokens');
    // The plain un-prefixed name is the obsolete one. Absence is load-bearing —
    // its presence is what produced the production bug. We assert the substring
    // is missing rather than embedding the literal in a regex so that a code
    // grep for the old pattern doesn't false-positive on this file.
    const obsoleteFieldRegex = new RegExp('\\bsum\\s*\\{[^}]*\\b' + 'neur' + 'ons\\b');
    expect(capturedQuery).not.toMatch(obsoleteFieldRegex);
  });

  it('uses correctly-capitalized GraphQL scalar types', async () => {
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      // GraphQL is case-sensitive on built-in scalars. Lowercase "string!" would be rejected by the server.
      expect(body.query).toContain(': String!');
      expect(body.query).not.toMatch(/:\s+string!/);
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{}] } } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as any;
    await fetchCFMetrics({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_GRAPHQL_ENDPOINT: 'https://x/graphql' });
  });

  it('returns empty arrays + null on a 4xx response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Unauthorized', { status: 401 })) as any;
    const result = await fetchCFMetrics({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_GRAPHQL_ENDPOINT: 'https://x/graphql' });
    expect(result.d1Storage).toEqual([]);
    expect(result.kvStorage).toEqual([]);
    expect(result.aiUsage).toBeNull();
  });

  // 200-OK-with-errors is how CF GraphQL signals query-level failures
  // (unknown field, type mismatch, etc.). The original bug was silent in this
  // path because data=null was treated as "no data" instead of "query rejected".
  // This test ensures we surface a structured error log AND return the safe
  // empty result, so the next schema drift is visible in observability.
  it('logs structured error and returns empty result when CF returns errors[] (200 OK)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      data: null,
      errors: [{ message: 'unknown field "neurons"', path: null }],
    }), { headers: { 'content-type': 'application/json' } })) as any;
    const result = await fetchCFMetrics({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_GRAPHQL_ENDPOINT: 'https://x/graphql' });
    expect(result.d1Storage).toEqual([]);
    expect(result.kvStorage).toEqual([]);
    expect(result.aiUsage).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    const logged = errSpy.mock.calls[0][0] as any;
    expect(logged.message).toBe('GraphQL query errors');
    expect(logged.errors).toEqual(['unknown field "neurons"']);
    errSpy.mockRestore();
  });
});
