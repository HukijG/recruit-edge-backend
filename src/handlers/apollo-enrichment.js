/**
 * Apollo enrichment — async webhook + apply step.
 *
 * Enrichment is kicked off elsewhere (candidate flows); Apollo calls back
 * here with the enriched person, which is merged into RF (arrays merged,
 * never replaced — RF /candidate/update REPLACES arrays).
 */

import { cacheCandidate, getCachedCandidate, invalidateCandidateDetailsCache } from '../cache.js';
import { patchDialpadContact, getDialpadContact } from '../dialpad-client.js';
import { buildPhoneOrder, digitsOnly } from '../phone-merge.js';
import { updateRFCandidate, getRFCandidate } from '../rf-client.js';
import { trace } from '@opentelemetry/api';

/**
 * Apply an Apollo phone-reveal webhook: merge all desirable numbers into both RF and
 * Dialpad in one ranked best-first order (`buildPhoneOrder`, pure). This function owns
 * the I/O.
 *
 * There is deliberately NO waterfall re-run: Apollo always runs its own DB first and
 * short-circuits the rest (`request_already_fulfilled`), so a re-reveal can never reach
 * ContactOut — verified 2026-06-22 (investigation report § 6b). `run_waterfall_phone`
 * still helps via the pass-1 fall-through when Apollo has no number.
 *
 * Returns `{ ok }` — `ok:false` when an intended RF/Dialpad write threw, so the caller
 * can reply non-2xx and let Apollo retry the webhook. Retry is self-healing: the
 * per-system sequence-skip below re-attempts only the side that's still out of date.
 *
 * @param {string} rfId
 * @param {Object} person - payload.people[0] ({ id, phone_numbers })
 * @param {Object} env
 * @returns {Promise<{ ok: boolean }>}
 */
async function applyApolloEnrichment(rfId, person, env) {
  const apolloEntries = Array.isArray(person?.phone_numbers) ? person.phone_numbers : [];

  // Existing numbers from BOTH systems — so the two never diverge and manual numbers
  // survive. Keep them as their ORIGINAL strings (do not normalize/drop): a real number
  // RF stored in a non-E.164 shape must not be silently lost when we rewrite the array.
  const currentCandidate = await getRFCandidate(rfId, env);
  const rfExisting = (Array.isArray(currentCandidate?.phone_number) ? currentCandidate.phone_number : [])
    .map(p => (typeof p === 'string' ? p : p?.phone_number))
    .filter(n => typeof n === 'string' && n.trim() !== '');

  let dialpadContact = null;
  try {
    dialpadContact = await getDialpadContact(rfId, env);
  } catch (err) {
    console.error({ message: `[Apollo] Dialpad GET failed (non-fatal): ${err.message}`, source: 'apollo', rfId });
  }
  const dpExisting = (Array.isArray(dialpadContact?.phones) ? dialpadContact.phones : [])
    .map(n => (typeof n === 'string' ? n : ''))
    .filter(n => n.trim() !== '');

  const existingNumbers = [...rfExisting, ...dpExisting];

  const { ordered, droppedUnnormalizable } = buildPhoneOrder({ existingNumbers, apolloEntries });

  if (droppedUnnormalizable.length) {
    console.warn({ message: `[Apollo] dropped un-normalizable number(s) rfId=${rfId}`, source: 'apollo', rfId, count: droppedUnnormalizable.length });
  }

  // Write the full ordered set to each system only when its current sequence differs
  // (idempotent across Apollo's webhook retries). A write that throws flips its flag so
  // the caller can 500 → Apollo retries and the sequence-skip re-attempts only the
  // still-stale side (self-healing, no divergence).
  const newSeq = ordered.map(digitsOnly).join('|');
  const rfSeq = rfExisting.map(digitsOnly).join('|');
  const dpSeq = dpExisting.map(digitsOnly).join('|');
  let rfWriteFailed = false;
  let dpWriteFailed = false;

  if (ordered.length && newSeq !== rfSeq) {
    // updateRFCandidate auto-resolves phone-uniqueness 409s.
    try {
      await updateRFCandidate(rfId, { phone_number: ordered.map(n => ({ phone_number: n, type: 1 })) }, env);
      await env.SYNC_STATE.put(`sync:RF${rfId}`, 'true', { expirationTtl: 60 });
    } catch (error) {
      rfWriteFailed = true;
      console.error({ message: `[Apollo] RF update failed (will retry) rfId=${rfId}: ${error.message}`, source: 'apollo', rfId, parity: 'rf_write_failed' });
    }
  }
  if (ordered.length && newSeq !== dpSeq) {
    try {
      await patchDialpadContact(rfId, { phones: ordered }, env);
    } catch (dialpadErr) {
      dpWriteFailed = true;
      console.error({ message: `[Apollo] Dialpad patch failed (will retry) rfId=${rfId}: ${dialpadErr.message}`, source: 'apollo', rfId, parity: 'dialpad_write_failed' });
    }
  }
  const writeFailed = rfWriteFailed || dpWriteFailed;

  // Refresh caches so a freshly-enriched number shows up immediately. Invalidate the
  // details/activities snapshot (the /candidate-details fast path) unconditionally so the
  // next read repulls live RF. Only update the canonical record's phone string when the RF
  // write didn't fail — otherwise the cache would briefly advertise a number RF doesn't yet
  // have. `ordered[0]` is intentionally the manual-first number (manual-stays-at-top rule);
  // the dial target the extension uses is the RF/Dialpad array[0], not this snapshot field.
  await invalidateCandidateDetailsCache(rfId, env);
  if (!rfWriteFailed) {
    const cached = await getCachedCandidate(rfId, env);
    if (cached) {
      await cacheCandidate({ ...cached, phone_number: ordered[0] || cached.phone_number || '' }, env);
    }
  }

  // Decision attributes on the active (webhook) span — makes the enrichment outcome
  // queryable in the trace alongside the auto-instrumented RF/Dialpad/Apollo fetch spans.
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('apollo.rf_id', String(rfId));
    span.setAttribute('apollo.stored', ordered.length);
    if (droppedUnnormalizable.length) span.setAttribute('apollo.dropped_unnormalizable', droppedUnnormalizable.length);
    if (writeFailed) span.setAttribute('apollo.write_failed', true);
  }

  console.log({
    message: `[Apollo] applied rfId=${rfId} stored=${ordered.length}`,
    source: 'apollo', rfId, stored: ordered.length,
  });

  return { ok: !writeFailed };
}

export async function handleApolloWebhook(request, env, url) {
  try {
    const webhookSecret = env.APOLLO_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error({ message: '[Apollo] secret not configured', source: 'apollo' });
      return new Response('Unauthorized', { status: 401 });
    }
    const token = url.searchParams.get('token');
    if (!token || token !== webhookSecret) {
      return new Response('Unauthorized', { status: 401 });
    }

    const rfId = url.searchParams.get('rfId');
    if (!rfId) {
      return new Response('Bad Request — missing rfId', { status: 400 });
    }

    const payload = await request.json();

    // Apollo webhook sends { people: [{ id, phone_numbers, status }] }
    const person = payload.people?.[0];

    console.log({
      message: `[Apollo] raw webhook payload`,
      source: 'apollo',
      rfId,
      rawPayload: JSON.stringify(payload),
    });

    // No KV "pending context" gate here, on purpose. Apollo delivers the phone-reveal
    // webhook asynchronously with an unbounded delay (observed 12s to ~46min) — far
    // longer than any short-lived flag we'd keep. The reveal is authenticated by the URL
    // token and fully self-describing (rfId from the URL we built + phones from the
    // payload), so we ALWAYS deliver to RF + Dialpad regardless of when it lands. The
    // `apollo_enrich:${rfId}` flag stays a request-time dedup guard only (so we don't
    // re-spend Apollo credits); it intentionally does not gate delivery. Idempotency
    // across Apollo's webhook retries comes from applyApolloEnrichment's per-system
    // digit-set sequence-skip (it only writes a side whose current numbers differ).

    // A truly empty payload (no phone_numbers at all) has nothing to merge and no
    // context worth fetching — short-circuit.
    const phoneNumbers = person?.phone_numbers;
    if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
      console.log({ message: `[Apollo] → no phone numbers in payload`, source: 'apollo', rfId });
      return new Response('OK', { status: 200 });
    }

    const { ok } = await applyApolloEnrichment(rfId, person, env);
    return new Response(ok ? 'OK' : 'Write failed — retry', { status: ok ? 200 : 500 });

  } catch (error) {
    // Inline the actual error into the message so it surfaces in CF Logs metadata.
    // Structured `error: error.message` field is not indexed and stays invisible.
    console.error({ message: `[Apollo] error: ${error.message}`, source: 'apollo', stack: error.stack });
    return new Response('Internal Server Error', { status: 500 });
  }
}
