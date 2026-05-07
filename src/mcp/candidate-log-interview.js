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
import { getCandidateById } from './d1-read.js';

const DEFAULT_DURATION_MIN = 60;
// Fallback only — used if the sync-worker hasn't yet populated
// `sync_state.activity_types` (e.g. before the first full rebuild).
const ACTIVITY_TYPE_INTERVIEW_FALLBACK = 1003;

/**
 * Resolve the RF activity-type id whose name matches "interview" (case-
 * insensitive) from the cached `sync_state.activity_types`. The cache is
 * populated by the sync-worker's full-rebuild flow as a JSON-encoded
 * `[{id,name},...]`. Falls back to the legacy hardcoded id if the cache
 * isn't available yet.
 */
async function getInterviewActivityTypeId(env) {
  const row = await env.RF_MCP_CACHE
    .prepare("SELECT value FROM sync_state WHERE key = 'activity_types'")
    .first();
  if (!row?.value) return ACTIVITY_TYPE_INTERVIEW_FALLBACK;
  let types;
  try {
    types = JSON.parse(row.value);
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
  if (!body.start_time) return jsonResponse(400, { error: 'start_time is required' });
  if (typeof body.candidate !== 'number') {
    return jsonResponse(400, { error: 'candidate must be numeric id' });
  }

  const candidate = await getCandidateById(env, body.candidate);
  if (!candidate) return jsonResponse(404, { error: 'candidate not found' });

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
  const r = await fetch(`${env.RF_API_BASE_URL}/custom-activity/create`, {
    method: 'POST',
    headers: { 'RF-Api-Key': env.RF_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate_id: candidate.id,
      activity_type_id,
      activity_text: text || `${body.kind ?? 'Interview'} scheduled`,
      activity_user_id: consultant.rfUserId,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    }),
  });
  if (!r.ok) return jsonResponse(502, { error: `RF activity create failed: ${r.status}` });
  const activity = await r.json();

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
