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
 * Create a new candidate in RecruiterFlow
 */
export async function addRFCandidate(candidateData, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const response = await fetch(`${rfBaseUrl}/candidate/add`, {
    method: 'POST',
    headers: {
      'RF-Api-Key': rfApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(candidateData)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF add candidate error: ${response.status}`, errorText);
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
 * Convert Dialpad contact to RF update format for email and phone
 */
export function convertDialpadContactToRFUpdate(dialpadContact) {
  const updateData = {};

  if (dialpadContact.emails) {
    updateData.email = dialpadContact.emails.length > 0
      ? dialpadContact.emails.map((email) => ({
          email: email,
          is_primary: email === dialpadContact.primary_email ? 1 : 0
        }))
      : [];
  }

  if (dialpadContact.phones) {
    updateData.phone_number = dialpadContact.phones.length > 0
      ? dialpadContact.phones.map((phone) => ({
          phone_number: phone,
          type: 1
        }))
      : [];
  }

  if (dialpadContact.urls) {
    if (dialpadContact.urls.length > 0) {
      const linkedinUrl = dialpadContact.urls.find(url => url.includes('linkedin.com'));
      if (linkedinUrl) {
        updateData.linkedin_profile = linkedinUrl;
      }
    } else {
      updateData.linkedin_profile = '';
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

/**
 * Stage names eligible for automatic move to "Call Booked".
 */
const CALL_BOOKED_ELIGIBLE_STAGES = ['Sourced', 'Replied', 'Replied (Cold)'];
const CALL_BOOKED_TARGET = 'Call Booked';
const JOEL_RF_USER_ID = 900001;

/**
 * Find the most-recently-moved job on a candidate and check if it's
 * eligible for stage movement to "Call Booked".
 *
 * @param {object} candidate - Full candidate object from GET /candidate/get (must include jobs array)
 * @returns {{ job_id: number, targetStage: { id: number, name: string }, userId: number } | null}
 */
export function findEligibleJob(candidate) {
  const jobs = candidate?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return null;

  // Sort by stage_moved descending — most recent first
  const sorted = [...jobs].sort((a, b) =>
    new Date(b.stage_moved).getTime() - new Date(a.stage_moved).getTime()
  );

  const mostRecent = sorted[0];

  // Check if current stage is eligible
  if (!CALL_BOOKED_ELIGIBLE_STAGES.includes(mostRecent.stage_name)) {
    return null;
  }

  // Find "Call Booked" in this job's stages array
  const targetStage = mostRecent.stages?.find(s => s.name === CALL_BOOKED_TARGET);
  if (!targetStage) return null;

  return {
    job_id: mostRecent.job_id,
    targetStage: { id: targetStage.id, name: targetStage.name },
    userId: mostRecent.added_to_job_by?.id || JOEL_RF_USER_ID,
  };
}

/**
 * Move a candidate to "Call Booked" stage if eligible.
 * Caller provides full candidate data (already fetched) to avoid a redundant GET.
 *
 * @param {string|number} candidateId - RF candidate ID
 * @param {object} candidateData - Full candidate object from GET /candidate/get
 * @param {object} env - Worker env
 * @returns {{ moved: boolean, jobId?: number, reason?: string }}
 */
export async function moveToCallBooked(candidateId, candidateData, env) {
  const eligible = findEligibleJob(candidateData);

  if (!eligible) {
    return { moved: false, reason: 'not eligible (no jobs, wrong stage, or no Call Booked stage)' };
  }

  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const payload = {
    id: parseInt(candidateId, 10),
    job_id: eligible.job_id,
    stage: {
      id: eligible.targetStage.id,
      name: eligible.targetStage.name,
    },
    user_id: eligible.userId,
  };

  const response = await fetch(`${rfBaseUrl}/candidate/move-to-stage`, {
    method: 'POST',
    headers: {
      'RF-Api-Key': rfApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF move-to-stage error: ${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  return { moved: true, jobId: eligible.job_id };
}
