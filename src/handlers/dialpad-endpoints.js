/**
 * Extension telephony endpoints — user context, call initiation, SMS,
 * hangup, and the call-state poll backed by the ExtCallState DO
 * (strict read-after-write; the DO is written only by the
 * extension-calls webhook).
 */

import { signCallerIdAlias, verifyCallerIdAlias } from '../dialpad-aliases.js';
import {
  getUserCallerId,
  initiateCall,
  buildCallerIdsFromDialpad,
  sendSMS,
  hangupCall,
} from '../dialpad-client.js';
import { checkAndRecordCall } from '../rate-limit.js';
import { getUserByFirstName } from '../users.js';
import { trace } from '@opentelemetry/api';

export async function handleDialpadUserContextEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    let user = auth?.user ?? null;
    let consultantFirstName;
    if (user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = user.firstName;
    } else {
      // Legacy path: preserve today's 400 on missing, 403 on unknown.
      consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName.trim() : '';

      if (!consultantFirstName) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
          status: 400, headers: responseHeaders,
        });
      }

      user = await getUserByFirstName(env, consultantFirstName);
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
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName);

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

export async function handleDialpadCallEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const phoneNumber = typeof payload.phoneNumber === 'string' ? payload.phoneNumber.trim() : '';
    const callerAliasId = typeof payload.callerAliasId === 'string' ? payload.callerAliasId.trim() : '';

    let user = auth?.user ?? null;
    let consultantFirstName;
    if (user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = user.firstName;
    } else {
      // Legacy path: preserve today's 400 on missing, 403 on unknown.
      consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName.trim() : '';

      if (!consultantFirstName) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
          status: 400, headers: responseHeaders,
        });
      }

      user = await getUserByFirstName(env, consultantFirstName);
      if (!user) {
        return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
          status: 403, headers: responseHeaders,
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName);

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

export async function handleDialpadSmsEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const phoneNumber = typeof payload.phoneNumber === 'string' ? payload.phoneNumber.trim() : '';
    // Do NOT trim text — recruiters typed it deliberately, including any
    // leading/trailing whitespace. Only reject if it's empty after trim.
    const text = typeof payload.text === 'string' ? payload.text : '';
    // callerAliasId is optional — empty/missing means "use Dialpad default".
    const callerAliasId = typeof payload.callerAliasId === 'string' ? payload.callerAliasId.trim() : '';

    let user = auth?.user ?? null;
    let consultantFirstName;
    if (user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = user.firstName;
    } else {
      // Legacy path: preserve today's 400 on missing, 403 on unknown.
      consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName.trim() : '';

      if (!consultantFirstName) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
          status: 400, headers: responseHeaders,
        });
      }

      user = await getUserByFirstName(env, consultantFirstName);
      if (!user) {
        return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
          status: 403, headers: responseHeaders,
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName);

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

export async function handleDialpadHangupEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    let user = auth?.user ?? null;
    let consultantFirstName;
    if (user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = user.firstName;
    } else {
      // Legacy path: preserve today's 400 on missing, 403 on unknown.
      consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName.trim() : '';

      if (!consultantFirstName) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
          status: 400, headers: responseHeaders,
        });
      }

      user = await getUserByFirstName(env, consultantFirstName);
      if (!user) {
        return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
          status: 403, headers: responseHeaders,
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName);

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

export async function handleExtensionCallStatusEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    let user = auth?.user ?? null;
    let consultantFirstName;
    if (user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = user.firstName;
    } else {
      // Legacy path: preserve today's 400 on missing, 403 on unknown.
      consultantFirstName = typeof payload.consultantFirstName === 'string'
        ? payload.consultantFirstName.trim()
        : '';

      if (!consultantFirstName) {
        return new Response(JSON.stringify({ ok: false, error: 'Missing "consultantFirstName"' }), {
          status: 400, headers: responseHeaders,
        });
      }

      user = await getUserByFirstName(env, consultantFirstName);
      if (!user) {
        return new Response(JSON.stringify({ ok: false, error: 'Consultant not found' }), {
          status: 403, headers: responseHeaders,
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName);

    // Strongly-consistent read via the per-user Durable Object. The
    // webhook is the only thing that sets/clears the stored call_id;
    // this endpoint never writes.
    const stub = env.EXT_CALL_STATE.get(env.EXT_CALL_STATE.idFromName(user.dialpadId));
    const callId = await stub.getCallId();

    if (callId) {
      return new Response(JSON.stringify({ state: 'in_progress' }), {
        status: 200, headers: responseHeaders,
      });
    }

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
