import { createOrUpdateDialpadContact } from './dialpad-client.js';
import { verifyJWT } from './auth.js';
import {
  extractRFIdFromDialpadContact, updateRFCandidate, convertDialpadContactToRFUpdate,
  isValidLinkedInUrl, normalizeLinkedInUrl, getRFCandidate, searchRFCandidateByLinkedIn,
  searchRFCandidateByEmail, addRFCandidateNote
} from './rf-client.js';
import { cacheCandidate, getCachedCandidate, lookupByLinkedIn, lookupByEmail, lookupByName } from './cache.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RF-Webhook-Token, X-Calendar-Webhook-Token, RF-Event-Type, Authorization',
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
    // Verify webhook signature — fail closed if secret not configured
    const webhookSecret = env.RF_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('RF_WEBHOOK_SECRET not configured, rejecting request');
      return new Response('Unauthorized', { status: 401 });
    }
    const signature = request.headers.get('X-RF-Webhook-Token');
    if (!signature || signature !== webhookSecret) {
      console.log('Webhook signature verification failed');
      return new Response('Unauthorized', { status: 401 });
    }

    // Get event type from custom header
    const eventType = request.headers.get('RF-Event-Type');
    console.log('RF Event Type:', eventType);

    const payload = await request.json();
    const candidate = payload?.candidate;

    if (!candidate || !candidate.id) {
      console.log('Malformed RF webhook payload — missing candidate data');
      return new Response('Bad Request', { status: 400 });
    }

    console.log('RF webhook received:', {
      eventType,
      eventTime: payload.event_time,
      candidateId: candidate.id,
      candidateName: candidate.name,
      hasEmail: !!candidate.email && candidate.email !== "",
      hasPhone: !!candidate.phone_number && candidate.phone_number !== "",
      linkedinProfile: candidate.linkedin_profile,
      currentOrg: candidate.current_organization,
      currentTitle: candidate.current_title
    });

    // Process based on event type
    if (eventType === 'Created' || eventType === 'Updated') {
      await syncCandidateToDialpad(candidate, env);
      // Passively build candidate cache from RF webhook traffic
      await cacheCandidate(candidate, env);
    } else {
      console.log('Unhandled event type:', eventType);
    }

    return new Response('Webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('RF webhook error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleDialpadWebhook(request, env) {
  try {
    // Get the JWT token from Authorization header or body
    const authHeader = request.headers.get('Authorization');
    const bodyText = await request.text();

    let token;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else {
      // If no auth header, assume the entire body is the JWT
      token = bodyText;
    }

    if (!token) {
      console.log('No JWT token found in Dialpad webhook');
      return new Response('Unauthorized - No token', { status: 401 });
    }

    // Verify and decode the JWT
    const payload = await verifyJWT(token, env.DIALPAD_WEBHOOK_SECRET);

    if (!payload) {
      console.log('Dialpad webhook JWT verification failed');
      return new Response('Unauthorized - Invalid token', { status: 401 });
    }

    console.log('Dialpad webhook received and decoded:', {
      event: payload.event,
      contactId: payload.contact?.id,
      contactType: payload.contact?.type,
      displayName: payload.contact?.display_name,
      firstName: payload.contact?.first_name,
      lastName: payload.contact?.last_name,
      primaryPhone: payload.contact?.primary_phone,
      primaryEmail: payload.contact?.primary_email,
      companyName: payload.contact?.company_name,
      jobTitle: payload.contact?.job_title,
      phones: payload.contact?.phones,
      emails: payload.contact?.emails,
      urls: payload.contact?.urls
    });

    // Process based on event type
    if (payload.event === 'Updated') {
      await processDialpadContactUpdate(payload.contact, env);
    } else {
      console.log('Unhandled Dialpad event type:', payload.event);
    }

    return new Response('Dialpad webhook processed successfully', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Dialpad webhook error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function processDialpadContactUpdate(contact, env) {
  console.log('Processing Dialpad contact update for RF sync:', {
    id: contact.id,
    displayName: contact.display_name,
    firstName: contact.first_name,
    lastName: contact.last_name,
    primaryPhone: contact.primary_phone,
    primaryEmail: contact.primary_email,
    companyName: contact.company_name,
    jobTitle: contact.job_title
  });

  // Extract RF candidate ID from Dialpad contact ID
  const rfCandidateId = extractRFIdFromDialpadContact(contact.id);

  if (!rfCandidateId) {
    console.log('No RF candidate ID found in Dialpad contact ID, skipping sync');
    return;
  }

  console.log('Found RF candidate ID:', rfCandidateId);

  // Loop prevention: skip if this contact was recently synced from RF
  const syncKey = `sync:RF${rfCandidateId}`;
  const recentSync = await env.SYNC_STATE.get(syncKey);
  if (recentSync) {
    console.log('Skipping Dialpad->RF sync, recent RF->Dialpad sync detected for candidate:', rfCandidateId);
    return;
  }

  try {
    // Convert Dialpad contact data to RF update format
    const updateData = convertDialpadContactToRFUpdate(contact);

    if (Object.keys(updateData).length === 0) {
      console.log('No email or phone data to update, skipping');
      return;
    }

    console.log('Updating RF candidate with data:', updateData);

    // Update the candidate in RecruiterFlow
    const result = await updateRFCandidate(rfCandidateId, updateData, env);

    // Write debounce flag to prevent RF->Dialpad echo (60s TTL)
    await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });
    console.log('Set reverse sync debounce flag:', syncKey);

    console.log('Successfully synced Dialpad contact to RF:', {
      rfCandidateId,
      updatedFields: Object.keys(updateData)
    });

    // Update cache with Dialpad changes
    const cached = await getCachedCandidate(rfCandidateId, env);
    if (cached) {
      // Merge Dialpad changes into cached record
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
      // Cache miss — fetch fresh from RF to populate cache
      try {
        const fresh = await getRFCandidate(rfCandidateId, env);
        await cacheCandidate(fresh, env);
      } catch (e) {
        console.error('Failed to fetch RF candidate for cache warming:', e.message);
      }
    }

  } catch (error) {
    console.error('Failed to sync Dialpad contact to RF:', {
      rfCandidateId,
      error: error.message,
      contact: contact
    });
    throw error;
  }
}

async function handleCalendarWebhook(request, env) {
  try {
    // Verify webhook secret — fail closed if not configured
    const webhookSecret = env.CALENDAR_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('CALENDAR_WEBHOOK_SECRET not configured, rejecting request');
      return new Response('Unauthorized', { status: 401 });
    }
    const token = request.headers.get('X-Calendar-Webhook-Token');
    if (!token || token !== webhookSecret) {
      console.log('Calendar webhook auth failed');
      return new Response('Unauthorized', { status: 401 });
    }

    const payload = await request.json();

    // Validate required fields
    if (!payload.attendee_email) {
      console.log('Calendar webhook missing attendee_email, rejecting');
      return new Response('Bad Request — missing attendee_email', { status: 400 });
    }

    console.log('Calendar webhook received:', {
      event_id: payload.event_id,
      event_title: payload.event_title,
      event_start: payload.event_start,
      attendee_email: payload.attendee_email,
      attendee_name: payload.attendee_name,
      linkedin_answer: payload.linkedin_answer,
    });

    await processCalendarEvent(payload, env);

    return new Response('Calendar webhook processed', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Calendar webhook error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function processCalendarEvent(payload, env) {
  const { attendee_email, attendee_name, linkedin_answer } = payload;

  // Step 1: Find the RF candidate
  let candidateId = null;

  // Tier 1: LinkedIn lookup (cache, then RF search API)
  if (isValidLinkedInUrl(linkedin_answer)) {
    const normalized = normalizeLinkedInUrl(linkedin_answer);
    console.log('Valid LinkedIn URL, searching RF:', { original: linkedin_answer, normalized });

    const cachedId = await lookupByLinkedIn(linkedin_answer, env);
    if (cachedId) {
      console.log('Cache hit for LinkedIn:', { normalized, candidateId: cachedId });
      candidateId = cachedId;
    } else {
      console.log('Cache miss for LinkedIn, falling back to RF search API');
      const searchResult = await searchRFCandidateByLinkedIn(linkedin_answer, env);
      if (searchResult) {
        candidateId = searchResult.id;
        await cacheCandidate(searchResult, env);
      }
    }
  } else {
    console.log('LinkedIn answer is not a valid URL, skipping LinkedIn lookup:', linkedin_answer);
  }

  // Tier 2: Email fallback (cache only)
  if (!candidateId && attendee_email) {
    const emailId = await lookupByEmail(attendee_email, env);
    if (emailId) {
      console.log('Cache hit for email:', { email: attendee_email, candidateId: emailId });
      candidateId = emailId;
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
        console.log('Cache hit for name:', { firstName, lastName, candidateId: nameId });
        candidateId = nameId;
      } else {
        console.log('No unambiguous cache match for name:', { firstName, lastName });
      }
    }
  }

  if (!candidateId) {
    console.log('No RF candidate found, skipping calendar event processing');
    return;
  }

  console.log('Found RF candidate:', candidateId);

  // Step 2: GET current candidate data (RF update REPLACES arrays, doesn't append)
  const currentCandidate = await getRFCandidate(candidateId, env);

  // Step 3: Merge email into existing array
  const existingEmails = Array.isArray(currentCandidate.email)
    ? currentCandidate.email
    : [];

  const emailAlreadyExists = existingEmails.some(
    e => e.email?.toLowerCase() === attendee_email.toLowerCase()
  );

  if (emailAlreadyExists) {
    console.log('Email already exists on candidate, skipping update:', attendee_email);
    return;
  }

  const isPrimary = existingEmails.length === 0 ? 1 : 0;
  const mergedEmails = [...existingEmails, { email: attendee_email, is_primary: isPrimary }];

  console.log('Merging email into candidate:', {
    candidateId,
    newEmail: attendee_email,
    isPrimary,
    totalEmails: mergedEmails.length
  });

  // Step 4: Update RF candidate with merged emails
  await updateRFCandidate(candidateId, { email: mergedEmails }, env);

  // Step 5: Set debounce flag to prevent RF→Dialpad webhook loop
  const syncKey = `sync:RF${candidateId}`;
  await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });
  console.log('Set sync debounce flag:', syncKey);

  // Step 6: Upsert Dialpad contact directly (RF webhook takes 6-7 hours)
  try {
    // Extract primary email string for the Dialpad client
    const primaryEmail = mergedEmails.find(e => e.is_primary === 1)?.email || attendee_email;
    // Extract primary phone string (RF might store as array of objects)
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

    const dialpadResult = await createOrUpdateDialpadContact(dialpadCandidate, env);
    console.log('Dialpad contact updated with email:', dialpadResult);
  } catch (error) {
    // Dialpad failure is non-fatal — RF update already succeeded
    console.error('Failed to update Dialpad contact (non-fatal):', error.message);
  }

  // Update cache with the new email data
  await cacheCandidate({ ...currentCandidate, email: mergedEmails }, env);

  console.log('Calendar event processed successfully:', { candidateId, emailAdded: attendee_email });
}

async function syncCandidateToDialpad(candidate, env) {
  console.log('Processing candidate for Dialpad sync:', {
    id: candidate.id,
    name: candidate.name,
    organization: candidate.current_organization,
    title: candidate.current_title,
    email: candidate.email,
    phone: candidate.phone_number
  });

  // Validate required fields for Dialpad sync
  const validation = validateCandidateForDialpad(candidate);
  console.log('Candidate validation for Dialpad sync:', validation);

  if (!validation.isValidForSync) {
    console.log('Candidate not valid for Dialpad sync, skipping');
    return;
  }

  try {
    // Create contact in Dialpad
    const dialpadResult = await createOrUpdateDialpadContact(candidate, env);
    console.log('Dialpad contact created/updated:', dialpadResult);

    // Write debounce flag to KV to prevent loop (60s TTL)
    const syncKey = `sync:RF${candidate.id}`;
    await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });
    console.log('Set sync debounce flag:', syncKey);
  } catch (error) {
    console.error('Failed to sync candidate to Dialpad:', error);
    throw error;
  }
}

function validateCandidateForDialpad(candidate) {
  const validation = {
    hasName: !!(candidate.first_name && candidate.last_name) || !!candidate.name,
    hasOrganization: !!candidate.current_organization,
    hasTitle: !!candidate.current_title,
    isValidForSync: false
  };

  // Require at least name and email for Dialpad contact creation
  validation.isValidForSync = validation.hasName && validation.hasOrganization && validation.hasTitle;

  return validation;
}
