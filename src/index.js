// RF-Dialpad Sync Middleware - Main Worker Entry Point
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

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route requests
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
    // RF uses custom headers for auth (e.g., API tokens) - no webhook secret needed
    // Authentication will be configured in the RF webhook setup
    
    const payload = await request.json();
    const candidate = payload.candidate;
    
    console.log('RF webhook received:', {
      eventTime: payload.event_time,
      candidateId: candidate.id,
      name: candidate.name,
      hasPhone: !!candidate.phone_number && candidate.phone_number !== "",
      hasEmail: !!candidate.email || !!candidate.email_1,
      organization: candidate.current_organization,
      title: candidate.current_title
    });

    // Check if candidate has data worth syncing to Dialpad
    const hasContactInfo = (candidate.phone_number && candidate.phone_number !== "") || 
                          candidate.email || candidate.email_1;
    
    if (!hasContactInfo) {
      console.log('Candidate has no phone or email - skipping sync');
      return new Response(JSON.stringify({ 
        success: true,
        message: 'Candidate skipped - no contact info',
        candidateId: candidate.id 
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // TODO: Add Dialpad API integration here
    console.log('Would sync to Dialpad:', {
      name: candidate.name,
      phone: candidate.phone_number,
      email: candidate.email || candidate.email_1,
      company: candidate.current_organization,
      title: candidate.current_title
    });

    return new Response(JSON.stringify({ 
      success: true,
      message: 'RF webhook processed successfully',
      candidateId: candidate.id,
      action: 'ready_for_dialpad_sync'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('RF webhook error:', error);
    return new Response(JSON.stringify({ 
      error: 'Processing failed',
      message: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleDialpadWebhook(request, env) {
  try {
    const body = await request.text();
    
    // Verify JWT signature from Dialpad
    const payload = await verifyJWT(body, env.DIALPAD_WEBHOOK_SECRET);
    if (!payload) {
      console.error('Dialpad JWT verification failed');
      return new Response('Unauthorized', { status: 401 });
    }

    console.log('Dialpad webhook received:', {
      event: payload.event,
      contactId: payload.contact?.id,
      contactName: payload.contact?.display_name
    });

    // TODO: Add actual sync logic here
    return new Response(JSON.stringify({ 
      success: true,
      message: 'Dialpad webhook processed successfully',
      event: payload.event 
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Dialpad webhook error:', error);
    return new Response(JSON.stringify({ 
      error: 'Processing failed',
      message: error.message 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}