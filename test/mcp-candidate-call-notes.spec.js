import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';
import { formatTranscript } from '../src/mcp/candidate-call-notes.js';
import { CALL_NOTES_GUIDANCE } from '../src/mcp/call-notes-guidance.js';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-call-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, createExecutionContext());
}

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  resetSnapshot();
  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
  // Seed one candidate matching Priya Sharma / id 50976.
  await env.RF_MCP_CACHE.prepare(
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (50976, ?, ?, ?)',
  ).bind(
    JSON.stringify({ id: 50976, name: 'Priya Sharma', primary_email: 's@x.com' }),
    'Priya Sharma',
    new Date().toISOString(),
  ).run();
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe('CALL_NOTES_GUIDANCE text-import', () => {
  it('resolves to the markdown source from docs/references/call_notes_guidance.md', () => {
    expect(typeof CALL_NOTES_GUIDANCE).toBe('string');
    // The file is the structured-note brief, several KB in the current shape.
    expect(CALL_NOTES_GUIDANCE.length).toBeGreaterThan(500);
    // Header from the real file; if this stops matching, someone replaced the
    // markdown with a pointer/placeholder by mistake.
    expect(CALL_NOTES_GUIDANCE).toMatch(/Description\/context prompt/);
  });
});

describe('formatTranscript', () => {
  it('filters to type=transcript and renders "name: content" per line', () => {
    const lines = [
      { type: 'moment', name: 'X', content: 'voicemail', time: '2026-05-08T17:14:54Z' },
      { type: 'transcript', name: 'Sarah', content: 'Hi Joel, thanks.', time: '2026-05-08T17:15:00Z' },
      { type: 'moment', name: 'X', content: 'call_purpose_category' },
      { type: 'transcript', name: 'Joel', content: 'Of course — start by telling me…' },
    ];
    expect(formatTranscript(lines)).toBe(
      'Sarah: Hi Joel, thanks.\nJoel: Of course — start by telling me…',
    );
  });

  it('all moments → empty string', () => {
    expect(formatTranscript([{ type: 'moment', name: 'a', content: 'b' }])).toBe('');
  });

  it('missing name → "Unknown:"', () => {
    expect(formatTranscript([{ type: 'transcript', content: 'hi' }])).toBe('Unknown: hi');
  });

  it('missing content → empty after colon', () => {
    expect(formatTranscript([{ type: 'transcript', name: 'A' }])).toBe('A: ');
  });

  it('null / undefined → empty string', () => {
    expect(formatTranscript(null)).toBe('');
    expect(formatTranscript(undefined)).toBe('');
  });
});

describe('/mcp/candidate-call-notes step=list_calls', () => {
  it('happy path: time_query, two paginated pages, mix of <2min and matching/non-matching contacts', async () => {
    const page1 = {
      items: [
        // Long matching call → keep
        {
          call_id: 'A',
          contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976', name: 'Priya Sharma', phone: '+1', type: 'shared' },
          target: { id: '8000000000000001', type: 'user' },
          date_started: '1747000000000',
          direction: 'outbound',
          duration: 0,
          total_duration: 1440000.0,
        },
        // Short matching call → drop (under 120000 ms)
        {
          call_id: 'B',
          contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976', name: 'Priya Sharma', phone: '+1', type: 'shared' },
          target: { id: '8000000000000001', type: 'user' },
          date_started: '1747100000000',
          direction: 'outbound',
          duration: 0,
          total_duration: 60_000,
        },
        // Long non-matching call → drop
        {
          call_id: 'C',
          contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF99999', name: 'Other', phone: '+1', type: 'shared' },
          target: { id: '8000000000000001', type: 'user' },
          date_started: '1747200000000',
          direction: 'outbound',
          duration: 0,
          total_duration: 600_000,
        },
      ],
      cursor: 'PAGE2',
    };
    const page2 = {
      items: [
        // Long matching call on page 2 → keep
        {
          call_id: 'D',
          contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976', name: 'Priya Sharma', phone: '+1', type: 'shared' },
          target: { id: '8000000000000001', type: 'user' },
          date_started: '1746900000000',
          direction: 'inbound',
          duration: 0,
          total_duration: 480_000,
        },
      ],
      cursor: null,
    };
    let n = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      n += 1;
      return Promise.resolve(new Response(
        JSON.stringify(n === 1 ? page1 : page2),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    });

    const r = await call({
      consultantFirstName: 'Joel',
      step: 'list_calls',
      candidate: 50976,
      time_query: 'last 7 days',
    });

    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.candidate).toEqual({ id: 50976, name: 'Priya Sharma' });
    expect(b.window?.started_after).toMatch(/T/);
    expect(b.window?.started_before).toMatch(/T/);
    expect(b.calls).toEqual([
      { call_id: 'A', started_at: new Date(1747000000000).toISOString().replace('.000Z', '+00:00'), duration_minutes: 24, direction: 'outbound' },
      { call_id: 'D', started_at: new Date(1746900000000).toISOString().replace('.000Z', '+00:00'), duration_minutes: 8, direction: 'inbound' },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const page2Url = new URL(String(globalThis.fetch.mock.calls[1][0]));
    expect(page2Url.searchParams.get('cursor')).toBe('PAGE2');
  });

  it('ISO inputs → window OMITTED on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        items: [{
          call_id: 'A', contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976' },
          target: { id: '8000000000000001', type: 'user' }, date_started: '1747000000000',
          direction: 'outbound', duration: 0, total_duration: 1_440_000,
        }],
        cursor: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const r = await call({
      consultantFirstName: 'Joel',
      step: 'list_calls', candidate: 50976,
      started_after: '2026-05-03T00:00:00Z',
      started_before: '2026-05-10T00:00:00Z',
    });
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.window).toBeUndefined();
  });

  it('zero long calls → kind=no_long_calls with window included', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ items: [], cursor: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const r = await call({
      consultantFirstName: 'Joel',
      step: 'list_calls', candidate: 50976, time_query: 'today',
    });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_long_calls');
    expect(b.window?.started_after).toBeTruthy();
    expect(b.window?.started_before).toBeTruthy();
  });

  it('consultant with no dialpadId → kind=no_dialpad_id', async () => {
    await env.USERS_DB.prepare(
      "UPDATE users SET dialpad_id = '' WHERE first_name = 'Joel'",
    ).run();
    _resetCacheForTests();
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel',
      step: 'list_calls', candidate: 50976, time_query: 'today',
    });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_dialpad_id');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('candidate missing → 400', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', step: 'list_calls' });
    expect(r.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('candidate not found → kind=no_candidate', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel', step: 'list_calls', candidate: 999999, time_query: 'today',
    });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_candidate');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('ambiguous fuzzy → needs_disambiguation', async () => {
    await env.RF_MCP_CACHE.prepare(
      'INSERT INTO candidates (id, body, name, current_organization, current_title, cached_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(60001, JSON.stringify({ id: 60001, name: 'Sarah Patel' }), 'Sarah Patel', 'Acme', 'AE', new Date().toISOString()).run();
    await env.RF_MCP_CACHE.prepare(
      'UPDATE candidates SET current_organization = ?, current_title = ? WHERE id = 50976',
    ).bind('Globex', 'CSM').run();
    resetSnapshot();
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel', step: 'list_calls', candidate: 'Sarah', time_query: 'today',
    });
    const b = await r.json();
    expect(b.needs_disambiguation).toBe(true);
    expect(b.kind).toBe('candidate');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('Dialpad list returns 500 → 502', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('boom', { status: 500 }),
    );
    const r = await call({
      consultantFirstName: 'Joel', step: 'list_calls', candidate: 50976, time_query: 'today',
    });
    expect(r.status).toBe(502);
  });

  it('boundary: total_duration of exactly 119_999.5 dropped; 120_000.025 kept (fractional ms per live payloads)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        items: [
          { call_id: 'X', contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976' },
            target: { id: '8000000000000001', type: 'user' }, date_started: '1747000000000',
            direction: 'outbound', duration: 0, total_duration: 119_999.5 },
          { call_id: 'Y', contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976' },
            target: { id: '8000000000000001', type: 'user' }, date_started: '1747100000000',
            direction: 'outbound', duration: 0, total_duration: 120_000.025 },
        ],
        cursor: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const r = await call({
      consultantFirstName: 'Joel', step: 'list_calls', candidate: 50976, time_query: 'today',
    });
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.calls.map((c) => c.call_id)).toEqual(['Y']);
  });

  it('ISO + time_query both set → window OMITTED, warning includes drop', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        items: [{
          call_id: 'A', contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976' },
          target: { id: '8000000000000001', type: 'user' }, date_started: '1747000000000',
          direction: 'outbound', duration: 0, total_duration: 1_440_000,
        }],
        cursor: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const r = await call({
      consultantFirstName: 'Joel', step: 'list_calls', candidate: 50976,
      started_after: '2026-05-03T00:00:00Z',
      time_query: 'yesterday',
    });
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.window).toBeUndefined();
    expect(b._meta?.warnings ?? []).toEqual(expect.arrayContaining([
      expect.stringMatching(/dropped time_query/i),
    ]));
  });

  it('garbage time_query → 7d default window + warning propagated to _meta', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ items: [], cursor: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const r = await call({
      consultantFirstName: 'Joel', step: 'list_calls', candidate: 50976,
      time_query: 'around 3pm last fortnight',
    });
    const b = await r.json();
    expect(b._meta?.warnings ?? []).toEqual(expect.arrayContaining([
      expect.stringMatching(/unrecognised time_query/i),
    ]));
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_long_calls');
  });

  it('non-RF contact (numeric local id, no uid_RF substring) is dropped', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({
        items: [
          { call_id: 'L', contact: { id: '5000000000000002', name: '(415) 555-0184', type: 'local' },
            target: { id: '8000000000000001', type: 'user' }, date_started: '1747000000000',
            direction: 'outbound', duration: 0, total_duration: 600_000 },
        ],
        cursor: null,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const r = await call({
      consultantFirstName: 'Joel', step: 'list_calls', candidate: 50976, time_query: 'today',
    });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_long_calls');
  });

  it('pagination cap (MAX_LIST_PAGES = 20) → first 20 pages returned, warning emitted', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(
      JSON.stringify({
        items: [{
          call_id: 'A', contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976' },
          target: { id: '8000000000000001', type: 'user' }, date_started: '1747000000000',
          direction: 'outbound', duration: 0, total_duration: 600_000,
        }],
        cursor: 'NEXT',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )));
    const r = await call({
      consultantFirstName: 'Joel', step: 'list_calls', candidate: 50976, time_query: 'today',
    });
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.calls.length).toBe(20);
    expect(globalThis.fetch).toHaveBeenCalledTimes(20);
    expect(b._meta?.warnings ?? []).toEqual(expect.arrayContaining([
      expect.stringMatching(/pagination cap/i),
    ]));
  });
});
