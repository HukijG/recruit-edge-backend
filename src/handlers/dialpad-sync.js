/**
 * RF → Dialpad contact sync — shared by the RF webhook, calendar, and
 * extension candidate flows. Enforces the sync validation invariant
 * (name + organization + title) in one place.
 */

import { createOrUpdateDialpadContact } from '../dialpad-client.js';

/**
 * Sync candidate to Dialpad. Returns true if synced, false if skipped validation.
 */
export async function syncCandidateToDialpad(candidate, env) {
  const validation = validateCandidateForDialpad(candidate);

  if (!validation.isValidForSync) {
    const missing = [];
    if (!validation.hasName) missing.push('name');
    if (!validation.hasOrganization) missing.push('current_organization');
    if (!validation.hasTitle) missing.push('current_title');
    console.warn({
      message: `[Dialpad sync] skipped validation candidate=${candidate.id} missing=[${missing.join(', ')}]`,
      source: 'dialpad-sync',
      candidateId: candidate.id,
      missing,
      checks: {
        hasName: validation.hasName,
        hasOrganization: validation.hasOrganization,
        hasTitle: validation.hasTitle,
      },
      values: {
        first_name: candidate.first_name ?? null,
        last_name: candidate.last_name ?? null,
        name: candidate.name ?? null,
        current_organization: candidate.current_organization ?? null,
        current_title: candidate.current_title ?? null,
      },
    });
    return false;
  }

  await createOrUpdateDialpadContact(candidate, env);

  // Write debounce flag to KV to prevent loop (60s TTL)
  const syncKey = `sync:RF${candidate.id}`;
  await env.SYNC_STATE.put(syncKey, 'true', { expirationTtl: 60 });

  return true;
}

function validateCandidateForDialpad(candidate) {
  const validation = {
    hasName: !!(candidate.first_name && candidate.last_name) || !!candidate.name,
    hasOrganization: !!candidate.current_organization,
    hasTitle: !!candidate.current_title,
    isValidForSync: false
  };

  validation.isValidForSync = validation.hasName && validation.hasOrganization && validation.hasTitle;

  return validation;
}
