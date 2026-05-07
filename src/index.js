import {
  createOrUpdateDialpadContact, patchDialpadContact, getDialpadContact,
  getUserCallerId, initiateCall, buildCallerIdsFromDialpad, sendSMS,
  hangupCall,
} from './dialpad-client.js';
import { verifyJWT } from './auth.js';
import { signCallerIdAlias, verifyCallerIdAlias } from './dialpad-aliases.js';
import { checkAndRecordCall } from './rate-limit.js';
import { processExtensionCallEvent } from './extension-calls.js';
import { ExtCallState } from './extension-call-do.js';
export { ExtCallState };
import {
  extractRFIdFromDialpadContact, updateRFCandidate, convertDialpadContactToRFUpdate,
  isValidLinkedInUrl, normalizeLinkedInUrl, getRFCandidate, searchRFCandidateByLinkedIn,
  searchRFCandidateByEmail, addRFCandidateNote, moveToCallBooked, addRFCandidate,
  listOpenJobs, addCandidateToJob, setJobCandidateConsultantId,
  listCandidateActivities, normalizeToE164, pickConsultantJob,
  prewarmCandidatesIfMissing, searchCandidatesByJobAndStage, extractLinkedInSlug,
} from './rf-client.js';
import {
  cacheCandidate, getCachedCandidate, lookupByLinkedIn, lookupByEmail, lookupByName,
  cacheConsultantForJobLink,
  cacheCandidateDetails, getCachedCandidateDetails,
  cacheCandidateActivities, getCachedCandidateActivities,
  invalidateCandidateDetailsCache,
  appendToJobBatchIndex, getJobBatchIndex,
  getPrewarmState, setPrewarmState,
  getDailyCallCount,
} from './cache.js';
import { formatKrispNotesAsHtml, extractCandidateEmail } from './krisp.js';
import { processCallEvent, parseColdCallActivity, mergeTag } from './cold-call.js';
import { isJoelCandidate, enrichCandidate, buildApolloWebhookUrl } from './enrichment.js';
import { enrichPerson } from './apollo-client.js';
import { resolveRFUserId, getUserByFirstName } from './users.js';

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
      if (url.pathname.startsWith('/mcp/')) {
        const { routeMcp } = await import('./mcp/router.js');
        const { handlers } = await import('./mcp/handlers-registry.js');
        return routeMcp(request, env, ctx, handlers);
      }

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

      if (url.pathname === '/webhook/dialpad/extension-calls' && request.method === 'POST') {
        return await handleDialpadExtensionCallsWebhook(request, env);
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
        return await handleAddToJobEndpoint(request, env, ctx, corsHeaders);
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
        return await handleCandidateDetailsEndpoint(request, env, ctx, corsHeaders);
      }

      if (url.pathname === '/dialpad-user-context' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ ok: false, error: 'Authentication failed' }), { status: 401, headers: corsHeaders });
        }
        return await handleDialpadUserContextEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/dialpad-call' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ ok: false, error: 'Authentication failed' }), { status: 401, headers: corsHeaders });
        }
        return await handleDialpadCallEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/dialpad-sms' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ ok: false, error: 'Authentication failed' }), { status: 401, headers: corsHeaders });
        }
        return await handleDialpadSmsEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/dialpad-hangup' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ ok: false, error: 'Authentication failed' }), { status: 401, headers: corsHeaders });
        }
        return await handleDialpadHangupEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/extension-call-status' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ ok: false, error: 'Authentication failed' }), { status: 401, headers: corsHeaders });
        }
        return await handleExtensionCallStatusEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/my-sourcing-jobs' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ ok: false, error: 'Authentication failed' }), { status: 401, headers: corsHeaders });
        }
        return await handleMySourcingJobsEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/job-pipeline' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ ok: false, error: 'Authentication failed' }), { status: 401, headers: corsHeaders });
        }
        return await handleJobPipelineEndpoint(request, env, corsHeaders);
      }

      if (url.pathname === '/call-stats' && request.method === 'POST') {
        const extAuth = request.headers.get('X-Extension-Token');
        if (!env.LINKEDIN_EXTENSION_SECRET || extAuth !== env.LINKEDIN_EXTENSION_SECRET) {
          return new Response(JSON.stringify({ ok: false, error: 'Authentication failed' }), { status: 401, headers: corsHeaders });
        }
        return await handleCallStatsEndpoint(request, env, corsHeaders);
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
    const missing = [];
    if (!validation.hasName) missing.push('name');
    if (!validation.hasOrganization) missing.push('current_organization');
    if (!validation.hasTitle) missing.push('current_title');
    console.warn({
      message: `[Dialpad sync] skipped validation candidate=${candidate.id} missing=[${missing.join(', ')}]`,
      source: 'dialpad-sync',
      candidateId: candidate.id,
      missing,
      checks: {
        hasName: validation.hasName,
        hasOrganization: validation.hasOrganization,
        hasTitle: validation.hasTitle,
      },
      values: {
        first_name: candidate.first_name ?? null,
        last_name: candidate.last_name ?? null,
        name: candidate.name ?? null,
        current_organization: candidate.current_organization ?? null,
        current_title: candidate.current_title ?? null,
      },
    });
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
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
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

async function handleAddToJobEndpoint(request, env, ctx, corsHeaders) {
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

      // Step 2: write consultant_id whenever the candidate is on the job and we have a
      // consultant. Re-adds (already_in_job) reattribute to the current caller — by design,
      // because the LinkedIn extension is the only path that hits this route and a recruiter
      // would only re-add a candidate they're now driving themselves. This also gives us a
      // simple cache-refresh mechanism: re-add a candidate to a job to populate the cache.
      const shouldWriteConsultant =
        (addResult.status === 'added' || addResult.status === 'already_in_job') &&
        consultantRfUserId !== null;

      if (shouldWriteConsultant) {
        try {
          await setJobCandidateConsultantId(rfId, jobId, consultantRfUserId, env);
          await cacheConsultantForJobLink(rfId, jobId, consultantRfUserId, env);
          console.log({
            message: `[AddToJob] rfId=${rfId} → job ${jobId} consultant_id=${consultantRfUserId} ✓ (status=${addResult.status})`,
            source: 'add-to-job',
            rfId,
            jobId,
            consultantRfUserId,
            status: addResult.status,
          });
        } catch (error) {
          addResult.consultantWriteFailed = true;
          console.error({ message: `[AddToJob] rfId=${rfId} → consultant_id write failed: ${error.message}`, source: 'add-to-job' });
        }
      } else if (addResult.status === 'added' || addResult.status === 'already_in_job') {
        console.log({ message: `[AddToJob] rfId=${rfId} → job ${jobId} ${addResult.status} (no consultant attribution)`, source: 'add-to-job' });
      }

      // Append to the per-job batch index for both freshly-added rows AND
      // re-adds (the dedup inside appendToJobBatchIndex makes re-adds a no-op
      // for rfIds already in the list, but lets older candidates we never
      // tracked enter the index when re-added). The index drives the
      // /candidate-details neighbor-prewarming behavior.
      if (addResult.status === 'added' || addResult.status === 'already_in_job') {
        try {
          await appendToJobBatchIndex(jobId, rfId, env);
        } catch (error) {
          console.warn({ message: `[AddToJob] batch index append failed rfId=${rfId} job=${jobId}: ${error.message}`, source: 'add-to-job' });
        }
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
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
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

    // Invalidate the details/activities snapshot caches so the next
    // /candidate-details read picks up the new tag set immediately rather
    // than waiting up to 5 minutes for the snapshot TTL to expire.
    await invalidateCandidateDetailsCache(rfId, env);

    console.log({
      message: `[MarkInvalid] rfId=${rfId} — tag added, total=${merged.length}`,
      source: 'mark-invalid',
      rfId,
      tags: merged,
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: responseHeaders });

  } catch (error) {
    console.error({ message: `[MarkInvalid] error: ${error.message}`, source: 'mark-invalid', stack: error.stack });
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

async function handleCandidateDetailsEndpoint(request, env, ctx, corsHeaders) {
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

    // Resolve rfId — KV linkedin index first, RF search fallback.
    let rfId = await lookupByLinkedIn(profileUrl, env);
    let linkedinSource = rfId ? 'linkedin-cache' : null;
    if (!rfId) {
      const found = await searchRFCandidateByLinkedIn(profileUrl, env);
      if (found) {
        rfId = String(found.id);
        linkedinSource = 'rf-search';
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

    console.log({
      message: `[CandidateDetails] linkedin → rfId=${rfId} via ${linkedinSource}`,
      source: 'candidate-details',
      cacheHit: linkedinSource === 'linkedin-cache',
      linkedinSource,
      rfId,
    });

    const rfIdNum = parseInt(rfId, 10);

    // Try details + activities cache first (5-min TTL). On hit, skip RF entirely.
    const [cachedDetails, cachedActivities] = await Promise.all([
      getCachedCandidateDetails(rfIdNum, env),
      getCachedCandidateActivities(rfIdNum, env),
    ]);

    let candidate = cachedDetails;
    let activities = cachedActivities;

    if (cachedDetails && cachedActivities) {
      console.log({
        message: `[CandidateDetails] details+activities cache HIT rfId=${rfIdNum}`,
        source: 'candidate-details',
        cacheHit: 'both',
        rfId: rfIdNum,
      });
    } else {
      // Fetch only what's missing — keep both fetches parallel
      const [freshCandidate, freshActivities] = await Promise.all([
        cachedDetails ? Promise.resolve(cachedDetails) : getRFCandidate(rfIdNum, env),
        cachedActivities ? Promise.resolve(cachedActivities) : listCandidateActivities(rfIdNum, env),
      ]);
      candidate = freshCandidate;
      activities = freshActivities;

      // Write back the freshly-fetched pieces
      const writes = [];
      if (!cachedDetails) writes.push(cacheCandidateDetails(rfIdNum, candidate, env));
      if (!cachedActivities) writes.push(cacheCandidateActivities(rfIdNum, activities, env));
      if (writes.length) await Promise.all(writes);

      console.log({
        message: `[CandidateDetails] cache MISS rfId=${rfIdNum} detailsCached=${!!cachedDetails} activitiesCached=${!!cachedActivities}`,
        source: 'candidate-details',
        cacheHit: cachedDetails ? 'details-only' : (cachedActivities ? 'activities-only' : 'none'),
        rfId: rfIdNum,
      });
    }

    // Pick best job
    const pickedJob = await pickConsultantJob(candidate, consultantRfUserId, env);
    const jobOut = pickedJob ? {
      title: pickedJob.name || pickedJob.title || '',
      company: pickedJob.company?.name || '',
      stage: pickedJob.stage_name || '',
    } : null;

    // Fire-and-forget neighbor prewarming. Reads the picked job's batch
    // index, finds this candidate's position, and prewarms 30 either side
    // on first hit OR the next 30 in the direction of motion when the
    // recruiter has walked 20+ candidates since the last prewarm.
    if (pickedJob && consultantRfUserId !== null && ctx?.waitUntil) {
      ctx.waitUntil(handleNeighborPrewarm(rfIdNum, pickedJob.job_id, consultantRfUserId, env));
    }

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
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

/**
 * Neighbor-prewarm orchestration. Runs inside ctx.waitUntil so the response
 * is never blocked. Reads the per-job batch index to find the current
 * candidate's position, reads the per-recruiter+job prewarm state, and
 * decides what (if anything) to prewarm:
 *
 *   - First call (no state): prewarm RING candidates either side. Sets state.
 *   - Subsequent calls: if |currentIdx - lastPrewarmIdx| >= TRIGGER, prewarm
 *     the next RING candidates in the direction of motion. Updates state.
 *   - Otherwise: no-op (state untouched).
 *
 * Errors are caught and logged — never throw out of waitUntil.
 */
const PREWARM_RING = 30;
const PREWARM_TRIGGER_DISTANCE = 20;

async function handleNeighborPrewarm(rfId, jobId, recruiterRfUserId, env) {
  try {
    const batchList = await getJobBatchIndex(jobId, env);
    const idx = batchList.indexOf(String(rfId));
    if (idx < 0) {
      console.log({
        message: `[Prewarm] rfId=${rfId} not in batch index for job=${jobId}, skipping`,
        source: 'prewarm',
        rfId,
        jobId,
      });
      return;
    }

    const state = await getPrewarmState(recruiterRfUserId, jobId, env);

    if (!state || typeof state.lastPrewarmIdx !== 'number') {
      // First call — prewarm both directions.
      const start = Math.max(0, idx - PREWARM_RING);
      const end = Math.min(batchList.length - 1, idx + PREWARM_RING);
      const toWarm = batchList.slice(start, end + 1).filter(id => id !== String(rfId));
      console.log({
        message: `[Prewarm] initial both-directions rfId=${rfId} job=${jobId} idx=${idx} count=${toWarm.length}`,
        source: 'prewarm',
        rfId,
        jobId,
        idx,
        count: toWarm.length,
        phase: 'initial',
      });
      await prewarmCandidatesIfMissing(toWarm, env);
      await setPrewarmState(recruiterRfUserId, jobId, { lastPrewarmIdx: idx }, env);
      return;
    }

    const distance = idx - state.lastPrewarmIdx;
    if (Math.abs(distance) < PREWARM_TRIGGER_DISTANCE) {
      // Still within the prewarmed ring — nothing to do.
      return;
    }

    let toWarm;
    let direction;
    if (distance > 0) {
      // Ascending — prewarm the next RING ahead of the current index.
      direction = 'asc';
      const start = idx + 1;
      const end = Math.min(batchList.length - 1, idx + PREWARM_RING);
      toWarm = start <= end ? batchList.slice(start, end + 1) : [];
    } else {
      // Descending — prewarm the next RING behind the current index.
      direction = 'desc';
      const start = Math.max(0, idx - PREWARM_RING);
      const end = idx - 1;
      toWarm = start <= end ? batchList.slice(start, end + 1) : [];
    }

    console.log({
      message: `[Prewarm] direction=${direction} rfId=${rfId} job=${jobId} idx=${idx} count=${toWarm.length}`,
      source: 'prewarm',
      rfId,
      jobId,
      idx,
      direction,
      count: toWarm.length,
      phase: 'directional',
    });
    await prewarmCandidatesIfMissing(toWarm, env);
    await setPrewarmState(recruiterRfUserId, jobId, { lastPrewarmIdx: idx }, env);
  } catch (error) {
    console.error({
      message: `[Prewarm] handleNeighborPrewarm error: ${error.message}`,
      source: 'prewarm',
      rfId,
      jobId,
      stack: error.stack,
    });
  }
}

// ---------------------------------------------------------------------------
// Dialpad calling endpoints — wired up to the LinkedIn Recruiter extension.
// /dialpad-user-context returns the consultant's caller-IDs (with opaque
// alias tokens) so the extension can render its picker without ever seeing
// raw E.164 numbers. /dialpad-call decodes the picked alias and asks Dialpad
// to ring the consultant's eligible devices via initiate_call.
// ---------------------------------------------------------------------------

async function handleDialpadUserContextEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName.trim() : '';

    if (!consultantFirstName) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const user = getUserByFirstName(consultantFirstName);
    if (!user) {
      console.warn({
        message: `[DialpadUserContext] unknown consultantFirstName="${consultantFirstName}"`,
        source: 'dialpad-user-context',
        consultantFirstName,
      });
      return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
        status: 403, headers: responseHeaders,
      });
    }

    let dpCallerId;
    try {
      dpCallerId = await getUserCallerId(user.dialpadId, env);
    } catch (error) {
      console.error({
        message: `[DialpadUserContext] Dialpad caller_id fetch failed: ${error.message}`,
        source: 'dialpad-user-context',
        consultantFirstName,
        dialpadId: user.dialpadId,
        stack: error.stack,
      });
      return new Response(JSON.stringify({ ok: false, error: 'Dialpad caller_id lookup failed' }), {
        status: 502, headers: responseHeaders,
      });
    }

    const callerIds = await buildCallerIdsFromDialpad(
      dpCallerId,
      (number) => signCallerIdAlias(number, env),
    );

    console.log({
      message: `[DialpadUserContext] consultant=${consultantFirstName} callerIds=${callerIds.length}`,
      source: 'dialpad-user-context',
      consultantFirstName,
      dialpadId: user.dialpadId,
      callerIdCount: callerIds.length,
    });

    return new Response(JSON.stringify({ callerIds }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[DialpadUserContext] error: ${error.message}`,
      source: 'dialpad-user-context',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

async function handleDialpadCallEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName.trim() : '';
    const phoneNumber = typeof payload.phoneNumber === 'string' ? payload.phoneNumber.trim() : '';
    const callerAliasId = typeof payload.callerAliasId === 'string' ? payload.callerAliasId.trim() : '';

    if (!consultantFirstName) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const user = getUserByFirstName(consultantFirstName);
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
        status: 403, headers: responseHeaders,
      });
    }

    if (!phoneNumber) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing phone number' }), {
        status: 400, headers: responseHeaders,
      });
    }
    if (!/^\+\d{6,}$/.test(phoneNumber)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid phone number' }), {
        status: 400, headers: responseHeaders,
      });
    }

    if (!callerAliasId) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing caller-ID selection' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const outboundCallerId = await verifyCallerIdAlias(callerAliasId, env);
    if (!outboundCallerId) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid caller-ID selection — please refresh and try again' }), {
        status: 400, headers: responseHeaders,
      });
    }

    // Rate limit + dedup at the request-processing step. Dialpad caps each
    // user at 5 calls/min upstream; we mirror it locally so a button-mashing
    // recruiter gets a clean 429 instead of an opaque Dialpad rejection.
    // The 3s same-(user,phone) dedup window catches literal double-clicks.
    const rateLimitDecision = await checkAndRecordCall({
      dialpadUserId: user.dialpadId,
      phoneNumber,
    }, env);
    if (!rateLimitDecision.allowed) {
      const errorMsg = rateLimitDecision.reason === 'duplicate'
        ? `You just dialled this number — wait ${rateLimitDecision.retryAfterSec}s before retrying`
        : `Call rate limit hit (5/min) — try again in ${rateLimitDecision.retryAfterSec}s`;
      console.warn({
        message: `[DialpadCall] denied: ${rateLimitDecision.reason} consultant=${consultantFirstName}`,
        source: 'dialpad-call',
        consultantFirstName,
        dialpadId: user.dialpadId,
        reason: rateLimitDecision.reason,
        retryAfterSec: rateLimitDecision.retryAfterSec,
      });
      return new Response(JSON.stringify({
        ok: false,
        error: errorMsg,
        reason: rateLimitDecision.reason,
        retryAfterSec: rateLimitDecision.retryAfterSec,
      }), {
        status: 429,
        headers: { ...responseHeaders, 'Retry-After': String(rateLimitDecision.retryAfterSec) },
      });
    }

    console.log({
      message: `[DialpadCall] consultant=${consultantFirstName} → ${phoneNumber}`,
      source: 'dialpad-call',
      consultantFirstName,
      dialpadId: user.dialpadId,
      // Don't log the actual outbound number; just whether one was picked.
      hasOutboundCallerId: true,
    });

    const result = await initiateCall({
      userId: user.dialpadId,
      phoneNumber,
      outboundCallerId,
    }, env);

    if (!result.ok) {
      const upstreamMsg = result.body?.error || result.body?.message || `HTTP ${result.status}`;
      console.error({
        message: `[DialpadCall] Dialpad rejected: ${upstreamMsg}`,
        source: 'dialpad-call',
        consultantFirstName,
        dialpadId: user.dialpadId,
        upstreamStatus: result.status,
        upstreamBody: result.body,
      });
      return new Response(JSON.stringify({
        ok: false,
        error: `Dialpad rejected the call: ${upstreamMsg}`,
      }), { status: 502, headers: responseHeaders });
    }

    // No KV write here. The Dialpad `calling` webhook is the only thing that
    // writes extcall:callid:{userId} (and `hangup` is the only thing that
    // clears it). Eventual consistency: extension polls until the calling
    // webhook lands, then sees in_progress. If the webhook never lands the
    // extension's own 10s clock reverts the button to Call.

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[DialpadCall] error: ${error.message}`,
      source: 'dialpad-call',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

// ---------------------------------------------------------------------------
// /dialpad-sms — send a single SMS to a candidate via the consultant's
// Dialpad number. Same auth + alias machinery as /dialpad-call; key
// differences: callerAliasId is OPTIONAL (Dialpad falls back to the user's
// default sender when from_number is omitted), text is sent verbatim
// (preserve newlines/whitespace — recruiters typed it that way), and there's
// no rate-limit gate for now (per the SMS handoff: ships test-only first,
// revisit when production candidate-mode lights up).
// ---------------------------------------------------------------------------

async function handleDialpadSmsEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName.trim() : '';
    const phoneNumber = typeof payload.phoneNumber === 'string' ? payload.phoneNumber.trim() : '';
    // Do NOT trim text — recruiters typed it deliberately, including any
    // leading/trailing whitespace. Only reject if it's empty after trim.
    const text = typeof payload.text === 'string' ? payload.text : '';
    // callerAliasId is optional — empty/missing means "use Dialpad default".
    const callerAliasId = typeof payload.callerAliasId === 'string' ? payload.callerAliasId.trim() : '';

    if (!consultantFirstName) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const user = getUserByFirstName(consultantFirstName);
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
        status: 403, headers: responseHeaders,
      });
    }

    if (!phoneNumber) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing phone number' }), {
        status: 400, headers: responseHeaders,
      });
    }
    if (!/^\+\d{6,}$/.test(phoneNumber)) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid phone number' }), {
        status: 400, headers: responseHeaders,
      });
    }

    if (!text || !text.trim()) {
      return new Response(JSON.stringify({ ok: false, error: 'Empty message' }), {
        status: 400, headers: responseHeaders,
      });
    }

    let outboundCallerId;
    if (callerAliasId) {
      outboundCallerId = await verifyCallerIdAlias(callerAliasId, env);
      if (!outboundCallerId) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid caller-ID selection — please refresh and try again' }), {
          status: 400, headers: responseHeaders,
        });
      }
    }

    console.log({
      message: `[DialpadSms] consultant=${consultantFirstName} → ${phoneNumber} chars=${text.length}`,
      source: 'dialpad-sms',
      consultantFirstName,
      dialpadId: user.dialpadId,
      hasFromNumber: !!outboundCallerId,
      textLength: text.length,
      // Don't log message body itself — handoff calls it candidate-PII
      // once {{firstName}} is substituted.
    });

    const result = await sendSMS({
      userId: user.dialpadId,
      toNumbers: [phoneNumber],
      text,
      fromNumber: outboundCallerId,
      inferCountryCode: false,
    }, env);

    if (!result.ok) {
      const upstreamMsg = result.body?.error || result.body?.message || `HTTP ${result.status}`;
      console.error({
        message: `[DialpadSms] Dialpad rejected: ${upstreamMsg}`,
        source: 'dialpad-sms',
        consultantFirstName,
        dialpadId: user.dialpadId,
        upstreamStatus: result.status,
        upstreamBody: result.body,
      });
      return new Response(JSON.stringify({
        ok: false,
        error: `Dialpad rejected the message: ${upstreamMsg}`,
      }), { status: 502, headers: responseHeaders });
    }

    const responseBody = { ok: true };
    const messageId = result.body?.id || result.body?.message_id;
    if (messageId) responseBody.messageId = messageId;

    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[DialpadSms] error: ${error.message}`,
      source: 'dialpad-sms',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

// ---------------------------------------------------------------------------
// /dialpad-hangup — terminate whatever call_id is currently stored for the
// consultant. Body is just { consultantFirstName }; the worker reads
// call_id from the per-user ExtCallState Durable Object (set by the
// Dialpad `calling` webhook). 409 if no call_id is set. Does NOT clear
// the DO — the Dialpad `hangup` webhook is the single source of truth
// for clearing.
// ---------------------------------------------------------------------------

async function handleDialpadHangupEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName.trim() : '';

    if (!consultantFirstName) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const user = getUserByFirstName(consultantFirstName);
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
        status: 403, headers: responseHeaders,
      });
    }

    const stub = env.EXT_CALL_STATE.get(env.EXT_CALL_STATE.idFromName(user.dialpadId));
    const callId = await stub.getCallId();
    if (!callId) {
      console.warn({
        message: `[DialpadHangup] no active call_id consultant=${consultantFirstName}`,
        source: 'dialpad-hangup',
        consultantFirstName,
        dialpadId: user.dialpadId,
      });
      return new Response(JSON.stringify({ ok: false, error: 'No active call' }), {
        status: 409, headers: responseHeaders,
      });
    }

    console.log({
      message: `[DialpadHangup] consultant=${consultantFirstName} callId=${callId}`,
      source: 'dialpad-hangup',
      consultantFirstName,
      dialpadId: user.dialpadId,
      callId,
    });

    const result = await hangupCall({ callId }, env);

    // Do NOT clear the DO here. The Dialpad `hangup` webhook will fire
    // (Dialpad emits it after processing our hangup) and the webhook
    // handler is the only path that clears. This keeps the "single
    // source of truth = webhook" invariant intact.

    if (!result.ok) {
      const upstreamMsg = result.body?.error || result.body?.message || `HTTP ${result.status}`;
      console.error({
        message: `[DialpadHangup] Dialpad rejected: ${upstreamMsg}`,
        source: 'dialpad-hangup',
        consultantFirstName,
        dialpadId: user.dialpadId,
        callId,
        upstreamStatus: result.status,
        upstreamBody: result.body,
      });
      return new Response(JSON.stringify({
        ok: false,
        error: `Dialpad rejected the hangup: ${upstreamMsg}`,
      }), { status: 502, headers: responseHeaders });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[DialpadHangup] error: ${error.message}`,
      source: 'dialpad-hangup',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

// ---------------------------------------------------------------------------
// /extension-call-status — polled by the extension every ~500ms after a
// successful /dialpad-call. Returns one of { state: "in_progress" | "ended" }.
//
// KV-first: if `extcall:state:{userId}` has a callId bound, the response is a
// pure KV read. On the discovery branch (record exists, state="in_progress",
// no callId yet), we hit Dialpad's call-list to find the new call_id and
// cache it. Subsequent polls then become KV-only until the hangup webhook
// flips state to "ended".
//
// No server-side discovery timeout — the extension's own 10s clock decides
// give-up. As long as the extension is polling, we keep returning
// "in_progress" during discovery (so the extension's clock keeps running on
// the right side of the decision).
// ---------------------------------------------------------------------------

async function handleExtensionCallStatusEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const consultantFirstName = typeof payload.consultantFirstName === 'string'
      ? payload.consultantFirstName.trim()
      : '';

    if (!consultantFirstName) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const user = getUserByFirstName(consultantFirstName);
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
        status: 403, headers: responseHeaders,
      });
    }

    // Strongly-consistent read via the per-user Durable Object. The
    // webhook is the only thing that sets/clears the stored call_id;
    // this endpoint never writes.
    const stub = env.EXT_CALL_STATE.get(env.EXT_CALL_STATE.idFromName(user.dialpadId));
    const callId = await stub.getCallId();

    if (callId) {
      console.log({
        message: `[ExtCallStatus] poll consultant=${consultantFirstName} active callId=${callId} → in_progress`,
        source: 'extension-call-status',
        consultantFirstName,
        dialpadId: user.dialpadId,
        callId,
        returnedState: 'in_progress',
      });
      return new Response(JSON.stringify({ state: 'in_progress' }), {
        status: 200, headers: responseHeaders,
      });
    }

    console.log({
      message: `[ExtCallStatus] poll consultant=${consultantFirstName} no active call → ended`,
      source: 'extension-call-status',
      consultantFirstName,
      dialpadId: user.dialpadId,
      returnedState: 'ended',
    });
    return new Response(JSON.stringify({ state: 'ended' }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[ExtCallStatus] error: ${error.message}`,
      source: 'extension-call-status',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

// ---------------------------------------------------------------------------
// /webhook/dialpad/extension-calls — Dialpad call-state events that drive
// the extension Call/Hangup button. Subscription must be configured Dialpad-
// side for both `calling` and `hangup` events on the registered users.
// Auth: JWT (HS256) via DIALPAD_WEBHOOK_SECRET.
//
// This is the ONLY path that writes/clears `extcall:callid:{userId}`. The
// /dialpad-call and /dialpad-hangup endpoints don't touch KV — they just
// initiate/terminate via Dialpad and let the resulting webhook update KV.
//
//   - `calling` event for a monitored outbound call → KV[user] = call_id
//     (overwrites any prior — a new call replaces the previous record).
//   - `hangup` event whose call_id matches the stored value → KV.delete.
//     Mismatched call_id is dropped silently (protects against stale-event
//     races where an old hangup arrives after a new call's calling event).
//   - Anything else (`connected`, `voicemail`, inbound, unmonitored target)
//     → drop silently with a structured-log explanation.
//
// Always returns 200; Dialpad would retry on non-200 and we don't want
// that for events we deliberately dropped.
// ---------------------------------------------------------------------------

async function handleDialpadExtensionCallsWebhook(request, env) {
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

    const result = await processExtensionCallEvent(payload, env);

    if (result.processed) {
      console.log({
        message: `[Dialpad/extension-calls] ${result.reason} callId=${result.callId} user=${result.dialpadUserId}`,
        source: 'dialpad-extension-calls',
        reason: result.reason,
        callId: result.callId,
        targetId: result.targetId,
        dialpadUserId: result.dialpadUserId,
        eventState: result.eventState,
      });
    } else {
      console.log({
        message: `[Dialpad/extension-calls] dropped: ${result.reason}`,
        source: 'dialpad-extension-calls',
        reason: result.reason,
        eventState: result.eventState,
        eventCallId: result.eventCallId,
        targetId: result.targetId,
        recordCallId: result.recordCallId,
      });
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error({
      message: `[Dialpad/extension-calls] unhandled error: ${error.message}`,
      source: 'dialpad-extension-calls',
      stack: error.stack,
    });
    // Return 200 even on error — Dialpad's retry on non-200 would just
    // redeliver the same broken event.
    return new Response('OK', { status: 200 });
  }
}

// ---------------------------------------------------------------------------
// /my-sourcing-jobs — return open jobs where the consultant is on the
// hiring team as a Recruiter AND the job's status is "Sourcing". Drives
// the mobile PWA's home screen.
// ---------------------------------------------------------------------------

async function handleMySourcingJobsEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const consultantFirstName = typeof payload.consultantFirstName === 'string'
      ? payload.consultantFirstName.trim()
      : '';

    if (!consultantFirstName) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const consultantRfUserId = resolveRFUserId(consultantFirstName);
    if (!consultantRfUserId) {
      return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
        status: 403, headers: responseHeaders,
      });
    }

    const allJobs = await listOpenJobs(env);
    const filtered = allJobs.filter(job => {
      const onHiringTeamAsRecruiter = Array.isArray(job.hiring_team)
        && job.hiring_team.some(member =>
          member && member.user_id === consultantRfUserId
            && typeof member.role === 'string'
            && member.role.toLowerCase() === 'recruiter');
      const isSourcing = job.job_status
        && typeof job.job_status.name === 'string'
        && job.job_status.name.toLowerCase() === 'sourcing';
      return onHiringTeamAsRecruiter && isSourcing;
    });

    const jobs = filtered.map(j => ({
      id: j.id,
      name: j.name,
      company: j.company,
    }));

    console.log({
      message: `[MySourcingJobs] consultant=${consultantFirstName} jobs=${jobs.length} (filtered from ${allJobs.length} open)`,
      source: 'my-sourcing-jobs',
      consultantFirstName,
      consultantRfUserId,
      jobsReturned: jobs.length,
      jobsTotal: allJobs.length,
    });

    return new Response(JSON.stringify({ jobs }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[MySourcingJobs] error: ${error.message}`,
      source: 'my-sourcing-jobs',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

// ---------------------------------------------------------------------------
// /job-pipeline — return Sourced-stage candidates for a job, ordered by
// per-job added_time DESC (newest-first — the recruiter just bulk-added
// these and wants to walk through them in the order they came in).
// Returns just rfId + linkedinUrl per candidate; the PWA fetches full
// details per-card via the existing /candidate-details route as it
// traverses prev/next.
// ---------------------------------------------------------------------------

async function handleJobPipelineEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const consultantFirstName = typeof payload.consultantFirstName === 'string'
      ? payload.consultantFirstName.trim()
      : '';
    const jobIdRaw = payload.jobId;
    const jobId = typeof jobIdRaw === 'number'
      ? jobIdRaw
      : (typeof jobIdRaw === 'string' && /^\d+$/.test(jobIdRaw.trim()) ? parseInt(jobIdRaw.trim(), 10) : null);

    if (!consultantFirstName) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
        status: 400, headers: responseHeaders,
      });
    }
    if (!jobId) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing or invalid "jobId"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const consultantRfUserId = resolveRFUserId(consultantFirstName);
    if (!consultantRfUserId) {
      return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
        status: 403, headers: responseHeaders,
      });
    }

    const { candidates: rawCandidates, totalItems } = await searchCandidatesByJobAndStage(
      { jobId, stageName: 'Sourced' },
      env,
    );

    // Map → filter out missing linkedin → sort by per-job added_time DESC.
    //
    // RF's /candidate/search response carries `added_time` at TWO levels:
    //   - top-level `added_time` = candidate-record creation date (when they
    //     were first added to RF — could be years ago for existing leads)
    //   - jobs[].added_time = when this candidate was added to that specific
    //     job (the job-link creation date — what the pipeline view wants)
    //
    // Sorting by the top-level field mixes "candidate created in 2022" with
    // "candidate created today" by their CREATION date, which has no
    // relationship to the order they were added to this Sourced pipeline
    // and therefore looks random to the recruiter walking the queue.
    const enriched = rawCandidates.map(c => {
      const linkedinRaw = typeof c?.linkedin_profile === 'string' ? c.linkedin_profile.trim() : '';
      // RF returns the literal string "None" for missing fields.
      const linkedin = linkedinRaw && linkedinRaw.toLowerCase() !== 'none' ? linkedinRaw : null;
      const slug = linkedin ? extractLinkedInSlug(linkedin) : null;
      const linkedinUrl = slug ? `https://www.linkedin.com/in/${slug}` : null;
      const jobs = Array.isArray(c?.jobs) ? c.jobs : [];
      const matchingJob = jobs.find(j => Number(j?.job_id) === jobId);
      // Fall back to top-level added_time only when the per-job entry is
      // missing (shouldn't happen — RF only returns the candidate because
      // they matched the job filter — but defensive).
      const addedTime = matchingJob?.added_time || c?.added_time || null;
      const addedTs = addedTime ? Date.parse(addedTime) : NaN;
      return {
        rfId: c?.id,
        linkedinUrl,
        addedTime,
        addedTs: Number.isFinite(addedTs) ? addedTs : null,
      };
    }).filter(c => c.rfId && c.linkedinUrl);

    enriched.sort((a, b) => {
      // Newest-first; missing timestamps sink to the bottom.
      const aT = a.addedTs ?? Number.NEGATIVE_INFINITY;
      const bT = b.addedTs ?? Number.NEGATIVE_INFINITY;
      return bT - aT;
    });

    const candidates = enriched.map(c => ({
      rfId: c.rfId,
      linkedinUrl: c.linkedinUrl,
    }));

    console.log({
      message: `[JobPipeline] consultant=${consultantFirstName} job=${jobId} sourced=${candidates.length} (raw=${rawCandidates.length}, totalItems=${totalItems})`,
      source: 'job-pipeline',
      consultantFirstName,
      consultantRfUserId,
      jobId,
      stage: 'Sourced',
      candidatesReturned: candidates.length,
      rawCount: rawCandidates.length,
      totalItems,
    });

    return new Response(JSON.stringify({
      jobId,
      stage: 'Sourced',
      total: typeof totalItems === 'number' ? totalItems : candidates.length,
      candidates,
    }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[JobPipeline] error: ${error.message}`,
      source: 'job-pipeline',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

// ---------------------------------------------------------------------------
// /call-stats — extension's "calls today" badge data. Pure KV read of the
// per-consultant daily counter, which is incremented by the
// /webhook/dialpad/extension-calls handler on every monitored outbound
// `hangup` event. Body: { consultantFirstName }. Returns { daily }.
// ---------------------------------------------------------------------------

async function handleCallStatsEndpoint(request, env, corsHeaders) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const consultantFirstName = typeof payload.consultantFirstName === 'string'
      ? payload.consultantFirstName.trim()
      : '';

    if (!consultantFirstName) {
      return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    const user = getUserByFirstName(consultantFirstName);
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
        status: 403, headers: responseHeaders,
      });
    }

    const daily = await getDailyCallCount(user.rfUserId, env);

    return new Response(JSON.stringify({ daily }), {
      status: 200, headers: responseHeaders,
    });
  } catch (error) {
    console.error({
      message: `[CallStats] error: ${error.message}`,
      source: 'call-stats',
      stack: error.stack,
    });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

