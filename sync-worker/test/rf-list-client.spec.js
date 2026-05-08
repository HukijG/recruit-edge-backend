import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchCandidate,
  fetchCandidatesUpdatedSince,
  fetchAllJobs,
  fetchJobPipeline,
} from '../src/rf-list-client.js';

const env = { RF_API_KEY: 'test', RF_API_BASE_URL: 'https://api.recruiterflow.com/api/external' };

describe('rf-list-client', () => {
  beforeEach(() => {
    // Each test sets its own mock; reset between to keep call-count assertions honest.
    if (global.fetch && typeof global.fetch.mockReset === 'function') {
      global.fetch.mockReset();
    }
  });

  it('fetchCandidate sends the right request shape', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 123, name: 'X' })));
    await fetchCandidate(env, 123);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/candidate/get');
    expect(url).toContain('id=123');
    expect(init.headers['RF-Api-Key']).toBe('test');
  });

  it('fetchCandidatesUpdatedSince sends the right RF date filter shape', async () => {
    const cursor = '2026-05-01T00:00:00Z';
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 1 }, { id: 2 }] }))
    );
    const { ids } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids).toEqual([1, 2]);
    const [, init] = global.fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.filters[0]).toMatchObject({
      filter_type: 'after',
      is_relative: false,
      date: '2026-05-01',  // day-granularity
      key: 'last_activity',
      type: 'date',
    });
    expect(body.conjunction).toBe('match-all');
  });

  it('fetchCandidatesUpdatedSince walks pages until short last page', async () => {
    const cursor = '2026-05-01T00:00:00Z';
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    const shortPage = [{ id: 999 }];
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: fullPage })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: shortPage })));
    const { ids } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids.length).toBe(101);
    expect(global.fetch.mock.calls.length).toBe(2);
  });

  it('fetchAllJobs paginates until empty', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 1 }, { id: 2 }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
    const jobs = await fetchAllJobs(env);
    expect(jobs.length).toBe(2);
  });

  it('fetchCandidatesUpdatedSince respects HARD_CAP of 5000', async () => {
    // RF returns full pages indefinitely → function stops at the 5000-id cap.
    const PAGE_SIZE = 100;
    const cursor = '2026-01-01T00:00:00Z';
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i + 1 }));
    global.fetch = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ data: fullPage })))
    );
    const { ids } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids.length).toBe(5000);
    // 50 pages * 100 rows = 5000 — must not request a 51st page.
    expect(global.fetch.mock.calls.length).toBe(50);
  });

  it('fetchCandidatesUpdatedSince leaves cursor unchanged when capped', async () => {
    const cursor = '2026-01-01T00:00:00Z';
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i + 1 }));
    global.fetch = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ data: fullPage })))
    );
    const { ids, suggestedCursor } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids.length).toBe(5000);
    // Capped → cursor stays so next tick re-fetches from the same boundary.
    expect(suggestedCursor).toBe(cursor);
  });

  it('fetchCandidatesUpdatedSince advances cursor to "now" when not capped', async () => {
    const cursor = '2026-05-01T00:00:00Z';
    const before = Date.now();
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] }))
    );
    const { ids, suggestedCursor } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids).toEqual([1, 2, 3]);
    // suggestedCursor should be a fresh "now" — newer than `before`.
    expect(Date.parse(suggestedCursor)).toBeGreaterThanOrEqual(before);
  });

  it('fetchCandidatesUpdatedSince advances cursor when RF filter returns empty', async () => {
    // RF's date filter returned no rows → nothing changed since cursor → still
    // advance to "now" (we have the full delta — i.e. an empty delta).
    const cursor = '2026-05-01T00:00:00Z';
    const before = Date.now();
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }))
    );
    const { ids, suggestedCursor } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids).toEqual([]);
    expect(Date.parse(suggestedCursor)).toBeGreaterThanOrEqual(before);
  });

  it('fetchCandidate throws a useful error on non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('candidate not found', { status: 404 })
    );
    await expect(fetchCandidate(env, 999)).rejects.toThrow(/404/);
  });

  it('fetchCandidate retries once on 502 then returns the 200 payload', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 7, name: 'OK' })));
    const result = await fetchCandidate(env, 7);
    expect(result).toEqual({ id: 7, name: 'OK' });
    expect(global.fetch.mock.calls.length).toBe(2);
  });

  it('fetchCandidate throws after two consecutive 502s', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response('bad gateway again', { status: 502 }));
    await expect(fetchCandidate(env, 7)).rejects.toThrow(/502/);
    expect(global.fetch.mock.calls.length).toBe(2);
  });

  it('fetchCandidatesUpdatedSince retries POST once on 502', async () => {
    const cursor = '2026-05-01T00:00:00Z';
    const rows = [{ id: 1 }];
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: rows })));
    const { ids } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids).toEqual([1]);
    expect(global.fetch.mock.calls.length).toBe(2);
  });

  it('fetchJobPipeline GETs /job/pipeline?job_id=… and returns the parsed body', async () => {
    const sample = {
      summary: [{ id: 1, name: 'Sourced', count: 2 }],
      detail: [
        { candidate: { id: 100, name: 'A' }, stages: [{ from: null, time: '2026-05-01T00:00:00+0000', to: 'Sourced' }] },
      ],
    };
    global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(sample)));
    const out = await fetchJobPipeline(env, 984);
    expect(out).toEqual(sample);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toContain('/job/pipeline');
    expect(url).toContain('job_id=984');
    expect(init.headers['RF-Api-Key']).toBe('test');
  });
});
