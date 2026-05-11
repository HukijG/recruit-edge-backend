/**
 * normalize.js — canonical RF → D1 normaliser.
 *
 * Pure functions, no I/O. Every RF candidate object flows through these
 * before any D1 write.
 */

// Keys to keep in the curated body stored in D1.
// Heavy keys (activities, notes, files, experience, education) are dropped —
// they add cost to every D1 deserialisation and no /mcp/* tool reads them.
const CURATED_KEYS = [
  'id',
  'first_name', 'last_name', 'name',
  'primary_email', 'emails',
  'phone_numbers',
  'linkedin_profile', 'github_profile', 'twitter_profile',
  'current_title', 'current_organization',
  'location',
  'source', 'tags', 'skills', 'do_not_email',
  'added_time', 'last_updated', 'last_activity_at',
  'last_engaged', 'last_contacted',
  'rating',
  'lead_owner',
  'custom_fields', 'custom_fields_by_name',
  'jobs',
];

/**
 * Extract the slug portion from a LinkedIn URL or slug string.
 * Handles https/http, www prefix, trailing slashes, and query/hash params.
 * Returns the slug (e.g. "jerry-smith") or null if none found.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
// RF sometimes sends these sentinel strings instead of a real LinkedIn value.
const LINKEDIN_SENTINEL_RE = /^(none|n\/a|null|undefined|-)$/i;

function normalizeLinkedInSlug(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
  // Form 1: full URL like "linkedin.com/in/<slug>" or "linkedin.com/pub/<slug>"
  const urlMatch = s.match(/linkedin\.com\/(?:in|pub)\/([^/]+)/);
  if (urlMatch) return urlMatch[1];
  // Form 2: RF often returns the bare slug only (no URL). Accept any token of
  // alphanumeric / hyphen / underscore as a slug if it doesn't look like a URL.
  // Block known RF sentinel strings (e.g. "None") before accepting as slug.
  if (!s.includes('/') && !s.includes('.') && /^[a-z0-9_-]+$/i.test(s)) {
    if (LINKEDIN_SENTINEL_RE.test(s)) return null;
    return s;
  }
  return null;
}

/**
 * Transform a canonical RF candidate object into a D1 `candidates` row.
 *
 * @param {object} rf - RF candidate (from /candidate/get or equivalent)
 * @returns {{
 *   id: number,
 *   body: string,
 *   name: string|null,
 *   primary_email: string|null,
 *   linkedin_profile: string|null,
 *   current_organization: string|null,
 *   current_title: string|null,
 *   lead_owner_id: number|null,
 *   added_time: string|null,
 *   last_updated: string|null,
 *   last_activity_at: string|null,
 *   cached_at: string
 * }}
 */
/**
 * Pull the first email address out of RF's `email` field.
 * RF returns an array — entries can be plain strings or objects ({ email, type, ... }).
 */
function firstEmail(rf) {
  // Prefer top-level `primary_email` if a caller pre-populated it (defensive).
  if (typeof rf.primary_email === 'string' && rf.primary_email) {
    return rf.primary_email.toLowerCase();
  }
  const arr = Array.isArray(rf.email) ? rf.email : (Array.isArray(rf.emails) ? rf.emails : null);
  if (!arr || !arr.length) return null;
  const first = arr[0];
  if (typeof first === 'string') return first.toLowerCase();
  if (first && typeof first.email === 'string') return first.email.toLowerCase();
  return null;
}

export function toCandidateRow(rf) {
  // Build curated body — only the listed keys, heavy fields excluded.
  const curated = {};
  for (const k of CURATED_KEYS) {
    if (rf[k] !== undefined) curated[k] = rf[k];
  }

  // RF→internal alias mapping. RF returns several fields under different names
  // depending on endpoint (/list, /search, /get). The internal canonical names
  // are what projection.js + snapshots + handlers consume.
  const primary_email = firstEmail(rf);
  if (primary_email && curated.primary_email == null) curated.primary_email = primary_email;
  if (rf.email !== undefined && curated.emails == null) curated.emails = rf.email;
  if (Array.isArray(rf.phone_number) && curated.phone_numbers == null) {
    curated.phone_numbers = rf.phone_number;
  }
  const current_title = rf.current_title ?? rf.current_designation ?? null;
  if (current_title && curated.current_title == null) curated.current_title = current_title;
  const last_activity_at = rf.last_activity_at ?? rf.latest_activity_time ?? null;
  if (last_activity_at && curated.last_activity_at == null) curated.last_activity_at = last_activity_at;
  // /candidate/get has `source`; /candidate/list has `source_name`.
  const source = rf.source ?? rf.source_name ?? null;
  if (source && curated.source == null) curated.source = source;

  // Normalise job entries inside body so downstream consumers (snapshots,
  // projection.js dot-paths like `jobs.*.job_name`) see canonical names.
  if (Array.isArray(rf.jobs)) {
    curated.jobs = rf.jobs.map(j => ({
      ...j,
      job_name: j.job_name ?? j.name ?? null,        // RF uses `name` on /list and /get
      added_to_job: j.added_to_job ?? j.added_time ?? null,
      // Preserve RF's stages[] array (only on /get) verbatim — used by move-stage.
    }));
  }

  // Synthesise custom_fields_by_name from the custom_fields array.
  // Keys are lowercased for case-insensitive lookup (projection.js aliases use lowercased names).
  // The whole entry is preserved so callers can access .value, .id, etc.
  // Use ??= so a pre-existing custom_fields_by_name on the input is never stomped.
  if (Array.isArray(rf.custom_fields)) {
    const byName = {};
    for (const cf of rf.custom_fields) {
      if (cf?.name) {
        byName[cf.name.toLowerCase()] = cf;
      }
    }
    curated.custom_fields_by_name ??= byName;
  }

  return {
    id: rf.id,
    body: JSON.stringify(curated),
    name: rf.name ?? ([rf.first_name, rf.last_name].filter(Boolean).join(' ') || null),
    primary_email,
    linkedin_profile: normalizeLinkedInSlug(rf.linkedin_profile),
    current_organization: rf.current_organization ?? null,
    current_title,
    lead_owner_id: rf.lead_owner?.id ?? null,
    added_time: rf.added_time ?? null,
    last_updated: rf.last_updated ?? null,  // /list lacks this; rebuild compensates via global cursor
    last_activity_at,
    cached_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// THIN-IMMUTABLE row builders (spec rev 5).
// Coexist with toCandidateRow / toCandidateJobRows during the dual-write phase.
// ---------------------------------------------------------------------------

const RF_UID_RE = /uid_RF(\d+)$/;

function extractRFIdFromContactId(contactId) {
  if (typeof contactId !== 'string') return null;
  const m = contactId.match(RF_UID_RE);
  return m ? Number(m[1]) : null;
}

/**
 * Build a thin candidates_v2 row from any RF candidate-shaped object
 * (/candidate/list, /candidate/search, /candidate/get all flow through here).
 *
 * @throws if rf.added_time is missing — cron must skip incomplete rows upstream.
 */
export function toCandidateThinRow(rf) {
  if (!rf?.added_time) {
    throw new Error(`toCandidateThinRow: rf.added_time is required (id=${rf?.id})`);
  }
  return {
    id: rf.id,
    name: rf.name ?? ([rf.first_name, rf.last_name].filter(Boolean).join(' ') || null),
    linkedin_profile: normalizeLinkedInSlug(rf.linkedin_profile),
    added_time_ms: Date.parse(rf.added_time),
    current_title_at_cache_time: rf.current_title ?? rf.current_designation ?? null,
    current_company_at_cache_time: rf.current_organization ?? null,
    cached_at_ms: Date.now(),
  };
}

/**
 * Build a thin jobs_v2 row. Accepts both /job/list shape (company.name) and
 * /candidate/get's jobs[] shape (client_company_name flat).
 *
 * canonical_pipeline_json is set ONLY by the new-job-discovery path in cron;
 * pure normalization here leaves it null.
 */
export function toJobThinRow(rf) {
  if (!rf?.created_time) {
    throw new Error(`toJobThinRow: rf.created_time is required (id=${rf?.id})`);
  }
  return {
    id: rf.id,
    name: rf.name ?? rf.title ?? null,
    client_company_name: rf.client_company_name ?? rf.company?.name ?? null,
    added_time_ms: Date.parse(rf.created_time),
    canonical_pipeline_json: null,
    cached_at_ms: Date.now(),
  };
}

/**
 * Build a calls row from a Dialpad /v2/call response item OR a hangup webhook
 * payload (the schemas overlap on every field we use).
 */
export function toCallRow(dp) {
  return {
    call_id: String(dp.call_id),
    target_dialpad_id: String(dp.target?.id ?? ''),
    dialpad_contact_id: dp.contact?.id ?? null,
    rf_candidate_id: extractRFIdFromContactId(dp.contact?.id),
    date_started_ms: Number(dp.date_started),
    duration_ms: Math.round(Number(dp.total_duration ?? 0)),
    direction: dp.direction ?? null,
    cached_at_ms: Date.now(),
  };
}

/**
 * Transform a canonical RF candidate object into D1 `candidate_jobs` rows.
 * Returns one row per entry in rf.jobs[].
 * Returns [] if rf.jobs is missing or not an array.
 *
 * @param {object} rf - RF candidate
 * @returns {Array<{
 *   candidate_id: number,
 *   job_id: number,
 *   stage_id: number|null,
 *   stage_name: string|null,
 *   stage_moved: string|null,
 *   added_to_job: string|null,
 *   added_to_job_by_id: number|null,
 *   disqualified: 0|1,
 *   disqualification_reason: string|null
 * }>}
 */
export function toCandidateJobRows(rf) {
  if (!Array.isArray(rf.jobs)) return [];
  return rf.jobs.map(j => ({
    candidate_id: rf.id,
    job_id: j.job_id,
    // RF /candidate/list and /candidate/get both lack `stage_id` on job links;
    // /candidate/get's `stages[]` array carries IDs but jobs don't reference them
    // by id directly. Leave null and use stage_name everywhere.
    stage_id: j.stage_id ?? null,
    stage_name: j.stage_name ?? null,
    stage_moved: j.stage_moved ?? null,
    // RF returns the per-job "added" timestamp under `added_time` — accept the
    // internal `added_to_job` name as a fallback for forward compatibility.
    added_to_job: j.added_to_job ?? j.added_time ?? null,
    added_to_job_by_id: j.added_to_job_by?.id ?? null,
    // RF has no boolean `disqualified` field on job links — derive from the
    // stage name. Any stage explicitly named "Disqualified" counts as DQ.
    disqualified: (typeof j.disqualified === 'boolean' ? j.disqualified
                  : j.stage_name === 'Disqualified') ? 1 : 0,
    disqualification_reason: j.disqualification_reason ?? null,
  }));
}
