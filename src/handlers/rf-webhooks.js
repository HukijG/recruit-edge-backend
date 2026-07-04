/**
 * Recruiterflow webhook handlers — the RF → Dialpad direction.
 *
 * Candidate create/update events from RF land here (plus the manual re-sync
 * route) and drive Dialpad contact sync via syncCandidateToDialpad.
 */

import { cacheCandidate } from '../cache.js';
import { isJoelCandidate, enrichCandidate } from '../enrichment.js';
import { getRFCandidate } from '../rf-client.js';
import { getUserByFirstName } from '../users.js';
import { trace } from '@opentelemetry/api';
import { syncCandidateToDialpad } from './dialpad-sync.js';

export async function handleRecruiterflowWebhook(request, env) {
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
    trace.getActiveSpan()?.setAttribute('rf.event_type', eventType || 'unknown');
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
      await syncCandidateToDialpad(candidate, env);
      await cacheCandidate(candidate, env);

      // Apollo enrichment on Created events only, for Joel's candidates
      // Runs AFTER Dialpad sync — enrichment updates RF + Dialpad independently if it finds better data
      if (eventType === 'Created') {
        try {
          const fullCandidate = await getRFCandidate(candidate.id, env);
          const joel = await getUserByFirstName(env, 'Joel');
          if (joel && isJoelCandidate(fullCandidate, joel.rfUserId)) {
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

export async function handleManualRFWebhook(request, env, url) {
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

    trace.getActiveSpan()?.setAttribute('rf.event_type', 'manual');

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
    await syncCandidateToDialpad(candidate, env);
    await cacheCandidate(candidate, env);

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
