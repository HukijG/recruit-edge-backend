/**
 * Calendar webhook handler — call-booked detection.
 *
 * Matches inbound calendar events to RF candidates and moves them to
 * Call Booked, syncing the contact to Dialpad for the consultant.
 */

import { cacheCandidate, lookupByLinkedIn, lookupByEmail, lookupByName } from '../cache.js';
import { createOrUpdateDialpadContact } from '../dialpad-client.js';
import {
  updateRFCandidate,
  isValidLinkedInUrl,
  getRFCandidate,
  searchRFCandidateByLinkedIn,
  moveToCallBooked,
  RFContactConflictUnresolvedError,
} from '../rf-client.js';

export async function handleCalendarWebhook(request, env) {
  try {
    const webhookSecret = env.CALENDAR_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error({ message: '[Calendar] secret not configured', source: 'calendar' });
      return new Response('Unauthorized', { status: 401 });
    }
    const token = request.headers.get('X-Calendar-Webhook-Token');
    if (!token || token !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();

    if (!payload.attendee_email) {
      return new Response('Bad Request — missing attendee_email', { status: 400 });
    }

    console.log({
      message: `[Calendar] attendee="${payload.attendee_name}" email=${payload.attendee_email}`,
      source: 'calendar',
      eventId: payload.event_id,
      eventTitle: payload.event_title,
      eventStart: payload.event_start,
      attendeeEmail: payload.attendee_email,
      attendeeName: payload.attendee_name,
      linkedin: payload.linkedin_answer,
      phoneNumber: payload.phone_number,
    });

    await processCalendarEvent(payload, env);

    return new Response('Calendar webhook processed', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: `[Calendar] error: ${error.message}`, source: 'calendar', stack: error.stack });
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function processCalendarEvent(payload, env) {
  const { attendee_email, attendee_name, linkedin_answer, phone_number } = payload;

  // Find the RF candidate via tiered lookup
  let candidateId = null;
  let lookupMethod = null;

  // Tier 1: LinkedIn lookup (cache, then RF search API)
  if (isValidLinkedInUrl(linkedin_answer)) {
    const cachedId = await lookupByLinkedIn(linkedin_answer, env);
    if (cachedId) {
      candidateId = cachedId;
      lookupMethod = 'linkedin-cache';
    } else {
      const searchResult = await searchRFCandidateByLinkedIn(linkedin_answer, env);
      if (searchResult) {
        candidateId = searchResult.id;
        lookupMethod = 'linkedin-api';
        await cacheCandidate(searchResult, env);
      }
    }
  }

  // Tier 2: Email fallback (cache only)
  if (!candidateId && attendee_email) {
    const emailId = await lookupByEmail(attendee_email, env);
    if (emailId) {
      candidateId = emailId;
      lookupMethod = 'email-cache';
    }
  }

  // Tier 3: Name fallback (cache only)
  if (!candidateId && attendee_name) {
    const parts = attendee_name.trim().split(/\s+/);
    const firstName = parts[0] || '';
    const lastName = parts.slice(1).join(' ') || '';
    if (firstName && lastName) {
      const nameId = await lookupByName(firstName, lastName, env);
      if (nameId) {
        candidateId = nameId;
        lookupMethod = 'name-cache';
      }
    }
  }

  if (!candidateId) {
    console.log({ message: `[Calendar] → no candidate found, skipping`, source: 'calendar', attendeeEmail: attendee_email, attendeeName: attendee_name });
    return;
  }

  // GET current candidate data (RF update REPLACES arrays, doesn't append)
  const currentCandidate = await getRFCandidate(candidateId, env);

  // === EMAIL MERGE ===
  // Normalize existing emails to { email, is_primary } — RF GET may return extra fields
  // that the UPDATE endpoint rejects, or strings instead of objects.
  const rawEmails = Array.isArray(currentCandidate.email) ? currentCandidate.email : [];
  const existingEmails = rawEmails.map(e => {
    if (typeof e === 'string') return { email: e, is_primary: 0 };
    return { email: e.email, is_primary: e.is_primary ?? 0 };
  }).filter(e => e.email);

  const emailAlreadyExists = existingEmails.some(
    e => e.email?.toLowerCase() === attendee_email.toLowerCase()
  );

  let mergedEmails = existingEmails;
  let emailAdded = false;

  if (!emailAlreadyExists) {
    const isPrimary = existingEmails.length === 0 ? 1 : 0;
    mergedEmails = [...existingEmails, { email: attendee_email, is_primary: isPrimary }];
    emailAdded = true;
  }

  // === PHONE MERGE ===
  // Normalize existing phones to { phone_number, type } — same reason as emails.
  const rawPhones = Array.isArray(currentCandidate.phone_number) ? currentCandidate.phone_number : [];
  const existingPhones = rawPhones.map(p => {
    if (typeof p === 'string') return { phone_number: p, type: 1 };
    return { phone_number: p.phone_number, type: p.type ?? 1 };
  }).filter(p => p.phone_number);

  let mergedPhones = existingPhones;
  let phoneAdded = false;

  if (phone_number) {
    // Normalize for comparison: strip non-digits
    const normalizedNew = phone_number.replace(/\D/g, '');
    const phoneAlreadyExists = existingPhones.some(
      p => (p.phone_number || '').replace(/\D/g, '') === normalizedNew
    );

    if (!phoneAlreadyExists) {
      mergedPhones = [...existingPhones, { phone_number: phone_number, type: 1 }];
      phoneAdded = true;
    }
  }

  // === UPDATE RF CANDIDATE ===
  // Intentional change from old behavior: we no longer early-return when email exists.
  // Stage movement and Dialpad upsert should always run regardless of data changes.
  if (emailAdded || phoneAdded) {
    const updatePayload = {};
    if (emailAdded) updatePayload.email = mergedEmails;
    if (phoneAdded) updatePayload.phone_number = mergedPhones;

    // Non-fatal: updateRFCandidate auto-resolves phone/email uniqueness conflicts
    // (stripping the value from the stale duplicate, then retrying). If it STILL
    // can't (RFContactConflictUnresolvedError) or fails another way, we must not
    // abort — stage movement, Dialpad upsert and cache update below still need to
    // run. A buried contact-field conflict killing the whole calendar sync was the
    // original bug this guards against.
    try {
      await updateRFCandidate(candidateId, updatePayload, env);
      // Set debounce flag ONLY when we actually update RF (prevents RF→Dialpad loop)
      const syncKey = `sync:RF${candidateId}`;
      await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });
    } catch (error) {
      console.error({ message: `[Calendar] RF update failed (non-fatal, continuing) candidate=${candidateId}: ${error.message}`, source: 'calendar', candidateId, attendeeEmail: attendee_email });
    }
  } else {
    console.log({ message: `[Calendar] → skipped RF update: email/phone already exist`, source: 'calendar', candidateId, attendeeEmail: attendee_email });
  }

  // === STAGE MOVEMENT ===
  let stageMoved = false;
  try {
    const stageResult = await moveToCallBooked(candidateId, currentCandidate, env);
    stageMoved = stageResult.moved;
    if (!stageMoved) {
      console.log({
        message: `[Calendar] → stage not moved: ${stageResult.reason}`,
        source: 'calendar',
        candidateId,
      });
    }
  } catch (error) {
    console.error({ message: `[Calendar] stage movement failed (non-fatal) candidate=${candidateId}: ${error.message}`, source: 'calendar', candidateId });
  }

  // === DIALPAD UPSERT ===
  let dialpadOk = true;
  try {
    const primaryEmail = mergedEmails.find(e => e.is_primary === 1)?.email || attendee_email;
    let phoneStr = '';
    if (mergedPhones.length > 0) {
      phoneStr = mergedPhones[0]?.phone_number || '';
    }

    const dialpadCandidate = {
      id: candidateId,
      first_name: currentCandidate.first_name || '',
      last_name: currentCandidate.last_name || '',
      name: currentCandidate.name || '',
      email: primaryEmail,
      phone_number: phoneStr,
      current_organization: currentCandidate.current_organization || '',
      current_title: currentCandidate.current_title || '',
      linkedin_profile: currentCandidate.linkedin_profile || ''
    };

    await createOrUpdateDialpadContact(dialpadCandidate, env);
  } catch (error) {
    dialpadOk = false;
    console.error({ message: `[Calendar] Dialpad upsert failed (non-fatal) candidate=${candidateId}: ${error.message}`, source: 'calendar', candidateId });
  }

  // === CACHE UPDATE ===
  await cacheCandidate({ ...currentCandidate, email: mergedEmails, phone_number: mergedPhones }, env);

  console.log({
    message: `[Calendar] → ${emailAdded ? 'email merge' : 'no email change'}${phoneAdded ? ' + phone merge' : ''}${stageMoved ? ' + stage moved' : ''}${dialpadOk ? ' + Dialpad upsert' : ''} + cached candidate=${candidateId}`,
    source: 'calendar',
    action: 'calendar_sync',
    candidateId,
    lookupMethod,
    attendeeEmail: attendee_email,
    phoneNumber: phone_number,
    emailAdded,
    phoneAdded,
    stageMoved,
    totalEmails: mergedEmails.length,
    totalPhones: mergedPhones.length,
    dialpadOk,
  });
}
