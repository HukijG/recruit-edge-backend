import { createOrUpdateDialpadContact } from './dialpad-client.js';
import { verifyJWT } from './auth.js';
import { extractRFIdFromDialpadContact, updateRFCandidate, convertDialpadContactToRFUpdate } from './rf-client.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RF-Webhook-Token, RF-Event-Type, Authorization',
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

  } catch (error) {
    console.error('Failed to sync Dialpad contact to RF:', {
      rfCandidateId,
      error: error.message,
      contact: contact
    });
    throw error;
  }
}

// Phase 1: Dummy calendar webhook handler — logs full payload for testing Apps Script delivery.
// Will be replaced with auth + validation + processing in Phase 2/3.
async function handleCalendarWebhook(request, env) {
  try {
    const payload = await request.json();

    console.log('Calendar webhook received — full payload:', JSON.stringify(payload, null, 2));
    console.log('Calendar webhook fields:', {
      event_id: payload.event_id,
      event_title: payload.event_title,
      event_start: payload.event_start,
      attendee_email: payload.attendee_email,
      attendee_name: payload.attendee_name,
      linkedin_answer: payload.linkedin_answer,
    });

    return new Response(JSON.stringify({
      status: 'received',
      payload
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Calendar webhook error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
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
