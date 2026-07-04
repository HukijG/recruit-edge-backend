/**
 * Cold-call internal routes — the arbiter's async callback for finalizing
 * cancelled calls, and the test-harness route.
 */

import { processCallEvent, finalizeCancelledColdCall } from '../cold-call.js';
import { timingSafeEqual } from '../lib/timing-safe-equal.js';
import { trace } from '@opentelemetry/api';

/**
 * POST /internal/coldcall/finalize-cancelled — internal-only (X-Internal-Token).
 * Called by the ColdCallArbiter DO via the SELF binding once a cancelled call's
 * grace window elapses with no transcript. Runs inside the worker's instrumented
 * fetch handler so the mechanical finalize is fully traced and span-linked back
 * to the originating webhook (via the _otel_trace param in the callback URL).
 */
export async function handleColdCallFinalizeCancelled(request, env) {
  const presented = request.headers.get('X-Internal-Token');
  if (!env.INTERNAL_SECRET || !presented || !timingSafeEqual(presented, env.INTERNAL_SECRET)) {
    return new Response(JSON.stringify({ ok: false, error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  try {
    const payload = await request.json();
    if (payload?.callId != null) trace.getActiveSpan()?.setAttribute('coldcall.call_id', String(payload.callId));
    const result = await finalizeCancelledColdCall(payload, env);
    console.log({ message: `[ColdCall/cancelled] finalize: ${result.reason}`, source: 'cold-call-finalize', callId: payload?.callId, recorded: result.recorded, reason: result.reason });
    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error({ message: `[ColdCall/cancelled] finalize error: ${error.message}`, source: 'cold-call-finalize', stack: error.stack });
    return new Response(JSON.stringify({ ok: false, error: 'Internal Server Error' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}

export async function handleTestColdCall(request, env, url) {
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
