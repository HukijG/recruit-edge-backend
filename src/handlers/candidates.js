/**
 * Extension candidate flows — add candidate, add-to-job, mark-invalid,
 * candidate details (with neighbor prewarm).
 *
 * Matching is RF-first (never cache-first for new candidates); the KV
 * cache is reconciled after. See docs/architecture.md for the flow maps.
 */

import { enrichPerson } from '../apollo-client.js';
import {
  cacheCandidate,
  lookupByLinkedIn,
  cacheConsultantForJobLink,
  cacheCandidateDetails,
  getCachedCandidateDetails,
  cacheCandidateActivities,
  getCachedCandidateActivities,
  invalidateCandidateDetailsCache,
  appendToJobBatchIndex,
  getJobBatchIndex,
  getPrewarmState,
  setPrewarmState,
} from '../cache.js';
import { parseColdCallActivity, mergeTag } from '../cold-call.js';
import { patchDialpadContact, getDialpadContact } from '../dialpad-client.js';
import { buildApolloWebhookUrl, APOLLO_ENRICH_COOLDOWN_SEC } from '../enrichment.js';
import { OWNER_EMAIL } from '../krisp.js';
import { makeAsyncCallbackUrl } from '../lib/trace-link.js';
import { getMissedColdCallsForCandidate } from '../mcp/d1-read.js';
import {
  updateRFCandidate,
  getRFCandidate,
  searchRFCandidateByLinkedIn,
  addRFCandidate,
  listOpenJobs,
  addCandidateToJob,
  setJobCandidateConsultantId,
  listCandidateActivities,
  normalizeToE164,
  pickConsultantJob,
  prewarmCandidatesIfMissing,
} from '../rf-client.js';
import { resolveRFUserId, getUserByEmail } from '../users.js';
import { trace } from '@opentelemetry/api';
import { syncCandidateToDialpad } from './dialpad-sync.js';

/**
 * Handle a candidate that's already in RF: ensure Dialpad contact exists,
 * patch company/title if it does, and request Apollo phone reveal if needed.
 * Called both when search finds an existing record AND when /candidate/add
 * returns 409 (LinkedIn already exists).
 */
async function processExistingRFCandidate(existing, ext, label, env) {
  const rfId = existing.id;
  const currentExp = ext.experience?.find(e => e.isCurrent);
  const nameParts = ext.fullName.trim().split(/\s+/);

  let dialpadContact = null;
  try {
    dialpadContact = await getDialpadContact(rfId, env);
  } catch (error) {
    console.error({ message: `[Candidates] ${label} — Dialpad GET failed: ${error.message}`, source: 'candidates-endpoint' });
  }

  let dialpadSynced = false;

  if (!dialpadContact) {
    // Not in Dialpad — full creation with all available fields
    const fullCandidate = await getRFCandidate(rfId, env);

    let primaryEmail = '';
    if (Array.isArray(fullCandidate.email) && fullCandidate.email.length > 0) {
      const primary = fullCandidate.email.find(e => e.is_primary === 1);
      primaryEmail = primary ? primary.email : (fullCandidate.email[0]?.email || '');
    }
    let phoneStr = '';
    if (Array.isArray(fullCandidate.phone_number) && fullCandidate.phone_number.length > 0) {
      phoneStr = fullCandidate.phone_number[0]?.phone_number || '';
    }

    const rfCandidate = {
      id: rfId,
      first_name: nameParts[0] || fullCandidate.first_name || '',
      last_name: nameParts.slice(1).join(' ') || fullCandidate.last_name || '',
      name: ext.fullName,
      current_organization: currentExp?.company || fullCandidate.current_organization || '',
      current_title: currentExp?.title || fullCandidate.current_title || '',
      linkedin_profile: ext.linkedinUrl || fullCandidate.linkedin_profile || '',
      email: primaryEmail,
      phone_number: phoneStr,
    };

    dialpadSynced = await syncCandidateToDialpad(rfCandidate, env);
    await cacheCandidate(rfCandidate, env);
  } else {
    // Already in Dialpad — only update company name and job title
    const patchFields = {};
    if (currentExp?.company) patchFields.company_name = currentExp.company;
    if (currentExp?.title) patchFields.job_title = currentExp.title;

    if (Object.keys(patchFields).length > 0) {
      try {
        await patchDialpadContact(rfId, patchFields, env);
        // Set debounce flag — prevents Dialpad's "Updated" webhook from syncing
        // empty email/phone arrays back to RF and clearing existing data
        await env.SYNC_STATE.put(`sync:RF${rfId}`, 'true', { expirationTtl: 60 });
        dialpadSynced = true;
      } catch (error) {
        console.error({ message: `[Candidates] ${label} — Dialpad PATCH failed: ${error.message}`, source: 'candidates-endpoint' });
      }
    }
  }

  // Apollo phone enrichment — fire on EVERY extension add (not gated on "no Dialpad
  // phone"): the waterfall may surface a better number even when one already exists,
  // and the merge engine preserves existing numbers. The 120s `apollo_enrich:` flag is
  // kept purely as a double-submit guard against rapid duplicate adds.
  let phoneRequested = false;

  if (ext.linkedinUrl) {
    const apolloFlag = await env.SYNC_STATE.get(`apollo_enrich:${rfId}`);
    if (!apolloFlag) {
      try {
        const apolloPerson = await enrichPerson({ linkedin_url: ext.linkedinUrl }, {}, env);
        if (apolloPerson) {
          const webhookUrl = makeAsyncCallbackUrl(buildApolloWebhookUrl(rfId, env), {});
          await enrichPerson({ id: apolloPerson.id }, { reveal_phone_number: true, run_waterfall_phone: true, webhook_url: webhookUrl }, env);
          await env.SYNC_STATE.put(`apollo_enrich:${rfId}`, JSON.stringify({
            apolloPersonId: apolloPerson.id,
            timestamp: new Date().toISOString(),
          }), { expirationTtl: APOLLO_ENRICH_COOLDOWN_SEC });
          phoneRequested = true;
        } else {
          await env.SYNC_STATE.put(`apollo_enrich:${rfId}`, JSON.stringify({
            noMatch: true,
            timestamp: new Date().toISOString(),
          }), { expirationTtl: APOLLO_ENRICH_COOLDOWN_SEC });
        }
      } catch (error) {
        console.error({ message: `[Candidates] ${label} — phone reveal failed (non-fatal): ${error.message}`, source: 'candidates-endpoint', rfId });
      }
    } else {
      console.log({ message: `[Candidates] ${label} — Apollo enrichment already attempted, skipping`, source: 'candidates-endpoint', rfId });
    }
  }

  return { fullName: ext.fullName, status: 'updated', rfId, dialpadSynced, phoneRequested };
}

/**
 * Process a single candidate from the extension batch.
 * Returns a result object — never throws (catches internally).
 */
async function processOneCandidate(ext, i, total, env, consultantRfUserId) {
  const label = `[${i + 1}/${total}] ${ext.fullName}`;
  try {
    // Search RF by LinkedIn URL — RF is authoritative, do not consult cache for matching.
    // (searchRFCandidateByLinkedIn filters out RF's substring-fuzzy matches and
    // returns only true slug-matches.)
    const existing = ext.linkedinUrl
      ? await searchRFCandidateByLinkedIn(ext.linkedinUrl, env)
      : null;

    // Reconcile cache against the authoritative RF result. If the cache had this
    // LinkedIn URL pointing at a different rfId, refreshing self-heals it for
    // every downstream lookup (calendar, krisp, etc.) that does trust the cache.
    if (ext.linkedinUrl) {
      const cachedId = await lookupByLinkedIn(ext.linkedinUrl, env);
      const rfIdStr = existing ? String(existing.id) : null;
      if (cachedId && cachedId !== rfIdStr) {
        console.warn({
          message: `[Candidates] ${label} — cache stale for LinkedIn URL: cached rfId=${cachedId}, RF says ${rfIdStr || 'no match'}. Refreshing.`,
          source: 'candidates-endpoint',
          staleCachedId: cachedId,
          actualRfId: rfIdStr,
          linkedinUrl: ext.linkedinUrl,
        });
      }
      if (existing) {
        // Always re-cache the authoritative record so the LinkedIn → rfId index
        // and the canonical record:{rfId} blob match what RF currently has.
        await cacheCandidate(existing, env);
      }
    }

    if (existing) {
      return await processExistingRFCandidate(existing, ext, label, env);
    }

    // Map extension payload → RF candidate/add format
    const rfPayload = mapExtensionToRFCandidate(ext, consultantRfUserId);

    // Create in RF
    let rfResult;
    try {
      rfResult = await addRFCandidate(rfPayload, env);
    } catch (err) {
      // RF returns 409 when a candidate with this LinkedIn URL already exists.
      // The error body looks like: 409 - {"data":{"id":50615},"message":"..."}
      // Recover by treating this as an existing candidate — fetch + run the
      // already-in-RF path so Dialpad still gets updated.
      const m = err.message?.match(/409.*"id":\s*(\d+)/);
      if (m) {
        const existingId = parseInt(m[1], 10);
        console.warn({
          message: `[Candidates] ${label} — RF /candidate/add returned 409 (already exists), recovering with rfId=${existingId}`,
          source: 'candidates-endpoint',
          rfId: existingId,
        });
        const fetched = await getRFCandidate(existingId, env);
        return await processExistingRFCandidate(fetched, ext, label, env);
      }
      throw err;
    }
    const rfId = rfResult?.data?.id;

    if (!rfId) {
      console.error({
        message: `[Candidates] ${label} — RF add returned no ID`,
        source: 'candidates-endpoint',
        rfResult,
      });
      return { fullName: ext.fullName, status: 'error', reason: 'no_rf_id', rfResult };
    }

    // Build candidate for Dialpad sync + cache from extension data directly
    // No need to GET from RF — new candidates won't have email/phone yet
    const currentExp = ext.experience?.find(e => e.isCurrent);
    const nameParts = ext.fullName.trim().split(/\s+/);

    const rfCandidate = {
      id: rfId,
      first_name: nameParts[0] || '',
      last_name: nameParts.slice(1).join(' ') || '',
      name: ext.fullName,
      current_organization: currentExp?.company || '',
      current_title: currentExp?.title || '',
      linkedin_profile: ext.linkedinUrl || '',
      email: '',
      phone_number: '',
    };

    // Sync to Dialpad (creates contact with uid=RF{id} + sets debounce)
    const synced = await syncCandidateToDialpad(rfCandidate, env);
    await cacheCandidate(rfCandidate, env);

    // Apollo phone reveal — LinkedIn URL is already correct from the extension,
    // just look up the person and request phone. No verification/fallback/LinkedIn correction.
    let phoneRequested = false;
    if (rfCandidate.linkedin_profile && !rfCandidate.phone_number) {
      try {
        const apolloPerson = await enrichPerson({ linkedin_url: rfCandidate.linkedin_profile }, {}, env);
        if (apolloPerson) {
          const webhookUrl = makeAsyncCallbackUrl(buildApolloWebhookUrl(rfId, env), {});
          await enrichPerson({ id: apolloPerson.id }, { reveal_phone_number: true, run_waterfall_phone: true, webhook_url: webhookUrl }, env);
          await env.SYNC_STATE.put(`apollo_enrich:${rfId}`, JSON.stringify({
            apolloPersonId: apolloPerson.id,
            timestamp: new Date().toISOString(),
          }), { expirationTtl: APOLLO_ENRICH_COOLDOWN_SEC });
          phoneRequested = true;
        }
      } catch (error) {
        console.error({ message: `[Candidates] ${label} — phone reveal failed (non-fatal): ${error.message}`, source: 'candidates-endpoint', rfId });
      }
    }

    return { fullName: ext.fullName, status: 'created', rfId, dialpadSynced: synced, phoneRequested };

  } catch (error) {
    console.error({
      message: `[Candidates] ${label} — error: ${error.message}`,
      source: 'candidates-endpoint',
      stack: error.stack,
    });
    return { fullName: ext.fullName, status: 'error', reason: error.message };
  }
}

export async function handleCandidatesEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();

    if (!payload.candidates || !Array.isArray(payload.candidates)) {
      return new Response(JSON.stringify({ error: 'Missing or invalid "candidates" array' }), {
        status: 400,
        headers: responseHeaders
      });
    }

    let consultantFirstName;
    let consultantRfUserId;
    if (auth?.user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = auth.user.firstName;
      consultantRfUserId = auth.user.rfUserId;
    } else {
      // Legacy path: preserve today's tolerance for missing/unknown firstName.
      consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName : '';
      consultantRfUserId = await resolveRFUserId(env, consultantFirstName);
      if (consultantFirstName && consultantRfUserId === null) {
        console.warn({
          message: `[Candidates] unknown consultantFirstName="${consultantFirstName}", attribution will be skipped`,
          source: 'candidates-endpoint',
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName || '');

    const total = payload.candidates.length;
    console.log({
      message: `[Candidates] Received batch of ${total} candidates (consultant=${consultantFirstName || 'none'})`,
      source: 'candidates-endpoint',
      count: total,
      consultantFirstName,
      consultantRfUserId,
    });

    // Process in chunks of 5 for speed, but wait for all chunks before responding
    const CHUNK_SIZE = 5;
    const results = [];
    for (let c = 0; c < payload.candidates.length; c += CHUNK_SIZE) {
      const chunk = payload.candidates.slice(c, c + CHUNK_SIZE);
      const chunkResults = await Promise.all(chunk.map((ext, j) =>
        processOneCandidate(ext, c + j, total, env, consultantRfUserId)
      ));
      results.push(...chunkResults);
    }

    const created = results.filter(r => r.status === 'created').length;
    const updated = results.filter(r => r.status === 'updated').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors = results.filter(r => r.status === 'error').length;

    console.log({
      message: `[Candidates] Batch complete: ${created} created, ${updated} updated, ${skipped} skipped, ${errors} errors`,
      source: 'candidates-endpoint',
      created,
      updated,
      skipped,
      errors,
    });

    // Fetch open jobs for the extension's job selector dropdown
    let jobs = [];
    try {
      jobs = await listOpenJobs(env);
    } catch (error) {
      console.error({ message: `[Candidates] Failed to fetch jobs: ${error.message}`, source: 'candidates-endpoint' });
    }

    return new Response(JSON.stringify({ total, created, updated, skipped, errors, results, jobs }), {
      status: 200,
      headers: responseHeaders
    });

  } catch (error) {
    console.error({ message: `[Candidates] Error: ${error.message}`, source: 'candidates-endpoint', stack: error.stack });
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500,
      headers: responseHeaders
    });
  }
}

/**
 * Map the LinkedIn extension payload to RF's POST /candidate/add format.
 */
function mapExtensionToRFCandidate(ext, consultantRfUserId) {
  const nameParts = ext.fullName.trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const currentExp = ext.experience?.find(e => e.isCurrent);

  const rfCandidate = {
    name: ext.fullName,
    linkedin_profile: ext.linkedinUrl || '',
    title: currentExp?.title || '',
    organization: currentExp?.company || '',
    source: 'linkedin',
    location: ext.location ? { location: ext.location } : undefined,
  };

  if (typeof consultantRfUserId === 'number') {
    rfCandidate.lead_owner_id = consultantRfUserId;
  }

  // Map experience entries
  if (ext.experience?.length > 0) {
    rfCandidate.experience = ext.experience.map(exp => ({
      organization: exp.company || '',
      designation: exp.title || '',
      from: exp.startYear ? ['1', String(exp.startYear)] : [],
      to: exp.isCurrent ? [] : (exp.endYear ? ['1', String(exp.endYear)] : []),
    }));
  }

  // Map education entries
  if (ext.education?.length > 0) {
    rfCandidate.education = ext.education.map(edu => ({
      school: edu.institution || '',
      degree: edu.degree || '',
      specialization: '',
      from: edu.startYear ? ['1', String(edu.startYear)] : [],
      to: edu.endYear ? ['1', String(edu.endYear)] : [],
    }));
  }

  return rfCandidate;
}

export async function handleAddToJobEndpoint(request, env, ctx, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const { rfIds, jobId } = payload;

    if (!Array.isArray(rfIds) || rfIds.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing or empty "rfIds" array' }), {
        status: 400, headers: responseHeaders
      });
    }
    if (!jobId) {
      return new Response(JSON.stringify({ error: 'Missing "jobId"' }), {
        status: 400, headers: responseHeaders
      });
    }

    let consultantFirstName;
    let consultantRfUserId;
    if (auth?.user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = auth.user.firstName;
      consultantRfUserId = auth.user.rfUserId;
    } else {
      // Legacy path: preserve today's tolerance for missing/unknown firstName.
      consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName : '';
      consultantRfUserId = await resolveRFUserId(env, consultantFirstName);
      if (consultantFirstName && consultantRfUserId === null) {
        console.warn({
          message: `[AddToJob] unknown consultantFirstName="${consultantFirstName}", consultant_id will not be written`,
          source: 'add-to-job',
        });
      }
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName || '');

    console.log({
      message: `[AddToJob] Adding ${rfIds.length} candidates to job ${jobId} (consultant=${consultantFirstName || 'none'})`,
      source: 'add-to-job',
      rfIds,
      jobId,
      consultantFirstName,
      consultantRfUserId,
    });

    const results = await Promise.all(rfIds.map(async (rfId) => {
      // Step 1: existing add-to-job with retry on 502
      let addResult = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // addCandidateToJob returns {status:'already_in_job'} for the expected
          // "already in pipeline" case (no throw) — treat it as a non-error here.
          const addRes = await addCandidateToJob(rfId, jobId, env);
          addResult = { rfId, status: addRes?.status === 'already_in_job' ? 'already_in_job' : 'added' };
          break;
        } catch (error) {
          if (error.message.includes('502') && attempt < 3) {
            console.log({ message: `[AddToJob] rfId=${rfId} → 502, retrying (${attempt}/2)`, source: 'add-to-job' });
            continue;
          }
          console.error({ message: `[AddToJob] rfId=${rfId} → job ${jobId} failed: ${error.message}`, source: 'add-to-job' });
          addResult = { rfId, status: 'error', reason: error.message };
          break;
        }
      }

      if (addResult === null) {
        addResult = { rfId, status: 'error', reason: 'retry loop exited without result' };
      }

      // Step 2: write consultant_id whenever the candidate is on the job and we have a
      // consultant. Re-adds (already_in_job) reattribute to the current caller — by design,
      // because the LinkedIn extension is the only path that hits this route and a recruiter
      // would only re-add a candidate they're now driving themselves. This also gives us a
      // simple cache-refresh mechanism: re-add a candidate to a job to populate the cache.
      const shouldWriteConsultant =
        (addResult.status === 'added' || addResult.status === 'already_in_job') &&
        consultantRfUserId !== null;

      if (shouldWriteConsultant) {
        try {
          await setJobCandidateConsultantId(rfId, jobId, consultantRfUserId, env);
          await cacheConsultantForJobLink(rfId, jobId, consultantRfUserId, env);
        } catch (error) {
          addResult.consultantWriteFailed = true;
          console.error({ message: `[AddToJob] rfId=${rfId} → consultant_id write failed: ${error.message}`, source: 'add-to-job' });
        }
      } else if (addResult.status === 'added' || addResult.status === 'already_in_job') {
        console.log({ message: `[AddToJob] rfId=${rfId} → job ${jobId} ${addResult.status} (no consultant attribution)`, source: 'add-to-job' });
      }

      // Append to the per-job batch index for both freshly-added rows AND
      // re-adds (the dedup inside appendToJobBatchIndex makes re-adds a no-op
      // for rfIds already in the list, but lets older candidates we never
      // tracked enter the index when re-added). The index drives the
      // /candidate-details neighbor-prewarming behavior.
      if (addResult.status === 'added' || addResult.status === 'already_in_job') {
        try {
          await appendToJobBatchIndex(jobId, rfId, env);
        } catch (error) {
          console.warn({ message: `[AddToJob] batch index append failed rfId=${rfId} job=${jobId}: ${error.message}`, source: 'add-to-job' });
        }
      }

      return addResult;
    }));

    const added = results.filter(r => r.status === 'added').length;
    const alreadyInJob = results.filter(r => r.status === 'already_in_job').length;
    const errors = results.filter(r => r.status === 'error').length;

    console.log({
      message: `[AddToJob] Done: ${added} added, ${alreadyInJob} already in job, ${errors} errors`,
      source: 'add-to-job',
      jobId,
      added,
      alreadyInJob,
      errors,
    });

    return new Response(JSON.stringify({ jobId, added, alreadyInJob, errors, results }), {
      status: 200, headers: responseHeaders
    });

  } catch (error) {
    console.error({ message: `[AddToJob] Error: ${error.message}`, source: 'add-to-job', stack: error.stack });
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders
    });
  }
}

export async function handleMarkInvalidEndpoint(request, env, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const rfId = payload.rfId;
    let consultantFirstName;
    if (auth?.user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = auth.user.firstName;
    } else {
      // Legacy path: firstName is log-only — preserve tolerance for missing/unknown.
      consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName : '';
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName || '');

    if (!rfId) {
      return new Response(JSON.stringify({ error: 'Missing "rfId"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    console.log({
      message: `[MarkInvalid] rfId=${rfId} consultant=${consultantFirstName || 'none'}`,
      source: 'mark-invalid',
      rfId,
      consultantFirstName,
    });

    const candidate = await getRFCandidate(rfId, env);
    const existingTags = candidate?.tags;
    const TAG = 'Number Invalid';

    if (Array.isArray(existingTags) && existingTags.includes(TAG)) {
      console.log({
        message: `[MarkInvalid] rfId=${rfId} — tag already present, no-op`,
        source: 'mark-invalid',
        rfId,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: responseHeaders });
    }

    const merged = mergeTag(existingTags, TAG);
    await updateRFCandidate(rfId, { tags: merged }, env);

    // Invalidate the details/activities snapshot caches so the next
    // /candidate-details read picks up the new tag set immediately rather
    // than waiting up to 5 minutes for the snapshot TTL to expire.
    await invalidateCandidateDetailsCache(rfId, env);

    console.log({
      message: `[MarkInvalid] rfId=${rfId} — tag added, total=${merged.length}`,
      source: 'mark-invalid',
      rfId,
      tags: merged,
    });

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: responseHeaders });

  } catch (error) {
    console.error({ message: `[MarkInvalid] error: ${error.message}`, source: 'mark-invalid', stack: error.stack });
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

export async function handleCandidateDetailsEndpoint(request, env, ctx, corsHeaders, auth) {
  const responseHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  try {
    const payload = await request.json();
    const profileUrl = typeof payload.profileUrl === 'string' ? payload.profileUrl.trim() : '';
    let consultantFirstName;
    let consultantRfUserId;
    if (auth?.user) {
      // JWT path: identity is authoritative; ignore body firstName.
      consultantFirstName = auth.user.firstName;
      consultantRfUserId = auth.user.rfUserId;
    } else {
      // Legacy path: preserve today's tolerance (best-effort consultant resolution).
      consultantFirstName = typeof payload.consultantFirstName === 'string' ? payload.consultantFirstName : '';
      consultantRfUserId = await resolveRFUserId(env, consultantFirstName);
    }
    trace.getActiveSpan()?.setAttribute('consultant.first_name', consultantFirstName || '');

    if (!profileUrl) {
      return new Response(JSON.stringify({ error: 'Missing "profileUrl"' }), {
        status: 400, headers: responseHeaders,
      });
    }

    // Resolve rfId — KV linkedin index first, RF search fallback.
    let rfId = await lookupByLinkedIn(profileUrl, env);
    let linkedinSource = rfId ? 'linkedin-cache' : null;
    if (!rfId) {
      const found = await searchRFCandidateByLinkedIn(profileUrl, env);
      if (found) {
        rfId = String(found.id);
        linkedinSource = 'rf-search';
        await cacheCandidate(found, env);
      }
    }

    if (!rfId) {
      console.log({
        message: `[CandidateDetails] no RF match for url=${profileUrl}`,
        source: 'candidate-details',
        profileUrl,
      });
      return new Response(JSON.stringify({ error: 'Candidate not found in RF' }), {
        status: 404, headers: responseHeaders,
      });
    }

    console.log({
      message: `[CandidateDetails] linkedin → rfId=${rfId} via ${linkedinSource}`,
      source: 'candidate-details',
      cacheHit: linkedinSource === 'linkedin-cache',
      linkedinSource,
      rfId,
    });

    const rfIdNum = parseInt(rfId, 10);

    // Try details + activities cache first (5-min TTL). On hit, skip RF entirely.
    const [cachedDetails, cachedActivities] = await Promise.all([
      getCachedCandidateDetails(rfIdNum, env),
      getCachedCandidateActivities(rfIdNum, env),
    ]);

    let candidate = cachedDetails;
    let activities = cachedActivities;

    if (cachedDetails && cachedActivities) {
      console.log({
        message: `[CandidateDetails] details+activities cache HIT rfId=${rfIdNum}`,
        source: 'candidate-details',
        cacheHit: 'both',
        rfId: rfIdNum,
      });
    } else {
      // Fetch only what's missing — keep both fetches parallel
      const [freshCandidate, freshActivities] = await Promise.all([
        cachedDetails ? Promise.resolve(cachedDetails) : getRFCandidate(rfIdNum, env),
        cachedActivities ? Promise.resolve(cachedActivities) : listCandidateActivities(rfIdNum, env),
      ]);
      candidate = freshCandidate;
      activities = freshActivities;

      // Write back the freshly-fetched pieces
      const writes = [];
      if (!cachedDetails) writes.push(cacheCandidateDetails(rfIdNum, candidate, env));
      if (!cachedActivities) writes.push(cacheCandidateActivities(rfIdNum, activities, env));
      if (writes.length) await Promise.all(writes);

      console.log({
        message: `[CandidateDetails] cache MISS rfId=${rfIdNum} detailsCached=${!!cachedDetails} activitiesCached=${!!cachedActivities}`,
        source: 'candidate-details',
        cacheHit: cachedDetails ? 'details-only' : (cachedActivities ? 'activities-only' : 'none'),
        rfId: rfIdNum,
      });
    }

    // Pick best job
    const pickedJob = await pickConsultantJob(candidate, consultantRfUserId, env);
    const jobOut = pickedJob ? {
      title: pickedJob.name || pickedJob.title || '',
      company: pickedJob.company?.name || '',
      stage: pickedJob.stage_name || '',
    } : null;

    // Fire-and-forget neighbor prewarming. Reads the picked job's batch
    // index, finds this candidate's position, and prewarms 30 either side
    // on first hit OR the next 30 in the direction of motion when the
    // recruiter has walked 20+ candidates since the last prewarm.
    if (pickedJob && consultantRfUserId !== null && ctx?.waitUntil) {
      ctx.waitUntil(handleNeighborPrewarm(rfIdNum, pickedJob.job_id, consultantRfUserId, env));
    }

    // Normalize phone — first entry of phone_number array
    let phoneNumber = null;
    const rawPhones = Array.isArray(candidate.phone_number) ? candidate.phone_number : [];
    if (rawPhones.length > 0) {
      const first = rawPhones[0];
      const raw = typeof first === 'string' ? first : first?.phone_number;
      phoneNumber = normalizeToE164(raw);
    }

    // Cold-call activities (type 1002), ASC by time. Non-owners get the
    // historical list (voicemail + connected). The owner (Joel) additionally
    // gets cancelled calls: forward ones are type-1002 activities in RF;
    // historical ones live in the missed_cold_calls backfill table and are
    // merged in here. The backfill deduped against RF on ingest, so no
    // read-time dedup is needed.
    const owner = await getUserByEmail(env, OWNER_EMAIL);
    const isOwner = !!owner && consultantRfUserId != null && consultantRfUserId === owner.rfUserId;
    trace.getActiveSpan()?.setAttribute('coldcall.is_owner', isOwner);

    let coldCalls = activities
      .filter(a => a?.type?.id === 1002)
      .map(parseColdCallActivity);

    if (isOwner) {
      const missed = await getMissedColdCallsForCandidate(env, rfIdNum);
      for (const row of missed) {
        coldCalls.push({
          id: `missed:${row.call_id}`,
          type: 'cold_call',
          name: 'Cold call',
          description: '',
          createdAt: new Date(row.date_started_ms).toISOString(),
          outcome: row.outcome,
        });
      }
    } else {
      // Never expose cancelled calls to non-owners — preserves today's list.
      coldCalls = coldCalls.filter(c => c.outcome !== 'cancelled');
    }

    coldCalls.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const fullName = candidate.name || `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim();

    const responseBody = {
      rfId: rfIdNum,
      fullName,
      phoneNumber,
      job: jobOut,
      activities: coldCalls,
    };

    console.log({
      message: `[CandidateDetails] rfId=${rfIdNum} consultant=${consultantFirstName || 'none'} job=${jobOut ? jobOut.title : 'none'} activities=${coldCalls.length}`,
      source: 'candidate-details',
      rfId: rfIdNum,
      consultantFirstName,
      consultantRfUserId,
      jobPicked: jobOut,
      activityCount: coldCalls.length,
      phonePresent: phoneNumber !== null,
    });

    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: responseHeaders,
    });

  } catch (error) {
    console.error({ message: `[CandidateDetails] error: ${error.message}`, source: 'candidate-details', stack: error.stack });
    return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
      status: 500, headers: responseHeaders,
    });
  }
}

/**
 * Neighbor-prewarm orchestration. Runs inside ctx.waitUntil so the response
 * is never blocked. Reads the per-job batch index to find the current
 * candidate's position, reads the per-recruiter+job prewarm state, and
 * decides what (if anything) to prewarm:
 *
 *   - First call (no state): prewarm RING candidates either side. Sets state.
 *   - Subsequent calls: if |currentIdx - lastPrewarmIdx| >= TRIGGER, prewarm
 *     the next RING candidates in the direction of motion. Updates state.
 *   - Otherwise: no-op (state untouched).
 *
 * Errors are caught and logged — never throw out of waitUntil.
 */
const PREWARM_RING = 30;
const PREWARM_TRIGGER_DISTANCE = 20;

async function handleNeighborPrewarm(rfId, jobId, recruiterRfUserId, env) {
  try {
    const batchList = await getJobBatchIndex(jobId, env);
    const idx = batchList.indexOf(String(rfId));
    if (idx < 0) {
      console.log({
        message: `[Prewarm] rfId=${rfId} not in batch index for job=${jobId}, skipping`,
        source: 'prewarm',
        rfId,
        jobId,
      });
      return;
    }

    const state = await getPrewarmState(recruiterRfUserId, jobId, env);

    if (!state || typeof state.lastPrewarmIdx !== 'number') {
      // First call — prewarm both directions.
      const start = Math.max(0, idx - PREWARM_RING);
      const end = Math.min(batchList.length - 1, idx + PREWARM_RING);
      const toWarm = batchList.slice(start, end + 1).filter(id => id !== String(rfId));
      console.log({
        message: `[Prewarm] initial both-directions rfId=${rfId} job=${jobId} idx=${idx} count=${toWarm.length}`,
        source: 'prewarm',
        rfId,
        jobId,
        idx,
        count: toWarm.length,
        phase: 'initial',
      });
      await prewarmCandidatesIfMissing(toWarm, env);
      await setPrewarmState(recruiterRfUserId, jobId, { lastPrewarmIdx: idx }, env);
      return;
    }

    const distance = idx - state.lastPrewarmIdx;
    if (Math.abs(distance) < PREWARM_TRIGGER_DISTANCE) {
      // Still within the prewarmed ring — nothing to do.
      return;
    }

    let toWarm;
    let direction;
    if (distance > 0) {
      // Ascending — prewarm the next RING ahead of the current index.
      direction = 'asc';
      const start = idx + 1;
      const end = Math.min(batchList.length - 1, idx + PREWARM_RING);
      toWarm = start <= end ? batchList.slice(start, end + 1) : [];
    } else {
      // Descending — prewarm the next RING behind the current index.
      direction = 'desc';
      const start = Math.max(0, idx - PREWARM_RING);
      const end = idx - 1;
      toWarm = start <= end ? batchList.slice(start, end + 1) : [];
    }

    console.log({
      message: `[Prewarm] direction=${direction} rfId=${rfId} job=${jobId} idx=${idx} count=${toWarm.length}`,
      source: 'prewarm',
      rfId,
      jobId,
      idx,
      direction,
      count: toWarm.length,
      phase: 'directional',
    });
    await prewarmCandidatesIfMissing(toWarm, env);
    await setPrewarmState(recruiterRfUserId, jobId, { lastPrewarmIdx: idx }, env);
  } catch (error) {
    console.error({
      message: `[Prewarm] handleNeighborPrewarm error: ${error.message}`,
      source: 'prewarm',
      rfId,
      jobId,
      stack: error.stack,
    });
  }
}

// ---------------------------------------------------------------------------
// Dialpad calling endpoints — wired up to the LinkedIn Recruiter extension.
// /dialpad-user-context returns the consultant's caller-IDs (with opaque
// alias tokens) so the extension can render its picker without ever seeing
// raw E.164 numbers. /dialpad-call decodes the picked alias and asks Dialpad
// to ring the consultant's eligible devices via initiate_call.
// ---------------------------------------------------------------------------
