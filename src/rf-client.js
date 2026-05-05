/**
 * RecruiterFlow API Client
 */

import { getUserByFirstName } from './users.js';
import {
  getCachedConsultantForJobLink, cacheConsultantForJobLink,
  cacheCandidateDetails, getCachedCandidateDetails,
  cacheCandidateActivities, getCachedCandidateActivities,
} from './cache.js';

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
 * Fetch full candidate data from RF.
 *
 * Retries once on 502 — RF's edge occasionally returns transient 502s and
 * the cost of a single retry is far cheaper than failing the whole
 * /candidate-details response and forcing the user to refresh.
 */
export async function getRFCandidate(candidateId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const url = `${rfBaseUrl}/candidate/get?id=${candidateId}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'RF-Api-Key': rfApiKey }
    });

    if (response.ok) {
      const result = await response.json();
      return result.candidate || result;
    }

    const errorText = await response.text();

    if (response.status === 502 && attempt === 1) {
      console.warn({
        message: `[RF get] 502 for candidate=${candidateId}, retrying once`,
        source: 'rf-get',
        candidateId,
      });
      continue;
    }

    console.error(`RF get error: ${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  // Unreachable — the loop either returns or throws on every iteration
  throw new Error('RF API error: unreachable');
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
 * Async stage-move eligibility check.
 *
 * Algorithm:
 *   1. Compute "eligible" jobs (open + stage_name === currentStage + targetStage exists in stages).
 *   2. If recruiterRfUserId is a number AND env is provided, resolve consultant_id
 *      for each eligible job in parallel. If any matches the recruiter, return
 *      [first match].
 *   3. Else fall back to jobs[0] if it's eligible.
 *   4. Else return [].
 *
 * The jobs[0] fallback preserves today's behavior during the transition window
 * where existing job-candidate links lack a consultant_id custom field.
 *
 * Returns [] or a single-element [{ job_id, targetStage: { id, name } }].
 *
 * @param {object} candidate - Full candidate object from GET /candidate/get
 * @param {object} filters
 * @param {string} filters.currentStage         Required, e.g. 'Sourced'
 * @param {string} filters.targetStage          Required, e.g. 'Replied'
 * @param {number|null} [filters.recruiterRfUserId] If set, prefer the job
 *   whose consultant_id matches.
 * @param {boolean} [filters.openOnly=true]     Only act on open jobs
 * @param {object} env
 */
export async function findJobsForStageMove(candidate, filters, env) {
  const { currentStage, targetStage, recruiterRfUserId, openOnly = true } = filters || {};
  if (!currentStage || !targetStage) return [];

  const jobs = Array.isArray(candidate?.jobs) ? candidate.jobs : [];
  if (jobs.length === 0) return [];

  const eligibleEntry = (job) => {
    if (openOnly && !job?.is_open) return null;
    if (job?.stage_name !== currentStage) return null;
    const target = job?.stages?.find(s => s.name === targetStage);
    if (!target) return null;
    return { job_id: job.job_id, targetStage: { id: target.id, name: target.name } };
  };

  if (typeof recruiterRfUserId === 'number' && env) {
    const eligibleJobs = jobs
      .map(j => ({ raw: j, entry: eligibleEntry(j) }))
      .filter(x => x.entry !== null);

    if (eligibleJobs.length > 0) {
      const resolved = await Promise.all(
        eligibleJobs.map(async x => ({
          ...x,
          consultantId: await resolveJobConsultantId(candidate.id, x.raw.job_id, env),
        }))
      );
      const match = resolved.find(r => r.consultantId === recruiterRfUserId);
      if (match) return [match.entry];
    }
  }

  const firstEntry = eligibleEntry(jobs[0]);
  return firstEntry ? [firstEntry] : [];
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
  const { currentStage, targetStage, userId, recruiterRfUserId, openOnly } = options;
  const eligible = await findJobsForStageMove(candidateData, {
    currentStage, targetStage, recruiterRfUserId, openOnly,
  }, env);
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
        // Extra fields used by /my-sourcing-jobs to filter to "MY" jobs;
        // existing consumers (e.g. /candidates job-picker dropdown) just
        // ignore them.
        hiring_team: Array.isArray(job.hiring_team) ? job.hiring_team : [],
        job_status: job.job_status || null,
      });
    }

    if (jobs.length < perPage) break;
    page++;
  }

  return allJobs;
}

/**
 * Search RF for candidates matching a job + stage. Used by /job-pipeline
 * to power the mobile PWA's pipeline view.
 *
 * RF's /candidate/search filter docs: `job` is multi-select-by-id, `stage`
 * is multi-select-by-name. Results paginate; we fetch all pages up to
 * `maxPages` (default 10 = 1000 candidates at items_per_page=100, plenty
 * for a single Sourced pipeline).
 *
 * Returns the raw candidate array — caller filters / sorts / maps as needed.
 */
export async function searchCandidatesByJobAndStage({ jobId, stageName, maxPages = 10 }, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const perPage = 100;
  const allCandidates = [];
  let totalItems = null;

  for (let page = 1; page <= maxPages; page++) {
    const requestBody = {
      items_per_page: perPage,
      current_page: page,
      conjunction: 'match-all',
      filters: [
        { conjunction: 'in', values: [parseInt(jobId, 10)], key: 'job' },
        { conjunction: 'in', values: [stageName], key: 'stage' },
      ],
      include_count: true,
    };

    const response = await fetch(`${rfBaseUrl}/candidate/search`, {
      method: 'POST',
      headers: { 'RF-Api-Key': rfApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error({
        message: `RF candidate/search error status=${response.status} body=${errorText}`,
        source: 'rf-search',
        jobId,
        stageName,
        page,
      });
      throw new Error(`RF API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    const candidates = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.candidates)
        ? result.candidates
        : Array.isArray(result)
          ? result
          : [];
    if (typeof result?.total_items === 'number') totalItems = result.total_items;

    allCandidates.push(...candidates);

    if (candidates.length < perPage) break;
  }

  return { candidates: allCandidates, totalItems };
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
    console.error(`RF set-consultant-field error candidate=${candidateId} job=${jobId} status=${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  return await response.json();
}

/**
 * Read the consultant_id custom field for a job-candidate link.
 * Returns the numeric value (an RF user_id) or null if the field is unset.
 */
export async function getJobCandidateConsultantId(candidateId, jobId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const url = `${rfBaseUrl}/job-candidate/custom-field/value/list?candidate_id=${candidateId}&job_id=${jobId}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'RF-Api-Key': rfApiKey, 'Accept': 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF get-consultant-field error candidate=${candidateId} job=${jobId} status=${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  const fields = Array.isArray(result?.data) ? result.data : [];
  const entry = fields.find(f => f.id === JOB_CANDIDATE_CONSULTANT_FIELD_ID);
  if (!entry || entry.value === null || entry.value === undefined) return null;
  const num = typeof entry.value === 'number' ? entry.value : parseInt(entry.value, 10);
  return Number.isNaN(num) ? null : num;
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

/**
 * Resolve the consultant_id for a job-candidate link, preferring KV cache.
 * On cache miss, GETs from RF and writes the result back to cache.
 * Returns the numeric value or null.
 *
 * Logs every lookup with cacheHit:true|false so we can verify the cache is
 * doing its job in CF Logs.
 */
export async function resolveJobConsultantId(candidateId, jobId, env) {
  const cached = await getCachedConsultantForJobLink(candidateId, jobId, env);
  if (cached === 'none') {
    console.log({
      message: `[ConsultantCache] HIT (none) candidate=${candidateId} job=${jobId}`,
      source: 'consultant-cache',
      cacheHit: true,
      candidateId,
      jobId,
      consultantId: null,
    });
    return null;
  }
  if (typeof cached === 'number') {
    console.log({
      message: `[ConsultantCache] HIT candidate=${candidateId} job=${jobId} consultantId=${cached}`,
      source: 'consultant-cache',
      cacheHit: true,
      candidateId,
      jobId,
      consultantId: cached,
    });
    return cached;
  }

  // Cache miss — read from RF and write back
  const fresh = await getJobCandidateConsultantId(candidateId, jobId, env);
  await cacheConsultantForJobLink(candidateId, jobId, fresh, env);
  console.log({
    message: `[ConsultantCache] MISS candidate=${candidateId} job=${jobId} resolvedFromRF=${fresh === null ? 'none' : fresh} (now cached)`,
    source: 'consultant-cache',
    cacheHit: false,
    candidateId,
    jobId,
    consultantId: fresh,
  });
  return fresh;
}

/**
 * GET /candidate/activity/list — full activity feed for a candidate.
 * First page only (50 entries). Returns the data array (empty if none).
 */
export async function listCandidateActivities(candidateId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const url = `${rfBaseUrl}/candidate/activity/list?id=${candidateId}&items_per_page=50&current_page=1&include_count=true`;
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'RF-Api-Key': rfApiKey, 'Accept': 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`RF activity-list error candidate=${candidateId} status=${response.status}`, errorText);
    throw new Error(`RF API error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return Array.isArray(result?.data) ? result.data : [];
}

/**
 * Pick the best job to surface for a candidate in /candidate-details.
 *
 * Algorithm:
 *   1. Filter to open jobs.
 *   2. If consultantRfUserId is non-null, find the first job (in candidate.jobs
 *      order) whose resolved consultant_id matches.
 *   3. Otherwise (no match or no consultant), fall back to candidate.jobs[0]
 *      if it's open.
 *   4. Else null.
 *
 * Returns the raw job object (with all RF fields) or null.
 */
export async function pickConsultantJob(candidate, consultantRfUserId, env) {
  const jobs = Array.isArray(candidate?.jobs) ? candidate.jobs : [];
  if (jobs.length === 0) return null;

  if (typeof consultantRfUserId === 'number') {
    // Sort open jobs by stage_moved desc so when multiple jobs match the
    // consultant, the most-recently-touched one wins (deterministic — not
    // dependent on RF response ordering).
    const openJobs = jobs
      .filter(j => j?.is_open)
      .slice()
      .sort((a, b) => new Date(b?.stage_moved || 0).getTime() - new Date(a?.stage_moved || 0).getTime());
    // Resolve consultant_id in parallel; treat per-job lookup failures as no-match
    const resolved = await Promise.all(
      openJobs.map(async j => {
        try {
          return { job: j, consultantId: await resolveJobConsultantId(candidate.id, j.job_id, env) };
        } catch (error) {
          console.warn({
            message: `[pickConsultantJob] resolveJobConsultantId failed candidate=${candidate.id} job=${j.job_id}: ${error.message}`,
            source: 'pick-consultant-job',
          });
          return { job: j, consultantId: null };
        }
      })
    );
    const match = resolved.find(r => r.consultantId === consultantRfUserId);
    if (match) return match.job;
  }

  // Fallback: jobs[0] if open
  const first = jobs[0];
  if (first?.is_open) return first;
  return null;
}

/**
 * Normalize a raw phone string to E.164 (e.g. "+15551234567"). Returns null
 * if the input can't be confidently parsed.
 *
 * Rules:
 *   - Already-+ formatted: keep + and digits, sanity-check 7-15 digits total
 *   - 10 digits, no +: assume US, prepend +1
 *   - 11 digits starting with 1, no +: prepend +
 *   - Otherwise: null (caller treats as "no usable phone")
 */
export function normalizeToE164(raw) {
  if (typeof raw !== 'string' || !raw) return null;

  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    if (digits.length < 7 || digits.length > 15) return null;
    return `+${digits}`;
  }

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

  return null;
}

/**
 * Background prewarm: for each rfId, fetch /candidate/get and
 * /candidate/activity/list in parallel and write to the details +
 * activities caches. Skips per-rfId pieces that are already cached. Failures
 * are logged but never thrown — this runs inside ctx.waitUntil and a single
 * bad candidate must not poison the rest of the batch.
 */
export async function prewarmCandidatesIfMissing(rfIds, env) {
  if (!Array.isArray(rfIds) || rfIds.length === 0) return;

  await Promise.all(rfIds.map(async (rfIdRaw) => {
    const numId = typeof rfIdRaw === 'number' ? rfIdRaw : parseInt(rfIdRaw, 10);
    if (Number.isNaN(numId)) return;

    try {
      const [cachedDetails, cachedActivities] = await Promise.all([
        getCachedCandidateDetails(numId, env),
        getCachedCandidateActivities(numId, env),
      ]);

      const tasks = [];
      if (!cachedDetails) {
        tasks.push((async () => {
          const fresh = await getRFCandidate(numId, env);
          await cacheCandidateDetails(numId, fresh, env);
        })());
      }
      if (!cachedActivities) {
        tasks.push((async () => {
          const fresh = await listCandidateActivities(numId, env);
          await cacheCandidateActivities(numId, fresh, env);
        })());
      }

      if (tasks.length > 0) {
        await Promise.all(tasks);
      }
    } catch (error) {
      console.warn({
        message: `[Prewarm] failed for rfId=${numId}: ${error.message}`,
        source: 'prewarm',
        rfId: numId,
      });
    }
  }));
}
