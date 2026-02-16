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

/**
 * Write canonical record + all index keys for a candidate.
 * Call this after any RF webhook or successful RF API lookup.
 */
export async function cacheCandidate(candidate, env) {
  if (!candidate?.id) return;

  const rfId = String(candidate.id);

  // Build canonical record with key fields
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

  // 1. Canonical record
  writes.push(
    env.SYNC_STATE.put(`candidate:${rfId}`, JSON.stringify(record), { expirationTtl: CACHE_TTL })
  );

  // 2. LinkedIn index
  if (record.linkedin_profile && isValidLinkedInUrl(record.linkedin_profile)) {
    const normalized = normalizeLinkedInUrl(record.linkedin_profile);
    if (normalized) {
      writes.push(
        env.SYNC_STATE.put(`linkedin:${normalized}`, rfId, { expirationTtl: CACHE_TTL })
      );
    }
  }

  // 3. Email indexes — one key per email in the array
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
    // Fallback: single string email
    const addr = record.email.toLowerCase().trim();
    if (addr) {
      writes.push(
        env.SYNC_STATE.put(`email:${addr}`, rfId, { expirationTtl: CACHE_TTL })
      );
    }
  }

  // 4. Name index (with ambiguity detection)
  const first = (record.first_name || '').toLowerCase().trim();
  const last = (record.last_name || '').toLowerCase().trim();
  if (first && last) {
    const nameKey = `name:${first}:${last}`;
    const existing = await env.SYNC_STATE.get(nameKey);
    if (existing === null) {
      // First candidate with this name — claim the key
      writes.push(
        env.SYNC_STATE.put(nameKey, rfId, { expirationTtl: CACHE_TTL })
      );
    } else if (existing !== rfId && existing !== 'AMBIGUOUS') {
      // Different candidate — mark ambiguous
      writes.push(
        env.SYNC_STATE.put(nameKey, 'AMBIGUOUS', { expirationTtl: CACHE_TTL })
      );
    }
    // If existing === rfId, no update needed (same candidate re-cached)
  }

  await Promise.all(writes);
  console.log('Cache populated for candidate:', rfId);
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
