/**
 * /mcp/candidate-log-interview — log an interview as a custom RF activity and
 * return a calendar deeplink for the recruiter.
 *
 * RF doesn't expose a calendar primitive we can write to directly, so the
 * actual calendar event creation happens client-side: the recruiter clicks
 * the returned `outlook_url` (default for the team) or uses `gcal_hint` to
 * spin up a Google Calendar event. The recruiter is the only attendee — we
 * never auto-invite the candidate (that's the recruiter's call to make once
 * they've reviewed the event details).
 *
 * The activity is attributed to the consultant's RF user id via
 * `activity_user_id`. `calendarMode` on the consultant record drives whether
 * we include `gcal_hint` in the response (defaults to 'outlook' for the team;
 * Joel is the only known gcal user).
 */

import { jsonResponse } from './router.js';
import { readSyncState } from './d1-read.js';
import { resolveCandidate, resolveCandidateThin, resolveJob } from './resolvers.js';
import {
  getRFCandidate,
  createRFCustomActivity,
  RFRateLimitedError,
} from '../rf-client.js';
import { pMapLimit } from './concurrency.js';

const DEFAULT_DURATION_MIN = 60;
const HYDRATION_CONCURRENCY = 8;
// Fallback only — used if the cache-worker hasn't yet populated
// `sync_state.activity_types` (e.g. before the first full rebuild).
const ACTIVITY_TYPE_INTERVIEW_FALLBACK = 1003;

/**
 * Resolve the RF activity-type id whose name matches "interview" (case-
 * insensitive) from the cached `sync_state.activity_types`. The cache is
 * populated by the cache-worker's full-rebuild flow as a JSON-encoded
 * `[{id,name},...]`. Falls back to the legacy hardcoded id if the cache
 * isn't available yet.
 */
async function getInterviewActivityTypeId(env) {
  const value = await readSyncState(env, 'activity_types');
  if (!value) return ACTIVITY_TYPE_INTERVIEW_FALLBACK;
  let types;
  try {
    types = JSON.parse(value);
  } catch {
    return ACTIVITY_TYPE_INTERVIEW_FALLBACK;
  }
  const interview = Array.isArray(types)
    ? types.find((t) => t?.name && /interview/i.test(t.name))
    : null;
  return interview?.id ?? ACTIVITY_TYPE_INTERVIEW_FALLBACK;
}

function buildOutlookUrl({ subject, body, start, end }) {
  const u = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
  u.searchParams.set('subject', subject);
  u.searchParams.set('body', body);
  u.searchParams.set('startdt', start);
  u.searchParams.set('enddt', end);
  return u.toString();
}

function buildGcalHint({ subject, body, start, end }) {
  return {
    summary: subject,
    description: body,
    start,
    end,
    calendarId: 'primary',
    // Recruiter-only block — intentionally empty so we don't auto-invite
    // the candidate. The recruiter adds attendees themselves once the event
    // is on their calendar.
    attendees: [],
  };
}

export async function handleCandidateLogInterview({ env, body, consultant }) {
  // ─── ID short-circuit (deterministic path on follow-up turns) ────────
  // candidate_id / job_id coerced onto the fuzzy fields. resolveCandidate /
  // resolveJob already short-circuit numeric inputs to direct row lookups,
  // so this single coercion is enough — no separate fast-path branch.
  if (body.candidate_id != null && body.candidate == null) {
    body = { ...body, candidate: Number(body.candidate_id) };
  }
  if (body.job_id != null && body.job == null) {
    body = { ...body, job: Number(body.job_id) };
  }

  if (!body.start_time) return jsonResponse(400, { error: 'start_time is required' });
  if (body.candidate == null) {
    return jsonResponse(400, { error: 'candidate is required' });
  }

  // Resolve candidate(s). Use the thin resolver by default — full body is
  // only needed for the optional `job` filter post-narrow, in which case
  // we live-fetch on demand per option below.
  let candRes;
  try {
    candRes = await resolveCandidateThin(env, body.candidate);
  } catch (e) {
    if (e instanceof RFRateLimitedError) {
      return jsonResponse(200, {
        ok: false, kind: 'rate_limited', recoverable: false,
        retry_after_ms: e.retryAfterMs ?? null,
        error: 'RF rate limited',
      });
    }
    return jsonResponse(200, {
      ok: false, kind: 'rf_unavailable', recoverable: true,
      error: e?.message ?? String(e),
    });
  }
  let candidateOptions;
  if (candRes.ok) {
    // Thin row has id + name + snapshot title/org but NOT jobs[]. Project to
    // the candidate shape the legacy code path consumed.
    const t = candRes.value;
    candidateOptions = [{
      id: t.id,
      name: t.name,
      current_organization: t.current_company_at_cache_time ?? null,
      current_title: t.current_title_at_cache_time ?? null,
    }];
  } else if (candRes.reason === 'ambiguous') {
    // Each option carries thin display hints. Job filter (below) will
    // live-fetch jobs[] per option as needed.
    candidateOptions = candRes.options.map((o) => ({
      id: o.id,
      name: o.name,
      current_organization: o.current_organization ?? null,
      current_title: o.current_title ?? null,
    }));
  } else {
    // Lean envelope: HTTP 200 + {ok:false, kind:'no_candidate'} — consistent
    // with the rest of the system. The consumer apologises + asks for a
    // better-narrowed reference rather than crashing on a 404.
    return jsonResponse(200, { ok: false, kind: 'no_candidate', error: 'candidate not found' });
  }

  // If `body.job` is set, validate that each candidate has a non-DQ link to
  // that job. jobs[] is mutable → must live-fetch each option's body. Drop
  // candidates that don't survive the filter — auto-narrow win when only one
  // ambiguous candidate is on the requested job.
  if (body.job != null) {
    const bodies = await pMapLimit(
      candidateOptions.map((c) => c.id),
      HYDRATION_CONCURRENCY,
      async (id) => getRFCandidate(id, env),
    );
    const validated = [];
    for (let i = 0; i < candidateOptions.length; i++) {
      const r = bodies[i];
      if (!r.ok) continue;
      const fullBody = r.value;
      const nonDq = (fullBody.jobs ?? []).filter((j) => !j.disqualified);
      if (nonDq.length === 0) continue;
      const jobRes = await resolveJob(env, body.job, { restrictTo: nonDq });
      if (jobRes.ok || jobRes.reason === 'ambiguous') {
        // Carry the live body forward so we don't re-fetch when narrowed
        // to a single candidate below.
        validated.push({ ...candidateOptions[i], _liveBody: fullBody });
      }
    }
    candidateOptions = validated;
  }

  if (candidateOptions.length === 0) {
    return jsonResponse(400, {
      error: 'no candidate matches the given filters',
    });
  }

  if (candidateOptions.length > 1) {
    // Multiple candidates pass the filter → lean kind='candidate' envelope.
    return jsonResponse(200, {
      needs_disambiguation: true,
      kind: 'candidate',
      options: candidateOptions.map((c) => ({
        id: c.id,
        name: c.name,
        current_organization: c.current_organization ?? null,
        current_title: c.current_title ?? null,
      })),
      hint: 'Multiple candidates match — please be more specific.',
    });
  }

  const candidate = candidateOptions[0];

  const start = new Date(body.start_time);
  const end = body.end_time
    ? new Date(body.end_time)
    : new Date(start.getTime() + DEFAULT_DURATION_MIN * 60_000);

  const subject = `${body.kind ?? 'Interview'} — ${candidate.name}`;
  const text = body.context
    ? body.context
        .split('\n')
        .map((l) => `• ${l.trim()}`)
        .filter((l) => l !== '• ')
        .join('<br>')
    : '';

  const activity_type_id = await getInterviewActivityTypeId(env);
  let activity;
  try {
    // Delegate to the shared `createRFCustomActivity` helper so that 429
    // (RFRateLimitedError, with RFC-7231-compliant Retry-After parsing
    // including HTTP-date), 5xx (RFTransientError), and other non-2xx
    // (RFError) all surface as the canonical typed errors.
    activity = await createRFCustomActivity({
      candidate_id: candidate.id,
      activity_type_id,
      activity_text: text || `${body.kind ?? 'Interview'} scheduled`,
      activity_user_id: consultant.rfUserId,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    }, env);
  } catch (err) {
    // Lean envelope: HTTP 200 + {ok:false, kind, error}. 429 → rate_limited
    // (non-recoverable); other non-2xx → rf_unavailable (recoverable).
    if (err instanceof RFRateLimitedError) {
      return jsonResponse(200, {
        ok: false, kind: 'rate_limited', recoverable: false,
        retry_after_ms: err.retryAfterMs ?? null,
        error: 'RF rate limited',
      });
    }
    return jsonResponse(200, {
      ok: false, kind: 'rf_unavailable', recoverable: true,
      error: `RF activity create failed: ${err?.status ?? err?.message ?? 'unknown'}`,
    });
  }

  const calendarMode = consultant.calendarMode ?? 'outlook';
  // Recruiter-only calendar block — never include the candidate's email in
  // the calendar deeplink (the recruiter adds attendees themselves once the
  // event lands on their calendar). See spec § "log-interview".
  const out = {
    ok: true,
    activity: { id: activity.id, candidate_id: candidate.id, kind: body.kind },
    next_step: 'Add this interview to your calendar via the link below.',
    outlook_url: buildOutlookUrl({
      subject,
      body: text,
      start: start.toISOString(),
      end: end.toISOString(),
    }),
  };
  if (calendarMode === 'gcal' || calendarMode === 'both') {
    out.gcal_hint = buildGcalHint({
      subject,
      body: text,
      start: start.toISOString(),
      end: end.toISOString(),
    });
  }
  return jsonResponse(200, out);
}
