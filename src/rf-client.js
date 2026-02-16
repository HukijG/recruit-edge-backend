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
 * Check if a LinkedIn answer is actually a valid LinkedIn URL
 * (rejects garbage like "danielcbright")
 */
export function isValidLinkedInUrl(answer) {
  if (!answer || typeof answer !== 'string') return false;
  return /https?:\/\/.*linkedin\.com\/(in|pub)\//i.test(answer.trim());
}

/**
 * Normalize a LinkedIn URL for consistent cache key lookups.
 * Handles both /in/ and /pub/ paths.
 * e.g. "https://www.linkedin.com/in/david-stern/" → "linkedin.com/in/david-stern"
 * e.g. "http://www.linkedin.com/pub/example-candidate/4/a74/a97" → "linkedin.com/pub/example-candidate/4/a74/a97"
 */
export function normalizeLinkedInUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let normalized = url.trim().toLowerCase();
  normalized = normalized.replace(/^https?:\/\//, '');
  normalized = normalized.replace(/^www\./, '');
  normalized = normalized.replace(/[?#].*$/, '');
  normalized = normalized.replace(/\/+$/, '');
  return normalized || null;
}

/**
 * Fetch full candidate data from RF
 * GET /candidate/get?id=X
 */
export async function getRFCandidate(candidateId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const url = `${rfBaseUrl}/candidate/get?id=${candidateId}`;

  console.log('Fetching RF candidate:', { candidateId, url });

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'RF-Api-Key': rfApiKey,
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('RF GET candidate error:', { status: response.status, error: errorText });
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  // RF might wrap in {candidate: ...} or return directly — handle both
  const candidate = result.candidate || result;

  console.log('RF candidate fetched:', {
    id: candidate.id,
    name: candidate.name,
    emailCount: Array.isArray(candidate.email) ? candidate.email.length : (candidate.email ? 1 : 0),
    hasLinkedIn: !!candidate.linkedin_profile
  });

  return candidate;
}

/**
 * Search RF for a candidate by LinkedIn profile URL.
 * Returns the candidate object or null if not found.
 */
export async function searchRFCandidateByLinkedIn(linkedinUrl, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const url = `${rfBaseUrl}/candidate/search`;

  console.log('Searching RF for candidate by LinkedIn:', { linkedinUrl, url });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'RF-Api-Key': rfApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filters: [
          {
            conjunction: 'in',
            values: [linkedinUrl],
            key: 'linkedin_profile'
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('RF search API error:', { status: response.status, error: errorText });
      // Log full response so we can figure out the correct filter format
      console.error('RF search API response body (for debugging):', errorText);
      return null;
    }

    const result = await response.json();
    console.log('RF search API raw response shape:', {
      isArray: Array.isArray(result),
      keys: typeof result === 'object' ? Object.keys(result) : 'n/a'
    });

    const candidates = Array.isArray(result) ? result : (result.candidates || result.data || result.results || []);

    if (candidates.length === 0) {
      console.log('No RF candidate found for LinkedIn:', linkedinUrl);
      return null;
    }

    if (candidates.length > 1) {
      console.log('Multiple RF candidates found for LinkedIn, using first:', { count: candidates.length, linkedinUrl });
    }

    return candidates[0];
  } catch (error) {
    console.error('RF search API request failed:', error.message);
    return null;
  }
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