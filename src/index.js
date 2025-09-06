import { verifyJWT } from './auth.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-RF-Webhook-Token',
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
      
      if (url.pathname === '/webhook/dialpad' && request.method === 'POST') {
        return await handleDialpadWebhook(request, env);
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
    
    const payload = await request.json();
    
    console.log('RF webhook received:', {
      eventTime: payload.event_time,
      candidateId: payload.candidate.id,
      candidateName: payload.candidate.name,
      hasEmail: !!payload.candidate.email && payload.candidate.email !== "",
      hasPhone: !!payload.candidate.phone_number && payload.candidate.phone_number !== "",
      linkedinProfile: payload.candidate.linkedin_profile,
      currentOrg: payload.candidate.current_organization,
      currentTitle: payload.candidate.current_title,
      addedBy: payload.candidate.added_by.name,
      source: payload.candidate.source
    });

    // Process the candidate data
    await processCandidateData(payload.candidate, env);
    
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

async function processCandidateData(candidate, env) {
  console.log('Processing candidate:', {
    id: candidate.id,
    name: candidate.name,
    organization: candidate.current_organization,
    title: candidate.current_title,
    hasContactInfo: !!(candidate.email || candidate.phone_number),
    linkedinProfile: candidate.linkedin_profile
  });

  // For now, just log the candidate data
  // TODO: Add Dialpad contact creation logic here
  
  // Validate required fields for future Dialpad sync
  const validation = validateCandidateForDialpad(candidate);
  console.log('Candidate validation for Dialpad sync:', validation);
  
  // Store any additional processing logic here
  console.log('Candidate processing completed');
}

function validateCandidateForDialpad(candidate) {
  const validation = {
    hasName: !!(candidate.first_name && candidate.last_name) || !!candidate.name,
    hasEmail: !!candidate.email && candidate.email !== "",
    hasPhone: !!candidate.phone_number && candidate.phone_number !== "",
    hasLinkedIn: !!candidate.linkedin_profile,
    hasOrganization: !!candidate.current_organization,
    hasTitle: !!candidate.current_title,
    isValidForSync: false
  };

  // Determine if candidate is ready for Dialpad sync
  // For now, require at least name and either email or phone
  validation.isValidForSync = validation.hasName && (validation.hasEmail || validation.hasPhone);
  
  return validation;
}

async function handleDialpadWebhook(request, env) {
  try {
    const payload = await request.json();
    
    console.log('Dialpad webhook received:', {
      eventType: payload.event_type,
      timestamp: new Date().toISOString()
    });
    
    // Placeholder for future Dialpad webhook processing
    
    return new Response('Dialpad webhook received', { status: 200 });
    
  } catch (error) {
    console.error('Dialpad webhook error:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}