/**
 * RecruiterFlow API Client
 */

import {
  getCachedConsultantForJobLink, cacheConsultantForJobLink,
  cacheCandidateDetails, getCachedCandidateDetails,
  cacheCandidateActivities, getCachedCandidateActivities,
} from './cache.js';
import { getUserByFirstName } from './users.js';
import { canonicalizeRFCandidate } from './rf-canonical.js';

/**
 * Typed errors thrown by RF helpers so callers (MCP handlers) can distinguish
 * rate limits / transient failures / hard failures and react appropriately.
 *
 * Network failures (fetch() itself throwing) are NOT wrapped — the original
 * TypeError / AbortError / etc. propagates so the generic handler catch can
 * report it as "rf_unavailable".
 */
export class RFError extends Error {
  constructor(message, { status, body, retryAfterMs } = {}) {
    super(message);
    this.name = 'RFError';
    this.status = status;        // number | undefined
    this.body = body;            // raw response text or null
    this.retryAfterMs = retryAfterMs; // number | undefined
  }
}

export class RFRateLimitedError extends RFError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'RFRateLimitedError';
  }
}

export class RFTransientError extends RFError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'RFTransientError';
  }
}

/**
 * Thrown when an update fails with a 409 "phone/email already exists" conflict
 * that the dedupe handler could NOT resolve — i.e. we couldn't locate the other
 * candidate that owns the colliding value (RF search miss / normalization gap),
 * so we couldn't free it for the target. Distinct from a plain RFError so callers
 * (the calendar flow in particular) can recognise it and degrade gracefully —
 * continue stage movement / Dialpad upsert / cache — instead of dying.
 */
export class RFContactConflictUnresolvedError extends RFError {
  constructor(message, opts) {
    super(message, opts);
    this.name = 'RFContactConflictUnresolvedError';
  }
}

/**
 * Maximum Retry-After we will surface to callers. RFC 7231 allows seconds or
 * an HTTP-date; anything beyond 60s is almost certainly a server-side bug, so
 * we cap to avoid asking callers to back off indefinitely.
 */
const RETRY_AFTER_CAP_MS = 60_000;

/**
 * Parse a `Retry-After` header value into milliseconds.
 *
 * Accepts:
 *   - Integer seconds (`"5"` → 5000)
 *   - HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"` → diff vs now in ms)
 *
 * Returns `undefined` for missing / invalid / negative values. Result is
 * always capped at RETRY_AFTER_CAP_MS so callers can't be asked to wait
 * absurd amounts of time.
 *
 * @param {string|null|undefined} headerValue
 * @returns {number|undefined}
 */
export function parseRetryAfter(headerValue) {
  if (headerValue === null || headerValue === undefined) return undefined;
  const raw = String(headerValue).trim();
  if (!raw) return undefined;

  // Integer-seconds form. `/^\d+$/` rejects negatives and decimals (RFC 7231
  // says delta-seconds is a non-negative integer).
  if (/^\d+$/.test(raw)) {
    const seconds = parseInt(raw, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    const ms = seconds * 1000;
    return Math.min(ms, RETRY_AFTER_CAP_MS);
  }

  // HTTP-date form per RFC 7231 — always contains an alphabetic month name
  // (Jan…Dec) and / or weekday (Mon…Sun). Requiring at least one ASCII letter
  // rules out edge-cases where `Date.parse` mis-interprets a bare number like
  // `-5` (which V8 treats as a sparse year format).
  if (!/[A-Za-z]/.test(raw)) return undefined;
  const parsedTs = Date.parse(raw);
  if (Number.isNaN(parsedTs)) return undefined;
  const diffMs = parsedTs - Date.now();
  if (diffMs <= 0) return 0;
  return Math.min(diffMs, RETRY_AFTER_CAP_MS);
}

/**
 * Classify a non-2xx RF response into the appropriate typed error.
 *
 *   - 429                 → RFRateLimitedError (with parsed Retry-After)
 *   - 5xx (>=500, <=599)  → RFTransientError
 *   - everything else     → RFError
 *
 * @param {Response} res
 * @param {string|null} body
 * @returns {RFError}
 */
export function classifyRFResponse(res, body) {
  const status = res.status;
  if (status === 429) {
    return new RFRateLimitedError('RF rate limited (429)', {
      status,
      body,
      retryAfterMs: parseRetryAfter(res.headers.get('Retry-After')),
    });
  }
  if (status >= 500 && status <= 599) {
    return new RFTransientError(`RF transient error: ${status}`, { status, body });
  }
  return new RFError(`RF API error: ${status} - ${body}`, { status, body });
}

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
 * Update candidate in RecruiterFlow.
 *
 * Universal non-destructive dedupe is built in: RF enforces uniqueness on phone
 * and email, so an update that adds a value already owned by a DIFFERENT
 * candidate fails with `409 "A profile with this Phone Number/Email already
 * exists"`. That collision is almost always a stale duplicate record (added with
 * a wrong/missing LinkedIn so it never deduped). The target record is canonical
 * (it carries the correct LinkedIn from the extension), so we trust it: strip the
 * value from the other record and retry. See `resolveContactFieldConflict`.
 *
 * @param {string|number} candidateId
 * @param {object} updateData
 * @param {object} env
 * @param {{ dedupe?: boolean, _depth?: number }} [options] - `dedupe:false`
 *        disables the conflict handler (used for the internal strip-update).
 *        `_depth` bounds resolution passes so a record colliding on BOTH phone
 *        and email gets each freed in turn, while still terminating.
 */
export async function updateRFCandidate(candidateId, updateData, env, options = {}) {
  const { dedupe = true, _depth = 0 } = options;
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

  if (response.ok) {
    return JSON.parse(responseText);
  }

  const error = classifyRFResponse(response, responseText);

  // Phone/email uniqueness conflict → run the dedupe handler, then retry. Bound
  // to 2 passes (one per field: phone + email) so it always terminates.
  const conflictField = (dedupe && _depth < 2) ? detectContactConflictField(error, updateData) : null;
  if (conflictField) {
    await resolveContactFieldConflict({ targetId: candidateId, field: conflictField, updateData, env });
    // Owner(s) stripped — retry. A second collision (the other field) gets one
    // more resolution pass; depth 2 then re-enters this same branch and, finding
    // it can't resolve further, throws the typed unresolved error below.
    return await updateRFCandidate(candidateId, updateData, env, { dedupe, _depth: _depth + 1 });
  }

  // A contact 409 we won't auto-resolve (passes exhausted, or the strip didn't
  // free the value) surfaces as the typed unresolved error — never the raw
  // RFError — so every caller can discriminate it from generic RF failures and
  // degrade gracefully. (dedupe:false internal strip-updates skip this and throw
  // raw, which is correct: a strip-update should never hit a uniqueness 409.)
  if (dedupe && detectContactConflictField(error, updateData)) {
    throw new RFContactConflictUnresolvedError(
      `RF contact conflict for candidate=${candidateId} unresolved after ${_depth} dedupe pass(es)`,
      { status: error.status, body: error.body },
    );
  }

  throw error;
}

// RF's exact 409 conflict messages (confirmed in production logs):
//   {"message":"A profile with this Phone Number already exists"}
//   {"message":"A profile with this Email already exists"}
const RF_PHONE_CONFLICT_RE = /this phone number already exists/i;
const RF_EMAIL_CONFLICT_RE = /this email already exists/i;

/**
 * Decide whether an RF error is a phone/email uniqueness conflict we can dedupe.
 * Returns 'phone' | 'email' | null. Gated on the update actually having touched
 * that field, so an unrelated 409 never triggers the (destructive-to-the-other-
 * record) strip path.
 */
function detectContactConflictField(error, updateData) {
  if (!(error instanceof RFError) || error.status !== 409) return null;
  const body = String(error.body || error.message || '');
  // Require the update to actually carry a non-empty value for the field — an
  // empty array can't be the source of a uniqueness conflict, and gating on it
  // would send the resolver looking for an owner of nothing.
  const has = (v) => (Array.isArray(v) ? v.length > 0 : v != null);
  if (has(updateData.phone_number) && RF_PHONE_CONFLICT_RE.test(body)) return 'phone';
  if (has(updateData.email) && RF_EMAIL_CONFLICT_RE.test(body)) return 'email';
  return null;
}

const FIELD_KEY = { phone: 'phone_number', email: 'email' };

/** Strip a contact value (string or {phone_number|email|value}) to a bare string. */
function extractContactValue(field, item) {
  if (item == null) return null;
  if (typeof item === 'string') return item;
  if (typeof item === 'object') {
    return field === 'phone'
      ? (item.phone_number || item.value || null)
      : (item.email || item.value || null);
  }
  return null;
}

/** Strip all non-digits — phone equality is digit-only (handles +1 / formatting). */
function normalizePhoneDigits(p) {
  return String(p || '').replace(/\D/g, '');
}

/**
 * Phone equality tolerant of country-code drift: two numbers match if their full
 * digit strings are equal OR their last 10 digits are equal (e.g. "+1 555…" vs a
 * bare "555…"). Used by BOTH the owner search and the strip so the value we
 * locate is the value we remove — they must agree.
 */
function phoneDigitsMatch(a, b) {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (!da || !db) return false;
  return da === db || da.slice(-10) === db.slice(-10);
}

/**
 * Normalise one element of an RF email/phone array into the object shape the
 * UPDATE endpoint expects ({email,is_primary} / {phone_number,type}), preserving
 * existing primary/type flags. Returns null for empty entries.
 */
function normalizeContactItem(field, item) {
  if (field === 'phone') {
    if (typeof item === 'string') return item ? { phone_number: item, type: 1 } : null;
    const pn = item?.phone_number || item?.value;
    return pn ? { phone_number: pn, type: item?.type ?? 1 } : null;
  }
  if (typeof item === 'string') return item ? { email: item, is_primary: 0 } : null;
  const em = item?.email || item?.value;
  return em ? { email: em, is_primary: item?.is_primary ?? 0 } : null;
}

/**
 * Assess how "thin" the OTHER (losing) record is. A record with no jobs and no
 * resume file is a deletion candidate; anything richer should be merged by a
 * human. Uses only fields reliably present on a `/candidate/get` body.
 */
function assessThinness(owner) {
  const jobs = Array.isArray(owner.jobs) ? owner.jobs : [];
  const files = Array.isArray(owner.files) ? owner.files : [];
  const thinSignals = [];
  if (jobs.length === 0) thinSignals.push('no_jobs');
  if (files.length === 0) thinSignals.push('no_resume');
  if (!owner.current_organization) thinSignals.push('no_organization');
  if (!owner.current_title) thinSignals.push('no_title');
  // Deletion candidate only when it has neither pipeline history nor a resume.
  const isThin = jobs.length === 0 && files.length === 0;
  return { isThin, thinSignals, jobCount: jobs.length, fileCount: files.length };
}

/**
 * Non-blocking "is this the same person?" signal for the audit log. The strip
 * happens regardless (we trust the target); this just lets a human spot a
 * mis-fire. RF guarantees the two records have DIFFERENT LinkedIn slugs (that's
 * why the duplicate exists), so identity leans on name + work-history overlap.
 */
function buildSamePersonSignal(target, owner) {
  if (!target) return { nameMatch: 'unknown', orgOverlap: null };

  const norm = (s) => String(s || '').trim().toLowerCase();
  const tName = norm(`${target.first_name || ''} ${target.last_name || ''}`) || norm(target.name);
  const oName = norm(`${owner.first_name || ''} ${owner.last_name || ''}`) || norm(owner.name);
  let nameMatch = 'unknown';
  if (tName && oName) {
    if (tName === oName) nameMatch = 'exact';
    else {
      const tTok = new Set(tName.split(/\s+/).filter(Boolean));
      const oTok = oName.split(/\s+/).filter(Boolean);
      nameMatch = oTok.some((t) => tTok.has(t)) ? 'partial' : 'none';
    }
  }

  // Work-history overlap proxy: current_organization + any job client company.
  const orgs = (c) => {
    const set = new Set();
    if (c.current_organization) set.add(norm(c.current_organization));
    (Array.isArray(c.jobs) ? c.jobs : []).forEach((j) => {
      if (j?.client_company_name) set.add(norm(j.client_company_name));
    });
    return set;
  };
  const tOrgs = orgs(target);
  const oOrgs = orgs(owner);
  const shared = [...oOrgs].filter((o) => tOrgs.has(o));
  const orgOverlap = (tOrgs.size && oOrgs.size) ? (shared.length > 0) : null;

  return { nameMatch, orgOverlap, sharedOrgs: shared };
}

/**
 * Resolve a phone/email uniqueness conflict non-destructively.
 *
 * For each colliding value in the update, find the OTHER candidate that owns it
 * (RF's uniqueness constraint → exactly one), strip the value from that record,
 * and emit a detailed `source:'dedupe'` audit log so a human can review/merge.
 * We never delete the other candidate.
 *
 * Throws RFContactConflictUnresolvedError if no other owner can be located for
 * any colliding value — the caller's try/catch then degrades gracefully.
 */
async function resolveContactFieldConflict({ targetId, field, updateData, env }) {
  const fieldKey = FIELD_KEY[field];
  const raw = Array.isArray(updateData[fieldKey]) ? updateData[fieldKey] : [updateData[fieldKey]];
  const values = raw.map((v) => extractContactValue(field, v)).filter(Boolean);

  // Target body is for the same-person signal only — never block on it.
  let target = null;
  try {
    target = await getRFCandidate(targetId, env);
  } catch (e) {
    console.warn({ message: `[Dedupe] could not load target candidate=${targetId} for signal: ${e.message}`, source: 'dedupe', candidateId: targetId });
  }

  let resolvedAny = false;
  for (const value of values) {
    const owner = field === 'phone'
      ? await searchRFCandidateByPhone(value, env)
      : await searchRFCandidateByEmail(value, env);

    // Not the culprit: no owner found, or the value already belongs to the target.
    if (!owner || String(owner.id) === String(targetId)) continue;

    // Pull the full owner body so we strip against the complete array and have
    // jobs/files/org for the thinness + same-person assessment.
    const ownerFull = await getRFCandidate(owner.id, env);

    const existing = Array.isArray(ownerFull[fieldKey]) ? ownerFull[fieldKey] : [];
    const normalized = existing.map((item) => normalizeContactItem(field, item)).filter(Boolean);

    const matches = (item) => field === 'phone'
      ? phoneDigitsMatch(item.phone_number, value)
      : String(item.email).toLowerCase() === String(value).toLowerCase();

    // VERIFY the located record genuinely holds the value before we mutate it.
    // RF's /candidate/search is substring/loose (esp. for email — see
    // searchRFCandidateByEmail), so a search hit is NOT proof of ownership. Strip
    // and search must stay in lockstep: if the value isn't actually on this
    // record, this isn't the real owner — skip it (conflict stays unresolved →
    // caller degrades gracefully) rather than mutating the wrong candidate.
    const removed = normalized.filter(matches);
    if (removed.length === 0) {
      console.warn({
        message: `[Dedupe] search hit candidate=${owner.id} does not actually hold ${field} "${value}" (RF loose match) — skipping`,
        source: 'dedupe',
        flag: 'search_false_positive',
        field,
        value,
        searchHitId: owner.id,
        toCandidateId: targetId,
      });
      continue;
    }

    let kept = normalized.filter((item) => !matches(item));

    // Keep the losing record well-formed: if we removed the primary email and
    // survivors remain with none flagged primary, promote the first survivor so
    // the record isn't left without a primary email.
    if (field === 'email'
      && removed.some((e) => e.is_primary === 1)
      && kept.length > 0
      && !kept.some((e) => e.is_primary === 1)) {
      kept = kept.map((e, i) => (i === 0 ? { ...e, is_primary: 1 } : e));
    }

    // Removal can't trip the uniqueness constraint → dedupe:false (also avoids
    // re-entry). Non-destructive: the candidate stays, only the value leaves.
    await updateRFCandidate(owner.id, { [fieldKey]: kept }, env, { dedupe: false });

    const { isThin, thinSignals, jobCount, fileCount } = assessThinness(ownerFull);
    const samePersonSignal = buildSamePersonSignal(target, ownerFull);
    const flag = isThin ? 'review_delete' : 'manual_merge';

    // Distinctive, fully-detailed audit record (both ids + names, value, flag,
    // signals). `source:'dedupe'` + warn level is the hook for the #rf-alerts
    // LaunchDarkly alert rule. console.warn (not error): the conflict WAS
    // resolved — this needs human review, it is not a failure.
    console.warn({
      message: `[Dedupe] ${field} "${value}" moved from candidate=${ownerFull.id} (${ownerFull.name || '?'}) → candidate=${targetId} (${target?.name || '?'}); flag=${flag}`,
      source: 'dedupe',
      flag,
      field,
      value,
      fromCandidateId: ownerFull.id,
      fromCandidateName: ownerFull.name || null,
      toCandidateId: targetId,
      toCandidateName: target?.name || null,
      oldRecord: {
        jobCount,
        fileCount,
        addedOn: ownerFull.added_on || ownerFull.added_time || null,
        currentOrganization: ownerFull.current_organization || null,
        thinSignals,
      },
      samePersonSignal,
    });

    resolvedAny = true;
  }

  if (!resolvedAny) {
    const err = new RFContactConflictUnresolvedError(
      `RF ${field} conflict for candidate=${targetId} could not be resolved — no other owner found for: ${values.join(', ')}`,
      { status: 409 },
    );
    console.error({
      message: err.message,
      source: 'dedupe',
      flag: 'conflict_unresolved',
      candidateId: targetId,
      field,
      values,
    });
    throw err;
  }
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
    throw classifyRFResponse(response, errorText);
  }

  return await response.json();
}

/**
 * Check if a LinkedIn answer is actually a valid LinkedIn URL.
 * Accepts URLs with or without `https?://` and `www.` — Reclaim form
 * inputs frequently lack the protocol (e.g. "Linkedin.com/in/foo"), and
 * normalizeLinkedInUrl below canonicalizes both forms to the same key.
 */
export function isValidLinkedInUrl(answer) {
  if (!answer || typeof answer !== 'string') return false;
  return /linkedin\.com\/(in|pub)\//i.test(answer.trim());
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
 * Retries once on any 5xx (transient) — RF's edge occasionally returns
 * transient failures and the cost of a single retry is far cheaper than
 * failing the whole /candidate-details response and forcing the user to
 * refresh. Does NOT retry on 429 (rate limit): propagate immediately so the
 * caller can respect Retry-After.
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
      return canonicalizeRFCandidate(result.candidate || result);
    }

    const errorText = await response.text();
    const err = classifyRFResponse(response, errorText);

    if (err instanceof RFTransientError && attempt === 1) {
      console.warn({
        message: `[RF get] ${response.status} for candidate=${candidateId}, retrying once`,
        source: 'rf-get',
        candidateId,
      });
      continue;
    }

    console.error(`RF get error: ${response.status}`, errorText);
    throw err;
  }

  // Unreachable — the loop either returns or throws on every iteration
  throw new RFError('RF API error: unreachable');
}

/**
 * GET /job?job_id=… — full job body for a single id. Used by the MCP
 * Phase 2 live-rerank path to read mutable fields (`is_open`, `job_status`,
 * etc.) that intentionally aren't in the thin v2 cache.
 *
 * Endpoint shape: `GET /api/external/job?job_id=X&include_stages=1`
 * (NOT `/job/get` — that doesn't exist and returns RF's marketing-site
 * HTML fallback; learned 2026-05-12). Returns the bare job body with
 * `is_open: true|false` at the top level.
 *
 * One-shot retry on 5xx transient; propagates RFRateLimitedError on 429
 * so the caller can degrade (Phase 2 callers absorb individual fan-out
 * failures rather than aborting the whole rerank).
 *
 * @param {number|string} jobId
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.includeStages=false] — append &include_stages=1 to fetch the stages[] array (heavier; only request when needed)
 */
export async function getRFJob(jobId, env, opts = {}) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';
  if (!rfApiKey) throw new Error('RF_API_KEY environment variable is required');
  const stagesParam = opts.includeStages ? '&include_stages=1' : '';
  const url = `${rfBaseUrl}/job?job_id=${encodeURIComponent(jobId)}${stagesParam}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(url, { method: 'GET', headers: { 'RF-Api-Key': rfApiKey } });
    if (response.ok) {
      const result = await response.json();
      // Defensive: RF returns the bare body, but some deployments wrap it.
      return result?.job || result;
    }
    const errorText = await response.text();
    const err = classifyRFResponse(response, errorText);
    if (err instanceof RFTransientError && attempt === 1) {
      console.warn({
        message: `[RF job] ${response.status} for job=${jobId}, retrying once`,
        source: 'rf-job-get',
        jobId,
      });
      continue;
    }
    console.error({
      message: `RF /job error job=${jobId} status=${response.status} body=${errorText}`,
      source: 'rf-job-get',
      jobId,
    });
    throw err;
  }
  // Unreachable — the loop either returns or throws on every iteration
  throw new RFError('RF /job unreachable');
}

/**
 * GET /job/pipeline?job_id=… — live pass-through used by the MCP pipeline
 * tools (/mcp/job-pipeline + /mcp/job-candidates-filter).
 *
 * Per spec rev 5 RF-4 verification (thin-immutable cache design):
 * RF returns `{summary: [{id, name, count}], detail: [{candidate: {id, name},
 * stages: [{from, time, to}]}]}` in one GET. `summary[]` is the canonical
 * ordered pipeline (includes 0-count stages and `Disqualified`); `detail[]`
 * carries each candidate's full stage-movement history — the most recent
 * `stages[].time` `to` is their current stage. No documented pagination at
 * this scale (largest job's `detail[]` is "a few hundred").
 *
 * One-shot retry on any 5xx (transient) — RF's edge produces transient 5xx
 * on read paths. Does NOT retry on 429: propagate immediately so callers
 * can respect Retry-After.
 */
export async function fetchRFJobPipeline(env, jobId) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';
  if (!rfApiKey) throw new Error('RF_API_KEY environment variable is required');
  const url = `${rfBaseUrl}/job/pipeline?job_id=${encodeURIComponent(jobId)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(url, { method: 'GET', headers: { 'RF-Api-Key': rfApiKey } });
    if (response.ok) return response.json();
    const errorText = await response.text();
    const err = classifyRFResponse(response, errorText);
    if (err instanceof RFTransientError && attempt === 1) {
      console.warn({
        message: `[RF pipeline] ${response.status} for job=${jobId}, retrying once`,
        source: 'rf-job-pipeline',
        jobId,
      });
      continue;
    }
    console.error({
      message: `RF /job/pipeline error job=${jobId} status=${response.status} body=${errorText}`,
      source: 'rf-job-pipeline',
      jobId,
    });
    throw err;
  }
  // Unreachable — the loop either returns or throws on every iteration
  throw new RFError('RF /job/pipeline unreachable');
}

/**
 * GET /candidate/custom-field/list — full custom-field schema for the RF
 * account. Used by `src/mcp/custom-fields.js` to build a name→id map so
 * MCP `technology` / `segment` / `role` filters can be routed through RF as
 * the canonical `custom_field.<id>` filter shape (per spec rev 5 RF-7).
 *
 * Response shape: `{data: [{id, name, type, options: [...]}, ...]}` per the
 * RF API contract. Each entry carries the numeric `id` and a `name` we match
 * case-insensitively, plus an enumerated `options` list for single-select /
 * multi-select fields (empty for text fields).
 *
 * One-shot retry on any 5xx (transient); does NOT retry on 429 (caller
 * respects Retry-After via the typed RFRateLimitedError).
 */
export async function fetchRFCustomFieldList(env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';
  if (!rfApiKey) throw new Error('RF_API_KEY environment variable is required');
  const url = `${rfBaseUrl}/candidate/custom-field/list`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(url, { method: 'GET', headers: { 'RF-Api-Key': rfApiKey } });
    if (response.ok) {
      const result = await response.json();
      // Tolerate {data:[...]}, {fields:[...]}, or a bare array.
      if (Array.isArray(result?.data)) return result.data;
      if (Array.isArray(result?.fields)) return result.fields;
      if (Array.isArray(result)) return result;
      return [];
    }
    const errorText = await response.text();
    const err = classifyRFResponse(response, errorText);
    if (err instanceof RFTransientError && attempt === 1) {
      console.warn({
        message: `[RF custom-field/list] ${response.status}, retrying once`,
        source: 'rf-custom-field-list',
      });
      continue;
    }
    console.error({
      message: `RF /candidate/custom-field/list error status=${response.status} body=${errorText}`,
      source: 'rf-custom-field-list',
    });
    throw err;
  }
  // Unreachable — the loop either returns or throws on every iteration
  throw new RFError('RF /candidate/custom-field/list unreachable');
}

// ───────────────────────── Stage-movement surface ──────────────────────────
// Used by the stage-stats plane (src/stage-stats.js). Two load-bearing RF
// quirks live here (each cost a debugging session the first time they were
// hit, on the dashboard side):
//
//  1. `after`/`before` MUST be seconds-precision ISO-8601
//     (`2026-06-08T00:00:00Z`). A sub-second timestamp makes RF 400 every
//     call — `formatRFSeconds` truncates milliseconds.
//  2. RF's `entered` timestamps use `+0000` (no colon in the offset).
//     `parseRFTimestamp` accepts `+0000`, `+00:00`, `Z`, and a
//     fractional-seconds variant. The VERBATIM string is kept alongside the
//     parsed ms — it is the stage-events dedup identity (`entered_raw`);
//     never normalise it.

/**
 * UTC epoch ms → seconds-precision ISO-8601 (`2026-06-08T00:00:00Z`).
 * RF's stage-movement endpoint 400s on sub-second timestamps.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatRFSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const RF_TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Parse an RF timestamp string to UTC epoch ms. Accepts `%Y-%m-%dT%H:%M:%S%z`
 * with `+0000` (RF's usual shape), `+00:00`, bare `Z`, and an optional
 * fractional-seconds component. Returns null for anything else — callers keep
 * the verbatim string regardless (it is the identity; the parse is only for
 * window math).
 *
 * @param {string|null|undefined} s
 * @returns {number|null}
 */
export function parseRFTimestamp(s) {
  if (typeof s !== 'string') return null;
  const m = RF_TS_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac, off] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (frac) ms += Math.round(parseFloat(`0.${frac}`) * 1000);
  if (off !== 'Z') {
    const sign = off[0] === '-' ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const offsetMin = sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2), 10));
    ms -= offsetMin * 60_000;
  }
  return ms;
}

/** Bounded backoff for RF bursts: attempt, ~0.4s, attempt, ~1.6s, attempt. */
const STAGE_RETRY_DELAYS_MS = [400, 1600];

/**
 * Send one RF request with a bounded burst backoff: 3 attempts total,
 * retrying on 429 (RFRateLimitedError), 5xx (RFTransientError), and network
 * throws, with jittered 0.4s → 1.6s delays. Bulk stage-moves in RF fan out as
 * many near-simultaneous webhook invocations each fetching from RF — the
 * backoff absorbs the burst limit; anything that still fails is healed by the
 * hourly reconcile. (The one-shot-retry helpers above serve interactive MCP
 * paths where a caller is waiting; this one serves machine paths where
 * waiting two extra seconds is free.)
 *
 * @param {() => Promise<Response>} doFetch - invoked fresh each attempt
 * @param {string} what - request description for logs/errors
 * @returns {Promise<any>} parsed JSON body
 */
export async function rfRequestWithRetry(doFetch, what) {
  let lastError;
  for (let attempt = 0; attempt < STAGE_RETRY_DELAYS_MS.length + 1; attempt++) {
    if (attempt > 0) {
      const jitter = Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, STAGE_RETRY_DELAYS_MS[attempt - 1] + jitter));
    }
    let response;
    try {
      response = await doFetch();
    } catch (err) {
      lastError = err; // network-level throw — retryable
      continue;
    }
    if (response.ok) {
      return await response.json();
    }
    const body = await response.text().catch(() => null);
    const error = classifyRFResponse(response, body);
    if (error instanceof RFRateLimitedError || error instanceof RFTransientError) {
      lastError = error;
      continue;
    }
    throw error; // hard 4xx — retrying won't help
  }
  console.warn({
    message: `[RF retry] request exhausted retries: ${what}: ${lastError?.message}`,
    source: 'rf-retry',
    what,
    error: lastError?.message,
  });
  throw lastError;
}

/**
 * Fetch one candidate's stage transitions in `[afterMs, beforeMs)` from RF's
 * TRANSACTIONAL stage-movement store (instantly consistent, carries the
 * mover — unlike the lagging search index).
 *
 * @param {*} env
 * @param {number} candidateId
 * @param {number} afterMs
 * @param {number} beforeMs
 * @returns {Promise<Array<{jobId: number, fromStage: string|null, toStage: string|null,
 *                          enteredRaw: string|null, enteredMs: number|null, moverRfId: number|null}>>}
 */
export async function fetchStageMovements(env, candidateId, afterMs, beforeMs) {
  const base = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';
  const params = new URLSearchParams({
    id: String(candidateId),
    after: formatRFSeconds(afterMs),
    before: formatRFSeconds(beforeMs),
  });
  const url = `${base}/candidate/activities/stage-movement/list?${params}`;
  const data = await rfRequestWithRetry(
    () => fetch(url, { headers: { 'RF-Api-Key': env.RF_API_KEY } }),
    `stage-movement candidate ${candidateId}`,
  );

  const out = [];
  const jobs = data?.data?.jobs ?? [];
  for (const job of jobs) {
    const jobId = toIntOrNull(job?.id) ?? 0;
    for (const tr of job?.transitions ?? []) {
      const enteredRaw = typeof tr?.entered === 'string' ? tr.entered : null;
      out.push({
        jobId,
        fromStage: typeof tr?.from === 'string' ? tr.from : null,
        toStage: typeof tr?.to === 'string' ? tr.to : null,
        enteredRaw,
        enteredMs: parseRFTimestamp(enteredRaw),
        moverRfId: toIntOrNull(tr?.stage_moved_by?.id),
      });
    }
  }
  return out;
}

/** Number | numeric string → integer; anything else → null. */
export function toIntOrNull(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
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
 * Search RF for a candidate by phone number — the owner-lookup the dedupe
 * handler needs when an update 409s on phone uniqueness.
 *
 * RF's `/candidate/search` does loose (substring) matching and formats vary
 * (+1, spaces, dashes), so we post-filter on digit-only equality against the
 * returned candidates' phone arrays. Returns the first true match or null.
 */
export async function searchRFCandidateByPhone(phone, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const wantDigits = normalizePhoneDigits(phone);
  if (!wantDigits) return null;

  try {
    const response = await fetch(`${rfBaseUrl}/candidate/search`, {
      method: 'POST',
      headers: {
        'RF-Api-Key': rfApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filters: [{ conjunction: 'in', values: [phone], key: 'phone_number' }],
        conjunction: 'match-all',
        current_page: 1,
        items_per_page: 10
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error({ message: `RF phone search error status=${response.status} body=${errorText}`, source: 'rf-search' });
      return null;
    }

    const result = await response.json();
    const candidates = Array.isArray(result) ? result : (result.candidates || result.data || result.results || []);

    // Post-filter on digit-only equality (RF search is substring/loose). Compare
    // against every phone the candidate carries, tolerant of country-code drift —
    // the SAME comparison the strip uses, so search and strip stay in lockstep.
    const match = candidates.find((c) => {
      const phones = Array.isArray(c.phone_number) ? c.phone_number : (c.phone_number ? [c.phone_number] : []);
      return phones.some((p) => phoneDigitsMatch(extractContactValue('phone', p), phone));
    });

    return match || null;
  } catch (error) {
    console.error({ message: `RF phone search failed: ${error.message}`, source: 'rf-search' });
    return null;
  }
}

/**
 * Add a note to an RF candidate. Attribution (`createdBy`) is required —
 * callers pass the consultant's RF user id (resolved from the Access JWT
 * upstream in the /mcp/* surface).
 */
export async function addRFCandidateNote(candidateId, htmlContent, createdBy, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const payload = {
    created_by: createdBy,
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
    throw classifyRFResponse(response, errorText);
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
    throw classifyRFResponse(response, errorText);
  }

  return await response.json();
}

/**
 * Stage names eligible for automatic move to "Call Booked".
 */
const CALL_BOOKED_ELIGIBLE_STAGES = ['Sourced', 'Replied', 'Replied (Cold)'];
const CALL_BOOKED_TARGET = 'Call Booked';

/**
 * Find the most-recently-moved job on a candidate and check if it's
 * eligible for stage movement to "Call Booked".
 *
 * Joel's RF user id is passed in by the caller (resolved from the D1
 * users table, the source of truth) — this keeps the function pure / sync.
 *
 * @param {object} candidate - Full candidate object from GET /candidate/get (must include jobs array)
 * @param {number} joelRfUserId - Joel's RF user id, looked up via getUserByFirstName(env, 'Joel')
 * @returns {{ job_id: number, targetStage: { id: number, name: string }, userId: number } | null}
 */
export function findEligibleJob(candidate, joelRfUserId) {
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
    userId: joelRfUserId,
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
  const joel = await getUserByFirstName(env, 'Joel');
  if (!joel) {
    throw new Error('moveToCallBooked: Joel not found in users table — cannot resolve userId for stage move');
  }
  const eligible = findEligibleJob(candidateData, joel.rfUserId);

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
    throw classifyRFResponse(response, errorText);
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
      throw classifyRFResponse(response, errorText);
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
    let jobs = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'RF-Api-Key': rfApiKey },
      });

      if (response.ok) {
        jobs = await response.json();
        break;
      }

      const errorText = await response.text();
      const err = classifyRFResponse(response, errorText);
      if (err instanceof RFTransientError && attempt === 1) {
        console.warn({
          message: `[RF job/list] ${response.status} on page=${page}, retrying once`,
          source: 'rf-job-list',
          page,
        });
        continue;
      }
      console.error(`RF job/list error: ${response.status}`, errorText);
      throw err;
    }

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
  return searchCandidatesByFilters({
    filters: [
      { conjunction: 'in', values: [parseInt(jobId, 10)], key: 'job' },
      { conjunction: 'in', values: [stageName], key: 'stage' },
    ],
    maxPages,
  }, env);
}

/**
 * Single-call tier-2 search: RF /candidate/search with `candidate_id IN (ids)`
 * intersected with additional mutable predicate filters server-side via
 * `conjunction: 'match-all'`.
 *
 * Per spec rev 5 RF-1 + RF-7 verification (thin-immutable cache design):
 * `candidate_id` is a multi-select-by-ID filter (`{conjunction: 'in', values: [...], key: 'candidate_id'}`).
 * It composes with any other filter object (`email`, `current_company`,
 * `current_title`, `lead_owner`, `stage`, `job`, `custom_field.<id>`, etc.)
 * in the same `filters[]` array — the top-level `match-all` ANDs them.
 *
 * Empty / invalid id-list short-circuits to `{candidates: [], totalItems: 0}`
 * without hitting RF — saves the round-trip.
 *
 * @param {Object} args
 * @param {Array<number>} args.ids               id-list to intersect with predicate
 * @param {Array<Object>} args.predicateFilters  RF filter objects to AND with the id-list
 * @param {number} [args.maxPages=10]
 * @param {Object} env
 * @returns {Promise<{candidates: Array, totalItems: number|null}>}
 */
export async function searchCandidatesByIdsAndPredicate({ ids, predicateFilters, maxPages = 10 }, env) {
  const numericIds = (Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter(Number.isFinite);
  if (numericIds.length === 0) {
    return { candidates: [], totalItems: 0 };
  }
  const filters = [
    { conjunction: 'in', values: numericIds, key: 'candidate_id' },
    ...(Array.isArray(predicateFilters) ? predicateFilters : []),
  ];
  return searchCandidatesByFilters({ filters, maxPages }, env);
}

/**
 * Predicate-only candidate search — no id-list intersection. Used by the
 * mutable-filter-only path (no fuzzy `query`) where the caller wants RF to
 * narrow purely on predicate.
 *
 * @param {Object} args
 * @param {Array<Object>} args.predicateFilters  RF filter objects to AND together
 * @param {number} [args.maxPages=10]
 * @param {Object} env
 * @returns {Promise<{candidates: Array, totalItems: number|null}>}
 */
export async function searchCandidatesByPredicateOnly({ predicateFilters, maxPages = 10 }, env) {
  const filters = Array.isArray(predicateFilters) ? predicateFilters.slice() : [];
  if (filters.length === 0) {
    // Defensive — caller should never reach here with no filters; bail before
    // RF returns the entire account.
    return { candidates: [], totalItems: 0 };
  }
  return searchCandidatesByFilters({ filters, maxPages }, env);
}

/**
 * Internal — paginated `/candidate/search` with `conjunction: 'match-all'` over
 * the supplied filter array. Page size 100; loops until a short page or
 * `maxPages` reached. Used by both `searchCandidatesByIdsAndPredicate` and
 * `searchCandidatesByPredicateOnly`.
 *
 * Per-page one-shot 5xx retry (mirrors `getRFCandidate` + `fetchRFJobPipeline`).
 * Does NOT retry on 429: propagate immediately so callers can respect
 * Retry-After.
 */
async function searchCandidatesByFilters({ filters, maxPages = 10 }, env) {
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
      filters,
      include_count: true,
    };

    let result = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch(`${rfBaseUrl}/candidate/search`, {
        method: 'POST',
        headers: { 'RF-Api-Key': rfApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        result = await response.json();
        break;
      }

      const errorText = await response.text();
      const err = classifyRFResponse(response, errorText);
      if (err instanceof RFTransientError && attempt === 1) {
        console.warn({
          message: `[RF candidate/search] ${response.status} on page=${page}, retrying once`,
          source: 'rf-search',
          page,
          filterKeys: filters.map(f => f.key),
        });
        continue;
      }
      console.error({
        message: `RF candidate/search error status=${response.status} body=${errorText}`,
        source: 'rf-search',
        page,
        filterKeys: filters.map(f => f.key),
      });
      throw err;
    }

    const candidates = Array.isArray(result?.data)
      ? result.data
      : Array.isArray(result?.candidates)
        ? result.candidates
        : Array.isArray(result)
          ? result
          : [];
    if (typeof result?.total_items === 'number') totalItems = result.total_items;

    // Canonicalise per-row at the integration boundary so every downstream
    // MCP consumer reads `primary_email` / `phone_numbers` / `current_title`
    // / `jobs[].job_name` regardless of RF's wire-shape drift. Additive;
    // raw fields are preserved untouched.
    allCandidates.push(...candidates.map(canonicalizeRFCandidate));

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
    throw classifyRFResponse(response, errorText);
  }

  return await response.json();
}

/**
 * Read the consultant_id custom field for a job-candidate link.
 * Returns the numeric value (an RF user_id) or null if the field is unset.
 *
 * One-shot 5xx retry; 429 propagates immediately as RFRateLimitedError.
 */
export async function getJobCandidateConsultantId(candidateId, jobId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const url = `${rfBaseUrl}/job-candidate/custom-field/value/list?candidate_id=${candidateId}&job_id=${jobId}`;
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'RF-Api-Key': rfApiKey, 'Accept': 'application/json' },
    });

    if (response.ok) {
      result = await response.json();
      break;
    }

    const errorText = await response.text();
    const err = classifyRFResponse(response, errorText);
    if (err instanceof RFTransientError && attempt === 1) {
      console.warn({
        message: `[RF get-consultant-field] ${response.status} candidate=${candidateId} job=${jobId}, retrying once`,
        source: 'rf-get-consultant-field',
        candidateId,
        jobId,
      });
      continue;
    }
    console.error(`RF get-consultant-field error candidate=${candidateId} job=${jobId} status=${response.status}`, errorText);
    throw err;
  }

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
    // "Already in the job pipeline" is an expected, graceful outcome — not an
    // error. Return a signal instead of console.error + throw so this (very
    // common on re-adds) stops polluting the LaunchDarkly/CF error views. The
    // frontend already renders this as "already in pipeline". Detection mirrors
    // the breadth the caller previously used (any "already" + "pipeline"
    // wording, any 4xx) so RF status/phrasing drift can't reintroduce the noise.
    const lower = errorText.toLowerCase();
    if (lower.includes('already') && lower.includes('pipeline')) {
      return { status: 'already_in_job' };
    }
    console.error(`RF add-to-job error: ${response.status}`, errorText);
    throw classifyRFResponse(response, errorText);
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
 *
 * One-shot 5xx retry; 429 propagates immediately as RFRateLimitedError.
 */
export async function listCandidateActivities(candidateId, env) {
  const rfApiKey = env.RF_API_KEY;
  const rfBaseUrl = env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';

  if (!rfApiKey) {
    throw new Error('RF_API_KEY environment variable is required');
  }

  const url = `${rfBaseUrl}/candidate/activity/list?id=${candidateId}&items_per_page=50&current_page=1&include_count=true`;
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'RF-Api-Key': rfApiKey, 'Accept': 'application/json' },
    });

    if (response.ok) {
      result = await response.json();
      break;
    }

    const errorText = await response.text();
    const err = classifyRFResponse(response, errorText);
    if (err instanceof RFTransientError && attempt === 1) {
      console.warn({
        message: `[RF activity-list] ${response.status} candidate=${candidateId}, retrying once`,
        source: 'rf-activity-list',
        candidateId,
      });
      continue;
    }
    console.error(`RF activity-list error candidate=${candidateId} status=${response.status}`, errorText);
    throw err;
  }
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
