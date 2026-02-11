/**
 * Dialpad API Client for Cloudflare Workers
 * Handles contact creation and updates
 */

const DIALPAD_COMPANY_ID = '0000000000000000';

export async function createOrUpdateDialpadContact(candidate, env) {
  const dialpadApiKey = env.DIALPAD_API_KEY;
  const dialpadBaseUrl = env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

  if (!dialpadApiKey) {
    throw new Error('DIALPAD_API_KEY environment variable is required');
  }

  // Generate the UID using RF + candidate ID
  const uid = `RF${candidate.id}`;

  // Prepare contact data for Dialpad API
  const contactData = prepareContactData(candidate, uid);

  console.log('Creating/updating Dialpad contact:', {
    uid,
    name: `${candidate.first_name} ${candidate.last_name}`,
    email: candidate.email,
    company: candidate.current_organization
  });

  try {
    const response = await fetch(`${dialpadBaseUrl}/contacts?apikey=${dialpadApiKey}`, {
      method: 'PUT',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json'
      },
      body: JSON.stringify(contactData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Dialpad API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    // The contact ID will be in format: shared_contact_pool_Company:0000000000000000_uid_RF{id}
    const expectedContactId = `shared_contact_pool_Company:${DIALPAD_COMPANY_ID}_uid_${uid}`;

    console.log('Dialpad contact operation successful:', {
      contactId: expectedContactId,
      uid: uid,
      rfCandidateId: candidate.id
    });

    return {
      success: true,
      contactId: expectedContactId,
      uid: uid,
      dialpadResponse: result
    };

  } catch (error) {
    console.error('Dialpad API request failed:', error);
    throw error;
  }
}

function prepareContactData(candidate, uid) {
  // Fall back to splitting combined name field if first/last not provided
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

  // Add email if present
  if (candidate.email && candidate.email.trim() !== '') {
    contactData.emails.push(candidate.email.trim());
  }

  // Add phone if present
  if (candidate.phone_number && candidate.phone_number.trim() !== '') {
    contactData.phones.push(candidate.phone_number.trim());
  }

  // Add LinkedIn profile if present
  if (candidate.linkedin_profile && candidate.linkedin_profile.trim() !== '') {
    contactData.urls.push(candidate.linkedin_profile.trim());
  }

  return contactData;
}
