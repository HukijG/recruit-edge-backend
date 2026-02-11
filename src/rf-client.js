/**
 * RecruiterFlow API Client
 */

/**
 * Extract RF candidate ID from Dialpad contact ID
 * @param {string} dialpadContactId - Dialpad contact ID in format "shared_contact_pool_Company:xxx_uid_RFxxxxx"
 * @returns {string|null} - RF candidate ID or null if not found
 */
export function extractRFIdFromDialpadContact(dialpadContactId) {
  if (!dialpadContactId) return null;
  
  const match = dialpadContactId.match(/uid_RF(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Update candidate in RecruiterFlow
 * @param {string} candidateId - RF candidate ID
 * @param {Object} updateData - Data to update
 * @param {Object} env - Environment variables
 * @returns {Object} - API response
 */
export async function updateRFCandidate(candidateId, updateData, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';
  
  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const url = `${rfBaseUrl}/candidate/update`;
  
  const payload = {
    id: parseInt(candidateId, 10),
    ...updateData
  };

  console.log('Updating RF candidate:', {
    candidateId,
    url,
    payload: JSON.stringify(payload, null, 2)
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'RF-Api-Key': rfApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('RF API error:', {
      status: response.status,
      statusText: response.statusText,
      error: errorText
    });
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log('RF candidate updated successfully:', result);
  return result;
}

/**
 * Convert Dialpad contact to RF update format for email and phone
 * @param {Object} dialpadContact - Dialpad contact object
 * @returns {Object} - RF update payload
 */
export function convertDialpadContactToRFUpdate(dialpadContact) {
  const updateData = {};

  // Handle emails
  if (dialpadContact.emails && dialpadContact.emails.length > 0) {
    updateData.email = dialpadContact.emails.map((email) => ({
      email: email,
      is_primary: email === dialpadContact.primary_email ? 1 : 0
    }));
  }

  // Handle phone numbers
  if (dialpadContact.phones && dialpadContact.phones.length > 0) {
    updateData.phone_number = dialpadContact.phones.map((phone, index) => ({
      phone_number: phone,
      type: 1
    }));
  }

  // Handle LinkedIn URL from Dialpad's urls array
  if (dialpadContact.urls && dialpadContact.urls.length > 0) {
    const linkedinUrl = dialpadContact.urls.find(url => url.includes('linkedin.com'));
    if (linkedinUrl) {
      updateData.linkedin_profile = linkedinUrl;
    }
  }

  return updateData;
}