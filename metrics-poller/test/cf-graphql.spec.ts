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
              aiInferenceAdaptiveGroups: [{ sum: { neurons: 100 }, dimensions: { date: '2026-05-10' } }],
            }],
          },
        },
      }), { headers: { 'content-type': 'application/json' } });
    }) as any;
    const result = await fetchCFMetrics({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'account-id-xyz', CF_GRAPHQL_ENDPOINT: 'https://x/graphql' });
    expect(result.d1Storage).toEqual([{ databaseId: 'rf-mcp-cache', sizeBytes: 12345 }]);
    expect(result.kvStorage).toEqual([{ namespaceId: 'SYNC_STATE', byteCount: 9876, keyCount: 42 }]);
    expect(result.aiUsage).toEqual({ neurons: 100 });
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
});
