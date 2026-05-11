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
  // Dual-write the thin cache — pipeline tools now read from jobs_v2.
  await env.RF_MCP_CACHE
    .prepare(`INSERT OR IGNORE INTO jobs_v2 (id, name, client_company_name, added_time_ms, cached_at_ms)
              VALUES (?, ?, ?, ?, ?)`)
    .bind(id, name, client, Date.now(), Date.now())
    .run();
};

/**
 * Seed BOTH legacy `candidates` (for fuzzy resolvers / pre-cutover code paths)
 * AND new `candidates_v2` (the thin-hydration source). Tests that exercise
 * thin-only hydration only need the v2 row.
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
 * Build a Response-like object mirroring what `globalThis.fetch` returns —
 * matches the shape the rf-client.js read helpers expect (`r.ok`, `r.status`,
 * `r.json()`, `r.text()`).
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
 * Build a single RF `/job/pipeline` response from a `{<stageName>: [<id>...]}`
 * map. Honours the `STANDARD_SUMMARY` order; produces `detail[]` entries with
 * a single `stages[]` move (the current stage) since the handler only cares
 * about the most-recent `stages[].time` `to`.
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
 * Default fetch mock used by every test in this file: route `/job/pipeline`
 * to a per-test fixture, throw on any unexpected URL so missing mocks fail
 * loudly rather than silently 404ing.
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
  { id: 1, name: 'Sourced',         count: 0 },
  { id: 2, name: 'Replied',         count: 0 },
  { id: 3, name: 'Call Booked',     count: 0 },
  { id: 4, name: 'Shortlist',       count: 0 },
  { id: 5, name: 'CV Sent',         count: 0 },
  { id: 6, name: '1st Interview',   count: 0 },
  { id: 7, name: 'Final Interview', count: 0 },
  { id: 8, name: 'Offer',           count: 0 },
  { id: 9, name: 'Hired',           count: 0 },
  { id: 10, name: 'Disqualified',   count: 0 },
];

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates_v2');
  await env.RF_MCP_CACHE.exec('DELETE FROM candidate_jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs');
  await env.RF_MCP_CACHE.exec('DELETE FROM jobs_v2');
  await env.RF_MCP_CACHE.exec('DELETE FROM job_pipelines');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const call = (b) => worker.fetch(
  new Request('http://x/mcp/job-pipeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'test-mcp-extension-secret' },
    body: JSON.stringify({ consultantFirstName: 'Joel', ...b }),
  }),
  env,
  createExecutionContext(),
);

describe('/mcp/job-pipeline', () => {
  describe('default range (CV Sent → end of pipeline)', () => {
    it('returns CV Sent through Hired in canonical order, excludes Sourced/Replied', async () => {
      await insertJob(984, 'Sales Engineer', 'Eon.io');
      await insertCandidate(7, 'X', { linkedin_profile: 'x-slug' });
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {
        Sourced: [1, 2], Replied: [3], 'CV Sent': [7],
      }));
      const r = await call({ job: 984 });
      const body = await r.json();
      expect(body.job).toEqual({ id: 984, name: 'Sales Engineer', client_company_name: 'Eon.io' });
      expect(body.stage_breakdown.map((s) => s.stage_name)).toEqual([
        'CV Sent', '1st Interview', 'Final Interview', 'Offer', 'Hired',
      ]);
      expect(Object.keys(body.stages)).toEqual([
        'CV Sent', '1st Interview', 'Final Interview', 'Offer', 'Hired',
      ]);
      expect(body.stages['CV Sent']).toEqual([
        { id: 7, name: 'X', linkedin_profile: 'https://www.linkedin.com/in/x-slug' },
      ]);
      expect(body.stages['1st Interview']).toEqual([]);
    });
  });

  describe('submitted: true', () => {
    it('exact match on "CV Sent" — no fuzzy', async () => {
      await insertJob(984);
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {}));
      const r = await call({ job: 984, submitted: true });
      const body = await r.json();
      expect(body.stage_breakdown.map((s) => s.stage_name)).toEqual([
        'CV Sent', '1st Interview', 'Final Interview', 'Offer', 'Hired',
      ]);
    });

    it('emits a warning + returns full pipeline when CV Sent is missing', async () => {
      await insertJob(984);
      const customSummary = [
        { id: 1, name: 'Sourced',  count: 0 },
        { id: 2, name: 'Reviewed', count: 0 },
        { id: 3, name: 'Hired',    count: 0 },
      ];
      mockRFPipeline(buildPipelinePayload(customSummary, {}));
      const r = await call({ job: 984, submitted: true });
      const body = await r.json();
      expect(body.stage_breakdown.map((s) => s.stage_name)).toEqual(['Sourced', 'Reviewed', 'Hired']);
      expect(body._meta?.warnings?.[0]).toMatch(/no 'CV Sent' stage/i);
    });
  });

  describe('stage filter (single)', () => {
    it('exact match', async () => {
      await insertJob(984);
      await insertCandidate(11, 'A', { linkedin_profile: 'a' });
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { Replied: [11] }));
      const r = await call({ job: 984, stage: 'Replied' });
      const body = await r.json();
      expect(body.stage_breakdown).toEqual([{ stage_name: 'Replied', count: 1 }]);
      expect(body.stages.Replied[0].id).toBe(11);
    });

    it('fuzzy match — "replied" → "Replied"', async () => {
      await insertJob(984);
      await insertCandidate(11, 'A');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { Replied: [11] }));
      const r = await call({ job: 984, stage: 'replied' });
      const body = await r.json();
      expect(body.stage_breakdown).toEqual([{ stage_name: 'Replied', count: 1 }]);
    });

    it('ambiguity returns 200 disambiguation envelope', async () => {
      await insertJob(984);
      const ambiguousSummary = [
        { id: 1, name: '1st Interview', count: 0 },
        { id: 2, name: '2nd Interview', count: 0 },
      ];
      mockRFPipeline(buildPipelinePayload(ambiguousSummary, {}));
      const r = await call({ job: 984, stage: 'interview' });
      const body = await r.json();
      expect(body.needs_disambiguation).toBe(true);
      expect(body.kind).toBe('stage');
    });
  });

  describe('from / to range', () => {
    it('inclusive on both ends, in canonical order', async () => {
      await insertJob(984);
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {}));
      const r = await call({ job: 984, from: 'Replied', to: 'Shortlist' });
      const body = await r.json();
      expect(body.stage_breakdown.map((s) => s.stage_name)).toEqual([
        'Replied', 'Call Booked', 'Shortlist',
      ]);
    });
  });

  describe('include_disqualified', () => {
    it('omitted by default', async () => {
      await insertJob(984);
      await insertCandidate(99, 'DQ');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {
        'CV Sent': [], Disqualified: [99],
      }));
      const r = await call({ job: 984 });
      const body = await r.json();
      expect(Object.keys(body.stages)).not.toContain('Disqualified');
    });

    it('included when flag set, regardless of default range', async () => {
      await insertJob(984);
      await insertCandidate(99, 'DQ');
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {
        'CV Sent': [], Disqualified: [99],
      }));
      const r = await call({ job: 984, include_disqualified: true });
      const body = await r.json();
      expect(Object.keys(body.stages)).toContain('Disqualified');
    });
  });

  describe('empty pipeline (no candidates)', () => {
    it('returns empty stages + zero counts when RF detail[] is empty', async () => {
      // Replaces the legacy "cold cache" test — under live-fetch there's no
      // pre-warm step, so an empty pipeline simply produces empty stages.
      await insertJob(984);
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {}));
      const r = await call({ job: 984 });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.stages['CV Sent']).toEqual([]);
      expect(body.stage_breakdown.every((s) => s.count === 0)).toBe(true);
    });
  });

  describe('fields param', () => {
    it('extends defaults — does not replace them (thin path: current_title from cache)', async () => {
      // `title` resolves to current_title alias, which now comes from the
      // v2 snapshot column → thin path, no /candidate/get fan-out.
      await insertJob(984);
      await insertCandidate(7, 'X', {
        linkedin_profile: 'x',
        current_organization: 'Acme',
        current_title: 'CTO',
      });
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, { 'CV Sent': [7] }));
      const r = await call({ job: 984, fields: ['title'] });
      const body = await r.json();
      const c = body.stages['CV Sent'][0];
      expect(c.id).toBe(7);
      expect(c.name).toBe('X');
      expect(c.linkedin_profile).toBe('https://www.linkedin.com/in/x');
      expect(c.current_title).toBe('CTO');
    });

    it('drops unknown field names silently — no _meta on a clean call', async () => {
      await insertJob(984);
      await insertCandidate(7, 'X');
      mockRFPipeline(
        buildPipelinePayload(STANDARD_SUMMARY, { 'CV Sent': [7] }),
        {
          // Unknown field forces expanded path (any field outside THIN_FIELDS
          // does); /candidate/get must be mocked even though the unknown field
          // resolves to nothing.
          onCandidateGet: () =>
            fakeJsonResponse({ candidate: { id: 7, name: 'X' } }),
        },
      );
      // Use a key the resolver can't map to a thin column so the expanded
      // path fires. (Bare unknown like 'totally_unknown_xyz' silently
      // resolves to nothing AND stays on the thin path because it's not in
      // THIN_FIELDS — but isThinOnly returns false for it, forcing fan-out
      // even when projection drops it.)
      const r = await call({ job: 984, fields: ['totally_unknown_xyz'] });
      const body = await r.json();
      expect(body._meta).toBeUndefined();
    });
  });

  describe('job_id short-circuit', () => {
    it('numeric job_id bypasses fuzzy', async () => {
      await insertJob(984);
      mockRFPipeline(buildPipelinePayload(STANDARD_SUMMARY, {}));
      const r = await call({ job_id: 984, submitted: true });
      const body = await r.json();
      expect(body.job.id).toBe(984);
    });

    it('404 when job_id is unknown', async () => {
      // No RF mock needed — handler returns 404 before hitting RF.
      globalThis.fetch = vi.fn(async () => {
        throw new Error('handler should not call fetch on unknown job_id');
      });
      const r = await call({ job_id: 99999 });
      expect(r.status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Thin-vs-expanded hydration (Task 15 — the new behavioural contract).
  // ─────────────────────────────────────────────────────────────────────

  describe('thin vs expanded hydration', () => {
    it('thin-only fields → 1 RF /job/pipeline call + 1 D1 batch (no per-id /candidate/get)', async () => {
      await insertJob(984);
      await insertCandidate(1, 'A', { linkedin_profile: 'a' });
      await insertCandidate(2, 'B', { linkedin_profile: 'b' });
      const fetches = [];
      globalThis.fetch = vi.fn(async (url) => {
        fetches.push(String(url));
        return fakeJsonResponse(buildPipelinePayload(STANDARD_SUMMARY, {
          'CV Sent': [1, 2],
        }));
      });
      const r = await call({ job: 984, fields: ['id', 'name', 'linkedin_profile'] });
      const body = await r.json();
      const rfCalls = fetches.filter((u) => u.includes('/job/pipeline'));
      const candGets = fetches.filter((u) => u.includes('/candidate/get'));
      expect(rfCalls).toHaveLength(1);
      expect(candGets).toHaveLength(0);
      expect(body.stages['CV Sent']).toHaveLength(2);
      expect(body.stages['CV Sent'].map((c) => c.id).sort()).toEqual([1, 2]);
    });

    it('expanded fields → /job/pipeline + N parallel /candidate/get (concurrency capped at 8)', async () => {
      await insertJob(984);
      // Seed 30 thin rows so the legacy `candidates` table exists for any
      // shared lookups; the v2 rows are the source of truth for thin path.
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
            'CV Sent': Array.from({ length: 30 }, (_, i) => i + 1),
          }));
        }
        if (u.includes('/candidate/get')) {
          candidateFetched++;
          inFlight++;
          if (inFlight > observedMaxConcurrency) observedMaxConcurrency = inFlight;
          // Microtask yield so concurrent invocations actually overlap and the
          // in-flight count reflects the worker pool's parallelism.
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight--;
          const idMatch = u.match(/[?&]id=(\d+)/);
          const id = idMatch ? Number(idMatch[1]) : 0;
          return fakeJsonResponse({
            candidate: { id, name: `C${id}`, primary_email: `c${id}@x.com` },
          });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });

      // primary_email is OUTSIDE the thin set so it forces the expanded
      // hydration path (current_title now stays thin — see THIN_FIELDS docs).
      const r = await call({ job: 984, fields: ['id', 'name', 'primary_email'] });
      const body = await r.json();
      expect(pipelineFetched).toBe(1);
      expect(candidateFetched).toBe(30);
      // Hard cap at 8 — defensive against accidental concurrency-bound bumps.
      expect(observedMaxConcurrency).toBeLessThanOrEqual(8);
      expect(body.stages['CV Sent']).toHaveLength(30);
      expect(body.stages['CV Sent'].every((c) => c.primary_email?.startsWith('c'))).toBe(true);
    });

    it('current_title field stays on the thin path (no /candidate/get fan-out — at-cache-time snapshot)', async () => {
      // Spec rev 5 lines 173-175: current_title_at_cache_time is cached on
      // candidates_v2; requesting `current_title` returns that snapshot
      // verbatim and skips the live /candidate/get fan-out. Trade-off
      // documented on the rf_job_pipeline descriptor.
      await insertJob(984);
      await insertCandidate(7, 'X', {
        linkedin_profile: 'x-slug',
        current_title: 'Engineer',
      });
      const fetches = [];
      globalThis.fetch = vi.fn(async (url) => {
        fetches.push(String(url));
        return fakeJsonResponse(buildPipelinePayload(STANDARD_SUMMARY, { 'CV Sent': [7] }));
      });
      const r = await call({ job: 984, fields: ['id', 'name', 'current_title'] });
      const body = await r.json();
      expect(fetches.filter((u) => u.includes('/candidate/get'))).toHaveLength(0);
      const c = body.stages['CV Sent'][0];
      expect(c.id).toBe(7);
      expect(c.current_title).toBe('Engineer');
    });

    it('per-id /candidate/get failure during hydration returns partial result + hydration_errors with status', async () => {
      await insertJob(984);
      await insertCandidate(1, 'A');
      await insertCandidate(2, 'B');
      globalThis.fetch = vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/job/pipeline')) {
          return fakeJsonResponse(buildPipelinePayload(STANDARD_SUMMARY, {
            'CV Sent': [1, 2],
          }));
        }
        if (u.includes('/candidate/get')) {
          const idMatch = u.match(/[?&]id=(\d+)/);
          const id = idMatch ? Number(idMatch[1]) : 0;
          if (id === 1) {
            return fakeJsonResponse({
              candidate: { id: 1, name: 'A', primary_email: 'a@x.com' },
            });
          }
          // 502 retry-once fires, then second attempt also 502 → upstream
          // throws RFTransientError. Handler captures as hydration_errors[]
          // entry instead of bubbling.
          return fakeErrorResponse({ status: 502, body: 'boom' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });

      // primary_email forces fan-out (current_title would stay thin).
      const r = await call({ job: 984, fields: ['id', 'name', 'primary_email'] });
      const body = await r.json();
      expect(body.hydration_errors).toEqual([
        { id: 2, reason: expect.stringContaining('502'), status: 502 },
      ]);
      // Partial success: candidate 1 surfaces in CV Sent, candidate 2 dropped.
      expect(body.stages['CV Sent']).toHaveLength(1);
      expect(body.stages['CV Sent'][0].id).toBe(1);
      expect(body.stages['CV Sent'][0].primary_email).toBe('a@x.com');
    });

    it('RF /job/pipeline failure → recoverable pipeline_unavailable envelope', async () => {
      await insertJob(984);
      globalThis.fetch = vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('/job/pipeline')) {
          // 500 (not 502) so the one-shot 502-retry is skipped and we surface
          // the failure on the first attempt.
          return fakeErrorResponse({ status: 500, body: 'pipeline service down' });
        }
        throw new Error(`unexpected fetch: ${u}`);
      });
      const r = await call({ job: 984 });
      const body = await r.json();
      expect(r.status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.recoverable).toBe(true);
      expect(body.kind).toBe('pipeline_unavailable');
      expect(body.error).toMatch(/500/);
    });
  });
});
