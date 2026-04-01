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

  try {
    // Try PATCH (update) first — avoids Dialpad firing "Created" events
    const patchUrl = `${dialpadBaseUrl}/contacts/${encodeURIComponent(contactId)}`;

    // GET the existing contact so we can merge — Dialpad PATCH replaces ALL fields,
    // so omitting a field clears it
    const getResponse = await fetch(patchUrl, { method: 'GET', headers });

    if (getResponse.ok) {
      const existing = await getResponse.json();
      const contactData = mergeContactData(existing, candidate, uid);

      console.log({
        message: `[Dialpad] PATCHing contact uid=${uid}`,
        source: 'dialpad',
        contactId,
        phones: contactData.phones,
        urls: contactData.urls,
        job_title: contactData.job_title,
        company_name: contactData.company_name,
      });

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

      const errorText = await patchResponse.text();
      throw new Error(`Dialpad PATCH error: ${patchResponse.status} - ${errorText}`);
    }

    // Contact doesn't exist yet — create with PUT
    if (getResponse.status === 404) {
      const contactData = prepareContactData(candidate, uid);

      console.log({
        message: `[Dialpad] creating contact uid=${uid}`,
        source: 'dialpad',
        contactId,
        phones: contactData.phones,
        urls: contactData.urls,
        job_title: contactData.job_title,
        company_name: contactData.company_name,
      });

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

    const errorText = await getResponse.text();
    throw new Error(`Dialpad GET error: ${getResponse.status} - ${errorText}`);

  } catch (error) {
    console.error('Dialpad API error:', error.message);
    throw error;
  }
}

/**
 * Merge new candidate data into existing Dialpad contact.
 * Only overwrites a field if the new value is non-empty — preserves existing data.
 */
function mergeContactData(existing, candidate, uid) {
  let firstName = candidate.first_name || '';
  let lastName = candidate.last_name || '';
  if (!firstName && !lastName && candidate.name) {
    const parts = candidate.name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  return {
    uid: uid,
    first_name: firstName || existing.first_name || '',
    last_name: lastName || existing.last_name || '',
    company_name: candidate.current_organization || existing.company_name || '',
    job_title: candidate.current_title || existing.job_title || '',
    emails: buildMergedArray(existing.emails, candidate.email),
    phones: buildMergedArray(existing.phones, candidate.phone_number),
    urls: buildMergedArray(existing.urls, candidate.linkedin_profile),
  };
}

/**
 * Merge a new value into an existing array, deduplicating.
 */
function buildMergedArray(existing, newValue) {
  const arr = Array.isArray(existing) ? [...existing] : [];
  if (newValue && newValue.trim() !== '' && !arr.includes(newValue.trim())) {
    arr.push(newValue.trim());
  }
  return arr;
}

/**
 * Build contact data for initial PUT (create) — no existing data to merge with.
 */
function prepareContactData(candidate, uid) {
  let firstName = candidate.first_name || '';
  let lastName = candidate.last_name || '';
  if (!firstName && !lastName && candidate.name) {
    const parts = candidate.name.trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }

  const contactData = {
    uid: uid,
    first_name: firstName,
    last_name: lastName,
    company_name: candidate.current_organization || '',
    job_title: candidate.current_title || '',
    emails: [],
    phones: [],
    urls: [],
  };

  if (candidate.email && candidate.email.trim() !== '') {
    contactData.emails.push(candidate.email.trim());
  }

  if (candidate.phone_number && candidate.phone_number.trim() !== '') {
    contactData.phones.push(candidate.phone_number.trim());
  }

  if (candidate.linkedin_profile && candidate.linkedin_profile.trim() !== '') {
    contactData.urls.push(candidate.linkedin_profile.trim());
  }

  return contactData;
}
