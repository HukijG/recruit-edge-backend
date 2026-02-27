/**
 * RecruiterFlow API Client
 */

/**
 * Extract RF candidate ID from Dialpad contact ID
 * @param {string} dialpadContactId - e.g. "shared_contact_pool_Company:xxx_uid_RFxxxxx"
 * @returns {string|null}
 */
export function extractRFIdFromDialpadContact(dialpadContactId) {
  if (!dialpadContactId) return null;
  const match = String(dialpadContactId).match(/uid_RF(\d+)$/);
  return match ? match[1] : null;
}

/**
 * Update candidate in RecruiterFlow
 */
export async function updateRFCandidate(candidateId, updateData, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const payload = {
    id: parseInt(candidateId, 10),
    ...updateData
  };

  const response = await fetch(`${rfBaseUrl}/candidate/update`, {
    method: 'POST',
    headers: {
      'RF-Api-Key': rfApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF update error: ${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

/**
 * Check if a LinkedIn answer is actually a valid LinkedIn URL
 */
export function isValidLinkedInUrl(answer) {
  if (!answer || typeof answer !== 'string') return false;
  return /https?:\/\/.*linkedin\.com\/(in|pub)\//i.test(answer.trim());
}

/**
 * Normalize a LinkedIn URL for consistent cache key lookups.
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
 */
export async function getRFCandidate(candidateId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const response = await fetch(`${rfBaseUrl}/candidate/get?id=${candidateId}`, {
    method: 'GET',
    headers: { 'RF-Api-Key': rfApiKey }
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF get error: ${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.candidate || result;
}

/**
 * Search RF for a candidate by LinkedIn profile URL.
 */
export async function searchRFCandidateByLinkedIn(linkedinUrl, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  try {
    const response = await fetch(`${rfBaseUrl}/candidate/search`, {
      method: 'POST',
      headers: {
        'RF-Api-Key': rfApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filters: [{ conjunction: 'in', values: [linkedinUrl], key: 'linkedin_profile' }],
        conjunction: 'match-all',
        current_page: 1,
        items_per_page: 5
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`RF search error: ${response.status}`, errorText);
      return null;
    }

    const result = await response.json();
    const candidates = Array.isArray(result) ? result : (result.candidates || result.data || result.results || []);

    return candidates.length > 0 ? candidates[0] : null;
  } catch (error) {
    console.error('RF search failed:', error.message);
    return null;
  }
}

/**
 * Search RF for a candidate by email address.
 */
export async function searchRFCandidateByEmail(email, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  try {
    const response = await fetch(`${rfBaseUrl}/candidate/search`, {
      method: 'POST',
      headers: {
        'RF-Api-Key': rfApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filters: [{ conjunction: 'in', values: [email], key: 'email' }],
        conjunction: 'match-all',
        current_page: 1,
        items_per_page: 5
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`RF search error: ${response.status}`, errorText);
      return null;
    }

    const result = await response.json();
    const candidates = Array.isArray(result) ? result : (result.candidates || result.data || result.results || []);

    return candidates.length > 0 ? candidates[0] : null;
  } catch (error) {
    console.error('RF search failed:', error.message);
    return null;
  }
}

/**
 * Add a note to an RF candidate.
 */
export async function addRFCandidateNote(candidateId, htmlContent, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const payload = {
    created_by: 900001,
    id: parseInt(candidateId, 10),
    mentions: [],
    value: htmlContent
  };

  const response = await fetch(`${rfBaseUrl}/candidate/notes/add`, {
    method: 'POST',
    headers: {
      'RF-Api-Key': rfApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF add note error: ${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

/**
 * List activities for an RF candidate.
 */
export async function listRFCandidateActivities(candidateId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const response = await fetch(
    `${rfBaseUrl}/candidate/activity/list?id=${candidateId}&items_per_page=50&current_page=1&include_count=true`,
    {
      method: 'GET',
      headers: { 'RF-Api-Key': rfApiKey }
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF activity list error: ${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

/**
 * Check if a cold call activity already exists for a candidate near the given call time.
 * Uses a same-day window to avoid duplicates.
 */
export function hasExistingColdCallActivity(activities, callTimestamp) {
  if (!Array.isArray(activities) || activities.length === 0) return false;

  const callDate = new Date(callTimestamp);
  const callDayStart = new Date(callDate.getFullYear(), callDate.getMonth(), callDate.getDate()).getTime();
  const callDayEnd = callDayStart + 86400000; // +24 hours

  return activities.some(activity => {
    const isTypeMatch = activity.activity_type_id === 1002;
    const isTextMatch = typeof activity.activity_text === 'string' && activity.activity_text.includes('Cold call');

    if (!isTypeMatch && !isTextMatch) return false;

    // Check time proximity (same-day window)
    if (activity.activity_time) {
      const activityTime = new Date(activity.activity_time).getTime();
      return activityTime >= callDayStart && activityTime < callDayEnd;
    }

    // If no time on the activity, match by type/text alone
    return isTypeMatch || isTextMatch;
  });
}

/**
 * Convert Dialpad contact to RF update format for email and phone
 */
export function convertDialpadContactToRFUpdate(dialpadContact) {
  const updateData = {};

  if (dialpadContact.emails && dialpadContact.emails.length > 0) {
    updateData.email = dialpadContact.emails.map((email) => ({
      email: email,
      is_primary: email === dialpadContact.primary_email ? 1 : 0
    }));
  }

  if (dialpadContact.phones && dialpadContact.phones.length > 0) {
    updateData.phone_number = dialpadContact.phones.map((phone, index) => ({
      phone_number: phone,
      type: 1
    }));
  }

  if (dialpadContact.urls && dialpadContact.urls.length > 0) {
    const linkedinUrl = dialpadContact.urls.find(url => url.includes('linkedin.com'));
    if (linkedinUrl) {
      updateData.linkedin_profile = linkedinUrl;
    }
  }

  return updateData;
}

/**
 * Create a custom activity on an RF candidate.
 */
export async function createRFCustomActivity(activityData, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const response = await fetch(`${rfBaseUrl}/custom-activity/create`, {
    method: 'POST',
    headers: {
      'RF-Api-Key': rfApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(activityData)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF custom activity error: ${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}
