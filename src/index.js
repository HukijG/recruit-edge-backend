import { createOrUpdateDialpadContact } from './dialpad-client.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RF-Webhook-Token, RF-Event-Type',
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
        return await handleRecriterflowWebhook(request, env);
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

async function handleRecriterflowWebhook(request, env) {
  try {
    // Verify webhook signature if needed
    const webhookSecret = env.RF_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = request.headers.get('X-RF-Webhook-Token');
      if (!signature || signature !== webhookSecret) {
        console.log('Webhook signature verification failed');
        return new Response('Unauthorized', { status: 401 });
      }
    }

    // Get event type from custom header
    const eventType = request.headers.get('RF-Event-Type');
    console.log('RF Event Type:', eventType);
    
    const payload = await request.json();
    
    console.log('RF webhook received:', {
      eventType,
      eventTime: payload.event_time,
      candidateId: payload.candidate.id,
      candidateName: payload.candidate.name,
      hasEmail: !!payload.candidate.email && payload.candidate.email !== "",
      hasPhone: !!payload.candidate.phone_number && payload.candidate.phone_number !== "",
      linkedinProfile: payload.candidate.linkedin_profile,
      currentOrg: payload.candidate.current_organization,
      currentTitle: payload.candidate.current_title
    });

    // Process based on event type
    if (eventType === 'Created') {
      await processNewCandidate(payload.candidate, env);
    } else {
      console.log('Unhandled event type:', eventType);
    }
    
    return new Response('Webhook processed successfully', { 
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    console.error('RF webhook error:', error);
    return new Response(JSON.stringify({ 
      error: 'Internal Server Error',
      message: error.message 
    }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function processNewCandidate(candidate, env) {
  console.log('Processing new candidate for Dialpad sync:', {
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
  } catch (error) {
    console.error('Failed to sync candidate to Dialpad:', error);
    throw error;
  }
}

function validateCandidateForDialpad(candidate) {
  const validation = {
    hasName: !!(candidate.first_name && candidate.last_name) || !!candidate.name,
    hasEmail: !!candidate.email && candidate.email !== "",
    hasPhone: !!candidate.phone_number && candidate.phone_number !== "",
    hasOrganization: !!candidate.current_organization,
    hasTitle: !!candidate.current_title,
    isValidForSync: false
  };

  // Require at least name and email for Dialpad contact creation
  validation.isValidForSync = validation.hasName && validation.hasEmail;
  
  return validation;
}