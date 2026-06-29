/**
 * Cancelled cold-call coverage: the Sourced gate (selectSourcedJob), the
 * mechanical finalize (finalizeCancelledColdCall), activity parsing/labelling,
 * and the webhook→arbiter dispatch helpers.
 */

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { selectSourcedJob } from '../src/rf-client.js';
import { formatOutcomeLabel, parseColdCallActivity, finalizeCancelledColdCall } from '../src/cold-call.js';
import { routeHangupToArbiter, signalTranscriptToArbiter } from '../src/cold-call-arbiter.js';

const JOEL_DIALPAD_ID = '8000000000000001';
const originalFetch = globalThis.fetch;

function job(overrides = {}) {
  return {
    job_id: 100,
    stage_name: 'Sourced',
    is_open: true,
    stages: [{ id: 1, name: 'Sourced' }, { id: 2, name: 'Replied' }],
    ...overrides,
  };
}
function candidate(jobs, extra = {}) {
  return { id: 123, tags: ['Existing'], jobs, ...extra };
}

function mockFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, opts });
    for (const r of routes) {
      if (u.includes(r.match)) {
        return new Response(JSON.stringify(r.response ?? {}), { status: r.status || 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ error: 'unmocked' }), { status: 500 });
  };
  return calls;
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe('formatOutcomeLabel / parseColdCallActivity — cancelled', () => {
  it('labels cancelled', () => {
    expect(formatOutcomeLabel('cancelled')).toBe('Cancelled');
  });
  it('parses a cancelled activity outcome', () => {
    const parsed = parseColdCallActivity({ activity_id: 7, time: '2026-05-01T10:00:00+0000', text: 'Cold call with Jane Doe — Cancelled' });
    expect(parsed.outcome).toBe('cancelled');
    expect(parsed.type).toBe('cold_call');
  });
  it('still parses voicemail / connected', () => {
    expect(parseColdCallActivity({ activity_id: 1, time: '2026-05-01T10:00:00+0000', text: 'Cold call with X — Voicemail' }).outcome).toBe('voicemail');
    expect(parseColdCallActivity({ activity_id: 2, time: '2026-05-01T10:00:00+0000', text: 'Cold call with X — Connected (Positive)' }).outcome).toBe('connected');
  });
});

describe('selectSourcedJob', () => {
  it('returns the single open Sourced job', async () => {
    const c = candidate([job()]);
    const r = await selectSourcedJob(c, null, env);
    expect(r?.job_id).toBe(100);
  });
  it('returns null when jobs[0] is not Sourced', async () => {
    const c = candidate([job({ stage_name: '1st Interview' })]);
    expect(await selectSourcedJob(c, null, env)).toBeNull();
  });
  it('returns null when the Sourced job is closed (openOnly)', async () => {
    const c = candidate([job({ is_open: false })]);
    expect(await selectSourcedJob(c, null, env)).toBeNull();
  });
  it('returns null when there are no jobs', async () => {
    expect(await selectSourcedJob(candidate([]), null, env)).toBeNull();
  });
});

describe('finalizeCancelledColdCall', () => {
  beforeEach(async () => {
    await applyUsersMigration(env);
    _resetCacheForTests();
  });

  const tenv = () => ({ ...env, RF_API_KEY: env.RF_API_KEY || 'test-key', RF_API_BASE_URL: 'https://api.recruiterflow.com/api/external' });
  const payload = (over = {}) => ({
    rfCandidateId: 123,
    dialpadUserId: 'unmapped-user',   // → activityUserId null → jobs[0] fallback (no consultant fetch)
    callId: '555',
    callTimeMs: Date.parse('2026-05-01T10:00:00Z'),
    contactName: 'Jane Doe',
    ...over,
  });

  it('records a cancelled activity for a Sourced candidate', async () => {
    const calls = mockFetch([
      { match: '/candidate/get', response: { candidate: candidate([job()]) } },
      { match: '/custom-activity/create', response: { ok: true } },
      { match: '/candidate/update', response: { ok: true } },
    ]);

    const res = await finalizeCancelledColdCall(payload(), tenv());
    expect(res.recorded).toBe(true);

    const created = calls.find(c => c.url.includes('/custom-activity/create'));
    expect(created).toBeTruthy();
    const body = JSON.parse(created.opts.body);
    expect(body.activity_text).toContain('Cancelled');
    expect(body.activity_type_id).toBe(1002);
    expect(body.associated_entities.candidates).toContain(123);

    const updated = calls.find(c => c.url.includes('/candidate/update'));
    expect(JSON.parse(updated.opts.body).source).toBe('Cold Call');
  });

  it('skips a candidate not in Sourced (no activity written)', async () => {
    const calls = mockFetch([
      { match: '/candidate/get', response: { candidate: candidate([job({ stage_name: '1st Interview' })]) } },
      { match: '/custom-activity/create', response: { ok: true } },
      { match: '/candidate/update', response: { ok: true } },
    ]);

    const res = await finalizeCancelledColdCall(payload(), tenv());
    expect(res.recorded).toBe(false);
    expect(res.reason).toBe('not in Sourced');
    expect(calls.find(c => c.url.includes('/custom-activity/create'))).toBeUndefined();
  });
});

describe('routeHangupToArbiter / signalTranscriptToArbiter', () => {
  beforeEach(async () => {
    await applyUsersMigration(env);
    _resetCacheForTests();
  });

  it('ignores non-outbound hangups', async () => {
    const r = await routeHangupToArbiter({ call_id: 1, direction: 'inbound', state: 'hangup' }, env);
    expect(r.armed).toBe(false);
    expect(r.reason).toBe('not-outbound');
  });

  it('ignores connected calls (talk duration > 0)', async () => {
    const r = await routeHangupToArbiter({ call_id: 1, direction: 'outbound', state: 'hangup', duration: 12000, target: { id: JOEL_DIALPAD_ID } }, env);
    expect(r.armed).toBe(false);
    expect(r.reason).toBe('connected');
  });

  it('ignores monitored never-connected calls with no RF candidate', async () => {
    const r = await routeHangupToArbiter({
      call_id: 2, direction: 'outbound', state: 'hangup', duration: 0,
      target: { id: JOEL_DIALPAD_ID }, contact: { id: 'no-uid-here', name: 'Stranger' },
    }, env);
    expect(r.armed).toBe(false);
    expect(r.reason).toBe('no-rf-candidate');
  });

  it('arms the arbiter for a monitored never-connected call to an RF candidate', async () => {
    const r = await routeHangupToArbiter({
      call_id: 'arb-1', direction: 'outbound', state: 'hangup', duration: 0,
      date_started: Date.parse('2026-05-01T10:00:00Z'),
      target: { id: JOEL_DIALPAD_ID }, contact: { id: 'abc-uid_RF123', name: 'Jane Doe' },
    }, env);
    expect(r.armed).toBe(true);
    expect(r.state).toBe('cancelled-pending');
    expect(r.rfCandidateId).toBe('123'); // extractRFIdFromDialpadContact returns a string
  });

  it('signals a transcript to the arbiter', async () => {
    const r = await signalTranscriptToArbiter({ call_id: 'arb-2', state: 'call_transcription' }, env);
    expect(r.signalled).toBe(true);
  });
});
