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
  const contactData = prepareContactData(candidate, uid);
  const contactId = buildDialpadContactId(candidate.id);
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${dialpadApiKey}`
  };

  try {
    console.log({
      message: `[Dialpad] upserting contact uid=${uid}`,
      source: 'dialpad',
      contactId,
      phones: contactData.phones,
      urls: contactData.urls,
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
  };

  // Only include fields that have values — Dialpad blanks fields that receive empty values
  if (candidate.current_organization) {
    contactData.company_name = candidate.current_organization;
  }

  if (candidate.current_title) {
    contactData.job_title = candidate.current_title;
  }

  const emails = [];
  if (candidate.email && candidate.email.trim() !== '') {
    emails.push(candidate.email.trim());
  }
  if (emails.length > 0) {
    contactData.emails = emails;
  }

  const phones = [];
  if (candidate.phone_number && candidate.phone_number.trim() !== '') {
    phones.push(candidate.phone_number.trim());
  }
  if (phones.length > 0) {
    contactData.phones = phones;
  }

  const urls = [];
  if (candidate.linkedin_profile && candidate.linkedin_profile.trim() !== '') {
    urls.push(candidate.linkedin_profile.trim());
  }
  if (urls.length > 0) {
    contactData.urls = urls;
  }

  return contactData;
}
