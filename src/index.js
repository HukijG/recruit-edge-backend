import { createOrUpdateDialpadContact } from './dialpad-client.js';
import { verifyJWT } from './auth.js';
import {
  extractRFIdFromDialpadContact, updateRFCandidate, convertDialpadContactToRFUpdate,
  isValidLinkedInUrl, normalizeLinkedInUrl, getRFCandidate, searchRFCandidateByLinkedIn,
  searchRFCandidateByEmail, addRFCandidateNote
} from './rf-client.js';
import { cacheCandidate, getCachedCandidate, lookupByLinkedIn, lookupByEmail, lookupByName } from './cache.js';
import { formatKrispNotesAsHtml, extractCandidateEmail } from './krisp.js';
import { processCallEvent } from './cold-call.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RF-Webhook-Token, X-Calendar-Webhook-Token, X-Krisp-Webhook-Token, RF-Event-Type, Authorization',
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
      const synced = await syncCandidateToDialpad(candidate, env);
      await cacheCandidate(candidate, env);
      console.log({
        message: `[RF] → ${synced ? 'Dialpad upsert + cached' : 'skipped Dialpad (validation), cached'} candidate=${candidate.id}`,
        source: 'rf',
        action: synced ? 'dialpad_upsert' : 'skipped_validation',
        candidateId: candidate.id,
      });
    } else {
      console.log({ message: `[RF] → ignored event: ${eventType}`, source: 'rf', event: eventType });
    }

    return new Response('Webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: '[RF] error', source: 'rf', error: error.message });
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

    const synced = await syncCandidateToDialpad(candidate, env);
    await cacheCandidate(candidate, env);

    console.log({
      message: `[RF/manual] → ${synced ? 'Dialpad upsert + cached' : 'skipped Dialpad (validation), cached'} candidate=${candidate.id}`,
      source: 'rf-manual',
      action: synced ? 'dialpad_upsert' : 'skipped_validation',
      candidateId: candidate.id,
    });

    return new Response('Manual webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: '[RF/manual] error', source: 'rf-manual', error: error.message });
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
    console.error({ message: '[Dialpad] error', source: 'dialpad', error: error.message });
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
    console.error({ message: `[Dialpad] sync error`, source: 'dialpad', candidateId: rfCandidateId, error: error.message });
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
    });

    await processCalendarEvent(payload, env);

    return new Response('Calendar webhook processed', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: '[Calendar] error', source: 'calendar', error: error.message });
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function processCalendarEvent(payload, env) {
  const { attendee_email, attendee_name, linkedin_answer } = payload;

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

  const existingEmails = Array.isArray(currentCandidate.email)
    ? currentCandidate.email
    : [];

  const emailAlreadyExists = existingEmails.some(
    e => e.email?.toLowerCase() === attendee_email.toLowerCase()
  );

  if (emailAlreadyExists) {
    console.log({ message: `[Calendar] → skipped: email already exists`, source: 'calendar', candidateId, attendeeEmail: attendee_email });
    return;
  }

  const isPrimary = existingEmails.length === 0 ? 1 : 0;
  const mergedEmails = [...existingEmails, { email: attendee_email, is_primary: isPrimary }];

  // Update RF candidate with merged emails
  await updateRFCandidate(candidateId, { email: mergedEmails }, env);

  // Set debounce flag to prevent RF→Dialpad webhook loop
  const syncKey = `sync:RF${candidateId}`;
  await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });

  // Upsert Dialpad contact directly (RF webhook takes 6-7 hours)
  let dialpadOk = true;
  try {
    const primaryEmail = mergedEmails.find(e => e.is_primary === 1)?.email || attendee_email;
    let phoneStr = '';
    if (Array.isArray(currentCandidate.phone_number) && currentCandidate.phone_number.length > 0) {
      phoneStr = currentCandidate.phone_number[0]?.phone_number || '';
    } else if (typeof currentCandidate.phone_number === 'string') {
      phoneStr = currentCandidate.phone_number;
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
    console.error({ message: '[Calendar] Dialpad upsert failed (non-fatal)', source: 'calendar', candidateId, error: error.message });
  }

  await cacheCandidate({ ...currentCandidate, email: mergedEmails }, env);

  console.log({
    message: `[Calendar] → RF email merge${dialpadOk ? ' + Dialpad upsert' : ''} + cached candidate=${candidateId}`,
    source: 'calendar',
    action: 'email_merge',
    candidateId,
    lookupMethod,
    attendeeEmail: attendee_email,
    totalEmails: mergedEmails.length,
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
    console.error({ message: '[Krisp] error', source: 'krisp', error: error.message });
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
    });

    const result = await processCallEvent(payload, env);

    console.log({
      message: `[Dialpad/calls] → ${result.isColdCall ? 'COLD CALL tracked' : result.reason}`,
      source: 'dialpad-calls',
      callId: payload.call_id,
      processed: result.processed,
      isColdCall: result.isColdCall,
      reason: result.reason,
    });

    return new Response('Call webhook processed', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error({ message: '[Dialpad/calls] error', source: 'dialpad-calls', error: error.message });
    return new Response('Internal Server Error', { status: 500 });
  }
}
