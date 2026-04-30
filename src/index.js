import { createOrUpdateDialpadContact, patchDialpadContact, getDialpadContact } from './dialpad-client.js';
import { verifyJWT } from './auth.js';
import {
  extractRFIdFromDialpadContact, updateRFCandidate, convertDialpadContactToRFUpdate,
  isValidLinkedInUrl, normalizeLinkedInUrl, getRFCandidate, searchRFCandidateByLinkedIn,
  searchRFCandidateByEmail, addRFCandidateNote, moveToCallBooked, addRFCandidate,
  listOpenJobs, addCandidateToJob, setJobCandidateConsultantId,
  listCandidateActivities, normalizeToE164, pickConsultantJob
} from './rf-client.js';
import { cacheCandidate, getCachedCandidate, lookupByLinkedIn, lookupByEmail, lookupByName, cacheConsultantForJobLink } from './cache.js';
import { formatKrispNotesAsHtml, extractCandidateEmail } from './krisp.js';
import { processCallEvent, parseColdCallActivity, mergeTag } from './cold-call.js';
import { isJoelCandidate, enrichCandidate, buildApolloWebhookUrl } from './enrichment.js';
import { enrichPerson } from './apollo-client.js';
import { resolveRFUserId } from './users.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RF-Webhook-Token, X-Calendar-Webhook-Token, X-Krisp-Webhook-Token, X-Extension-Token, RF-Event-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (url.pathname === '/health') {
        return new Response('RF-Dialpad Sync Middleware - OK', {
          status: 200,
          headers: corsHeaders
        });
      }

      if (url.pathname === '/webhook/recruiterflow' && request.method === 'POST') {
        return await handleRecruiterflowWebhook(request, env);
      }

      if (url.pathname === '/webhook/dialpad' && request.method === 'POST') {
        return await handleDialpadWebhook(request, env);
      }

      if (url.pathname === '/webhook/calendar' && request.method === 'POST') {
        return await handleCalendarWebhook(request, env);
      }

      if (url.pathname === '/webhook/recruiterflow/manual' && request.method === 'POST') {
        return await handleManualRFWebhook(request, env, url);
      }

      if (url.pathname === '/webhook/krisp' && request.method === 'POST') {
        return await handleKrispWebhook(request, env);
      }

      if (url.pathname === '/webhook/dialpad/calls' && request.method === 'POST') {
        return await handleDialpadCallWebhook(request, env);
      }

      if (url.pathname === '/webhook/apollo' && request.method === 'POST') {
        return await handleApolloWebhook(request, env, url);
      }

      if (url.pathname === '/test/coldcall' && request.method === 'POST') {
        return await handleTestColdCall(request, env, url);
      }

      if (url.pathname === '/candidates' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }
        return await handleCandidatesEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/candidates/add-to-job' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }
        return await handleAddToJobEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/candidate-mark-invalid' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }
        return await handleMarkInvalidEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/candidate-details' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: corsHeaders });
        }
        return await handleCandidateDetailsEndpoint(request, env, corsHeaders);
      }

      return new Response('Not Found', {
        status: 404,
        headers: corsHeaders
      });

    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', {
        status: 500,
        headers: corsHeaders
      });
    }
  },
};

async function handleRecruiterflowWebhook(request, env) {
  try {
    const webhookSecret = env.RF_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error({ message: '[RF] secret not configured', source: 'rf' });
      return new Response('Unauthorized', { status: 401 });
    }
    const signature = request.headers.get('X-RF-Webhook-Token');
    if (!signature || signature !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const eventType = request.headers.get('RF-Event-Type');
    const clonedRequest = request.clone();
    const payload = await request.json();
    const candidate = payload?.candidate;

    if (!candidate || !candidate.id) {
      return new Response('Bad Request', { status: 400 });
    }

    console.log({
      message: `[RF] ${eventType} candidate=${candidate.id} "${candidate.name}"`,
      source: 'rf',
      event: eventType,
      candidateId: candidate.id,
      name: candidate.name,
      firstName: candidate.first_name,
      lastName: candidate.last_name,
      email: candidate.email,
      phone: candidate.phone_number,
      org: candidate.current_organization,
      title: candidate.current_title,
      linkedin: candidate.linkedin_profile,
    });

    if (eventType === 'Created' || eventType === 'Updated') {
      // Sync to Dialpad FIRST with original RF data — don't let enrichment mutate the candidate object
      const synced = await syncCandidateToDialpad(candidate, env);
      await cacheCandidate(candidate, env);
      console.log({
        message: `[RF] → ${synced ? 'Dialpad upsert + cached' : 'skipped Dialpad (validation), cached'} candidate=${candidate.id}`,
        source: 'rf',
        action: synced ? 'dialpad_upsert' : 'skipped_validation',
        candidateId: candidate.id,
      });

      // Apollo enrichment on Created events only, for Joel's candidates
      // Runs AFTER Dialpad sync — enrichment updates RF + Dialpad independently if it finds better data
      if (eventType === 'Created') {
        try {
          const fullCandidate = await getRFCandidate(candidate.id, env);
          if (isJoelCandidate(fullCandidate)) {
            const enrichResult = await enrichCandidate(candidate, fullCandidate, env);
            console.log({
              message: `[RF] enrichment: ${enrichResult.enriched ? 'done' : `skipped (${enrichResult.reason})`}`,
              source: 'rf',
              candidateId: candidate.id,
              enriched: enrichResult.enriched,
              reason: enrichResult.reason,
              correctedLinkedIn: enrichResult.correctedLinkedIn || null,
              phoneRequested: enrichResult.phoneRequested || false,
            });
          }
        } catch (error) {
          console.error({ message: `[RF] enrichment failed (non-fatal) candidate=${candidate.id}: ${error.message}`, source: 'rf', candidateId: candidate.id });
        }
      }
    } else {
      console.log({ message: `[RF] → ignored event: ${eventType}`, source: 'rf', event: eventType });
    }

    return new Response('Webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: `[RF] error: ${error.message}`, source: 'rf', stack: error.stack });
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleManualRFWebhook(request, env, url) {
  try {
    const webhookSecret = env.RF_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error({ message: '[RF/manual] secret not configured', source: 'rf-manual' });
      return new Response('Unauthorized', { status: 401 });
    }
    const token = url.searchParams.get('token');
    if (!token || token !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const clonedRequest = request.clone();
    const candidate = await request.json();

    if (!candidate || !candidate.id) {
      return new Response('Bad Request', { status: 400 });
    }

    console.log({
      message: `[RF/manual] candidate=${candidate.id} "${candidate.name}"`,
      source: 'rf-manual',
      candidateId: candidate.id,
      name: candidate.name,
      firstName: candidate.first_name,
      lastName: candidate.last_name,
      email: candidate.email,
      phone: candidate.phone_number,
      org: candidate.current_organization,
      title: candidate.current_title,
      linkedin: candidate.linkedin_profile,
      rfLink: candidate.rf_link,
    });

    // Sync to Dialpad FIRST with original RF data
    const synced = await syncCandidateToDialpad(candidate, env);
    await cacheCandidate(candidate, env);

    console.log({
      message: `[RF/manual] → ${synced ? 'Dialpad upsert + cached' : 'skipped Dialpad (validation), cached'} candidate=${candidate.id}`,
      source: 'rf-manual',
      action: synced ? 'dialpad_upsert' : 'skipped_validation',
      candidateId: candidate.id,
    });

    // Enrichment runs AFTER Dialpad sync — updates RF + Dialpad independently if it finds better data
    try {
      const fullCandidate = await getRFCandidate(candidate.id, env);
      const enrichResult = await enrichCandidate(candidate, fullCandidate, env);
      console.log({
        message: `[RF/manual] enrichment: ${enrichResult.enriched ? 'done' : `skipped (${enrichResult.reason})`}`,
        source: 'rf-manual',
        candidateId: candidate.id,
        enriched: enrichResult.enriched,
        reason: enrichResult.reason,
      });
    } catch (error) {
      console.error({ message: `[RF/manual] enrichment failed (non-fatal) candidate=${candidate.id}: ${error.message}`, source: 'rf-manual', candidateId: candidate.id });
    }

    return new Response('Manual webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: `[RF/manual] error: ${error.message}`, source: 'rf-manual', stack: error.stack });
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleDialpadWebhook(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    const bodyText = await request.text();

    let token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else {
      token = bodyText;
    }

    if (!token) {
      return new Response('Unauthorized - No token', { status: 401 });
    }

    const payload = await verifyJWT(token, env.DIALPAD_WEBHOOK_SECRET);

    if (!payload) {
      return new Response('Unauthorized - Invalid token', { status: 401 });
    }

    const contact = payload.contact;

    console.log({
      message: `[Dialpad] ${payload.event} contact="${contact?.display_name}"`,
      source: 'dialpad',
      event: payload.event,
      contactId: contact?.id,
      displayName: contact?.display_name,
      firstName: contact?.first_name,
      lastName: contact?.last_name,
      primaryEmail: contact?.primary_email,
      primaryPhone: contact?.primary_phone,
      companyName: contact?.company_name,
      jobTitle: contact?.job_title,
      emails: contact?.emails,
      phones: contact?.phones,
      urls: contact?.urls,
    });

    if (payload.event === 'Updated') {
      await processDialpadContactUpdate(contact, env);
    } else {
      console.log({ message: `[Dialpad] → ignored event: ${payload.event}`, source: 'dialpad', event: payload.event });
    }

    return new Response('Dialpad webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: `[Dialpad] error: ${error.message}`, source: 'dialpad', stack: error.stack });
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function processDialpadContactUpdate(contact, env) {
  const rfCandidateId = extractRFIdFromDialpadContact(contact.id);

  if (!rfCandidateId) {
    console.log({ message: '[Dialpad] → skipped: no RF ID in contact', source: 'dialpad', contactId: contact.id });
    return;
  }

  const syncKey = `sync:RF${rfCandidateId}`;
  const recentSync = await env.SYNC_STATE.get(syncKey);
  if (recentSync) {
    console.log({ message: `[Dialpad] → skipped: debounce active`, source: 'dialpad', candidateId: rfCandidateId });
    return;
  }

  try {
    const updateData = convertDialpadContactToRFUpdate(contact);

    if (Object.keys(updateData).length === 0) {
      console.log({ message: `[Dialpad] → skipped: no syncable data`, source: 'dialpad', candidateId: rfCandidateId });
      return;
    }

    await updateRFCandidate(rfCandidateId, updateData, env);
    await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });

    // Update cache with Dialpad changes
    const cached = await getCachedCandidate(rfCandidateId, env);
    if (cached) {
      const merged = {
        id: parseInt(rfCandidateId, 10),
        first_name: cached.first_name,
        last_name: cached.last_name,
        email: updateData.email || cached.emails || cached.email,
        phone_number: updateData.phone_number || cached.phone_number,
        linkedin_profile: updateData.linkedin_profile || cached.linkedin_profile,
        current_organization: cached.current_organization,
        current_title: cached.current_title,
      };
      await cacheCandidate(merged, env);
    } else {
      try {
        const fresh = await getRFCandidate(rfCandidateId, env);
        await cacheCandidate(fresh, env);
      } catch (e) {
        console.error({ message: '[Dialpad] cache warming failed', source: 'dialpad', candidateId: rfCandidateId, error: e.message });
      }
    }

    console.log({
      message: `[Dialpad] → RF update + cached candidate=${rfCandidateId}`,
      source: 'dialpad',
      action: 'rf_update',
      candidateId: rfCandidateId,
      updatedFields: Object.keys(updateData),
      updateData,
    });

  } catch (error) {
    console.error({ message: `[Dialpad] sync error candidate=${rfCandidateId}: ${error.message}`, source: 'dialpad', candidateId: rfCandidateId });
    throw error;
  }
}

async function handleCalendarWebhook(request, env) {
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

    await updateRFCandidate(candidateId, updatePayload, env);

    // Set debounce flag ONLY when we actually update RF (prevents RF→Dialpad loop)
    const syncKey = `sync:RF${candidateId}`;
    await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });
  } else {
    console.log({ message: `[Calendar] → skipped RF update: email/phone already exist`, source: 'calendar', candidateId, attendeeEmail: attendee_email });
  }

  // === STAGE MOVEMENT ===
  let stageMoved = false;
  try {
    const stageResult = await moveToCallBooked(candidateId, currentCandidate, env);
    stageMoved = stageResult.moved;
    if (stageMoved) {
      console.log({
        message: `[Calendar] → moved to Call Booked in job=${stageResult.jobId}`,
        source: 'calendar',
        candidateId,
        jobId: stageResult.jobId,
      });
    } else {
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

/**
 * Sync candidate to Dialpad. Returns true if synced, false if skipped validation.
 */
async function syncCandidateToDialpad(candidate, env) {
  const validation = validateCandidateForDialpad(candidate);

  if (!validation.isValidForSync) {
    return false;
  }

  await createOrUpdateDialpadContact(candidate, env);

  // Write debounce flag to KV to prevent loop (60s TTL)
  const syncKey = `sync:RF${candidate.id}`;
  await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });

  return true;
}

function validateCandidateForDialpad(candidate) {
  const validation = {
    hasName: !!(candidate.first_name && candidate.last_name) || !!candidate.name,
    hasOrganization: !!candidate.current_organization,
    hasTitle: !!candidate.current_title,
    isValidForSync: false
  };

  validation.isValidForSync = validation.hasName && validation.hasOrganization && validation.hasTitle;

  return validation;
}

async function handleKrispWebhook(request, env) {
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

    if (payload.event !== 'summary_generated') {
      console.log({ message: `[Krisp] → ignored event: ${payload.event}`, source: 'krisp', event: payload.event });
      return new Response('OK', { status: 200 });
    }

    const meeting = payload.data?.meeting;
    const content = payload.data?.content;

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
      contentSections: content?.length || 0,
    });

    const notePosted = await processKrispMeetingNotes(meeting, content, env);

    if (notePosted) {
      await env.SYNC_STATE.put(dedupeKey, 'true', { expirationTtl: 300 });
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

async function processKrispMeetingNotes(meeting, content, env) {
  const candidateEmail = extractCandidateEmail(meeting.participants);
  if (!candidateEmail) {
    console.log({
      message: '[Krisp] → skipped: no candidate email in participants',
      source: 'krisp',
      meetingId: meeting.id,
      meetingTitle: meeting.title,
      participants: meeting.participants,
    });
    return false;
  }

  if (!Array.isArray(content) || content.length === 0) {
    console.log({ message: '[Krisp] → skipped: no content sections', source: 'krisp', meetingId: meeting.id });
    return false;
  }

  // Look up RF candidate — cache first, then RF search API fallback
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

  const htmlContent = formatKrispNotesAsHtml(meeting, content);
  await addRFCandidateNote(candidateId, htmlContent, env);

  console.log({
    message: `[Krisp] → RF note posted for candidate=${candidateId}`,
    source: 'krisp',
    action: 'note_posted',
    candidateId,
    candidateEmail,
    lookupMethod,
    meetingId: meeting.id,
    meetingTitle: meeting.title,
  });

  return true;
}

async function handleDialpadCallWebhook(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    const bodyText = await request.text();

    let token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else {
      token = bodyText;
    }

    if (!token) {
      return new Response('Unauthorized - No token', { status: 401 });
    }

    const payload = await verifyJWT(token, env.DIALPAD_WEBHOOK_SECRET);
    if (!payload) {
      return new Response('Unauthorized - Invalid token', { status: 401 });
    }

    console.log({
      message: `[Dialpad/calls] ${payload.state} call_id=${payload.call_id}`,
      source: 'dialpad-calls',
      state: payload.state,
      callId: payload.call_id,
      direction: payload.direction,
      contactId: payload.contact?.id,
      contactName: payload.contact?.name,
      targetId: payload.target?.id,
      targetName: payload.target?.name,
      dateStarted: payload.date_started,
      eventTimestamp: payload.event_timestamp,
      duration: payload.duration,
      externalNumber: payload.external_number,
      internalNumber: payload.internal_number,
      hasTranscriptionText: !!payload.transcription_text,
      transcriptionPreview: payload.transcription_text ? payload.transcription_text.substring(0, 200) : null,
    });

    const result = await processCallEvent(payload, env);

    const outcomeStr = result.outcome ? ` [${result.outcome}]` : '';
    console.log({
      message: `[Dialpad/calls] → ${result.isColdCall ? `COLD CALL tracked${outcomeStr}` : result.reason}`,
      source: 'dialpad-calls',
      callId: payload.call_id,
      processed: result.processed,
      isColdCall: result.isColdCall,
      outcome: result.outcome,
      reason: result.reason,
    });

    return new Response('Call webhook processed', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: `[Dialpad/calls] unhandled error: ${error.message}`, source: 'dialpad-calls', stack: error.stack });
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleApolloWebhook(request, env, url) {
  try {
    const webhookSecret = env.APOLLO_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error({ message: '[Apollo] secret not configured', source: 'apollo' });
      return new Response('Unauthorized', { status: 401 });
    }
    const token = url.searchParams.get('token');
    if (!token || token !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const rfId = url.searchParams.get('rfId');
    if (!rfId) {
      return new Response('Bad Request — missing rfId', { status: 400 });
    }

    const payload = await request.json();

    // Apollo webhook sends { people: [{ id, phone_numbers, status }] }
    const person = payload.people?.[0];

    console.log({
      message: `[Apollo] raw webhook payload`,
      source: 'apollo',
      rfId,
      rawPayload: JSON.stringify(payload),
    });

    // Look up pending enrichment context from KV
    const pendingRaw = await env.SYNC_STATE.get(`apollo_enrich:${rfId}`);
    if (!pendingRaw) {
      console.log({ message: `[Apollo] → no pending enrichment context for rfId=${rfId}, skipping`, source: 'apollo', rfId });
      return new Response('OK', { status: 200 });
    }
    const pending = JSON.parse(pendingRaw);

    // Extract phone numbers from the person object
    const phoneNumbers = person?.phone_numbers;
    if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      console.log({ message: `[Apollo] → no phone numbers in payload, skipping`, source: 'apollo', rfId });
      return new Response('OK', { status: 200 });
    }

    // Pick first valid phone — Apollo uses status_cd, not status
    const validPhone = phoneNumbers.find(p => p.sanitized_number && p.status_cd !== 'invalid_number');
    if (!validPhone) {
      console.log({ message: `[Apollo] → no valid phone numbers, skipping`, source: 'apollo', rfId });
      return new Response('OK', { status: 200 });
    }
    const phoneStr = validPhone.sanitized_number;

    // Update RF directly — Dialpad Created events are intentionally ignored,
    // so we can't rely on Dialpad→RF sync to carry the phone across.
    const currentCandidate = await getRFCandidate(rfId, env);
    const rawPhones = Array.isArray(currentCandidate.phone_number) ? currentCandidate.phone_number : [];
    // Drop legacy/malformed entries with no actual phone_number value before
    // sending back to RF — RF rejects {type:1} entries as "invalid format".
    const existingPhones = rawPhones
      .map(p => (typeof p === 'string' ? { phone_number: p, type: 1 } : { phone_number: p.phone_number, type: p.type ?? 1 }))
      .filter(p => p.phone_number);
    const normalizedNew = phoneStr.replace(/\D/g, '');
    const phoneAlreadyExists = existingPhones.some(
      p => (p.phone_number || '').replace(/\D/g, '') === normalizedNew
    );

    if (!phoneAlreadyExists) {
      const mergedPhones = [
        ...existingPhones,
        { phone_number: phoneStr, type: 1 },
      ];
      await updateRFCandidate(rfId, { phone_number: mergedPhones }, env);
      // Debounce prevents the eventual RF Updated webhook from re-syncing to Dialpad
      await env.SYNC_STATE.put(`sync:RF${rfId}`, 'true', { expirationTtl: 60 });
      console.log({ message: `[Apollo] → RF updated with phone`, source: 'apollo', rfId, phone: phoneStr });
    } else {
      console.log({ message: `[Apollo] → phone already in RF, skipped RF update`, source: 'apollo', rfId, phone: phoneStr });
    }

    // Patch Dialpad directly too — don't wait for RF webhook (hours of delay)
    // Non-fatal: contact may not exist yet if extension creation failed or is still in progress
    try {
      await patchDialpadContact(rfId, { phones: [phoneStr] }, env);
    } catch (dialpadErr) {
      console.error({ message: `[Apollo] Dialpad patch failed (non-fatal)`, source: 'apollo', rfId, error: dialpadErr.message });
    }

    // Update cache with new phone
    const cached = await getCachedCandidate(rfId, env);
    if (cached) {
      await cacheCandidate({ ...cached, phone_number: phoneStr }, env);
    }

    console.log({
      message: `[Apollo] → done rfId=${rfId} phone=${phoneStr}`,
      source: 'apollo',
      action: 'apollo_phone_sync',
      rfId,
      phone: phoneStr,
    });

    return new Response('OK', { status: 200 });

  } catch (error) {
    // Inline the actual error into the message so it surfaces in CF Logs metadata.
    // Structured `error: error.message` field is not indexed and stays invisible.
    console.error({ message: `[Apollo] error: ${error.message}`, source: 'apollo', stack: error.stack });
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleTestColdCall(request, env, url) {
  try {
    const webhookSecret = env.RF_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }
    const token = url.searchParams.get('token');
    if (!token || token !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();

    if (!payload.call_id) {
      return new Response(JSON.stringify({ error: 'missing call_id' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log({
      message: `[Test/coldcall] processing call_id=${payload.call_id} contact="${payload.contact?.name}"`,
      source: 'test-coldcall',
      callId: payload.call_id,
      state: payload.state,
      direction: payload.direction,
      contactId: payload.contact?.id,
      contactName: payload.contact?.name,
      targetId: payload.target?.id,
      hasTranscriptionText: !!payload.transcription_text,
    });

    const result = await processCallEvent(payload, env);

    console.log({
      message: `[Test/coldcall] result: ${result.isColdCall ? `COLD CALL [${result.outcome}]` : result.reason}`,
      source: 'test-coldcall',
      callId: payload.call_id,
      processed: result.processed,
      isColdCall: result.isColdCall,
      outcome: result.outcome,
      reason: result.reason,
    });

    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: `[Test/coldcall] error: ${error.message}`, source: 'test-coldcall', stack: error.stack });
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Handle a candidate that's already in RF: ensure Dialpad contact exists,
 * patch company/title if it does, and request Apollo phone reveal if needed.
 * Called both when search finds an existing record AND when /candidate/add
 * returns 409 (LinkedIn already exists).
 */
async function processExistingRFCandidate(existing, ext, label, env) {
  const rfId = existing.id;
  console.log({
    message: `[Candidates] ${label} — already in RF (id=${rfId}), checking Dialpad`,
    source: 'candidates-endpoint',
  });

  const currentExp = ext.experience?.find(e => e.isCurrent);
  const nameParts = ext.fullName.trim().split(/\s+/);

  let dialpadContact = null;
  try {
    dialpadContact = await getDialpadContact(rfId, env);
  } catch (error) {
    console.error({ message: `[Candidates] ${label} — Dialpad GET failed: ${error.message}`, source: 'candidates-endpoint' });
  }

  let dialpadSynced = false;

  if (!dialpadContact) {
    // Not in Dialpad — full creation with all available fields
    const fullCandidate = await getRFCandidate(rfId, env);

    let primaryEmail = '';
    if (Array.isArray(fullCandidate.email) && fullCandidate.email.length > 0) {
      const primary = fullCandidate.email.find(e => e.is_primary === 1);
      primaryEmail = primary ? primary.email : (fullCandidate.email[0]?.email || '');
    }
    let phoneStr = '';
    if (Array.isArray(fullCandidate.phone_number) && fullCandidate.phone_number.length > 0) {
      phoneStr = fullCandidate.phone_number[0]?.phone_number || '';
    }

    const rfCandidate = {
      id: rfId,
      first_name: nameParts[0] || fullCandidate.first_name || '',
      last_name: nameParts.slice(1).join(' ') || fullCandidate.last_name || '',
      name: ext.fullName,
      current_organization: currentExp?.company || fullCandidate.current_organization || '',
      current_title: currentExp?.title || fullCandidate.current_title || '',
      linkedin_profile: ext.linkedinUrl || fullCandidate.linkedin_profile || '',
      email: primaryEmail,
      phone_number: phoneStr,
    };

    dialpadSynced = await syncCandidateToDialpad(rfCandidate, env);
    await cacheCandidate(rfCandidate, env);
    console.log({ message: `[Candidates] ${label} — created Dialpad contact rfId=${rfId}`, source: 'candidates-endpoint' });
  } else {
    // Already in Dialpad — only update company name and job title
    const patchFields = {};
    if (currentExp?.company) patchFields.company_name = currentExp.company;
    if (currentExp?.title) patchFields.job_title = currentExp.title;

    if (Object.keys(patchFields).length > 0) {
      try {
        await patchDialpadContact(rfId, patchFields, env);
        // Set debounce flag — prevents Dialpad's "Updated" webhook from syncing
        // empty email/phone arrays back to RF and clearing existing data
        await env.SYNC_STATE.put(`sync:RF${rfId}`, 'true', { expirationTtl: 60 });
        dialpadSynced = true;
        console.log({ message: `[Candidates] ${label} — patched Dialpad (company/title only) rfId=${rfId}`, source: 'candidates-endpoint' });
      } catch (error) {
        console.error({ message: `[Candidates] ${label} — Dialpad PATCH failed: ${error.message}`, source: 'candidates-endpoint' });
      }
    }
  }

  // Apollo phone enrichment — only if Dialpad contact has no phone and no prior attempt
  let phoneRequested = false;
  const hasDialpadPhone = dialpadContact?.phones?.length > 0;

  if (!hasDialpadPhone && ext.linkedinUrl) {
    const apolloFlag = await env.SYNC_STATE.get(`apollo_enrich:${rfId}`);
    if (!apolloFlag) {
      try {
        const apolloPerson = await enrichPerson({ linkedin_url: ext.linkedinUrl }, {}, env);
        if (apolloPerson) {
          const webhookUrl = buildApolloWebhookUrl(rfId, env);
          await enrichPerson({ id: apolloPerson.id }, { reveal_phone_number: true, webhook_url: webhookUrl }, env);
          await env.SYNC_STATE.put(`apollo_enrich:${rfId}`, JSON.stringify({
            apolloPersonId: apolloPerson.id,
            timestamp: new Date().toISOString(),
          }), { expirationTtl: 900 });
          phoneRequested = true;
          console.log({ message: `[Candidates] ${label} — phone reveal requested (apolloId=${apolloPerson.id})`, source: 'candidates-endpoint', rfId });
        } else {
          await env.SYNC_STATE.put(`apollo_enrich:${rfId}`, JSON.stringify({
            noMatch: true,
            timestamp: new Date().toISOString(),
          }), { expirationTtl: 900 });
          console.log({ message: `[Candidates] ${label} — Apollo returned no match, flagged to skip future attempts`, source: 'candidates-endpoint', rfId });
        }
      } catch (error) {
        console.error({ message: `[Candidates] ${label} — phone reveal failed (non-fatal): ${error.message}`, source: 'candidates-endpoint', rfId });
      }
    } else {
      console.log({ message: `[Candidates] ${label} — Apollo enrichment already attempted, skipping`, source: 'candidates-endpoint', rfId });
    }
  }

  return { fullName: ext.fullName, status: 'updated', rfId, dialpadSynced, phoneRequested };
}

/**
 * Process a single candidate from the extension batch.
 * Returns a result object — never throws (catches internally).
 */
async function processOneCandidate(ext, i, total, env, consultantRfUserId) {
  const label = `[${i + 1}/${total}] ${ext.fullName}`;
  try {
    // Search RF by LinkedIn URL — RF is authoritative, do not consult cache for matching.
    // (searchRFCandidateByLinkedIn filters out RF's substring-fuzzy matches and
    // returns only true slug-matches.)
    const existing = ext.linkedinUrl
      ? await searchRFCandidateByLinkedIn(ext.linkedinUrl, env)
      : null;

    // Reconcile cache against the authoritative RF result. If the cache had this
    // LinkedIn URL pointing at a different rfId, refreshing self-heals it for
    // every downstream lookup (calendar, krisp, etc.) that does trust the cache.
    if (ext.linkedinUrl) {
      const cachedId = await lookupByLinkedIn(ext.linkedinUrl, env);
      const rfIdStr = existing ? String(existing.id) : null;
      if (cachedId && cachedId !== rfIdStr) {
        console.warn({
          message: `[Candidates] ${label} — cache stale for LinkedIn URL: cached rfId=${cachedId}, RF says ${rfIdStr || 'no match'}. Refreshing.`,
          source: 'candidates-endpoint',
          staleCachedId: cachedId,
          actualRfId: rfIdStr,
          linkedinUrl: ext.linkedinUrl,
        });
      }
      if (existing) {
        // Always re-cache the authoritative record so the LinkedIn → rfId index
        // and the canonical record:{rfId} blob match what RF currently has.
        await cacheCandidate(existing, env);
      }
    }

    if (existing) {
      return await processExistingRFCandidate(existing, ext, label, env);
    }

    // Map extension payload → RF candidate/add format
    const rfPayload = mapExtensionToRFCandidate(ext, consultantRfUserId);

    console.log({
      message: `[Candidates] ${label} — creating in RF`,
      source: 'candidates-endpoint',
      rfPayload,
    });

    // Create in RF
    let rfResult;
    try {
      rfResult = await addRFCandidate(rfPayload, env);
    } catch (err) {
      // RF returns 409 when a candidate with this LinkedIn URL already exists.
      // The error body looks like: 409 - {"data":{"id":50615},"message":"..."}
      // Recover by treating this as an existing candidate — fetch + run the
      // already-in-RF path so Dialpad still gets updated.
      const m = err.message?.match(/409.*"id":\s*(\d+)/);
      if (m) {
        const existingId = parseInt(m[1], 10);
        console.warn({
          message: `[Candidates] ${label} — RF /candidate/add returned 409 (already exists), recovering with rfId=${existingId}`,
          source: 'candidates-endpoint',
          rfId: existingId,
        });
        const fetched = await getRFCandidate(existingId, env);
        return await processExistingRFCandidate(fetched, ext, label, env);
      }
      throw err;
    }
    const rfId = rfResult?.data?.id;

    if (!rfId) {
      console.error({
        message: `[Candidates] ${label} — RF add returned no ID`,
        source: 'candidates-endpoint',
        rfResult,
      });
      return { fullName: ext.fullName, status: 'error', reason: 'no_rf_id', rfResult };
    }

    console.log({
      message: `[Candidates] ${label} — created in RF (id=${rfId})`,
      source: 'candidates-endpoint',
      rfId,
    });

    // Build candidate for Dialpad sync + cache from extension data directly
    // No need to GET from RF — new candidates won't have email/phone yet
    const currentExp = ext.experience?.find(e => e.isCurrent);
    const nameParts = ext.fullName.trim().split(/\s+/);

    const rfCandidate = {
      id: rfId,
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      name: ext.fullName,
      current_organization: currentExp?.company || '',
      current_title: currentExp?.title || '',
      linkedin_profile: ext.linkedinUrl || '',
      email: '',
      phone_number: '',
    };

    // Sync to Dialpad (creates contact with uid=RF{id} + sets debounce)
    const synced = await syncCandidateToDialpad(rfCandidate, env);
    await cacheCandidate(rfCandidate, env);

    console.log({
      message: `[Candidates] ${label} — ${synced ? 'Dialpad synced + cached' : 'Dialpad skipped (validation), cached'} rfId=${rfId}`,
      source: 'candidates-endpoint',
      rfId,
      dialpadSynced: synced,
    });

    // Apollo phone reveal — LinkedIn URL is already correct from the extension,
    // just look up the person and request phone. No verification/fallback/LinkedIn correction.
    let phoneRequested = false;
    if (rfCandidate.linkedin_profile && !rfCandidate.phone_number) {
      try {
        const apolloPerson = await enrichPerson({ linkedin_url: rfCandidate.linkedin_profile }, {}, env);
        if (apolloPerson) {
          const webhookUrl = buildApolloWebhookUrl(rfId, env);
          await enrichPerson({ id: apolloPerson.id }, { reveal_phone_number: true, run_waterfall_phone: true, webhook_url: webhookUrl }, env);
          await env.SYNC_STATE.put(`apollo_enrich:${rfId}`, JSON.stringify({
            apolloPersonId: apolloPerson.id,
            timestamp: new Date().toISOString(),
          }), { expirationTtl: 900 });
          phoneRequested = true;
          console.log({
            message: `[Candidates] ${label} — phone reveal requested (apolloId=${apolloPerson.id})`,
            source: 'candidates-endpoint',
            rfId,
            apolloPersonId: apolloPerson.id,
          });
        } else {
          console.log({
            message: `[Candidates] ${label} — Apollo lookup returned no person, skipping phone reveal`,
            source: 'candidates-endpoint',
            rfId,
          });
        }
      } catch (error) {
        console.error({ message: `[Candidates] ${label} — phone reveal failed (non-fatal): ${error.message}`, source: 'candidates-endpoint', rfId });
      }
    }

    return { fullName: ext.fullName, status: 'created', rfId, dialpadSynced: synced, phoneRequested };

  } catch (error) {
    console.error({
      message: `[Candidates] ${label} — error: ${error.message}`,
      source: 'candidates-endpoint',
      stack: error.stack,
    });
    return { fullName: ext.fullName, status: 'error', reason: error.message };
  }
}

async function handleCandidatesEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();

    if (!payload.candidates || !Array.isArray(payload.candidates)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid "candidates" array' }), {
        status: 400,
        headers: responseHeaders
      });
    }

    const consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName : '';
    const consultantRfUserId = resolveRFUserId(consultantFirstName);
    if (consultantFirstName && consultantRfUserId === null) {
      console.warn({
        message: `[Candidates] unknown consultantFirstName="${consultantFirstName}", attribution will be skipped`,
        source: 'candidates-endpoint',
      });
    }

    const total = payload.candidates.length;
    console.log({
      message: `[Candidates] Received batch of ${total} candidates (consultant=${consultantFirstName || 'none'})`,
      source: 'candidates-endpoint',
      count: total,
      consultantFirstName,
      consultantRfUserId,
    });

    // Process in chunks of 5 for speed, but wait for all chunks before responding
    const CHUNK_SIZE = 5;
    const results = [];
    for (let c = 0; c < payload.candidates.length; c += CHUNK_SIZE) {
      const chunk = payload.candidates.slice(c, c + CHUNK_SIZE);
      const chunkResults = await Promise.all(chunk.map((ext, j) =>
        processOneCandidate(ext, c + j, total, env, consultantRfUserId)
      ));
      results.push(...chunkResults);
    }

    const created = results.filter(r => r.status === 'created').length;
    const updated = results.filter(r => r.status === 'updated').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;

    console.log({
      message: `[Candidates] Batch complete: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`,
      source: 'candidates-endpoint',
      created,
      updated,
      skipped,
      errors,
    });

    // Fetch open jobs for the extension's job selector dropdown
    let jobs = [];
    try {
      jobs = await listOpenJobs(env);
    } catch (error) {
      console.error({ message: `[Candidates] Failed to fetch jobs: ${error.message}`, source: 'candidates-endpoint' });
    }

    return new Response(JSON.stringify({ total, created, updated, skipped, errors, results, jobs }), {
      status: 200,
      headers: responseHeaders
    });

  } catch (error) {
    console.error({ message: `[Candidates] Error: ${error.message}`, source: 'candidates-endpoint', stack: error.stack });
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: responseHeaders
    });
  }
}

/**
 * Map the LinkedIn extension payload to RF's POST /candidate/add format.
 */
function mapExtensionToRFCandidate(ext, consultantRfUserId) {
  const nameParts = ext.fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const currentExp = ext.experience?.find(e => e.isCurrent);

  const rfCandidate = {
    name: ext.fullName,
    linkedin_profile: ext.linkedinUrl || '',
    title: currentExp?.title || '',
    organization: currentExp?.company || '',
    source: 'linkedin',
    location: ext.location ? { location: ext.location } : undefined,
  };

  if (typeof consultantRfUserId === 'number') {
    rfCandidate.lead_owner_id = consultantRfUserId;
  }

  // Map experience entries
  if (ext.experience?.length > 0) {
    rfCandidate.experience = ext.experience.map(exp => ({
      organization: exp.company || '',
      designation: exp.title || '',
      from: exp.startYear ? ['1', String(exp.startYear)] : [],
      to: exp.isCurrent ? [] : (exp.endYear ? ['1', String(exp.endYear)] : []),
    }));
  }

  // Map education entries
  if (ext.education?.length > 0) {
    rfCandidate.education = ext.education.map(edu => ({
      school: edu.institution || '',
      degree: edu.degree || '',
      specialization: '',
      from: edu.startYear ? ['1', String(edu.startYear)] : [],
      to: edu.endYear ? ['1', String(edu.endYear)] : [],
    }));
  }

  return rfCandidate;
}

async function handleAddToJobEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const { rfIds, jobId } = payload;

    if (!Array.isArray(rfIds) || rfIds.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing or empty "rfIds" array' }), {
        status: 400, headers: responseHeaders
      });
    }
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing "jobId"' }), {
        status: 400, headers: responseHeaders
      });
    }

    const consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName : '';
    const consultantRfUserId = resolveRFUserId(consultantFirstName);
    if (consultantFirstName && consultantRfUserId === null) {
      console.warn({
        message: `[AddToJob] unknown consultantFirstName="${consultantFirstName}", consultant_id will not be written`,
        source: 'add-to-job',
      });
    }

    console.log({
      message: `[AddToJob] Adding ${rfIds.length} candidates to job ${jobId} (consultant=${consultantFirstName || 'none'})`,
      source: 'add-to-job',
      rfIds,
      jobId,
      consultantFirstName,
      consultantRfUserId,
    });

    const results = await Promise.all(rfIds.map(async (rfId) => {
      // Step 1: existing add-to-job with retry on 502
      let addResult = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await addCandidateToJob(rfId, jobId, env);
          addResult = { rfId, status: 'added' };
          break;
        } catch (error) {
          if (error.message.toLowerCase().includes('already') && error.message.toLowerCase().includes('pipeline')) {
            addResult = { rfId, status: 'already_in_job' };
            break;
          }
          if (error.message.includes('502') && attempt < 3) {
            console.log({ message: `[AddToJob] rfId=${rfId} → 502, retrying (${attempt}/2)`, source: 'add-to-job' });
            continue;
          }
          console.error({ message: `[AddToJob] rfId=${rfId} → job ${jobId} failed: ${error.message}`, source: 'add-to-job' });
          addResult = { rfId, status: 'error', reason: error.message };
          break;
        }
      }

      if (addResult === null) {
        addResult = { rfId, status: 'error', reason: 'retry loop exited without result' };
      }

      // Step 2: write consultant_id only when add succeeded AND we have a consultant
      if (addResult.status === 'added' && consultantRfUserId !== null) {
        try {
          await setJobCandidateConsultantId(rfId, jobId, consultantRfUserId, env);
          await cacheConsultantForJobLink(rfId, jobId, consultantRfUserId, env);
          console.log({ message: `[AddToJob] rfId=${rfId} → job ${jobId} consultant_id=${consultantRfUserId} ✓`, source: 'add-to-job' });
        } catch (error) {
          addResult.consultantWriteFailed = true;
          console.error({ message: `[AddToJob] rfId=${rfId} → consultant_id write failed: ${error.message}`, source: 'add-to-job' });
        }
      } else if (addResult.status === 'added') {
        console.log({ message: `[AddToJob] rfId=${rfId} → job ${jobId} ✓ (no consultant attribution)`, source: 'add-to-job' });
      }

      return addResult;
    }));

    const added = results.filter(r => r.status === 'added').length;
    const alreadyInJob = results.filter(r => r.status === 'already_in_job').length;
    const errors = results.filter(r => r.status === 'error').length;

    console.log({
      message: `[AddToJob] Done: ${added} added, ${alreadyInJob} already in job, ${errors} errors`,
      source: 'add-to-job',
      jobId,
      added,
      alreadyInJob,
      errors,
    });

    return new Response(JSON.stringify({ jobId, added, alreadyInJob, errors, results }), {
      status: 200, headers: responseHeaders
    });

  } catch (error) {
    console.error({ message: `[AddToJob] Error: ${error.message}`, source: 'add-to-job', stack: error.stack });
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: responseHeaders
    });
  }
}

async function handleMarkInvalidEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const rfId = payload.rfId;
    const consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName : '';

    if (!rfId) {
      return new Response(JSON.stringify({ error: 'Missing "rfId"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    console.log({
      message: `[MarkInvalid] rfId=${rfId} consultant=${consultantFirstName || 'none'}`,
      source: 'mark-invalid',
      rfId,
      consultantFirstName,
    });

    const candidate = await getRFCandidate(rfId, env);
    const existingTags = candidate?.tags;
    const TAG = 'Number Invalid';

    if (Array.isArray(existingTags) && existingTags.includes(TAG)) {
      console.log({
        message: `[MarkInvalid] rfId=${rfId} — tag already present, no-op`,
        source: 'mark-invalid',
        rfId,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: responseHeaders });
    }

    const merged = mergeTag(existingTags, TAG);
    await updateRFCandidate(rfId, { tags: merged }, env);

    console.log({
      message: `[MarkInvalid] rfId=${rfId} — tag added, total=${merged.length}`,
      source: 'mark-invalid',
      rfId,
      tags: merged,
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: responseHeaders });

  } catch (error) {
    console.error({ message: `[MarkInvalid] error: ${error.message}`, source: 'mark-invalid', stack: error.stack });
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: responseHeaders,
    });
  }
}

async function handleCandidateDetailsEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const profileUrl = typeof payload.profileUrl === 'string' ? payload.profileUrl.trim() : '';
    const consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName : '';

    if (!profileUrl) {
      return new Response(JSON.stringify({ error: 'Missing "profileUrl"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const consultantRfUserId = resolveRFUserId(consultantFirstName);

    // Resolve rfId — KV first, RF search fallback
    let rfId = await lookupByLinkedIn(profileUrl, env);
    if (!rfId) {
      const found = await searchRFCandidateByLinkedIn(profileUrl, env);
      if (found) {
        rfId = String(found.id);
        await cacheCandidate(found, env);
      }
    }

    if (!rfId) {
      console.log({
        message: `[CandidateDetails] no RF match for url=${profileUrl}`,
        source: 'candidate-details',
        profileUrl,
      });
      return new Response(JSON.stringify({ error: 'Candidate not found in RF' }), {
        status: 404, headers: responseHeaders,
      });
    }

    const rfIdNum = parseInt(rfId, 10);

    // Parallel fetches: full candidate + activities
    const [candidate, activities] = await Promise.all([
      getRFCandidate(rfIdNum, env),
      listCandidateActivities(rfIdNum, env),
    ]);

    // Pick best job
    const pickedJob = await pickConsultantJob(candidate, consultantRfUserId, env);
    const jobOut = pickedJob ? {
      title: pickedJob.name || pickedJob.title || '',
      company: pickedJob.company?.name || '',
      stage: pickedJob.stage_name || '',
    } : null;

    // Normalize phone — first entry of phone_number array
    let phoneNumber = null;
    const rawPhones = Array.isArray(candidate.phone_number) ? candidate.phone_number : [];
    if (rawPhones.length > 0) {
      const first = rawPhones[0];
      const raw = typeof first === 'string' ? first : first?.phone_number;
      phoneNumber = normalizeToE164(raw);
    }

    // Filter + map + sort cold-call activities (ASC by time)
    const coldCalls = activities
      .filter(a => a?.type?.id === 1002)
      .map(parseColdCallActivity)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const fullName = candidate.name || `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim();

    const responseBody = {
      rfId: rfIdNum,
      fullName,
      phoneNumber,
      job: jobOut,
      activities: coldCalls,
    };

    console.log({
      message: `[CandidateDetails] rfId=${rfIdNum} consultant=${consultantFirstName || 'none'} job=${jobOut ? jobOut.title : 'none'} activities=${coldCalls.length}`,
      source: 'candidate-details',
      rfId: rfIdNum,
      consultantFirstName,
      consultantRfUserId,
      jobPicked: jobOut,
      activityCount: coldCalls.length,
      phonePresent: phoneNumber !== null,
    });

    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: responseHeaders,
    });

  } catch (error) {
    console.error({ message: `[CandidateDetails] error: ${error.message}`, source: 'candidate-details', stack: error.stack });
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: responseHeaders,
    });
  }
}
