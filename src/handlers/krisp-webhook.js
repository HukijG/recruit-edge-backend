/**
 * Krisp webhook handler — meeting notes → RF candidate notes.
 *
 * Resolves attribution (which consultant's meeting) and formats the
 * Krisp payload as an HTML note on the matched RF candidate.
 */

import { cacheCandidate, lookupByEmail } from '../cache.js';
import { formatKrispNotesAsHtml, resolveKrispAttribution, OWNER_EMAIL } from '../krisp.js';
import { searchRFCandidateByEmail, addRFCandidateNote } from '../rf-client.js';
import { getUserByEmail } from '../users.js';

export async function handleKrispWebhook(request, env) {
  try {
    const webhookSecret = env.KRISP_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error({ message: '[Krisp] secret not configured', source: 'krisp' });
      return new Response('Unauthorized', { status: 401 });
    }
    const token = request.headers.get('X-Krisp-Webhook-Token');
    if (!token || token !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();

    if (payload.event !== 'note_generated') {
      console.log({ message: `[Krisp] → ignored event: ${payload.event}`, source: 'krisp', event: payload.event });
      return new Response('OK', { status: 200 });
    }

    const meeting = payload.data?.meeting;
    // note_generated delivers the meeting notes as a single markdown string in
    // `data.raw_content` (the old `data.content` section array is gone).
    const rawContent = payload.data?.raw_content;

    if (!meeting || !meeting.id) {
      return new Response('Bad Request', { status: 400 });
    }

    const dedupeKey = `krisp:${meeting.id}`;
    const alreadyProcessed = await env.SYNC_STATE.get(dedupeKey);
    if (alreadyProcessed) {
      console.log({ message: `[Krisp] → skipped: already processed`, source: 'krisp', meetingId: meeting.id });
      return new Response('OK', { status: 200 });
    }

    console.log({
      message: `[Krisp] meeting="${meeting.title}"`,
      source: 'krisp',
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      meetingUrl: meeting.url,
      startDate: meeting.start_date,
      duration: meeting.duration,
      participants: meeting.participants,
      contentChars: rawContent?.length || 0,
    });

    const notePosted = await processKrispMeetingNotes(meeting, rawContent, env);

    if (notePosted) {
      // 7 days: notes are immutable once posted, so the idempotency key has no
      // reason to expire quickly. Krisp emits multiple events per meeting and
      // can re-deliver `note_generated` on edits/retries — a short TTL would
      // let a late re-delivery double-post the note.
      await env.SYNC_STATE.put(dedupeKey, 'true', { expirationTtl: 604800 });
    }

    return new Response('Krisp webhook processed', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: `[Krisp] error: ${error.message}`, source: 'krisp', stack: error.stack });
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * Post a Krisp meeting's notes (`data.raw_content` markdown) to the matching
 * RF candidate as an HTML note.
 *
 * Attribution: the consultant on the call (resolved from participants by team
 * membership via `resolveKrispAttribution`). If no participant resolves to a
 * team member — their Krisp account email isn't registered in `krisp_emails`
 * yet — we fall back to the owner (Joel), derive their RF id from the registry,
 * and warn loudly. The candidate is the external (guest-shaped) participant.
 *
 * @returns {Promise<boolean>} true if a note was posted (drives the dedup write).
 */
async function processKrispMeetingNotes(meeting, rawContent, env) {
  const { consultant, candidateEmail } = await resolveKrispAttribution(meeting.participants, env);

  if (!candidateEmail) {
    console.log({
      message: '[Krisp] → skipped: no candidate email in participants',
      source: 'krisp',
      meetingId: meeting.id,
      participants: meeting.participants,
    });
    return false;
  }

  if (typeof rawContent !== 'string' || !rawContent.trim()) {
    console.log({ message: '[Krisp] → skipped: empty raw_content', source: 'krisp', meetingId: meeting.id });
    return false;
  }

  // Attribution: consultant on the call, falling back to the owner (Joel) if no
  // participant resolves to a team member. The owner's RF id is derived from the
  // registry via OWNER_EMAIL — no RF id is hardcoded here.
  let createdBy = consultant?.rfUserId ?? null;
  if (!consultant) {
    const owner = await getUserByEmail(env, OWNER_EMAIL);
    createdBy = owner?.rfUserId ?? null;
    console.warn({
      message: '[Krisp] consultant not resolved from participants — attributing to owner; add their krisp_email to USERS_DB',
      source: 'krisp',
      meetingId: meeting.id,
      participants: meeting.participants,
    });
  }
  if (!createdBy) {
    // The owner fallback resolves Joel via OWNER_EMAIL, which only maps to a
    // record through migration 0004's krisp_emails UPDATE. If that migration
    // wasn't applied to remote USERS_DB (or matched 0 rows), the fallback is
    // dead and notes are silently skipped — name the remediation explicitly.
    console.error({
      message: '[Krisp] → skipped: no RF user id for attribution — apply migration 0004 / verify krisp_emails for rf_user_id 900001 (owner) in USERS_DB',
      source: 'krisp',
      meetingId: meeting.id,
    });
    return false;
  }

  // Candidate lookup — cache first, then RF search API fallback.
  let candidateId = await lookupByEmail(candidateEmail, env);
  let lookupMethod = candidateId ? 'email-cache' : null;

  if (!candidateId) {
    const searchResult = await searchRFCandidateByEmail(candidateEmail, env);
    if (searchResult) {
      candidateId = String(searchResult.id);
      lookupMethod = 'email-api';
      await cacheCandidate(searchResult, env);
    }
  }

  if (!candidateId) {
    console.log({ message: `[Krisp] → no candidate found, skipping`, source: 'krisp', candidateEmail, meetingId: meeting.id });
    return false;
  }

  const htmlContent = formatKrispNotesAsHtml(meeting, rawContent);
  await addRFCandidateNote(candidateId, htmlContent, createdBy, env);

  console.log({
    message: `[Krisp] → RF note posted for candidate=${candidateId}`,
    source: 'krisp',
    action: 'note_posted',
    candidateId,
    candidateEmail,
    createdBy,
    lookupMethod,
    meetingId: meeting.id,
    meetingTitle: meeting.title,
  });

  return true;
}
