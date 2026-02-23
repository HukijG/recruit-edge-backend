import { createOrUpdateDialpadContact } from './dialpad-client.js';
import { verifyJWT } from './auth.js';
import {
  extractRFIdFromDialpadContact, updateRFCandidate, convertDialpadContactToRFUpdate,
  isValidLinkedInUrl, normalizeLinkedInUrl, getRFCandidate, searchRFCandidateByLinkedIn,
  searchRFCandidateByEmail, addRFCandidateNote
} from './rf-client.js';
import { cacheCandidate, getCachedCandidate, lookupByLinkedIn, lookupByEmail, lookupByName } from './cache.js';
import { formatKrispNotesAsHtml, extractCandidateEmail } from './krisp.js';

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
      console.error('[RF] RF_WEBHOOK_SECRET not configured');
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

    console.log(`[RF] ${eventType} candidate=${candidate.id} "${candidate.name}" org=${candidate.current_organization || '—'}`);

    if (eventType === 'Created' || eventType === 'Updated') {
      const synced = await syncCandidateToDialpad(candidate, env);
      await cacheCandidate(candidate, env);
      console.log(`[RF] → ${synced ? 'Dialpad upsert + cached' : 'skipped Dialpad (validation), cached'} candidate=${candidate.id}`);
    } else {
      console.log(`[RF] → ignored event: ${eventType}`);
    }

    return new Response('Webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[RF] error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleManualRFWebhook(request, env, url) {
  try {
    const webhookSecret = env.RF_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[RF/manual] RF_WEBHOOK_SECRET not configured');
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

    console.log(`[RF/manual] candidate=${candidate.id} "${candidate.name}" org=${candidate.current_organization || '—'}`);

    const synced = await syncCandidateToDialpad(candidate, env);
    await cacheCandidate(candidate, env);
    console.log(`[RF/manual] → ${synced ? 'Dialpad upsert + cached' : 'skipped Dialpad (validation), cached'} candidate=${candidate.id}`);

    return new Response('Manual webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[RF/manual] error:', error);
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
    console.log(`[Dialpad] ${payload.event} contact="${contact?.display_name}" id=${contact?.id}`);

    if (payload.event === 'Updated') {
      await processDialpadContactUpdate(contact, env);
    } else {
      console.log(`[Dialpad] → ignored event: ${payload.event}`);
    }

    return new Response('Dialpad webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Dialpad] error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function processDialpadContactUpdate(contact, env) {
  const rfCandidateId = extractRFIdFromDialpadContact(contact.id);

  if (!rfCandidateId) {
    console.log('[Dialpad] → skipped: no RF ID in contact');
    return;
  }

  const syncKey = `sync:RF${rfCandidateId}`;
  const recentSync = await env.SYNC_STATE.get(syncKey);
  if (recentSync) {
    console.log(`[Dialpad] → skipped candidate=${rfCandidateId}: debounce active`);
    return;
  }

  try {
    const updateData = convertDialpadContactToRFUpdate(contact);

    if (Object.keys(updateData).length === 0) {
      console.log(`[Dialpad] → skipped candidate=${rfCandidateId}: no email/phone/linkedin data`);
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
        console.error(`[Dialpad] cache warming failed for candidate=${rfCandidateId}:`, e.message);
      }
    }

    console.log(`[Dialpad] → RF update [${Object.keys(updateData).join(',')}] + cached candidate=${rfCandidateId}`);

  } catch (error) {
    console.error(`[Dialpad] error syncing candidate=${rfCandidateId}:`, error.message);
    throw error;
  }
}

async function handleCalendarWebhook(request, env) {
  try {
    const webhookSecret = env.CALENDAR_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('[Calendar] CALENDAR_WEBHOOK_SECRET not configured');
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

    console.log(`[Calendar] attendee="${payload.attendee_name}" email=${payload.attendee_email} linkedin=${payload.linkedin_answer || '—'}`);

    await processCalendarEvent(payload, env);

    return new Response('Calendar webhook processed', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Calendar] error:', error);
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
    console.log(`[Calendar] → no candidate found for ${attendee_email}, skipping`);
    return;
  }

  console.log(`[Calendar] → found candidate=${candidateId} via ${lookupMethod}`);

  // GET current candidate data (RF update REPLACES arrays, doesn't append)
  const currentCandidate = await getRFCandidate(candidateId, env);

  const existingEmails = Array.isArray(currentCandidate.email)
    ? currentCandidate.email
    : [];

  const emailAlreadyExists = existingEmails.some(
    e => e.email?.toLowerCase() === attendee_email.toLowerCase()
  );

  if (emailAlreadyExists) {
    console.log(`[Calendar] → skipped: email ${attendee_email} already on candidate=${candidateId}`);
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
    console.error(`[Calendar] Dialpad upsert failed (non-fatal):`, error.message);
  }

  await cacheCandidate({ ...currentCandidate, email: mergedEmails }, env);

  console.log(`[Calendar] → RF email merge (${mergedEmails.length} total)${dialpadOk ? ' + Dialpad upsert' : ''} + cached candidate=${candidateId}`);
}

/**
 * Sync candidate to Dialpad. Returns true if synced, false if skipped validation.
 */
async function syncCandidateToDialpad(candidate, env) {
  const validation = validateCandidateForDialpad(candidate);

  if (!validation.isValidForSync) {
    return false;
  }

  const dialpadResult = await createOrUpdateDialpadContact(candidate, env);

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
      console.error('[Krisp] KRISP_WEBHOOK_SECRET not configured');
      return new Response('Unauthorized', { status: 401 });
    }
    const token = request.headers.get('X-Krisp-Webhook-Token');
    if (!token || token !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();

    if (payload.event !== 'summary_generated') {
      console.log(`[Krisp] → ignored event: ${payload.event}`);
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
      console.log(`[Krisp] → skipped: already processed meeting=${meeting.id}`);
      return new Response('OK', { status: 200 });
    }

    console.log(`[Krisp] meeting=${meeting.id} "${meeting.title}" participants=${meeting.participants?.length || 0}`);

    const notePosted = await processKrispMeetingNotes(meeting, content, env);

    if (notePosted) {
      await env.SYNC_STATE.put(dedupeKey, 'true', { expirationTtl: 300 });
    }

    return new Response('Krisp webhook processed', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('[Krisp] error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function processKrispMeetingNotes(meeting, content, env) {
  const candidateEmail = extractCandidateEmail(meeting.participants);
  if (!candidateEmail) {
    console.log('[Krisp] → skipped: no candidate email in participants');
    return false;
  }

  if (!Array.isArray(content) || content.length === 0) {
    console.log('[Krisp] → skipped: no content sections');
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
    console.log(`[Krisp] → no candidate found for ${candidateEmail}, skipping`);
    return false;
  }

  const htmlContent = formatKrispNotesAsHtml(meeting, content);
  await addRFCandidateNote(candidateId, htmlContent, env);

  console.log(`[Krisp] → RF note posted for candidate=${candidateId} (${lookupMethod}) meeting="${meeting.title}"`);

  return true;
}
