/**
 * RecruiterFlow API Client
 */

import { getUserByFirstName } from './users.js';

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

  const bodyJson = JSON.stringify(payload);

  // Inline request body in message so it surfaces in queryable CF Logs
  // (structured `requestBody` field is stored but not indexed).
  console.log({
    message: `RF update request candidate=${candidateId} body=${bodyJson}`,
    candidateId,
  });

  const response = await fetch(`${rfBaseUrl}/candidate/update`, {
    method: 'POST',
    headers: {
      'RF-Api-Key': rfApiKey,
      'Content-Type': 'application/json'
    },
    body: bodyJson
  });

  const responseText = await response.text();

  // Inline status + body so non-200s and validation errors are visible in CF Logs.
  console.log({
    message: `RF update response candidate=${candidateId} status=${response.status} body=${responseText}`,
    candidateId,
  });

  if (!response.ok) {
    throw new Error(`RF API error: ${response.status} - ${responseText}`);
  }

  return JSON.parse(responseText);
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
 * Extract the unique LinkedIn profile slug from any of the formats RF/the
 * extension might give us:
 *   "https://www.linkedin.com/in/jamie-lin/"  → "jamie-lin"
 *   "linkedin.com/in/jamie-lin"               → "jamie-lin"
 *   "jamie-lin"                               → "jamie-lin"
 *   "https://www.linkedin.com/pub/foo/1/2/3"  → "foo"
 *
 * Used for identity comparison when RF's search response gives a bare slug
 * but the extension sent a full URL.
 */
export function extractLinkedInSlug(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  // If the string contains an /in/ or /pub/ segment, take the next path piece.
  // Otherwise treat the whole string as the slug.
  const pathMatch = trimmed.match(/(?:linkedin\.com\/)?(?:in|pub)\/([^\/?#\s]+)/);
  if (pathMatch) return pathMatch[1].replace(/\/+$/, '') || null;
  // Bare slug — strip any leading/trailing slashes and query/hash junk
  return trimmed.replace(/[?#].*$/, '').replace(/^\/+|\/+$/g, '') || null;
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

  const requestBody = {
    filters: [{ conjunction: 'in', values: [linkedinUrl], key: 'linkedin_profile' }],
    conjunction: 'match-all',
    current_page: 1,
    items_per_page: 5
  };

  try {
    const response = await fetch(`${rfBaseUrl}/candidate/search`, {
      method: 'POST',
      headers: {
        'RF-Api-Key': rfApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error({ message: `RF search error status=${response.status} body=${responseText} searchedUrl=${linkedinUrl}`, source: 'rf-search' });
      return null;
    }

    const result = JSON.parse(responseText);
    const candidates = Array.isArray(result) ? result : (result.candidates || result.data || result.results || []);

    // RF's /candidate/search with linkedin_profile filter does substring matching,
    // not exact match. Searching for "e-cobb" returns "averee-cobb" + "steve-cobb24"
    // because both contain "e-cobb". Filter to only true matches by slug identity.
    // RF returns linkedin_profile as a bare slug ("averee-cobb") even when we
    // sent a full URL — extractLinkedInSlug normalizes both sides.
    const wantSlug = extractLinkedInSlug(linkedinUrl);
    const matches = wantSlug
      ? candidates.filter(c => extractLinkedInSlug(c.linkedin_profile) === wantSlug)
      : [];

    if (candidates.length > 0 && matches.length !== candidates.length) {
      // RF returned extras due to substring match — log so we can see how often this happens
      console.log({
        message: `RF search filtered fuzzy results: searched="${linkedinUrl}" rfReturned=${candidates.length} kept=${matches.length} discarded=${candidates.length - matches.length} (RF does substring match on linkedin_profile)`,
        source: 'rf-search',
      });
    }

    return matches.length > 0 ? matches[0] : null;
  } catch (error) {
    console.error({ message: `RF search failed: ${error.message} searchedUrl=${linkedinUrl}`, source: 'rf-search' });
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
    // TODO: route via users.js when Krisp template webhook support returns (currently dead code).
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

  if (dialpadContact.emails && dialpadContact.emails.length > 0) {
    updateData.email = dialpadContact.emails.map((email) => ({
      email: email,
      is_primary: email === dialpadContact.primary_email ? 1 : 0
    }));
  }

  if (dialpadContact.phones && dialpadContact.phones.length > 0) {
    updateData.phone_number = dialpadContact.phones.map((phone) => ({
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

/**
 * Stage names eligible for automatic move to "Call Booked".
 */
const CALL_BOOKED_ELIGIBLE_STAGES = ['Sourced', 'Replied', 'Replied (Cold)'];
const CALL_BOOKED_TARGET = 'Call Booked';
const JOEL_RF_USER_ID = getUserByFirstName('Joel').rfUserId;

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
    userId: JOEL_RF_USER_ID,
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

/**
 * Stage-move eligibility check that ONLY considers the first entry in
 * `candidate.jobs`. RF returns jobs time-ordered, so jobs[0] is the most
 * recently-touched job — i.e. the one the recruiter is currently working
 * with. We deliberately do NOT scan later entries: if jobs[0] isn't
 * eligible, we return [] and the move is skipped. Moving a *different*
 * job than the one the recruiter is on is worse than doing nothing.
 *
 * Returns [] or a single-element [{ job_id, targetStage: { id, name } }].
 *
 * @param {object} candidate - Full candidate object from GET /candidate/get
 * @param {object} filters
 * @param {string} filters.currentStage   Required, e.g. 'Sourced'
 * @param {string} filters.targetStage    Required, e.g. 'Replied'
 * @param {boolean} [filters.openOnly=true] Only act when jobs[0].is_open
 */
export function findJobsForStageMove(candidate, filters) {
  const { currentStage, targetStage, openOnly = true } = filters || {};
  if (!currentStage || !targetStage) return [];

  const jobs = candidate?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) return [];

  const job = jobs[0];
  if (openOnly && !job?.is_open) return [];
  if (job?.stage_name !== currentStage) return [];

  const target = job?.stages?.find(s => s.name === targetStage);
  if (!target) return [];

  return [{
    job_id: job.job_id,
    targetStage: { id: target.id, name: target.name },
  }];
}

/**
 * Generalised stage-mover. Moves a candidate from `currentStage` to
 * `targetStage` in every matching job (per findJobsForStageMove).
 * Caller provides the full candidate object (already fetched) to avoid a
 * redundant GET. Fail-fast: if any single move call errors, the loop
 * aborts and the error is thrown.
 *
 * @param {string|number} candidateId
 * @param {object} candidateData       Full candidate object from GET
 * @param {object} options
 * @param {string} options.currentStage
 * @param {string} options.targetStage
 * @param {number} options.userId      RF user_id to attribute the move to
 * @param {boolean} [options.openOnly=true]
 * @param {object} env
 * @returns {Promise<{ moved: number, jobIds: number[] }>}
 */
export async function moveJobsToStage(candidateId, candidateData, options, env) {
  const { currentStage, targetStage, userId, openOnly } = options;
  const eligible = findJobsForStageMove(candidateData, { currentStage, targetStage, openOnly });
  if (eligible.length === 0) {
    return { moved: 0, jobIds: [] };
  }

  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const movedJobIds = [];
  for (const job of eligible) {
    const payload = {
      id: parseInt(candidateId, 10),
      job_id: job.job_id,
      stage: { id: job.targetStage.id, name: job.targetStage.name },
      user_id: userId,
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
      console.error({ message: `RF move-to-stage error candidate=${candidateId} job=${job.job_id} status=${response.status} body=${errorText}`, source: 'rf-move-stage' });
      throw new Error(`RF API error: ${response.status} - ${errorText}`);
    }

    movedJobIds.push(job.job_id);
  }

  return { moved: movedJobIds.length, jobIds: movedJobIds };
}

/**
 * Fetch all open jobs from RF, paginating through all pages.
 * Returns slim objects: { id, name, company }
 */
export async function listOpenJobs(env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const allJobs = [];
  let page = 1;
  const perPage = 50;

  while (true) {
    const url = `${rfBaseUrl}/job/list?only_open=1&items_per_page=${perPage}&current_page=${page}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'RF-Api-Key': rfApiKey },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`RF job/list error: ${response.status}`, errorText);
      throw new Error(`RF API error: ${response.status} - ${errorText}`);
    }

    const jobs = await response.json();
    if (!Array.isArray(jobs) || jobs.length === 0) break;

    for (const job of jobs) {
      allJobs.push({
        id: job.id,
        name: job.name || job.title || '',
        company: job.company?.name || '',
      });
    }

    if (jobs.length < perPage) break;
    page++;
  }

  return allJobs;
}

const JOB_CANDIDATE_CONSULTANT_FIELD_ID = 16;

/**
 * Write the consultant_id custom field on a job-candidate link.
 * Field id 16 (number type) is provisioned in RF.
 */
export async function setJobCandidateConsultantId(candidateId, jobId, consultantRfUserId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const payload = {
    candidate_id: parseInt(candidateId, 10),
    job_id: parseInt(jobId, 10),
    custom_fields: [{ id: JOB_CANDIDATE_CONSULTANT_FIELD_ID, value: consultantRfUserId }],
  };

  const response = await fetch(`${rfBaseUrl}/job-candidate/custom-field/value/update`, {
    method: 'POST',
    headers: { 'RF-Api-Key': rfApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

/**
 * Add a candidate to a job in RF.
 */
export async function addCandidateToJob(candidateId, jobId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const response = await fetch(`${rfBaseUrl}/candidate/add-to-job`, {
    method: 'POST',
    headers: {
      'RF-Api-Key': rfApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      "id": parseInt(candidateId, 10),
      "job_id": parseInt(jobId, 10),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF add-to-job error: ${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}
