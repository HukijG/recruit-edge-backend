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
    const { ids } = await fetchCandidatesUpdatedSince(env, cursor);
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

    const { ids } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids.length).toBe(5000);
    // 50 pages * 100 rows = 5000 — exactly the cap. Must not request a 51st page.
    expect(global.fetch.mock.calls.length).toBe(50);
  });

  it('fetchCandidatesUpdatedSince returns suggestedCursor = min(returned) when capped', async () => {
    // 5001+ fresh rows → cap kicks in → suggestedCursor must be the OLDEST
    // timestamp in the returned set so the next tick refetches from the cap edge
    // and doesn't drop the rows older-but-still-fresh that we skipped.
    // Since we sort DESC, we mock pages where each page's rows have timestamps
    // strictly older than the previous page. The 50th page's timestamps will be
    // the oldest → min(returned) lives there.
    const cursor = '2026-01-01T00:00:00Z';
    const PAGE_SIZE = 100;
    const NUM_PAGES = 51; // 5100 fresh rows total, cap stops us after 50

    let pageIdx = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      // Each page's rows: timestamps decrease as page index increases (DESC).
      // page 0 → 5100 down to 5001; page 1 → 5000 down to 4901; ...
      const start = (NUM_PAGES * PAGE_SIZE) - (pageIdx * PAGE_SIZE);
      const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({
        id: pageIdx * PAGE_SIZE + i + 1,
        // Encode the rank as minutes-from-epoch so timestamps are strictly ordered.
        last_updated: new Date(2026, 0, 1, 0, start - i).toISOString(),
      }));
      pageIdx++;
      return Promise.resolve(new Response(JSON.stringify({ data: rows })));
    });

    const { ids, suggestedCursor } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids.length).toBe(5000);
    // The oldest in the returned set is the LAST row of page 50 (index 49 in 0-based).
    // start for that page = 5100 - 49*100 = 200; last row's minute = 200 - 99 = 101.
    const expectedOldest = new Date(2026, 0, 1, 0, 101).toISOString();
    expect(suggestedCursor).toBe(expectedOldest);
  });

  it('fetchCandidatesUpdatedSince returns suggestedCursor = max(returned) when not capped', async () => {
    const cursor = '2026-05-01T00:00:00Z';
    const rows = [
      { id: 1, last_updated: '2026-05-05T00:00:00Z' },
      { id: 2, last_updated: '2026-05-04T00:00:00Z' },
      { id: 3, last_updated: '2026-05-03T00:00:00Z' },
      { id: 4, last_updated: '2026-05-02T00:00:00Z' },
      { id: 5, last_updated: '2026-05-01T12:00:00Z' },
    ];
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: rows })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] })));

    const { ids, suggestedCursor } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids).toEqual([1, 2, 3, 4, 5]);
    expect(suggestedCursor).toBe('2026-05-05T00:00:00Z');
  });

  it('fetchCandidatesUpdatedSince returns suggestedCursor = cursor when no fresh rows', async () => {
    const cursor = '2026-05-01T00:00:00Z';
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 99, last_updated: '2026-04-30T00:00:00Z' }] }))
    );
    const { ids, suggestedCursor } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids).toEqual([]);
    expect(suggestedCursor).toBe(cursor);
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
    const rows = [{ id: 1, last_updated: '2026-05-02T00:00:00Z' }];
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: rows })));
    const { ids } = await fetchCandidatesUpdatedSince(env, cursor);
    expect(ids).toEqual([1]);
    // 502 + retry → success. Single short page (< PAGE_SIZE) terminates pagination.
    expect(global.fetch.mock.calls.length).toBe(2);
  });
});
