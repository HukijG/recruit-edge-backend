/**
 * Entity resolvers for the /mcp/* surface.
 *
 * Claude does NOT have RF ids. Claude has names. Every /mcp/* endpoint that
 * accepts an entity reference (`candidate`, `job`, `stage`, `owner`) routes
 * through one of these resolvers so a string like "Eon SE" or "call booked"
 * lands as a numeric id before the handler does anything else.
 *
 * Each resolver returns a discriminated union:
 *   { ok: true, value }                                        — unique match
 *   { ok: false, reason: 'not_found', input }                  — no match
 *   { ok: false, reason: 'ambiguous', kind, options, hint }    — too close to call
 *
 * Numeric inputs short-circuit the fuzzy step and behave exactly as the old
 * "numeric only" wire contract did. Pure-digit strings are coerced to numbers
 * before resolution since Claude often JSON-stringifies ids by accident.
 *
 * The disambiguation envelope (`kind`, `options`, `hint`) is shaped to match
 * the existing /mcp/candidate-move-stage "multiple non-DQ jobs" path so the
 * local MCP can pattern-match a single shape across every endpoint.
 */

import { session, getThinCandidateById, getCandidatesByIds, getFullCandidateById } from './d1-read.js';
import { getSnapshot } from './snapshot.js';
import {
  scoreString,
  recencyBoost,
  prepareTarget,
  canonicalizeJobPhrase,
} from './fuzzy.js';
import { getUserByFirstName } from '../users.js';

const FUZZY_THRESHOLD = 0.35;
const UNIQUE_GAP = 0.08;
const MAX_OPTIONS = 5;

/**
 * Coerce a raw `candidate|job|stage|owner` body field to a numeric id when it
 * really is one (number or pure-digit string), otherwise to a non-empty
 * trimmed string, otherwise null. Centralised so every resolver agrees on the
 * "Claude sometimes wraps numbers in quotes" rule.
 */
function coerceInput(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { kind: 'id', value: input };
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      return { kind: 'id', value: Number(trimmed) };
    }
    return { kind: 'name', value: trimmed };
  }
  return null;
}

/**
 * Decide unique vs ambiguous from a sorted-DESC scored list.
 * - threshold-filter has already been applied by the caller
 * - returns { kind: 'unique', winner } | { kind: 'ambiguous', options }
 */
function pickWinner(scored) {
  if (scored.length === 0) return { kind: 'none' };
  if (scored.length === 1) return { kind: 'unique', winner: scored[0] };
  const [a, b] = scored;
  if (a.score - b.score >= UNIQUE_GAP) {
    return { kind: 'unique', winner: a };
  }
  return { kind: 'ambiguous', options: scored.slice(0, MAX_OPTIONS) };
}

// ─────────────────────── Candidate ───────────────────────

/**
 * Resolve a candidate reference to a THIN row only — no live RF fetch.
 *
 * Mirror of resolveCandidate, but the success value is the thin candidates_v2
 * row (`{id, name, linkedin_profile, added_time_ms, current_*_at_cache_time}`)
 * instead of a full RF body. Used by handlers that only need id + name
 * (e.g. /mcp/candidate-call-notes step=list_calls) — keeps the path
 * round-trip-free against RF.
 */
export async function resolveCandidateThin(env, input) {
  const coerced = coerceInput(input);
  if (!coerced) return { ok: false, reason: 'not_found', input };

  if (coerced.kind === 'id') {
    const row = await getThinCandidateById(env, coerced.value);
    if (!row) return { ok: false, reason: 'not_found', input };
    return { ok: true, value: row };
  }

  const snap = await getSnapshot(env);
  const q = coerced.value;
  const scored = snap.rows
    .map((r) => {
      const base = scoreString(q, r.prepared);
      const boost = recencyBoost({ added_time_ms: r.added_time_ms });
      return { id: r.id, name: r.name, score: base * (1 + boost) };
    })
    .filter((r) => r.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const decision = pickWinner(scored);
  if (decision.kind === 'none') return { ok: false, reason: 'not_found', input };
  if (decision.kind === 'ambiguous') {
    // Same disambiguation envelope as resolveCandidate (single source of
    // truth for the wire shape).
    const ids = decision.options.map((o) => o.id);
    const rows = await getCandidatesByIds(env, ids);
    const meta = new Map(rows.map((r) => [r.id, r]));
    return {
      ok: false,
      reason: 'ambiguous',
      kind: 'candidate',
      options: decision.options.map((o) => ({
        id: o.id,
        name: o.name,
        score: o.score,
        current_organization: meta.get(o.id)?.current_company_at_cache_time ?? null,
        current_title: meta.get(o.id)?.current_title_at_cache_time ?? null,
      })),
      hint: `Multiple candidates match "${q}" — please be more specific.`,
    };
  }
  const row = await getThinCandidateById(env, decision.winner.id);
  if (!row) return { ok: false, reason: 'not_found', input };
  return { ok: true, value: row };
}

/**
 * Resolve a candidate reference to a full candidate body.
 * Numeric → thin-cache id check + live RF `/candidate/get`. String → fuzzy
 * resolve via the in-memory snapshot, then live-fetch the winner.
 *
 * Disambiguation hydrates organisation + title from the thin cache's
 * `current_*_at_cache_time` snapshot columns (display hints; never live).
 * On the wire we alias them as `current_organization` / `current_title` to
 * preserve the existing caller contract.
 *
 * Returns:
 *   { ok: true, value: <full-rf-candidate-body> }
 *   { ok: false, reason: 'not_found', input }
 *   { ok: false, reason: 'ambiguous', kind: 'candidate', options: [...] }
 *
 * RF errors (RFRateLimitedError / RFTransientError / RFError) propagate from
 * the underlying live-fetch — callers wrap and emit the appropriate envelope.
 */
export async function resolveCandidate(env, input) {
  const coerced = coerceInput(input);
  if (!coerced) return { ok: false, reason: 'not_found', input };

  if (coerced.kind === 'id') {
    const res = await getFullCandidateById(env, coerced.value);
    if (!res.ok) return { ok: false, reason: 'not_found', input };
    return { ok: true, value: res.value };
  }

  // Fuzzy path — score every snapshot row, recency-boost, threshold, sort.
  const snap = await getSnapshot(env);
  const q = coerced.value;
  const scored = snap.rows
    .map((r) => {
      const base = scoreString(q, r.prepared);
      const boost = recencyBoost({ added_time_ms: r.added_time_ms });
      return { id: r.id, name: r.name, score: base * (1 + boost) };
    })
    .filter((r) => r.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const decision = pickWinner(scored);
  if (decision.kind === 'none') {
    return { ok: false, reason: 'not_found', input };
  }
  if (decision.kind === 'ambiguous') {
    // Hydrate organisation + title for each option from the thin cache's
    // snapshot columns (display hints). They reflect "at first-sight" values
    // and are intentionally not live — keeping the caller round-trip free.
    const ids = decision.options.map((o) => o.id);
    const rows = await getCandidatesByIds(env, ids);
    const meta = new Map(rows.map((r) => [r.id, r]));
    const options = decision.options.map((o) => ({
      id: o.id,
      name: o.name,
      score: o.score,
      current_organization: meta.get(o.id)?.current_company_at_cache_time ?? null,
      current_title: meta.get(o.id)?.current_title_at_cache_time ?? null,
    }));
    return {
      ok: false,
      reason: 'ambiguous',
      kind: 'candidate',
      options,
      hint: `Multiple candidates match "${q}" — please be more specific.`,
    };
  }
  // Unique fuzzy winner → live-fetch from RF.
  const res = await getFullCandidateById(env, decision.winner.id);
  if (!res.ok) return { ok: false, reason: 'not_found', input };
  return { ok: true, value: res.value };
}

// ─────────────────────── Job ───────────────────────

/**
 * Load all jobs (id, name, client_company_name) for fuzzy scoring.
 * Job count is small (~1k). At that size SELECT-all + score-in-JS on every
 * call is cheap enough (~1ms) that we don't bother with a snapshot module.
 *
 * Per spec rev 5 thin schema, `is_open` lives only on RF — it's mutable and
 * therefore not cached. The `onlyOpen` option is accepted but is currently
 * a no-op for filtering: the canonical pipeline cache holds all known jobs
 * including closed ones, and closed-job suppression now happens via RF's
 * `/job/pipeline` returning empty buckets if the caller follows up.
 * Recruiters who want closed-job access pass an explicit numeric id (the
 * `resolveJob` numeric short-circuit bypasses fuzzy entirely).
 */
async function loadJobs(env /*, { onlyOpen = false } = {} */) {
  const { results } = await session(env)
    .prepare('SELECT id, name, client_company_name FROM jobs_v2')
    .all();
  return results ?? [];
}

/**
 * Resolve a job reference.
 * Numeric → SELECT FROM jobs_v2 WHERE id=?  (or accept as-is when
 *           `validateNumeric: false`).
 * String → score against (name + client_company_name), canonicalised via
 *          canonicalizeJobPhrase so "Eon SE" ↔ "Eon Sales Engineer". Closed
 *          jobs are excluded from fuzzy scoring by default — recruiters
 *          almost never mean a closed job by name. Pass `onlyOpen: false` to
 *          opt in to closed-job matching (rare; usually a numeric id is the
 *          right escape hatch).
 *
 * `restrictTo` (optional): array of `{ job_id, job_name }` from a candidate's
 * jobs[]. When set, the resolver only considers those job ids — used by
 * /mcp/candidate-move-stage and /mcp/candidate-log-interview where the target
 * job must be one the candidate is on. `onlyOpen` is ignored on this path
 * (the candidate's job list is the universe, regardless of is_open).
 *
 * `validateNumeric: false` skips the SELECT-FROM-jobs lookup for numeric
 * inputs. Used by the search / list endpoints that have their own downstream
 * "no rows for this job" handling — and for which the sync_state.jobs table
 * may legitimately lag the candidate_jobs table by one tick.
 */
export async function resolveJob(env, input, { restrictTo, onlyOpen = true, validateNumeric = true } = {}) {
  const coerced = coerceInput(input);
  if (!coerced) return { ok: false, reason: 'not_found', input };

  if (coerced.kind === 'id') {
    if (restrictTo) {
      const hit = restrictTo.find((j) => Number(j.job_id) === coerced.value);
      if (!hit) return { ok: false, reason: 'not_found', input };
      return { ok: true, value: hit };
    }
    if (!validateNumeric) {
      return { ok: true, value: { id: coerced.value, name: null, client_company_name: null } };
    }
    const row = await session(env)
      .prepare('SELECT id, name, client_company_name FROM jobs_v2 WHERE id = ?')
      .bind(coerced.value)
      .first();
    if (!row) return { ok: false, reason: 'not_found', input };
    return { ok: true, value: row };
  }

  // Fuzzy path. Build the candidate set first.
  let candidates;
  if (restrictTo) {
    // Score against the candidate's job links — `job_name` only (no
    // client_company_name on these records).
    candidates = restrictTo.map((j) => ({
      id: j.job_id,
      name: j.job_name,
      client_company_name: null,
      _link: j,
    }));
  } else {
    candidates = await loadJobs(env, { onlyOpen });
  }

  const qCanonical = canonicalizeJobPhrase(coerced.value);
  const qPrepared = prepareTarget(qCanonical);

  const scored = candidates
    .map((j) => {
      const nameCanonical = canonicalizeJobPhrase(j.name ?? '');
      const companyCanonical = canonicalizeJobPhrase(j.client_company_name ?? '');
      const namePrepared = prepareTarget(nameCanonical);
      const companyPrepared = prepareTarget(companyCanonical);
      const nameScore = scoreString(qPrepared.normalized, namePrepared);
      const companyScore = j.client_company_name
        ? scoreString(qPrepared.normalized, companyPrepared)
        : 0;
      // Score against "name @ company" jointly so "Eon SE" against an entry
      // named "Sales Engineer" with company "Eon" still scores.
      const combinedTarget = j.client_company_name
        ? prepareTarget(`${companyCanonical} ${nameCanonical}`)
        : namePrepared;
      const combinedScore = scoreString(qPrepared.normalized, combinedTarget);
      const score = Math.max(nameScore, companyScore * 0.85, combinedScore);
      return { ...j, score };
    })
    .filter((j) => j.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const decision = pickWinner(scored);
  if (decision.kind === 'none') {
    return { ok: false, reason: 'not_found', input };
  }
  if (decision.kind === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous',
      kind: 'job',
      options: decision.options.map((o) => ({
        id: o.id,
        name: o.name,
        client_company_name: o.client_company_name ?? null,
        score: o.score,
      })),
      hint: `Multiple jobs match "${coerced.value}" — please be more specific.`,
    };
  }
  // For restrictTo we want to return the original candidate-job-link entry
  // (it has stages[], stage_name, etc).
  if (restrictTo) {
    return { ok: true, value: decision.winner._link };
  }
  return {
    ok: true,
    value: {
      id: decision.winner.id,
      name: decision.winner.name,
      client_company_name: decision.winner.client_company_name,
    },
  };
}

// ─────────────────────── Stage ───────────────────────

/**
 * Resolve a stage reference within a specific job's pipeline. In-memory only;
 * the caller passes the job's `stages[]` array.
 *
 * Numeric → match by id. String → fuzzy match against stage names.
 *
 * Note: this resolver is sync — `stages` is already in hand from the caller's
 * candidate body / job body lookup.
 */
export function resolveStage(input, stages) {
  const coerced = coerceInput(input);
  if (!coerced) return { ok: false, reason: 'not_found', input };
  const list = Array.isArray(stages) ? stages : [];

  if (coerced.kind === 'id') {
    const hit = list.find((s) => Number(s.id) === coerced.value);
    if (!hit) return { ok: false, reason: 'not_found', input };
    return { ok: true, value: hit };
  }

  // Exact case-insensitive match wins outright — short-circuit fuzzy so
  // numeric-id-shaped stage ids don't accidentally collide with prefix matches.
  const exact = list.find((s) => (s.name ?? '').toLowerCase() === coerced.value.toLowerCase());
  if (exact) return { ok: true, value: exact };

  const q = coerced.value;
  const scored = list
    .map((s) => ({ ...s, score: scoreString(q, s.name ?? '') }))
    .filter((s) => s.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const decision = pickWinner(scored);
  if (decision.kind === 'none') {
    return { ok: false, reason: 'not_found', input };
  }
  if (decision.kind === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous',
      kind: 'stage',
      options: decision.options.map((o) => ({
        id: o.id,
        name: o.name,
        score: o.score,
      })),
      hint: `Multiple stages match "${q}" — please be more specific.`,
    };
  }
  return { ok: true, value: decision.winner };
}

// ─────────────────────── Owner ───────────────────────

/**
 * Resolve an owner (recruiter) reference.
 * - number / pure-digit string → use as RF user id verbatim
 * - string → try users.js getUserByFirstName first (fast path for our team)
 *           then fall back to fuzzy match against sync_state.users (the cached
 *           full RF user list).
 */
export async function resolveOwner(env, input) {
  const coerced = coerceInput(input);
  if (!coerced) return { ok: false, reason: 'not_found', input };

  if (coerced.kind === 'id') {
    return { ok: true, value: { id: coerced.value } };
  }

  const fast = await getUserByFirstName(env, coerced.value);
  if (fast) {
    return { ok: true, value: { id: fast.rfUserId, name: fast.firstName } };
  }

  // Fall back to RF user list cached on sync_state — only populated after the
  // first full rebuild. Treat absence as "no match".
  const row = await session(env)
    .prepare("SELECT value FROM sync_state WHERE key = 'users'")
    .first();
  if (!row?.value) return { ok: false, reason: 'not_found', input };
  let users;
  try {
    users = JSON.parse(row.value);
  } catch {
    return { ok: false, reason: 'not_found', input };
  }
  if (!Array.isArray(users) || users.length === 0) {
    return { ok: false, reason: 'not_found', input };
  }
  const q = coerced.value;
  const scored = users
    .map((u) => {
      const display = [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.name || u.email || '';
      return { id: u.id, name: display, email: u.email ?? null, score: scoreString(q, display) };
    })
    .filter((u) => u.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  const decision = pickWinner(scored);
  if (decision.kind === 'none') {
    return { ok: false, reason: 'not_found', input };
  }
  if (decision.kind === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous',
      kind: 'owner',
      options: decision.options.map((o) => ({
        id: o.id,
        name: o.name,
        email: o.email,
        score: o.score,
      })),
      hint: `Multiple users match "${q}" — please be more specific.`,
    };
  }
  return {
    ok: true,
    value: {
      id: decision.winner.id,
      name: decision.winner.name,
      email: decision.winner.email,
    },
  };
}

/**
 * Translate an `ambiguous` resolver result into the standard 200-response
 * payload. Centralised so every endpoint emits the same shape.
 */
export function disambiguationPayload(result) {
  return {
    needs_disambiguation: true,
    kind: result.kind,
    options: result.options,
    hint: result.hint,
  };
}
