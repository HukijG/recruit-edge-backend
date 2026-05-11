import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import worker from '../src';

const originalFetch = globalThis.fetch;

const insertJob = async (id, name = 'Job ' + id, client = 'Acme') => {
  await env.RF_MCP_CACHE
    .prepare(`INSERT INTO jobs (id, body, name, client_company_name, is_open, cached_at)
              VALUES (?, ?, ?, ?, 1, ?)`)
    .bind(id, JSON.stringify({ id, name }), name, client, new Date().toISOString())
    .run();
};

/**
 * Seed BOTH legacy `candidates` (for fuzzy resolvers / pre-cutover code paths)
 * AND new `candidates_v2` (the thin-hydration source for the live-fetch path).
 */
const insertCandidate = async (id, name, body = {}) => {
  await env.RF_MCP_CACHE
    .prepare(`INSERT INTO candidates (id, body, name, linkedin_profile, current_organization, cached_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      JSON.stringify({ id, name, ...body }),
      name,
      body.linkedin_profile ?? null,
      body.current_organization ?? null,
      new Date().toISOString(),
    )
    .run();
  await env.RF_MCP_CACHE
    .prepare(`INSERT OR IGNORE INTO candidates_v2
              (id, name, linkedin_profile, added_time_ms,
               current_title_at_cache_time, current_company_at_cache_time, cached_at_ms)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id,
      name,
      body.linkedin_profile ?? null,
      body.added_time_ms ?? Date.now(),
      body.current_title ?? null,
      body.current_organization ?? null,
      Date.now(),
    )
    .run();
};

/**
 * Build a single RF `/job/pipeline` response from a `{<stageName>: [<id>...]}`
 * map. Produces `detail[]` entries with a single `stages[]` move (the current
 * stage) since the handler only cares about the most-recent `stages[].time` `to`.
 */
const buildPipelinePayload = (summary, stageCandidates) => ({
  summary,
  detail: Object.entries(stageCandidates).flatMap(([stageName, ids]) =>
    ids.map((id) => ({
      candidate: { id, name: 'C' + id },
      stages: [{ from: null, time: '2026-05-01T00:00:00+0000', to: stageName }],
    })),
  ),
});

/**
 * Build a Response-like object matching what `globalThis.fetch` returns.
 */
const fakeJsonResponse = (json, { status = 200 } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => json,
  text: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
});
const fakeErrorResponse = ({ status = 500, body = '' } = {}) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => body,
});

/**
 * Default fetch mock: route `/job/pipeline` to a per-test fixture.
 * Throws on unexpected URLs so missing mocks fail loudly.
 */
const mockRFPipeline = (pipelinePayload, { onCandidateGet } = {}) => {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/job/pipeline')) return fakeJsonResponse(pipelinePayload);
    if (u.includes('/candidate/get')) {
      if (onCandidateGet) return onCandidateGet(u);
      throw new Error(`unexpected /candidate/get in test: ${u}`);
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  });
};

const STANDARD_SUMMARY = [
  { id: 1,  name: 'Sourced',         count: 0 },
  { id: 2,  name: 'Replied',         count: 0 },
  { id: 3,  name: 'Call Booked',     count: 0 },
  { id: 4,  name: 'Shortlist',       count: 0 },
  { id: 5,  name: 'CV Sent',         count: 0 },
  { id: 6,  name: '1st Interview',   count: 0 },
  { id: 7,  name: 'Final Interview', count: 0 },
  { id: 8,  name: 'Offer',           count: 0 },
  { id: 9,  name: 'Hired',           count: 0 },
  { id: 10, name: 'Disqualified',    count: 0 },
];

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM job_pipelines');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const call = (b) =>
  worker.fetch(
    new Request('http://x/mcp/job-candidates-filter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
      body: JSON.stringify({ consultantFirstName: 'Joel', ...b }),
    }),
    env,
    createExecutionContext(),
  );

describe('/mcp/job-candidates-filter', () => {

  describe('basic flat list', () => {
    it('returns all active candidates as flat matched[] list', async () => {
      await insertJob(100, 'Eng');
      await insertCandidate(1, 'A', { linkedin_profile: 'a-slug' });
      await insertCandidate(2, 'B', { linkedin_profile: 'b-slug' });
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1, 2] }));
      const r = await call({ job: 100 });
      const body = await r.json();
      expect(body.ok).toBe(true);
      expect(body.total).toBe(2);
      expect(body.matched.map((m) => m.id).sort()).toEqual([1, 2]);
      // Each match has a full LinkedIn URL.
      expect(body.matched[0].linkedin_profile).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
    });

    it('default fields = id, name, linkedin_profile only — no stage_name on each row', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A', { linkedin_profile: 'a-slug' });
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1] }));
      const r = await call({ job: 100 });
      const body = await r.json();
      const m = body.matched[0];
      expect(Object.keys(m).sort()).toEqual(['id', 'linkedin_profile', 'name']);
    });

    it('returns top-level job block with id, name, client_company_name', async () => {
      await insertJob(100, 'Eng Lead', 'Acme.io');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {}));
      const r = await call({ job: 100 });
      const body = await r.json();
      expect(body.job).toEqual({ id: 100, name: 'Eng Lead', client_company_name: 'Acme.io' });
    });

    it('candidates from multiple stages merged in canonical pipeline order', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A');
      await insertCandidate(2, 'B');
      // Sourced before CV Sent in summary — so id 1 comes first in flat list.
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1], 'CV Sent': [2] }));
      const r = await call({ job: 100 });
      const body = await r.json();
      // Must preserve canonical stage order: Sourced (idx 0) before CV Sent (idx 4).
      expect(body.matched.map((m) => m.id)).toEqual([1, 2]);
    });
  });

  describe('stage filter', () => {
    it('exact stage filter restricts to that stage', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A');
      await insertCandidate(2, 'B');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1], Replied: [2] }));
      const r = await call({ job: 100, stage: 'Replied' });
      const body = await r.json();
      expect(body.matched.map((m) => m.id)).toEqual([2]);
    });

    it('fuzzy stage filter resolves case-insensitively', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1] }));
      const r = await call({ job: 100, stage: 'sourced' });
      const body = await r.json();
      expect(body.matched.map((m) => m.id)).toEqual([1]);
    });

    it('stage ambiguity returns 200 disambiguation envelope', async () => {
      await insertJob(100);
      const ambiguousSummary = [
        { id: 1, name: '1st Interview', count: 0 },
        { id: 2, name: '2nd Interview', count: 0 },
      ];
      mockRFPipeline(buildPipelinePayload(ambiguousSummary, {}));
      const r = await call({ job: 100, stage: 'interview' });
      const body = await r.json();
      expect(body.needs_disambiguation).toBe(true);
      expect(body.kind).toBe('stage');
    });

    it('unknown stage name returns empty matched with warning', async () => {
      await insertJob(100);
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {}));
      const r = await call({ job: 100, stage: 'Nonexistent Stage XYZ' });
      const body = await r.json();
      expect(body.matched).toEqual([]);
      expect(body._meta?.warnings?.[0]).toMatch(/unknown stage/i);
    });
  });

  describe('Disqualified handling', () => {
    it('Disqualified excluded by default', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A');
      await insertCandidate(2, 'DQ');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {
        Sourced: [1],
        Disqualified: [2],
      }));
      const r = await call({ job: 100 });
      const body = await r.json();
      expect(body.matched.map((m) => m.id)).toEqual([1]);
    });

    it('include_disqualified opt-in includes DQ candidates', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A');
      await insertCandidate(2, 'DQ');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {
        Sourced: [1],
        Disqualified: [2],
      }));
      const r = await call({ job: 100, include_disqualified: true });
      const body = await r.json();
      expect(body.matched.map((m) => m.id).sort()).toEqual([1, 2]);
    });
  });

  describe('limit + total', () => {
    it('limit truncates matched and sets truncated + total correctly', async () => {
      await insertJob(100);
      for (let i = 1; i <= 5; i++) {
        await insertCandidate(i, `C${i}`);
      }
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {
        Sourced: [1, 2, 3, 4, 5],
      }));
      const r = await call({ job: 100, limit: 2 });
      const body = await r.json();
      expect(body.matched.length).toBe(2);
      expect(body.total).toBe(5);
      expect(body.truncated).toBe(true);
    });

    it('no truncated key when matched count is within limit', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1] }));
      const r = await call({ job: 100, limit: 100 });
      const body = await r.json();
      expect(body.truncated).toBeUndefined();
    });
  });

  describe('job resolution', () => {
    it('job_id short-circuit bypasses fuzzy resolver', async () => {
      await insertJob(100, 'Eng Lead', 'Acme.io');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {}));
      const r = await call({ job_id: 100 });
      const body = await r.json();
      expect(body.job.id).toBe(100);
    });

    it('404 when job_id is unknown', async () => {
      // No RF mock needed — handler returns 404 before hitting RF.
      globalThis.fetch = vi.fn(async () => {
        throw new Error('handler should not call fetch on unknown job_id');
      });
      const r = await call({ job_id: 99999 });
      expect(r.status).toBe(404);
    });

    it('400 when neither job nor job_id is provided', async () => {
      globalThis.fetch = vi.fn(async () => {
        throw new Error('should not fetch');
      });
      const r = await call({});
      expect(r.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Thin-vs-expanded hydration (Task 16 — the new behavioural contract).
  // ─────────────────────────────────────────────────────────────────────

  describe('thin vs expanded hydration', () => {
    it('thin-only fields → 1 RF /job/pipeline call + 1 D1 batch (no per-id /candidate/get)', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A', { linkedin_profile: 'a' });
      await insertCandidate(2, 'B', { linkedin_profile: 'b' });
      const fetches = [];
      globalThis.fetch = vi.fn(async (url) => {
        fetches.push(String(url));
        return fakeJsonResponse(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1, 2] }));
      });
      const r = await call({ job: 100, fields: ['id', 'name', 'linkedin_profile'] });
      const body = await r.json();
      const rfCalls = fetches.filter((u) => u.includes('/job/pipeline'));
      const candGets = fetches.filter((u) => u.includes('/candidate/get'));
      expect(rfCalls).toHaveLength(1);
      expect(candGets).toHaveLength(0);
      expect(body.matched).toHaveLength(2);
      expect(body.matched.map((c) => c.id).sort()).toEqual([1, 2]);
    });

    it('added_time_ms is also thin-only — no /candidate/get', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A', { added_time_ms: 1700000000000 });
      const fetches = [];
      globalThis.fetch = vi.fn(async (url) => {
        fetches.push(String(url));
        return fakeJsonResponse(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1] }));
      });
      const r = await call({ job: 100, fields: ['id', 'name', 'added_time_ms'] });
      const body = await r.json();
      expect(fetches.filter((u) => u.includes('/candidate/get'))).toHaveLength(0);
      expect(body.matched[0].added_time_ms).toBe(1700000000000);
    });

    it('expanded fields → /job/pipeline + N parallel /candidate/get (concurrency capped at 8)', async () => {
      await insertJob(100);
      for (let i = 1; i <= 30; i++) {
        await insertCandidate(i, `C${i}`);
      }
      let pipelineFetched = 0;
      let candidateFetched = 0;
      let inFlight = 0;
      let observedMaxConcurrency = 0;
      globalThis.fetch = vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/job/pipeline')) {
          pipelineFetched++;
          return fakeJsonResponse(buildPipelinePayload(STANDARD_SUMMARY, {
            Sourced: Array.from({ length: 30 }, (_, i) => i + 1),
          }));
        }
        if (u.includes('/candidate/get')) {
          candidateFetched++;
          inFlight++;
          if (inFlight > observedMaxConcurrency) observedMaxConcurrency = inFlight;
          // Microtask yield so concurrent invocations actually overlap.
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight--;
          const idMatch = u.match(/[?&]id=(\d+)/);
          const id = idMatch ? Number(idMatch[1]) : 0;
          return fakeJsonResponse({
            candidate: { id, name: `C${id}`, current_title: 'Director' },
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });

      const r = await call({ job: 100, fields: ['id', 'name', 'current_title'] });
      const body = await r.json();
      expect(pipelineFetched).toBe(1);
      expect(candidateFetched).toBe(30);
      // Hard cap at 8.
      expect(observedMaxConcurrency).toBeLessThanOrEqual(8);
      expect(body.matched).toHaveLength(30);
      expect(body.matched.every((c) => c.current_title === 'Director')).toBe(true);
    });

    it('per-id /candidate/get failure during hydration returns partial result + hydration_errors', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A');
      await insertCandidate(2, 'B');
      globalThis.fetch = vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/job/pipeline')) {
          return fakeJsonResponse(buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1, 2] }));
        }
        if (u.includes('/candidate/get')) {
          const idMatch = u.match(/[?&]id=(\d+)/);
          const id = idMatch ? Number(idMatch[1]) : 0;
          if (id === 1) {
            return fakeJsonResponse({
              candidate: { id: 1, name: 'A', current_title: 'PM' },
            });
          }
          // 502 retry-once fires, second attempt also 502 → upstream throws.
          // Handler captures as hydration_errors[] entry.
          return fakeErrorResponse({ status: 502, body: 'service error' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });

      const r = await call({ job: 100, fields: ['id', 'name', 'current_title'] });
      const body = await r.json();
      expect(body.hydration_errors).toEqual([
        { id: 2, reason: expect.stringContaining('502') },
      ]);
      // Partial success: candidate 1 in matched, candidate 2 dropped.
      expect(body.matched).toHaveLength(1);
      expect(body.matched[0].id).toBe(1);
      expect(body.matched[0].current_title).toBe('PM');
    });

    it('fields extends defaults — id, name, linkedin_profile always present', async () => {
      await insertJob(100);
      await insertCandidate(1, 'A', { linkedin_profile: 'a' });
      mockRFPipeline(
        buildPipelinePayload(STANDARD_SUMMARY, { Sourced: [1] }),
        {
          onCandidateGet: () =>
            fakeJsonResponse({ candidate: { id: 1, name: 'A', linkedin_profile: 'a', current_title: 'CTO' } }),
        },
      );
      const r = await call({ job: 100, fields: ['current_title'] });
      const body = await r.json();
      const m = body.matched[0];
      expect(m.id).toBe(1);
      expect(m.name).toBe('A');
      expect(m.linkedin_profile).toBe('https://www.linkedin.com/in/a');
      expect(m.current_title).toBe('CTO');
    });
  });

  describe('RF pipeline failure', () => {
    it('RF /job/pipeline failure → recoverable pipeline_unavailable envelope', async () => {
      await insertJob(100);
      globalThis.fetch = vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/job/pipeline')) {
          return fakeErrorResponse({ status: 500, body: 'pipeline service down' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });
      const r = await call({ job: 100 });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.recoverable).toBe(true);
      expect(body.kind).toBe('pipeline_unavailable');
      expect(body.job).toEqual({ id: 100, name: 'Job 100', client_company_name: 'Acme' });
      expect(body.error).toMatch(/500/);
    });
  });

  describe('empty pipeline', () => {
    it('returns total=0, matched=[], ok=true when RF detail[] is empty', async () => {
      await insertJob(100);
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {}));
      const r = await call({ job: 100 });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.total).toBe(0);
      expect(body.matched).toEqual([]);
    });
  });
});
