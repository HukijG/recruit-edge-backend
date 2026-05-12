/**
 * /mcp/candidate-search — single-call tier-2 fuzzy + filter search.
 *
 * Per spec rev 5 ("thin-immutable-cache-design.md") this handler follows the
 * **single round-trip** design, never the per-id fan-out:
 *
 * 1. **Tier 1: cache fuzzy** — `query` (if any) → in-memory snapshot scan →
 *    candidate id list. Pure-name match, recency-boosted via `added_time_ms`.
 * 2. **Filter classification** — split user-supplied filters into:
 *      - **Immutable** (`added_after` / `added_before`, `linkedin_profile`)
 *        → resolved against the local cache; no RF round-trip.
 *      - **Mutable** (`email`, `company`/`current_organization`, `current_title`,
 *        `owner` / `lead_owner_id`, `stage`+`job`, `disqualified`,
 *        `technology` / `segment` / `role` → `custom_field.<id>`) → routed to RF.
 * 3. **Tier 2: RF `/candidate/search` (single call)** when any mutable filter
 *    is present. Composes `candidate_id IN (tier-1 ids)` + the predicate
 *    filters server-side via `conjunction: 'match-all'`. No fan-out.
 * 4. **Pure-fuzzy short-circuit** — no mutable filter → return tier-1 results
 *    directly (no RF call).
 * 5. **Empty tier-1 + mutable filter** — return empty without RF call.
 * 6. **RF failure during tier-2** — degrade to tier-1 results with
 *    `warning: 'filter_unverified'` (transient) or `rate_limited` envelope (429).
 *
 * Custom-field routing (rev 5 RF-7): the `getCustomFieldMap` helper pulls
 * RF's `/candidate/custom-field/list` once per 5 min into a name→id map.
 * `technology[]` / `segment` / `role` filters resolve to canonical option
 * names AND emit `custom_field.<id>` filters server-side — no
 * `unverifiedFilters` drop. If the map can't be fetched (RF unavailable),
 * the response surfaces `warning: 'custom_field_map_unavailable'` rather
 * than silently dropping the filter.
 *
 * Stage universe: RF `/job/pipeline` exposes per-job stage names, but the
 * fuzzy resolver for the `stage` filter needs an in-memory universe so
 * lowercase / abbreviation inputs resolve before going to RF. We build that
 * universe from `jobs_v2.canonical_pipeline_json` — the snapshot-only stage
 * list per job (rev 5 schema). Cached for 5 min in module scope.
 *
 * NB: the legacy `last_updated` / `last_activity` range filters are dropped
 * per spec rev 5 (mutable, not load-bearing).
 */

import { jsonResponse } from './router.js';
import { session, getCandidatesByIds } from './d1-read.js';
import { resolveFieldsWithDefaults } from './projection.js';
import { projectWithLinkedIn } from './linkedin.js';
import { getSnapshot } from './snapshot.js';
import { scoreString, normalize } from './fuzzy.js';
import { liveRerankCandidates } from './live-rerank.js';
import {
  resolveJob, resolveOwner, resolveStage, disambiguationPayload,
} from './resolvers.js';
import {
  searchCandidatesByIdsAndPredicate,
  searchCandidatesByPredicateOnly,
  getRFCandidate,
  extractLinkedInSlug,
  RFRateLimitedError,
} from '../rf-client.js';
import { getCustomFieldMap, lookupField } from './custom-fields.js';
import { pMapLimit } from './concurrency.js';

const DEFAULT_FIELDS = ['id', 'name', 'current_title', 'linkedin_profile'];
const FUZZY_THRESHOLD = 0.35;
const TIER1_FUZZY_LIMIT = 200;  // tier-1 pool size before tier-2 narrowing
const HYDRATION_CONCURRENCY = 8;
// Phase 2 (live-rerank) fan-out cap on the pure-fuzzy candidate-search
// path. Bounded so large `limit` values don't trigger a 50-call RF storm;
// top-5 by Phase 1 score get the live stage-recency rerank, the tail
// keeps Phase 1 ordering.
const PHASE2_FANOUT = 5;

// ─── In-memory caches ─────────────────────────────────────────────────────

const STAGE_UNIVERSE_KEY = '__rfMcpStageUniverse';
const STAGE_UNIVERSE_TTL_MS = 5 * 60_000;

/**
 * Read the union of all stage names across `jobs_v2.canonical_pipeline_json`.
 * Cached in module scope for 5 min. Used by the `stage` fuzzy resolver so a
 * user-typed "sourced" lands as "Sourced" before being sent to RF.
 *
 * Returns the canonical names verbatim (preserves case) so the RF filter
 * receives the same casing RF uses in its pipeline.
 *
 * @param {object} env
 * @returns {Promise<string[]>}
 */
export async function getKnownStageNames(env) {
  const G = globalThis;
  const cached = G[STAGE_UNIVERSE_KEY];
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < STAGE_UNIVERSE_TTL_MS) {
    return cached.stages;
  }
  const { results } = await session(env)
    .prepare('SELECT canonical_pipeline_json FROM jobs_v2 WHERE canonical_pipeline_json IS NOT NULL')
    .all();
  const seen = new Set();
  for (const row of results ?? []) {
    try {
      const parsed = JSON.parse(row.canonical_pipeline_json);
      const stages = Array.isArray(parsed?.stages)
        ? parsed.stages
        : Array.isArray(parsed) ? parsed : [];
      for (const s of stages) {
        const name = typeof s === 'string' ? s : s?.name;
        if (typeof name === 'string' && name.length > 0) seen.add(name);
      }
    } catch {
      // Tolerate corrupt JSON — skip the row.
    }
  }
  const stages = [...seen];
  G[STAGE_UNIVERSE_KEY] = { stages, fetchedAtMs: now };
  return stages;
}

/**
 * Test-only reset for the stage-universe cache.
 */
export function _resetStageUniverseForTests() {
  delete globalThis[STAGE_UNIVERSE_KEY];
}

// ─── Custom-field filter routing ──────────────────────────────────────────

/**
 * Fuzzy-resolve a user-typed custom-field value against the canonical
 * `options[]` enumeration from RF's `/candidate/custom-field/list`.
 *
 * `cfMeta` is the entry from `getCustomFieldMap` ({id, name, options}); if
 * the field has no enumerated options (text custom field) the input passes
 * through verbatim.
 *
 * Returns the standard discriminated union from `resolveStage`:
 *   { ok: true, value: {id, name} } | { ok: false, reason: 'ambiguous', ... }
 *   | { ok: false, reason: 'not_found', ... }
 */
function fuzzyResolveCustomFieldOption(cfMeta, input) {
  const options = cfMeta?.options ?? [];
  if (options.length === 0) {
    return { ok: true, value: { id: input, name: input } };
  }
  const resolvable = options.map((name) => ({ id: name, name }));
  return resolveStage(input, resolvable);
}

/**
 * Translate the request body's structured filters into RF `/candidate/search`
 * filter objects per spec rev 5 RF-7 verification.
 *
 * Returns:
 *   - `rfFilters`          — MUTABLE filter objects only (drives `hasMutableFilters`
 *     / whether an RF round-trip is made). Does NOT include immutable filters.
 *   - `rfImmutableFilters` — RF filter objects for immutable keys (`added_on`,
 *     `linkedin_profile` substring). These do NOT drive the RF call decision;
 *     the caller appends them to the RF request only when a call is already being
 *     made due to a mutable filter. This preserves the cache-only path for
 *     pure-immutable queries.
 *   - `cfWarnings`         — warnings emitted when the custom-field map is
 *     unavailable or a filter's field name doesn't exist in RF's schema.
 *
 * Inputs are read from BOTH the top-level body fields (existing wire contract)
 * AND the optional `filters` long-tail bag (forward-compat per the MCP tool
 * descriptor in `mcp-remote/src/tools.ts`).
 *
 * `resolved.{jobId,ownerId,stageName}` carry post-fuzzy-resolver canonical
 * values. `resolved.customFieldFilters` carries pre-built `custom_field.<id>`
 * RF filter objects (technology / segment / role); the caller resolves the
 * map + canonical option names upstream.
 *
 * Filter-key map (spec rev 5 RF-7):
 *   `email`              → RF `email`            (text — substring; MUTABLE)
 *   `company` /
 *     `current_organization` → RF `current_company` (text; MUTABLE)
 *   `current_title`      → RF `current_title`    (text; MUTABLE)
 *   `owner` / `lead_owner_id` → RF `lead_owner`  (multi-select-by-ID; MUTABLE)
 *   `stage` (with `job`) → RF `stage`            (multi-select-by-NAME; MUTABLE)
 *   `job_id` / `job`     → RF `job`              (multi-select-by-ID; MUTABLE)
 *   `disqualified=true`  → RF `{stage: 'Disqualified'}` (MUTABLE)
 *   `linkedin_profile`   → rfImmutableFilters `linkedin_profile` (substring;
 *                          ALSO exact-slug in buildImmutableSnapshotFilter)
 *   `added_after` /
 *     `added_before`     → rfImmutableFilters `added_on` (date;
 *                          ALSO snapshot predicate in buildImmutableSnapshotFilter)
 *   `technology` /
 *     `segment` / `role` → RF `custom_field.<id>` — emitted by the upstream
 *                          custom-field resolver (passed in as
 *                          `resolved.customFieldFilters`).
 */
function buildRFPredicateFilters(body, resolved = {}) {
  const out = [];          // mutable — drives hasMutableFilters
  const immutable = [];    // immutable RF filters — appended to RF calls when already made
  // Merge top-level body keys with the optional `filters` long-tail bag.
  // Top-level keys take precedence (existing wire contract).
  const longTail = (body && typeof body.filters === 'object' && body.filters !== null)
    ? body.filters
    : {};
  const tf = { ...longTail, ...body };

  // ─── email (text — substring per RF-7) ─────────────────────────
  if (tf.email != null && tf.email !== '') {
    out.push({ conjunction: 'in', values: [String(tf.email)], key: 'email' });
  }

  // ─── company / current_organization → RF `current_company` ─────
  const company = tf.current_organization ?? tf.company;
  if (company != null && company !== '') {
    out.push({ conjunction: 'in', values: [String(company)], key: 'current_company' });
  }

  // ─── current_title (text) ──────────────────────────────────────
  if (tf.current_title != null && tf.current_title !== '') {
    out.push({ conjunction: 'in', values: [String(tf.current_title)], key: 'current_title' });
  }

  // ─── owner / lead_owner → RF `lead_owner` (by ID) ──────────────
  // Use the post-resolver numeric id when present; fall through to a numeric
  // top-level value (preserves the `owner_id` direct-id wire shape).
  // `lead_owner_id` accepts numbers AND numeric-strings ("123") to match
  // Claude's habit of JSON-stringifying ids.
  let ownerNumeric = resolved.ownerId;
  if (typeof ownerNumeric !== 'number') {
    if (typeof tf.lead_owner_id === 'number' && Number.isFinite(tf.lead_owner_id)) {
      ownerNumeric = tf.lead_owner_id;
    } else if (typeof tf.lead_owner_id === 'string' && /^\d+$/.test(tf.lead_owner_id.trim())) {
      ownerNumeric = Number(tf.lead_owner_id.trim());
    }
  }
  if (typeof ownerNumeric === 'number' && Number.isFinite(ownerNumeric)) {
    out.push({ conjunction: 'in', values: [ownerNumeric], key: 'lead_owner' });
  }

  // ─── job → RF `job` (by ID) ────────────────────────────────────
  if (typeof resolved.jobId === 'number' && Number.isFinite(resolved.jobId)) {
    out.push({ conjunction: 'in', values: [resolved.jobId], key: 'job' });
  }

  // ─── stage (with job, by NAME) ─────────────────────────────────
  // `resolved.stageName` is the canonical post-fuzzy-resolver name. Only
  // emitted alongside a `job` filter — stage filtering without job context is
  // ambiguous (each job has its own pipeline).
  if (resolved.stageName && typeof resolved.jobId === 'number') {
    out.push({ conjunction: 'in', values: [String(resolved.stageName)], key: 'stage' });
  }

  // ─── disqualified=true → stage='Disqualified' (no boolean DQ filter) ──
  // NB: when the user *also* has a `job` filter set, the stage filter we
  // already pushed above is the canonical post-fuzzy-resolved one; appending
  // a second `stage` filter ANDs them and would return zero rows. Skip the
  // DQ expansion if a stage is already set — the user's explicit stage wins.
  if (tf.disqualified === true && !resolved.stageName) {
    out.push({ conjunction: 'in', values: ['Disqualified'], key: 'stage' });
  }

  // ─── custom_field.<id> (technology / segment / role) ───────────
  // Resolved upstream against RF's /candidate/custom-field/list; emit any
  // pre-built filter objects here.
  if (Array.isArray(resolved.customFieldFilters)) {
    out.push(...resolved.customFieldFilters);
  }

  // ─── linkedin_profile → rfImmutableFilters (substring per RF-7) ──
  // Dual-handled: buildImmutableSnapshotFilter applies exact-slug match on the
  // snapshot for tier-1 paths; here we route a substring search to RF for
  // branches 4/5 (mutable filter already present). Both predicates AND.
  // NB: this does NOT go into `out` — it doesn't trigger an RF call on its
  // own (it stays cache-side on pure-immutable paths).
  if (tf.linkedin_profile != null && tf.linkedin_profile !== '') {
    immutable.push({ conjunction: 'in', values: [String(tf.linkedin_profile)], key: 'linkedin_profile' });
  }

  // ─── added_after / added_before → rfImmutableFilters `added_on` ──
  if (tf.added_after) {
    immutable.push({
      type: 'date',
      is_relative: false,
      filter_type: 'after',
      date: String(tf.added_after).slice(0, 10),
      key: 'added_on',
    });
  }
  if (tf.added_before) {
    immutable.push({
      type: 'date',
      is_relative: false,
      filter_type: 'before',
      date: String(tf.added_before).slice(0, 10),
      key: 'added_on',
    });
  }

  // ─── Dropped per spec rev 5 ────────────────────────────────────
  // `last_updated` / `last_activity_at` ranges (`updated_after`/`updated_before`)
  // — mutable, not load-bearing. Silently dropped.

  return { rfFilters: out, rfImmutableFilters: immutable };
}

/**
 * Detect whether the request includes any IMMUTABLE filter that should narrow
 * the tier-1 fuzzy result set in JS. Returns a predicate to apply to each
 * snapshot row, or `null` if no immutable filter is set.
 *
 * Reads from BOTH top-level body fields AND the optional `filters` long-tail
 * bag — same merge strategy as buildRFPredicateFilters (top-level wins).
 *
 * Immutable per spec rev 5: `added_time` range, `linkedin_profile`.
 *
 * `linkedin_profile` is dual-handled:
 *   - Here (tier-1 paths): exact slug match against the snapshot row after
 *     normalising user input via `extractLinkedInSlug` (so a full URL like
 *     "https://www.linkedin.com/in/Jane-Doe/" still matches the lowercased
 *     slug "jane-doe" we store).
 *   - In buildRFPredicateFilters (tier-2 paths): RF substring search.
 *   Both predicates fire when both paths are active; they are AND'd.
 */
function buildImmutableSnapshotFilter(body) {
  const preds = [];
  const longTail = (body && typeof body.filters === 'object' && body.filters !== null)
    ? body.filters
    : {};
  const tf = { ...longTail, ...body };

  if (tf.added_after) {
    const ms = Date.parse(tf.added_after);
    if (Number.isFinite(ms)) preds.push((r) => r.added_time_ms >= ms);
  }
  if (tf.added_before) {
    const ms = Date.parse(tf.added_before);
    if (Number.isFinite(ms)) preds.push((r) => r.added_time_ms <= ms);
  }
  // linkedin_profile: normalise via extractLinkedInSlug so the caller can
  // pass a full URL ("https://www.linkedin.com/in/Jane-Doe/"), a bare slug
  // ("Jane-Doe"), or any of the formats the LinkedIn extension might use.
  // Snapshot stores the lowercased slug; we lowercase the input slug too.
  if (typeof tf.linkedin_profile === 'string' && tf.linkedin_profile) {
    const slug = extractLinkedInSlug(tf.linkedin_profile);
    if (slug) {
      preds.push((r) => r.linkedin_profile === slug);
    }
  }
  if (preds.length === 0) return null;
  return (r) => preds.every((p) => p(r));
}

/**
 * Tier-1 fuzzy: score every snapshot row against `query`, threshold, sort by
 * score, take top-`limit`. No D1 read here — the snapshot is cached in memory
 * and version-checked against the cron cursor stamp.
 *
 * Pure name score, no recency boost. The previous `added_time_ms` boost
 * was actively harmful — hundreds of candidates added weekly all enter
 * Sourced, so the boost just floods top results with newly-sourced rows
 * and deranks re-engaged candidates already in the CRM. Stage-based
 * recency (`stage_moved` on a non-Sourced / non-Disqualified job)
 * replaces it on the pure-fuzzy path via `liveRerankCandidates` below.
 *
 * Returns rows shaped as `{id, name, score, _thinRow}` where `_thinRow`
 * carries the snapshot's thin fields (id, name, linkedin_profile,
 * added_time_ms).
 */
async function tier1Fuzzy(env, query, limit, immutablePredicate = null) {
  const snap = await getSnapshot(env);
  const q = normalize(query);
  if (!q) return [];
  const scored = snap.rows
    .filter((r) => immutablePredicate == null || immutablePredicate(r))
    .map((r) => ({ id: r.id, name: r.name, score: scoreString(q, r.prepared), _thinRow: r }))
    .filter((r) => r.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Synthesize a candidate-shaped body from a snapshot thin row. Used for the
 * pure-fuzzy / immutable-only paths where no full body is available — the
 * snapshot's quasi-immutable fields are all we have. Other fields default to
 * undefined and projection drops them silently.
 */
function thinSnapRowToBody(row) {
  return {
    id: row.id,
    name: row.name,
    linkedin_profile: row.linkedin_profile,
    added_time: row.added_time_ms != null
      ? new Date(row.added_time_ms).toISOString()
      : null,
  };
}

/**
 * Synthesize a candidate-shaped body from a thin candidates_v2 row. Used
 * for the tier-2 path to project hydrated matched ids without fanning out
 * to RF when the requested fields are all thin.
 */
function thinDbRowToBody(row) {
  return {
    id: row.id,
    name: row.name,
    linkedin_profile: row.linkedin_profile,
    added_time: row.added_time_ms != null
      ? new Date(row.added_time_ms).toISOString()
      : null,
    current_title: row.current_title_at_cache_time ?? null,
    current_organization: row.current_company_at_cache_time ?? null,
  };
}

/**
 * Project a list of `{id, name, ...}` matches into the standard MCP response
 * shape.
 *
 * Body source by precedence (per match):
 *   1. `m._body` — set by tier-2 RF match (full RF candidate body, JSON
 *      string). Used directly.
 *   2. `m._thinRow` — synthesised from the snapshot row (pure-fuzzy /
 *      immutable-only paths). Carries the quasi-immutable fields only.
 *
 * For tier-2 we always have `_body` from RF (since RF returned the matched
 * candidate); thin hydration via `getCandidatesByIds` is used only when the
 * caller requests fields outside the thin set AND wants to avoid the RF
 * fan-out — handled separately in the tier-2 branch.
 *
 * `userFields` is the caller-supplied `fields[]` — additive over defaults.
 */
function projectMatches(matches, userFields) {
  return matches.map((m) => {
    // Body source precedence:
    //   1. `_body` (set by tier-2 RF result) — full RF body.
    //   2. `_thinDbRow` (set by pure-fuzzy / immutable-only enrichment) —
    //      v2 row carries current_title_at_cache_time + current_company_at_cache_time.
    //   3. `_thinRow` (snapshot-only) — fewer fields than the DB row.
    let c;
    if (m._body) {
      c = JSON.parse(m._body);
    } else if (m._thinDbRow) {
      c = thinDbRowToBody(m._thinDbRow);
    } else if (m._thinRow) {
      c = thinSnapRowToBody(m._thinRow);
    } else {
      c = { id: m.id, name: m.name };
    }
    const { paths } = resolveFieldsWithDefaults(userFields, DEFAULT_FIELDS, c, c);
    const projected = projectWithLinkedIn(c, paths);
    return m.score != null ? { ...projected, score: m.score } : projected;
  });
}

export async function handleCandidateSearch({ env, body }) {
  const limit = Math.min(body.limit ?? 5, 50);

  // ─── Resolve `job` (number or fuzzy name) and `owner` ──────────
  // Ambiguous → 200 disambiguation; not_found on either is a 400 since the
  // user gave a filter we couldn't apply.
  let jobId = null;
  if (body.job_id != null) {
    const id = Number(body.job_id);
    if (!Number.isFinite(id)) return jsonResponse(400, { ok: false, kind: 'invalid_input', error: 'job_id must be numeric' });
    jobId = id;
  } else if (body.job != null) {
    const r = await resolveJob(env, body.job, { validateNumeric: false });
    if (!r.ok) {
      if (r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      return jsonResponse(400, { ok: false, kind: 'invalid_input', error: `job not found: ${JSON.stringify(body.job)}` });
    }
    jobId = r.value.id;
  }
  let ownerId = null;
  if (body.owner_id != null) {
    const id = Number(body.owner_id);
    if (!Number.isFinite(id)) return jsonResponse(400, { ok: false, kind: 'invalid_input', error: 'owner_id must be numeric' });
    ownerId = id;
  } else if (body.owner != null) {
    const r = await resolveOwner(env, body.owner);
    if (!r.ok) {
      if (r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      return jsonResponse(400, { ok: false, kind: 'invalid_input', error: `owner not found: ${JSON.stringify(body.owner)}` });
    }
    ownerId = r.value.id;
  }

  // ─── Custom-field resolve (technology / segment / role) ────────
  // Pull the name→id map from RF; resolve each user input against the
  // canonical option list; emit `custom_field.<id>` filter objects.
  // On RF unavailable we surface `custom_field_map_unavailable` rather than
  // silently dropping the filter — no warn-and-drop block.
  const customFieldFilters = [];
  let cfMapWarning = null;
  const hasCfInput = (Array.isArray(body.technology) && body.technology.length)
    || (body.segment != null && body.segment !== '')
    || (body.role != null && body.role !== '');

  let cfMap = null;
  if (hasCfInput) {
    try {
      cfMap = await getCustomFieldMap(env);
    } catch (e) {
      if (e instanceof RFRateLimitedError) {
        return jsonResponse(200, {
          ok: false,
          kind: 'rate_limited',
          recoverable: false,
          retry_after_ms: e.retryAfterMs ?? null,
          error: 'RF rate limited fetching custom-field schema',
        });
      }
      // Transient or other → surface as warning, continue with no CF filter.
      cfMapWarning = 'custom_field_map_unavailable';
      cfMap = null;
    }
  }

  /**
   * Resolve one custom-field input against the schema. Returns either a
   * pushable filter object, or surfaces an ambiguity envelope to the caller
   * by returning `{ ambiguity: <disambiguationPayload> }`.
   * `multi` controls whether the resolved canonical name lands in `values`
   * as `[name]` for single-select or a flat list for multi-select.
   */
  async function resolveOneCfFilter(fieldName, input, isMulti) {
    if (!cfMap) return null;
    const meta = lookupField(cfMap, fieldName);
    if (!meta) return null; // field doesn't exist on this account — silently skip
    if (Array.isArray(input)) {
      const values = [];
      for (const v of input) {
        const r = fuzzyResolveCustomFieldOption(meta, v);
        if (!r.ok && r.reason === 'ambiguous') {
          return { ambiguity: disambiguationPayload(r) };
        }
        values.push(r.ok ? r.value.name : v);
      }
      if (values.length === 0) return null;
      return { conjunction: 'in', values, key: `custom_field.${meta.id}` };
    }
    const r = fuzzyResolveCustomFieldOption(meta, input);
    if (!r.ok && r.reason === 'ambiguous') {
      return { ambiguity: disambiguationPayload(r) };
    }
    const name = r.ok ? r.value.name : input;
    return { conjunction: 'in', values: [name], key: `custom_field.${meta.id}` };
  }

  if (Array.isArray(body.technology) && body.technology.length) {
    const fr = await resolveOneCfFilter('technology', body.technology, true);
    if (fr?.ambiguity) return jsonResponse(200, fr.ambiguity);
    if (fr) customFieldFilters.push(fr);
  }
  if (body.segment != null && body.segment !== '') {
    const fr = await resolveOneCfFilter('segment', body.segment, false);
    if (fr?.ambiguity) return jsonResponse(200, fr.ambiguity);
    if (fr) customFieldFilters.push(fr);
  }
  if (body.role != null && body.role !== '') {
    const fr = await resolveOneCfFilter('role', body.role, false);
    if (fr?.ambiguity) return jsonResponse(200, fr.ambiguity);
    if (fr) customFieldFilters.push(fr);
  }

  // ─── Stage fuzzy resolve (only with job context) ───────────────
  // Universe is the union of stage names across `jobs_v2.canonical_pipeline_json`.
  // Ambiguity returns the standard envelope; not_found falls through and the
  // unresolved name is sent verbatim to RF (which returns zero rows for an
  // unknown stage — same observable behaviour as the pre-rev-5 fall-through).
  let stageName = null;
  if (body.stage && jobId != null) {
    const knownStages = await getKnownStageNames(env);
    if (knownStages.length > 0) {
      const resolvable = knownStages.map((name) => ({ id: name, name }));
      const r = resolveStage(body.stage, resolvable);
      if (!r.ok && r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      if (r.ok) {
        stageName = r.value.name;
      } else {
        stageName = String(body.stage);
      }
    } else {
      stageName = String(body.stage);
    }
  }

  // ─── Build the RF filter envelope ──────────────────────────────
  const { rfFilters, rfImmutableFilters } = buildRFPredicateFilters(body, {
    jobId, ownerId, stageName, customFieldFilters,
  });
  const allRFFilters = [...rfFilters, ...rfImmutableFilters];

  const immutablePredicate = buildImmutableSnapshotFilter(body);
  const hasMutableFilters = rfFilters.length > 0;
  const hasImmutableFilters = immutablePredicate != null;
  const hasQuery = !!body.query;

  // Must have something to narrow on — query, mutable filter, OR immutable.
  if (!hasQuery && !hasMutableFilters && !hasImmutableFilters) {
    return jsonResponse(400, { ok: false, kind: 'invalid_input', error: 'must provide query or at least one filter' });
  }

  /**
   * Attach metadata + the `ok: true` flag to a success response. Centralised
   * so every success branch stays in sync.
   */
  function successResponse(projected, extras = {}) {
    const resp = { ok: true, count: projected.length, matches: projected, ...extras };
    if (cfMapWarning) {
      resp.warning = cfMapWarning;
      resp._meta = { ...(resp._meta ?? {}), warning: cfMapWarning };
    }
    return resp;
  }

  // ─── Pure-fuzzy short-circuit (no mutable filter) ──────────────
  // Two-phase rerank for the pure-fuzzy path:
  //   Phase 1: name score (`tier1Fuzzy`) — no recency, fixed in 2026-05-12.
  //   Phase 2: live RF stage-recency rerank on the top-K. Without this,
  //            "Jerry" returns N look-alikes all scoring 0.85+ with no
  //            way for the right Jerry to surface — see operator brief
  //            for the worked example.
  // Phase 2 fan-out is bounded at PHASE2_FANOUT (5); requests with larger
  // limits get Phase 2 rerank on the top 5 only, the tail keeps Phase 1
  // ordering. Trade-off: protects against a 50-fan-out latency cliff
  // while still answering the common "type a first name" intent right.
  if (hasQuery && !hasMutableFilters) {
    const tier1 = await tier1Fuzzy(env, body.query, limit, immutablePredicate);
    let ordered = tier1;
    if (tier1.length > 0) {
      const reranked = await liveRerankCandidates(env, tier1.slice(0, PHASE2_FANOUT));
      // Splice the reranked top-K back over the original order; tail (any
      // overflow beyond PHASE2_FANOUT) keeps Phase 1 score / position.
      const byId = new Map(reranked.map((r) => [r.id, r]));
      ordered = tier1
        .map((m) => {
          const r = byId.get(m.id);
          if (!r) return m;
          return { ...m, score: r.score, _body: r._body ? JSON.stringify(r._body) : undefined };
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    }
    const dbRows = ordered.length ? await getCandidatesByIds(env, ordered.map((m) => m.id)) : [];
    const dbById = new Map(dbRows.map((r) => [r.id, r]));
    const enriched = ordered.map((m) => ({ ...m, _thinDbRow: dbById.get(m.id) ?? null }));
    const projected = projectMatches(enriched, body.fields);
    return jsonResponse(200, successResponse(projected));
  }

  // ─── Immutable-only filter (no query, no mutable) ──────────────
  if (!hasQuery && !hasMutableFilters && hasImmutableFilters) {
    const snap = await getSnapshot(env);
    const matches = snap.rows
      .filter(immutablePredicate)
      .sort((a, b) => (b.added_time_ms ?? 0) - (a.added_time_ms ?? 0))
      .slice(0, limit)
      .map((r) => ({ id: r.id, name: r.name, _thinRow: r }));
    const dbRows = matches.length ? await getCandidatesByIds(env, matches.map((m) => m.id)) : [];
    const dbById = new Map(dbRows.map((r) => [r.id, r]));
    const enriched = matches.map((m) => ({ ...m, _thinDbRow: dbById.get(m.id) ?? null }));
    const projected = projectMatches(enriched, body.fields);
    return jsonResponse(200, successResponse(projected));
  }

  // ─── Tier-2: mutable filter present, route through RF ──────────
  let rfResult;
  let tier1ForFallback = [];

  if (hasQuery) {
    const tier1 = await tier1Fuzzy(env, body.query, TIER1_FUZZY_LIMIT, immutablePredicate);
    tier1ForFallback = tier1;
    if (tier1.length === 0) {
      // Tier-1 returned nothing — return empty without bothering RF.
      return jsonResponse(200, successResponse([]));
    }
    try {
      rfResult = await searchCandidatesByIdsAndPredicate(
        { ids: tier1.map((r) => r.id), predicateFilters: allRFFilters },
        env,
      );
    } catch (err) {
      if (err instanceof RFRateLimitedError) {
        return jsonResponse(200, {
          ok: false,
          kind: 'rate_limited',
          recoverable: false,
          retry_after_ms: err.retryAfterMs ?? null,
          error: 'RF rate limited',
        });
      }
      console.warn({
        message: `[mcp/candidate-search] RF search failed; degrading to tier-1: ${err.message}`,
        source: 'mcp-candidate-search',
        droppedFilters: Object.keys(body).filter((k) => !['query', 'limit', 'fields', 'filters'].includes(k)),
        query: body.query,
      });
      const projected = projectMatches(tier1.slice(0, limit), body.fields);
      const resp = { ok: true, count: projected.length, matches: projected, warning: 'filter_unverified' };
      if (cfMapWarning) resp._meta = { warning: cfMapWarning };
      return jsonResponse(200, resp);
    }
  } else {
    try {
      rfResult = await searchCandidatesByPredicateOnly(
        { predicateFilters: allRFFilters },
        env,
      );
    } catch (err) {
      if (err instanceof RFRateLimitedError) {
        return jsonResponse(200, {
          ok: false,
          kind: 'rate_limited',
          recoverable: false,
          retry_after_ms: err.retryAfterMs ?? null,
          error: 'RF rate limited',
        });
      }
      console.warn({
        message: `[mcp/candidate-search] RF predicate-only search failed: ${err.message}`,
        source: 'mcp-candidate-search',
        droppedFilters: Object.keys(body).filter((k) => !['query', 'limit', 'fields', 'filters'].includes(k)),
      });
      return jsonResponse(200, { ok: true, count: 0, matches: [], warning: 'filter_unverified' });
    }
  }

  // ─── Project RF results ────────────────────────────────────────
  // RF returns full candidate bodies; preserve them as `_body` so projection
  // can read them without an extra fetch.
  let rfMatches = (rfResult.candidates ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    _body: JSON.stringify(c),
  }));

  // If we ran tier-1, preserve its score-ordering on the RF result set.
  if (hasQuery && tier1ForFallback.length > 0) {
    const scoreById = new Map(tier1ForFallback.map((r) => [r.id, r.score]));
    rfMatches = rfMatches
      .map((m) => ({ ...m, score: scoreById.get(m.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }

  const trimmed = rfMatches.slice(0, limit);
  const projected = projectMatches(trimmed, body.fields);
  return jsonResponse(200, successResponse(projected));
}
