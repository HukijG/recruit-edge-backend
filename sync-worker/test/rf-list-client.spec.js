import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchCandidate,
  fetchCandidatesUpdatedSince,
  fetchAllJobs,
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

  it('fetchCandidatesUpdatedSince paginates and stops when all rows are stale', async () => {
    const cursor = '2026-05-01T00:00:00Z';
    const fresh = { id: 1, last_updated: '2026-05-02T00:00:00Z' };
    const stale = { id: 2, last_updated: '2026-04-30T00:00:00Z' };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [fresh, stale] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
    const ids = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids).toEqual([1]);
  });

  it('fetchAllJobs paginates until empty', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 1 }, { id: 2 }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));
    const jobs = await fetchAllJobs(env);
    expect(jobs.length).toBe(2);
  });

  it('fetchCandidatesUpdatedSince respects HARD_CAP of 5000', async () => {
    // Build a single fresh page of 100 rows (> cursor), and have fetch keep returning it.
    // The function should stop after collecting 5000 ids regardless of the upstream
    // never running out of fresh data.
    const PAGE_SIZE = 100;
    const cursor = '2026-01-01T00:00:00Z';
    const freshPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      id: i + 1,
      last_updated: '2026-05-02T00:00:00Z',
    }));
    global.fetch = vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify({ data: freshPage })))
    );

    const ids = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids.length).toBe(5000);
    // 50 pages * 100 rows = 5000 — exactly the cap. Must not request a 51st page.
    expect(global.fetch.mock.calls.length).toBe(50);
  });

  it('fetchCandidate throws a useful error on non-2xx response', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('candidate not found', { status: 404 })
    );
    await expect(fetchCandidate(env, 999)).rejects.toThrow(/404/);
  });
});
