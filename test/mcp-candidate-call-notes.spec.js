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

describe('/mcp/candidate-call-notes step=get_transcript', () => {
  const happyCall = {
    call_id: '5000000000000001',
    contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF50976', name: 'Priya Sharma', phone: '+1', type: 'shared' },
    target: { id: '8000000000000001', type: 'user', email: 'joel@…', name: 'Joel Haines' },
    date_started: '1747000000000',
    direction: 'outbound',
    duration: 0,
    total_duration: 1_440_000,
    state: 'hangup',
  };
  const happyTranscript = {
    call_id: '5000000000000001',
    lines: [
      { type: 'moment', name: 'X', content: 'voicemail', time: '...' },
      { type: 'transcript', name: 'Sarah', content: 'Hi Joel, thanks for setting this up.', time: '...' },
      { type: 'moment', name: 'X', content: 'call_purpose_category' },
      { type: 'transcript', name: 'Joel', content: 'Of course — start by telling me a bit about your role.' },
      { type: 'transcript', name: 'Sarah', content: 'Sure, I lead the platform team at Globex…' },
    ],
  };

  function mockTwo(callBody, transcriptBody) {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/call/')) {
        return Promise.resolve(new Response(JSON.stringify(callBody), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      if (u.includes('/transcripts/')) {
        return Promise.resolve(new Response(JSON.stringify(transcriptBody), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return Promise.resolve(new Response('unexpected', { status: 500 }));
    });
  }

  it('happy path: ownership ok, transcript filtered + formatted, guidance returned', async () => {
    mockTwo(happyCall, happyTranscript);
    const r = await call({
      consultantFirstName: 'Joel',
      step: 'get_transcript',
      call_id: '5000000000000001',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(true);
    expect(b.candidate).toEqual({ id: 50976, name: 'Priya Sharma' });
    expect(b.call.call_id).toBe('5000000000000001');
    expect(b.call.duration_minutes).toBe(24);
    expect(b.call.direction).toBe('outbound');
    expect(b.transcript).toBe(
      'Sarah: Hi Joel, thanks for setting this up.\n'
      + 'Joel: Of course — start by telling me a bit about your role.\n'
      + 'Sarah: Sure, I lead the platform team at Globex…',
    );
    expect(typeof b.guidance).toBe('string');
    expect(b.guidance.length).toBeGreaterThan(50);
  });

  it('call_id missing → 400', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript' });
    expect(r.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('Dialpad get-call 429 → rate_limited', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript', call_id: '1' });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('rate_limited');
  });

  it('Dialpad get-call 404 → call_not_found', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript', call_id: '1' });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('call_not_found');
  });

  it('Dialpad get-call 500 → 502', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript', call_id: '1' });
    expect(r.status).toBe(502);
  });

  it('target.id mismatch → not_your_call', async () => {
    mockTwo({ ...happyCall, target: { ...happyCall.target, id: '9999999999999999' } }, happyTranscript);
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript', call_id: '1' });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('not_your_call');
    const calls = globalThis.fetch.mock.calls.map(([u]) => String(u));
    expect(calls.every((u) => !u.includes('/transcripts/'))).toBe(true);
  });

  it('contact has no RF id → no_rf_candidate', async () => {
    mockTwo({ ...happyCall, contact: { id: '5000000000000002', name: '(415) 555-0184', type: 'local' } }, happyTranscript);
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript', call_id: '1' });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_rf_candidate');
  });

  it('RF id present but candidate missing in D1 → no_candidate', async () => {
    mockTwo({ ...happyCall, contact: { id: 'shared_contact_pool_Company:0000000000000000_uid_RF77777' } }, happyTranscript);
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript', call_id: '1' });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_candidate');
  });

  it('transcript 404 → no_transcript', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      const u = String(url);
      if (u.includes('/call/')) return Promise.resolve(new Response(JSON.stringify(happyCall), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (u.includes('/transcripts/')) return Promise.resolve(new Response('', { status: 404 }));
      return Promise.resolve(new Response('?', { status: 500 }));
    });
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript', call_id: '1' });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_transcript');
  });

  it('transcript with only moments → no_transcript', async () => {
    mockTwo(happyCall, { call_id: '1', lines: [{ type: 'moment', name: 'X', content: 'voicemail' }] });
    const r = await call({ consultantFirstName: 'Joel', step: 'get_transcript', call_id: '1' });
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_transcript');
  });
});

describe('/mcp/candidate-call-notes step=submit_notes', () => {
  it('fast path: candidate_id + note → RF note posted with consultant attribution', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      step: 'submit_notes',
      candidate_id: 50976,
      note: '**Background**\n- 8 yrs at Globex',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(String(url)).toContain('/candidate/notes/add');
    const sent = JSON.parse(opts.body);
    expect(sent.id).toBe(50976);
    expect(sent.created_by).toBe(900001); // Joel's rfUserId
    expect(sent.value).toContain('<strong>Background</strong>');
    expect(sent.value).toContain('<li>8 yrs at Globex</li>');
  });

  it('note missing → 400', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', step: 'submit_notes', candidate_id: 50976 });
    expect(r.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('both candidate_id and candidate_fallback → 400 XOR', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel', step: 'submit_notes',
      candidate_id: 50976, candidate_fallback: 'Sarah', note: 'x',
    });
    expect(r.status).toBe(400);
    const b = await r.json();
    expect(b.error).toMatch(/exactly one/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('neither candidate identifier → 400', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({ consultantFirstName: 'Joel', step: 'submit_notes', note: 'x' });
    expect(r.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('fast path: candidate_id not in D1 → kind=no_candidate (no RF call)', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel', step: 'submit_notes',
      candidate_id: 999999, note: 'x',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.ok).toBe(false);
    expect(b.kind).toBe('no_candidate');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('attribution always = consultant (fast path): override fields on body are ignored', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      step: 'submit_notes',
      candidate_id: 50976,
      note: 'attribution check',
      // Bogus override attempts — must be ignored.
      user: 999999,
      activity_user_id: 888888,
      created_by: 777777,
    });
    expect(r.status).toBe(200);
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.created_by).toBe(900001); // Joel's rfUserId, from the JWT-resolved consultant.
  });

  it('attribution always = consultant (fallback path): override fields ignored there too', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel',
      step: 'submit_notes',
      candidate_fallback: 'Priya Sharma',
      note: 'fallback attribution check',
      user: 999999,
      activity_user_id: 888888,
    });
    expect(r.status).toBe(200);
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.created_by).toBe(900001);
  });

  it('fast path: RF returns 500 → 502', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const r = await call({
      consultantFirstName: 'Joel', step: 'submit_notes',
      candidate_id: 50976, note: 'x',
    });
    expect(r.status).toBe(502);
  });

  it('fallback path: candidate_fallback resolves uniquely → ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), { status: 200 }),
    );
    const r = await call({
      consultantFirstName: 'Joel', step: 'submit_notes',
      candidate_fallback: 'Priya Sharma', note: 'fallback path',
    });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.id).toBe(50976);
  });

  it('fallback path: candidate_fallback not found → 404', async () => {
    globalThis.fetch = vi.fn();
    const r = await call({
      consultantFirstName: 'Joel', step: 'submit_notes',
      candidate_fallback: 'Nobody-McNoFace-1234567', note: 'x',
    });
    expect(r.status).toBe(404);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
