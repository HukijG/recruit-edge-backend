/**
 * Dialpad webhook handlers — the Dialpad → RF direction.
 *
 * Org-wide contact updates (update-only back into RF), call events feeding
 * cold-call detection, and the extension-calls webhook that is the single
 * writer of the ExtCallState Durable Object.
 */

import { verifyJWT } from '../auth.js';
import { cacheCandidate, getCachedCandidate } from '../cache.js';
import { routeHangupToArbiter, signalTranscriptToArbiter } from '../cold-call-arbiter.js';
import { processCallEvent } from '../cold-call.js';
import { processExtensionCallEvent } from '../extension-calls.js';
import {
  extractRFIdFromDialpadContact,
  updateRFCandidate,
  convertDialpadContactToRFUpdate,
  getRFCandidate,
  RFContactConflictUnresolvedError,
} from '../rf-client.js';
import { trace } from '@opentelemetry/api';

export async function handleDialpadWebhook(request, env) {
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

    trace.getActiveSpan()?.setAttribute('dialpad.event_type', payload.event || 'unknown');

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

    // updateRFCandidate auto-resolves phone/email uniqueness conflicts (strips the
    // value from a stale duplicate, then retries). A genuinely unresolvable
    // conflict is non-fatal here — log and stop rather than 500-looping the
    // Dialpad webhook (a retry won't find the missing owner). Transient/other
    // errors still propagate to the outer catch for legitimate retry.
    try {
      await updateRFCandidate(rfCandidateId, updateData, env);
    } catch (error) {
      if (error instanceof RFContactConflictUnresolvedError) {
        console.error({ message: `[Dialpad] RF update unresolved contact conflict (non-fatal) candidate=${rfCandidateId}: ${error.message}`, source: 'dialpad', candidateId: rfCandidateId });
        return;
      }
      throw error;
    }
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

  } catch (error) {
    console.error({ message: `[Dialpad] sync error candidate=${rfCandidateId}: ${error.message}`, source: 'dialpad', candidateId: rfCandidateId });
    throw error;
  }
}

export async function handleDialpadCallWebhook(request, env) {
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

    trace.getActiveSpan()?.setAttribute('dialpad.event_type', payload.state || 'unknown');

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

    const state = payload.state;

    // Cancelled (never-connected) outbound calls produce no transcript, so the
    // classification flow never sees them. Route the hangup to the per-call
    // ColdCallArbiter DO, which records it as a cancelled cold call after a grace
    // window — unless a transcript for the same call supersedes it first.
    if (state === 'hangup') {
      let arb = { armed: false, reason: 'error' };
      try {
        arb = await routeHangupToArbiter(payload, env);
      } catch (err) {
        // Missing one cancelled is low-stakes; don't 500 (avoids retry storms).
        console.error({ message: `[Dialpad/calls] hangup arbiter failed: ${err.message}`, source: 'dialpad-calls', callId: payload.call_id });
      }
      // Surface armed-vs-suppressed on the webhook span (the suppressed/armed
      // decision for a call that never finalizes is otherwise console-only).
      trace.getActiveSpan()?.setAttribute('coldcall.arbiter_state', arb.state || arb.reason || 'error');
      console.log({
        message: `[Dialpad/calls] → hangup ${arb.armed ? 'armed cancelled-call grace' : `ignored (${arb.reason || arb.state})`}`,
        source: 'dialpad-calls', callId: payload.call_id, armed: arb.armed, reason: arb.reason, arbiterState: arb.state,
      });
      return new Response('Call webhook processed', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // A transcript for this call means it reached transcription → tell the
    // arbiter so any pending cancelled for the same call is suppressed
    // (transcript always wins). Secondary to the classification below — a DO
    // hiccup must not block it.
    if (state === 'transcription' || state === 'call_transcription') {
      try {
        await signalTranscriptToArbiter(payload, env);
      } catch (err) {
        console.error({ message: `[Dialpad/calls] transcript arbiter signal failed: ${err.message}`, source: 'dialpad-calls', callId: payload.call_id });
      }
    }

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

export async function handleDialpadExtensionCallsWebhook(request, env, ctx) {
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

    trace.getActiveSpan()?.setAttribute('dialpad.event_type', payload.state || 'unknown');

    const result = await processExtensionCallEvent(payload, env, ctx);

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
