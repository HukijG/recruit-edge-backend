/**
 * KV Candidate Cache Layer
 *
 * Canonical record:  candidate:{rfId} → JSON blob (60-day TTL)
 * Index keys:        linkedin:{normalized}, email:{lowercase}, name:{first}:{last} → rfId string (60-day TTL)
 *
 * Name index uses "AMBIGUOUS" sentinel when two different candidates share the same name.
 */

import { normalizeLinkedInUrl, isValidLinkedInUrl } from './rf-client.js';

const CACHE_TTL = 60 * 24 * 60 * 60; // 60 days in seconds
const CONSULTANT_CACHE_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

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
