/**
 * KV Candidate Cache Layer
 *
 * Canonical record:  candidate:{rfId} → JSON blob (60-day TTL, slim record)
 * Index keys:        linkedin:{normalized}, email:{lowercase}, name:{first}:{last} → rfId string (60-day TTL)
 * Consultant index:  consultant:job{jobId}:cand{rfId} → rfUserId string or "none" sentinel (30-day TTL)
 * Details snapshot:  details:{rfId} → full RF /candidate/get response (20-min TTL)
 * Activities snapshot: activities:{rfId} → full RF /candidate/activity/list data array (20-min TTL)
 * Job batch index:   batch:job{jobId} → JSON array of rfIds in extension-add order (30-day TTL)
 * Prewarm state:     prewarm:rec{rfUserId}:job{jobId} → { lastPrewarmIdx } (1-hour TTL)
 *
 * Name index uses "AMBIGUOUS" sentinel when two different candidates share the same name.
 * Consultant index uses "none" sentinel when RF has no consultant_id on the job-candidate link.
 * Details + activities snapshots back the /candidate-details fast path: subsequent reads within
 * the 20-min TTL skip RF entirely. Invalidated by /candidate-mark-invalid so tag changes show up
 * on the next read.
 * Batch index + prewarm state drive the neighbor-warming flow: when a recruiter opens a profile,
 * we prewarm 30 candidates either side of its index in the batch list. Every 20 candidates of
 * forward motion through the index, we prewarm the next 30 in that direction so the recruiter
 * never hits a cold cache while walking through a queue.
 */

import { normalizeLinkedInUrl, isValidLinkedInUrl } from './rf-client.js';

const CACHE_TTL = 60 * 24 * 60 * 60; // 60 days in seconds
const CONSULTANT_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const DETAILS_CACHE_TTL = 20 * 60; // 20 minutes
const BATCH_INDEX_TTL = 30 * 24 * 60 * 60; // 30 days
const PREWARM_STATE_TTL = 60 * 60; // 1 hour (per-session lifetime)

/**
 * Write canonical record + all index keys for a candidate.
 */
export async function cacheCandidate(candidate, env) {
  if (!candidate?.id) return;

  const rfId = String(candidate.id);

  const record = {
    id: candidate.id,
    first_name: candidate.first_name || '',
    last_name: candidate.last_name || '',
    email: typeof candidate.email === 'string' ? candidate.email : '',
    emails: Array.isArray(candidate.email) ? candidate.email : [],
    linkedin_profile: candidate.linkedin_profile || '',
    current_organization: candidate.current_organization || '',
    current_title: candidate.current_title || '',
    phone_number: candidate.phone_number || '',
    cached_at: new Date().toISOString(),
  };

  const writes = [];

  // Canonical record
  writes.push(
    env.SYNC_STATE.put(`candidate:${rfId}`, JSON.stringify(record), { expirationTtl: CACHE_TTL })
  );

  // LinkedIn index
  if (record.linkedin_profile && isValidLinkedInUrl(record.linkedin_profile)) {
    const normalized = normalizeLinkedInUrl(record.linkedin_profile);
    if (normalized) {
      writes.push(
        env.SYNC_STATE.put(`linkedin:${normalized}`, rfId, { expirationTtl: CACHE_TTL })
      );
    }
  }

  // Email indexes — one key per email in the array
  if (record.emails.length > 0) {
    for (const entry of record.emails) {
      const addr = (entry.email || '').toLowerCase().trim();
      if (addr) {
        writes.push(
          env.SYNC_STATE.put(`email:${addr}`, rfId, { expirationTtl: CACHE_TTL })
        );
      }
    }
  } else if (record.email) {
    const addr = record.email.toLowerCase().trim();
    if (addr) {
      writes.push(
        env.SYNC_STATE.put(`email:${addr}`, rfId, { expirationTtl: CACHE_TTL })
      );
    }
  }

  // Name index (with ambiguity detection)
  const first = (record.first_name || '').toLowerCase().trim();
  const last = (record.last_name || '').toLowerCase().trim();
  if (first && last) {
    const nameKey = `name:${first}:${last}`;
    const existing = await env.SYNC_STATE.get(nameKey);
    if (existing === null) {
      writes.push(
        env.SYNC_STATE.put(nameKey, rfId, { expirationTtl: CACHE_TTL })
      );
    } else if (existing !== rfId && existing !== 'AMBIGUOUS') {
      writes.push(
        env.SYNC_STATE.put(nameKey, 'AMBIGUOUS', { expirationTtl: CACHE_TTL })
      );
    }
  }

  await Promise.all(writes);
}

/**
 * Read canonical record by RF ID.
 */
export async function getCachedCandidate(rfId, env) {
  const raw = await env.SYNC_STATE.get(`candidate:${rfId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Look up RF candidate ID by LinkedIn URL.
 */
export async function lookupByLinkedIn(linkedinUrl, env) {
  if (!linkedinUrl || !isValidLinkedInUrl(linkedinUrl)) return null;
  const normalized = normalizeLinkedInUrl(linkedinUrl);
  if (!normalized) return null;
  return await env.SYNC_STATE.get(`linkedin:${normalized}`) || null;
}

/**
 * Look up RF candidate ID by email address.
 */
export async function lookupByEmail(email, env) {
  if (!email) return null;
  const addr = email.toLowerCase().trim();
  if (!addr) return null;
  return await env.SYNC_STATE.get(`email:${addr}`) || null;
}

/**
 * Look up RF candidate ID by name. Returns null if ambiguous.
 */
export async function lookupByName(firstName, lastName, env) {
  const first = (firstName || '').toLowerCase().trim();
  const last = (lastName || '').toLowerCase().trim();
  if (!first || !last) return null;

  const value = await env.SYNC_STATE.get(`name:${first}:${last}`);
  if (!value || value === 'AMBIGUOUS') return null;
  return value;
}

/**
 * Cache the consultant_id for a (candidateId, jobId) link. Pass `null` to
 * write the "none" sentinel (RF has no consultant_id on the link). 30-day TTL.
 */
export async function cacheConsultantForJobLink(candidateId, jobId, consultantRfUserId, env) {
  const key = `consultant:job${jobId}:cand${candidateId}`;
  const value = consultantRfUserId === null || consultantRfUserId === undefined
    ? 'none'
    : String(consultantRfUserId);
  await env.SYNC_STATE.put(key, value, { expirationTtl: CONSULTANT_CACHE_TTL });
}

/**
 * Read the cached consultant_id for a (candidateId, jobId) link.
 * Returns:
 *   - a number (the rfUserId) if cached as a numeric string
 *   - the literal string "none" if RF has no consultant_id on the link
 *   - null if the cache has no entry (caller should fall back to RF GET)
 */
export async function getCachedConsultantForJobLink(candidateId, jobId, env) {
  const key = `consultant:job${jobId}:cand${candidateId}`;
  const raw = await env.SYNC_STATE.get(key);
  if (raw === null) return null;
  if (raw === 'none') return 'none';
  const num = parseInt(raw, 10);
  return Number.isNaN(num) ? null : num;
}

/**
 * Cache the full RF /candidate/get response under details:{rfId}. 5-min TTL so
 * the subsequent sidepanel open within that window skips the RF call entirely.
 */
export async function cacheCandidateDetails(rfId, candidate, env) {
  if (!rfId || !candidate) return;
  const key = `details:${rfId}`;
  await env.SYNC_STATE.put(key, JSON.stringify(candidate), { expirationTtl: DETAILS_CACHE_TTL });
}

/**
 * Read the cached full candidate. Returns the parsed object or null on miss.
 */
export async function getCachedCandidateDetails(rfId, env) {
  if (!rfId) return null;
  const key = `details:${rfId}`;
  const raw = await env.SYNC_STATE.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Cache the activity list under activities:{rfId}. 5-min TTL paired with the
 * details cache for symmetric freshness.
 */
export async function cacheCandidateActivities(rfId, activities, env) {
  if (!rfId || !Array.isArray(activities)) return;
  const key = `activities:${rfId}`;
  await env.SYNC_STATE.put(key, JSON.stringify(activities), { expirationTtl: DETAILS_CACHE_TTL });
}

/**
 * Read the cached activities array. Returns array or null on miss.
 */
export async function getCachedCandidateActivities(rfId, env) {
  if (!rfId) return null;
  const key = `activities:${rfId}`;
  const raw = await env.SYNC_STATE.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Invalidate both details and activities caches for an rfId. Called when a
 * mutation changes the candidate's RF state (e.g. /candidate-mark-invalid)
 * so the next /candidate-details read pulls fresh data.
 */
export async function invalidateCandidateDetailsCache(rfId, env) {
  if (!rfId) return;
  await Promise.all([
    env.SYNC_STATE.delete(`details:${rfId}`),
    env.SYNC_STATE.delete(`activities:${rfId}`),
  ]);
}

/**
 * Append rfId to the per-job batch index (the order in which candidates were
 * bulk-added to the job via the LinkedIn extension). Idempotent — skips if
 * already present. Used by /candidate-details neighbor-prewarming so that
 * opening one profile in a queue warms the surrounding candidates.
 *
 * Stored as a JSON array of rfId strings. 30-day TTL — long enough that a
 * recruiter walking through a stale batch still finds the index intact.
 */
export async function appendToJobBatchIndex(jobId, rfId, env) {
  if (!jobId || rfId === null || rfId === undefined) return;
  const key = `batch:job${jobId}`;
  const raw = await env.SYNC_STATE.get(key);
  let list = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      // fall through with empty list
    }
  }
  const id = String(rfId);
  if (list.includes(id)) return;
  list.push(id);
  await env.SYNC_STATE.put(key, JSON.stringify(list), { expirationTtl: BATCH_INDEX_TTL });
}

/**
 * Read the per-job batch index. Returns array of rfId strings in append
 * order, or [] if the key doesn't exist.
 */
export async function getJobBatchIndex(jobId, env) {
  if (!jobId) return [];
  const raw = await env.SYNC_STATE.get(`batch:job${jobId}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Read the per-recruiter+job prewarm state. Returns { lastPrewarmIdx } or
 * null if no state is recorded yet (first call in a session).
 */
export async function getPrewarmState(rfUserId, jobId, env) {
  if (!rfUserId || !jobId) return null;
  const raw = await env.SYNC_STATE.get(`prewarm:rec${rfUserId}:job${jobId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write the per-recruiter+job prewarm state. 1-hour TTL — long enough to
 * cover a single calling session, short enough to forget stale state.
 */
export async function setPrewarmState(rfUserId, jobId, state, env) {
  if (!rfUserId || !jobId || !state) return;
  await env.SYNC_STATE.put(
    `prewarm:rec${rfUserId}:job${jobId}`,
    JSON.stringify(state),
    { expirationTtl: PREWARM_STATE_TTL }
  );
}

