/**
 * Dialpad API Client for Cloudflare Workers
 */

const DIALPAD_COMPANY_ID = '0000000000000000';

/**
 * Build the deterministic Dialpad contact ID from an RF candidate ID.
 */
export function buildDialpadContactId(rfId) {
  return `shared_contact_pool_Company:${DIALPAD_COMPANY_ID}_uid_RF${rfId}`;
}

export async function createOrUpdateDialpadContact(candidate, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }

  const uid = `RF${candidate.id}`;
  const contactId = buildDialpadContactId(candidate.id);
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${dialpadApiKey}`
  };

  // Build contact data — only include fields that have actual values
  const contactData = buildContactData(candidate, uid);

  try {
    console.log({
      message: `[Dialpad] upserting contact uid=${uid}`,
      source: 'dialpad',
      contactId,
      contactData,
    });

    // Try PATCH (update) first — avoids Dialpad firing "Created" events
    const patchUrl = `${dialpadBaseUrl}/contacts/${encodeURIComponent(contactId)}`;
    const patchResponse = await fetch(patchUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(contactData)
    });

    if (patchResponse.ok) {
      const result = await patchResponse.json();
      console.log({ message: `[Dialpad] PATCH success uid=${uid}`, source: 'dialpad', contactId });
      return { success: true, contactId, uid, method: 'update', dialpadResponse: result };
    }

    // Fall back to PUT (create) if contact doesn't exist yet
    if (patchResponse.status === 404) {
      console.log({ message: `[Dialpad] PATCH 404 — falling back to PUT uid=${uid}`, source: 'dialpad', contactId });
      const putResponse = await fetch(`${dialpadBaseUrl}/contacts`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(contactData)
      });

      if (!putResponse.ok) {
        const errorText = await putResponse.text();
        throw new Error(`Dialpad PUT error: ${putResponse.status} - ${errorText}`);
      }

      const result = await putResponse.json();
      console.log({ message: `[Dialpad] PUT success (created) uid=${uid}`, source: 'dialpad', contactId });
      return { success: true, contactId, uid, method: 'create', dialpadResponse: result };
    }

    // Unexpected error from PATCH
    const errorText = await patchResponse.text();
    throw new Error(`Dialpad PATCH error: ${patchResponse.status} - ${errorText}`);

  } catch (error) {
    console.error('Dialpad API error:', error.message);
    throw error;
  }
}

/**
 * GET a Dialpad contact by RF candidate ID.
 * Returns the contact object if found, or null if 404.
 */
export async function getDialpadContact(rfId, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }

  const contactId = buildDialpadContactId(rfId);
  const response = await fetch(`${dialpadBaseUrl}/contacts/${encodeURIComponent(contactId)}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${dialpadApiKey}`,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dialpad GET error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

/**
 * PATCH an existing Dialpad contact with only the specified fields.
 * Use this for enrichment/update paths where the contact already exists.
 * Only sends the fields you pass — nothing else gets touched.
 *
 * @param {string|number} rfId - RF candidate ID (used to build the contact ID)
 * @param {Object} fields - Dialpad API fields to set (e.g. { phones: ['+15551234567'], urls: ['https://...'] })
 * @param {Object} env
 */
export async function patchDialpadContact(rfId, fields, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }

  const contactId = buildDialpadContactId(rfId);
  const patchUrl = `${dialpadBaseUrl}/contacts/${encodeURIComponent(contactId)}`;

  console.log({
    message: `[Dialpad] PATCH rfId=${rfId} fields=${Object.keys(fields).join(',')}`,
    source: 'dialpad',
    contactId,
    fields,
  });

  const response = await fetch(patchUrl, {
    method: 'PATCH',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dialpadApiKey}`,
    },
    body: JSON.stringify(fields),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dialpad PATCH error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log({ message: `[Dialpad] PATCH success rfId=${rfId}`, source: 'dialpad', contactId });
  return result;
}

/**
 * GET a Dialpad user's caller-ID record.
 *
 * Returns the flat shape Dialpad serves at GET /api/v2/users/{userId}/caller_id:
 *   { caller_id, phone_numbers, office_main_line, groups, ... }
 *
 * Throws on non-2xx responses — callers translate that into the {ok:false} 502
 * envelope the extension expects.
 */
export async function getUserCallerId(userId, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';
  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }
  const url = `${dialpadBaseUrl}/users/${encodeURIComponent(userId)}/caller_id`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${dialpadApiKey}`,
    },
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dialpad caller_id GET ${response.status}: ${errorText}`);
  }
  return response.json();
}

/**
 * POST Dialpad's initiate_call endpoint for a user. Dialpad auto-rings every
 * eligible autocallable device the user has — we deliberately do NOT pass
 * device_id, the recruiter just picks up on whichever app rings.
 *
 * Returns { ok, status, body } so callers can build a useful error message
 * from Dialpad's own response if it rejects the call.
 */
export async function initiateCall({ userId, phoneNumber, outboundCallerId, customData }, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';
  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }
  const url = `${dialpadBaseUrl}/users/${encodeURIComponent(userId)}/initiate_call`;
  const body = { phone_number: phoneNumber };
  if (outboundCallerId) body.outbound_caller_id = outboundCallerId;
  if (customData) body.custom_data = customData;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dialpadApiKey}`,
    },
    body: JSON.stringify(body),
  });

  let parsed = null;
  const text = await response.text();
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

/**
 * Pure transform: takes the flat Dialpad caller_id response shape and a sign
 * function, returns the extension-facing callerIds[] array (with opaque aliases
 * in place of the underlying E.164 numbers).
 *
 * Walks phone_numbers (label "My number") → office_main_line ("Office main line")
 * → groups[] (label = group's display_name). De-dupes on E.164 — first
 * occurrence wins for label. Marks isDefault on the entry whose number matches
 * the top-level caller_id field.
 *
 * @param {Object|null} dpCallerId — Dialpad's GET /users/{id}/caller_id response
 * @param {(number: string) => Promise<string>} sign — alias-mint function
 * @returns {Promise<Array<{aliasId: string, country: 'UK'|'US'|'OTHER', label?: string, isDefault?: boolean}>>}
 */
export async function buildCallerIdsFromDialpad(dpCallerId, sign) {
  if (!dpCallerId) return [];

  const seen = new Set(); // dedup by E.164 — first writer wins
  /** @type {Array<{number: string, label: string}>} */
  const ordered = [];

  const push = (raw, label) => {
    const normalized = normalizeE164(raw);
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    ordered.push({ number: normalized, label });
  };

  if (Array.isArray(dpCallerId.phone_numbers)) {
    for (const n of dpCallerId.phone_numbers) push(n, 'My number');
  }
  // office_main_line is intentionally skipped — never used in practice.
  if (Array.isArray(dpCallerId.groups)) {
    for (const g of dpCallerId.groups) {
      if (!g) continue;
      const label = (typeof g.display_name === 'string' && g.display_name.trim()) || 'Group';
      push(g.caller_id, label);
    }
  }

  const defaultNumber = normalizeE164(dpCallerId.caller_id);

  const out = [];
  for (const { number, label } of ordered) {
    const entry = {
      aliasId: await sign(number),
      country: countryFromE164(number),
      label,
    };
    if (defaultNumber && number === defaultNumber) entry.isDefault = true;
    out.push(entry);
  }
  return out;
}

function normalizeE164(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\+\d{6,}$/.test(trimmed)) return null;
  return trimmed;
}

function countryFromE164(number) {
  if (number.startsWith('+44')) return 'UK';
  if (number.startsWith('+1')) return 'US';
  return 'OTHER';
}

/**
 * Build contact payload. Only includes fields that have values —
 * Dialpad PATCH clears any field present with an empty value.
 * Omitting a field entirely leaves it untouched.
 */
function buildContactData(candidate, uid) {
  let firstName = candidate.first_name || '';
  let lastName = candidate.last_name || '';
  if (!firstName && !lastName && candidate.name) {
    const parts = candidate.name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  // uid + name always required
  const data = { uid, first_name: firstName, last_name: lastName };

  if (candidate.current_organization) data.company_name = candidate.current_organization;
  if (candidate.current_title) data.job_title = candidate.current_title;

  if (candidate.email && candidate.email.trim()) data.emails = [candidate.email.trim()];
  if (candidate.phone_number && candidate.phone_number.trim()) data.phones = [candidate.phone_number.trim()];
  if (candidate.linkedin_profile && candidate.linkedin_profile.trim()) data.urls = [candidate.linkedin_profile.trim()];

  return data;
}
