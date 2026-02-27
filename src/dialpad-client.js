/**
 * Dialpad API Client for Cloudflare Workers
 */

const DIALPAD_COMPANY_ID = '0000000000000000';

export async function createOrUpdateDialpadContact(candidate, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }

  const uid = `RF${candidate.id}`;
  const contactData = prepareContactData(candidate, uid);

  try {
    const response = await fetch(`${dialpadBaseUrl}/contacts`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${dialpadApiKey}`
      },
      body: JSON.stringify(contactData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Dialpad API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const expectedContactId = `shared_contact_pool_Company:${DIALPAD_COMPANY_ID}_uid_${uid}`;

    return {
      success: true,
      contactId: expectedContactId,
      uid: uid,
      dialpadResponse: result
    };

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
    emails: [],
    phones: [],
    company_name: candidate.current_organization || '',
    job_title: candidate.current_title || '',
    urls: []
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

/**
 * List calls from Dialpad call history.
 * @param {Object} params - { target_id, started_after, cursor? }
 * @param {Object} env
 * @returns {{ items: Array, cursor: string|null }}
 */
export async function listDialpadCalls(params, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }

  const url = new URL(`${dialpadBaseUrl}/call`);
  url.searchParams.set('target_id', params.target_id);
  url.searchParams.set('target_type', 'user');
  url.searchParams.set('started_after', String(params.started_after));
  if (params.cursor) {
    url.searchParams.set('cursor', params.cursor);
  }

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${dialpadApiKey}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dialpad call list API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}
