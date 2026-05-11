import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchCallsForConsultant } from '../src/dialpad-list-client.js';

const env = {
  DIALPAD_API_KEY: 'test-key',
  DIALPAD_API_BASE_URL: 'https://dialpad.com/api/v2',
};

beforeEach(() => { globalThis.fetch = vi.fn(); });

function mockPages(pages /* Array<{items, cursor}> */) {
  let i = 0;
  globalThis.fetch.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => pages[i++] ?? { items: [], cursor: null },
    text: async () => '',
    headers: new Map([['content-type', 'application/json']]),
  }));
}

describe('fetchCallsForConsultant', () => {
  it('paginates until cursor is null', async () => {
    mockPages([
      { items: [{ call_id: 'a' }, { call_id: 'b' }], cursor: 't1' },
      { items: [{ call_id: 'c' }], cursor: null },
    ]);
    const out = await fetchCallsForConsultant(env, '8000000000000001', 1717248000000);
    expect(out.map(c => c.call_id)).toEqual(['a', 'b', 'c']);
  });

  it('passes target_id, target_type=user, started_after to Dialpad', async () => {
    mockPages([{ items: [], cursor: null }]);
    await fetchCallsForConsultant(env, '8000000000000001', 1717248000000);
    const url = new URL(globalThis.fetch.mock.calls[0][0]);
    expect(url.searchParams.get('target_id')).toBe('8000000000000001');
    expect(url.searchParams.get('target_type')).toBe('user');
    expect(url.searchParams.get('started_after')).toBe('1717248000000');
  });

  it('caps at MAX_PAGES to avoid runaway pagination', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({
      items: [{ call_id: `c${i}` }],
      cursor: i < 29 ? `t${i}` : null,
    }));
    mockPages(pages);
    const out = await fetchCallsForConsultant(env, '8000000000000001', 0);
    // MAX_PAGES = 25 (well above the 1–3 pages a 15-min cron tick should ever need)
    expect(out.length).toBeLessThanOrEqual(25);
  });
});
