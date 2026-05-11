/**
 * /mcp/candidate-search — single-call tier-2 fuzzy + filter search.
 *
 * Per spec rev 5 ("thin-immutable-cache-design.md") this handler now follows
 * the **single round-trip** design instead of a per-id fan-out:
 *
 * 1. **Tier 1: cache fuzzy** — `query` (if any) → in-memory snapshot scan →
 *    candidate id list. Pure-name match, recency-boosted via `added_time_ms`.
 * 2. **Filter classification** — split user-supplied filters into:
 *      - **Immutable** (`added_after` / `added_before`, `linkedin_profile`)
 *        → resolved against the local cache; no RF round-trip.
 *      - **Mutable** (`email`, `company`/`current_organization`, `current_title`,
 *        `owner` / `lead_owner_id`, `stage`+`job`, `disqualified`,
 *        `custom_field.<id>`, …) → routed to RF.
 * 3. **Tier 2: RF `/candidate/search` (single call)** when any mutable filter
 *    is present. Composes `candidate_id IN (tier-1 ids)` + the predicate
 *    filters server-side via `conjunction: 'match-all'`. No fan-out.
 * 4. **Pure-fuzzy short-circuit** — no mutable filter → return tier-1 results
 *    directly (no RF call).
 * 5. **Empty tier-1 + mutable filter** — return empty without RF call.
 * 6. **RF failure during tier-2** — degrade to tier-1 results with
 *    `warning: 'filter_unverified'`.
 *
 * NB: the legacy `last_updated` / `last_activity` range filters are DROPPED
 * per spec rev 5 (mutable, not load-bearing). The legacy `last_updated DESC`
 * ordering for filter-only queries is replaced by RF's result order.
 *
 * The fuzzy resolvers for `job` / `owner` / `stage` / `technology` / `segment`
 * / `role` still run client-side first (so Claude's natural-language input
 * lands as canonical RF values). The `disqualified=true` shorthand expands to
 * `{key: 'stage', values: ['Disqualified']}` — RF has no boolean DQ filter.
 */

import { jsonResponse } from './router.js';
import { session } from './d1-read.js';
import { resolveFieldsWithDefaults } from './projection.js';
import { projectWithLinkedIn } from './linkedin.js';
import { getSnapshot } from './snapshot.js';
import { scoreString, recencyBoost, normalize } from './fuzzy.js';
import { resolveJob, resolveOwner, resolveStage, disambiguationPayload } from './resolvers.js';
import {
  searchCandidatesByIdsAndPredicate,
  searchCandidatesByPredicateOnly,
} from '../rf-client.js';

const DEFAULT_FIELDS = ['id', 'name', 'current_title', 'linkedin_profile'];
const FUZZY_THRESHOLD = 0.35;
const TIER1_FUZZY_LIMIT = 200;  // tier-1 pool size before tier-2 narrowing

// In-memory custom-field option universes, version-checked against the
// `last_tail_sync_at` sync_state stamp (same pattern as snapshot.js). Survives
// across requests within an isolate; refreshed automatically when the sync
// worker advances the cursor.
const CF_OPTS_KEY = '__rfMcpCustomFieldOptions';

async function readSyncVersion(env) {
  const row = await env.RF_MCP_CACHE
    .prepare("SELECT value FROM sync_state WHERE key = 'last_tail_sync_at'")
    .first();
  return row?.value ?? null;
}

/**
 * Pull the universe of distinct values for a single custom field by walking
 * every candidate's `custom_fields` JSON. Cached in worker globals + version-
 * checked. Returns [] if the field doesn't exist in the corpus — caller falls
 * back to literal exact-match behaviour in that case.
 *
 * `multiSelect=true` walks the inner array (Technology stores `value: [...]`).
 * `multiSelect=false` reads the single string `value` (Segment, Role).
 *
 * NB: this still reads the legacy `candidates.body` JSON during the dual-
 * write phase. When the legacy table drops (Task 30+), this helper either
 * dies with `technology`/`segment`/`role` filter support or migrates to a
 * dedicated lookup table — out-of-scope for Task 13.
 */
async function getCustomFieldOptions(env, fieldName, multiSelect) {
  const G = globalThis;
  G[CF_OPTS_KEY] = G[CF_OPTS_KEY] ?? {};
  const cacheKey = `${fieldName.toLowerCase()}:${multiSelect ? 'm' : 's'}`;
  const version = await readSyncVersion(env);
  const cached = G[CF_OPTS_KEY][cacheKey];
  if (cached && cached.dataVersion === version) return cached.options;

  const sql = multiSelect
    ? `SELECT DISTINCT tv.value AS v
         FROM candidates c, json_each(c.body, '$.custom_fields') AS cf,
              json_each(json_extract(cf.value, '$.value')) AS tv
        WHERE LOWER(json_extract(cf.value, '$.name')) = ?
          AND tv.value IS NOT NULL`
    : `SELECT DISTINCT json_extract(cf.value, '$.value') AS v
         FROM candidates c, json_each(c.body, '$.custom_fields') AS cf
        WHERE LOWER(json_extract(cf.value, '$.name')) = ?
          AND json_extract(cf.value, '$.value') IS NOT NULL`;
  const { results } = await session(env)
    .prepare(sql)
    .bind(fieldName.toLowerCase())
    .all();
  const options = (results ?? [])
    .map((r) => r.v)
    .filter((v) => typeof v === 'string' && v.length > 0);
  G[CF_OPTS_KEY][cacheKey] = { options, dataVersion: version };
  return options;
}

/**
 * Resolve a custom-field user-input string against the universe via the same
 * primitive `resolveStage` uses (case-insensitive exact, then fuzzy + UNIQUE_GAP).
 * Returns the standard discriminated union: `{ ok, value }` / `{ ok:false, reason:'ambiguous', ... }`.
 * On not_found the caller is expected to fall through to literal exact-match
 * behaviour — preserves zero-regression on canonical inputs and on inputs that
 * fuzzy genuinely can't disambiguate.
 */
async function fuzzyResolveCustomFieldValue(env, fieldName, input, multiSelect) {
  const options = await getCustomFieldOptions(env, fieldName, multiSelect);
  if (options.length === 0) {
    return { ok: true, value: { id: input, name: input } };  // schema empty → pass through
  }
  const resolvable = options.map((name) => ({ id: name, name }));
  return resolveStage(input, resolvable);
}

/**
 * Translate the request body's structured filters into RF `/candidate/search`
 * filter objects per spec rev 5 RF-7 verification.
 *
 * Returns:
 *   - `rfFilters`        — array of RF filter objects (to pass under `filters[]`).
 *   - `mutableKeysHit`   — list of mutable-filter keys we routed to RF (for
 *     telemetry / degradation logging).
 *
 * Inputs are read from BOTH the top-level body fields (existing wire contract)
 * AND the optional `filters` long-tail bag (forward-compat per the MCP tool
 * descriptor in `mcp-worker/src/tools.ts`).
 *
 * `resolved.{jobId,ownerId,stage}` carry post-fuzzy-resolver canonical values
 * so this builder doesn't have to know about fuzzy resolution.
 *
 * Filter-key map (spec rev 5 RF-7):
 *   `email`              → RF `email`            (text — substring)
 *   `company` /
 *     `current_organization` → RF `current_company` (text)
 *   `current_title`      → RF `current_title`    (text)
 *   `owner` / `lead_owner_id` → RF `lead_owner`  (multi-select-by-ID; numeric)
 *   `stage` (with `job`) → RF `stage`            (multi-select-by-NAME)
 *   `job_id` / `job`     → RF `job`              (multi-select-by-ID; numeric)
 *   `disqualified=true`  → RF `{stage: 'Disqualified'}` (no boolean DQ filter)
 *   `linkedin_profile`   → RF `linkedin_profile` (text — substring)
 *   `technology` /
 *     `segment` / `role` → custom_field.<id>     (TODO: id mapping not wired)
 *
 * Custom-field filters (`technology`, `segment`, `role`) are currently logged
 * and ignored — the project doesn't yet expose a custom-field-id mapping table.
 * They remain mutable per the spec's filter-to-source map; once a mapping is
 * wired (env var or D1 lookup of `/candidate/custom-field/list`), translate to
 * `{key: 'custom_field.<id>', conjunction: 'in', values: [...]}`.
 */
function buildRFPredicateFilters(body, resolved = {}) {
  const out = [];
  const mutableKeysHit = [];
  // Merge top-level body keys with the optional `filters` long-tail bag.
  // Top-level keys take precedence (existing wire contract).
  const longTail = (body && typeof body.filters === 'object' && body.filters !== null)
    ? body.filters
    : {};
  const tf = { ...longTail, ...body };

  // ─── email (text — substring per RF-7) ─────────────────────────
  if (tf.email != null && tf.email !== '') {
    out.push({ conjunction: 'in', values: [String(tf.email)], key: 'email' });
    mutableKeysHit.push('email');
  }

  // ─── company / current_organization → RF `current_company` ─────
  const company = tf.current_organization ?? tf.company;
  if (company != null && company !== '') {
    out.push({ conjunction: 'in', values: [String(company)], key: 'current_company' });
    mutableKeysHit.push('current_company');
  }

  // ─── current_title (text) ──────────────────────────────────────
  if (tf.current_title != null && tf.current_title !== '') {
    out.push({ conjunction: 'in', values: [String(tf.current_title)], key: 'current_title' });
    mutableKeysHit.push('current_title');
  }

  // ─── owner / lead_owner → RF `lead_owner` (by ID) ──────────────
  // Use the post-resolver numeric id when present; fall through to a numeric
  // top-level value (preserves the `owner_id` direct-id wire shape).
  const ownerNumeric = resolved.ownerId
    ?? (typeof tf.lead_owner_id === 'number' ? tf.lead_owner_id : undefined);
  if (typeof ownerNumeric === 'number' && Number.isFinite(ownerNumeric)) {
    out.push({ conjunction: 'in', values: [ownerNumeric], key: 'lead_owner' });
    mutableKeysHit.push('lead_owner');
  }

  // ─── job → RF `job` (by ID) ────────────────────────────────────
  if (typeof resolved.jobId === 'number' && Number.isFinite(resolved.jobId)) {
    out.push({ conjunction: 'in', values: [resolved.jobId], key: 'job' });
    mutableKeysHit.push('job');
  }

  // ─── stage (with job, by NAME) ─────────────────────────────────
  // `resolved.stageName` is the canonical post-fuzzy-resolver name. Only
  // emitted alongside a `job` filter — stage filtering without job context is
  // ambiguous (each job has its own pipeline).
  if (resolved.stageName && typeof resolved.jobId === 'number') {
    out.push({ conjunction: 'in', values: [String(resolved.stageName)], key: 'stage' });
    mutableKeysHit.push('stage');
  }

  // ─── disqualified=true → stage='Disqualified' (no boolean DQ filter) ──
  // NB: when the user *also* has a `job` filter set, the stage filter we
  // already pushed above is the canonical post-fuzzy-resolved one; appending
  // a second `stage` filter ANDs them and would return zero rows. Skip the
  // DQ expansion if a stage is already set — the user's explicit stage wins.
  // For DQ-from-a-specific-job, RF has `disqualified_from` (per RF-7 wrinkle)
  // but the current wire contract doesn't surface that knob.
  if (tf.disqualified === true && !resolved.stageName) {
    out.push({ conjunction: 'in', values: ['Disqualified'], key: 'stage' });
    mutableKeysHit.push('stage_disqualified');
  }

  // ─── linkedin_profile (text — substring per RF-7) ──────────────
  // NB: linkedin_profile is QUASI-immutable; we still route it through RF as
  // a substring search since RF treats it as a text filter. Callers wanting
  // exact-slug match should use the cache-only path (filter handler).
  if (tf.linkedin_profile != null && tf.linkedin_profile !== '') {
    out.push({ conjunction: 'in', values: [String(tf.linkedin_profile)], key: 'linkedin_profile' });
    mutableKeysHit.push('linkedin_profile');
  }

  // ─── technology / role / segment → custom_field.<id> (NOT wired) ──
  // Spec rev 5 routes these through RF as `custom_field.<id>` filters, but
  // the project doesn't expose a custom-field-id mapping table yet. Log the
  // dropped filter so we can spot drift in production telemetry; revisit
  // when the id mapping ships.
  const cfDropped = [];
  if (Array.isArray(tf.technology) && tf.technology.length > 0) cfDropped.push('technology');
  if (tf.segment != null && tf.segment !== '') cfDropped.push('segment');
  if (tf.role != null && tf.role !== '') cfDropped.push('role');
  if (cfDropped.length > 0) {
    console.warn({
      message: '[mcp/candidate-search] custom-field filters not yet wired to RF custom_field.<id> — ignored',
      source: 'mcp-candidate-search',
      ignoredFilters: cfDropped,
    });
    // TODO(future): map to `{key: 'custom_field.<id>', conjunction: 'in', values: [...]}`
    // once a custom-field id table is exposed (env var or D1 lookup of
    // `/candidate/custom-field/list`).
  }

  // ─── Dropped per spec rev 5 ────────────────────────────────────
  // `last_updated` / `last_activity_at` ranges (`updated_after`/`updated_before`)
  // — mutable, not load-bearing. Silently dropped; no warning needed since the
  // tool descriptor still lists them but they no longer route anywhere.
  // `added_after` / `added_before` are IMMUTABLE and handled by the caller's
  // immutable-filter path (cache-side), not here.

  return { rfFilters: out, mutableKeysHit };
}

/**
 * Detect whether the request includes any IMMUTABLE-only filter (i.e. a
 * filter that should narrow the tier-1 fuzzy result set in JS without
 * touching RF). Returns the predicate to apply to the snapshot row, or
 * `null` if no immutable filter is set.
 *
 * Immutable per spec rev 5: `added_time` range, `linkedin_profile` exact.
 * NB: `linkedin_profile` is also routed to RF as a substring search above —
 * here we additionally apply an exact slug match against the cache when the
 * user's input looks like a bare slug. Both paths can fire; the predicates
 * are conjunctive (AND).
 */
function buildImmutableSnapshotFilter(body) {
  const preds = [];
  if (body.added_after) {
    const ms = Date.parse(body.added_after);
    if (Number.isFinite(ms)) preds.push((r) => r.added_time_ms >= ms);
  }
  if (body.added_before) {
    const ms = Date.parse(body.added_before);
    if (Number.isFinite(ms)) preds.push((r) => r.added_time_ms <= ms);
  }
  // linkedin_profile exact slug match (cache-side); only when body says so
  // explicitly via top-level (the long-tail `filters.linkedin_profile` is
  // routed through RF as substring instead).
  if (typeof body.linkedin_profile === 'string' && body.linkedin_profile) {
    const slug = body.linkedin_profile;
    preds.push((r) => r.linkedin_profile === slug);
  }
  if (preds.length === 0) return null;
  return (r) => preds.every((p) => p(r));
}

/**
 * Tier-1 fuzzy: score every snapshot row against `query`, apply recency
 * boost, threshold, sort by score, take top-`limit`. No D1 read here — the
 * snapshot is cached in memory and version-checked against the cron cursor
 * stamp.
 *
 * `limit` defaults to TIER1_FUZZY_LIMIT (200) for the tier-2 funnel; the
 * pure-fuzzy short-circuit overrides this with the user's requested limit.
 *
 * Optional `immutablePredicate` further narrows in JS before returning.
 *
 * Returns rows shaped as `{id, name, score, _thinRow}` — `_thinRow` carries
 * the snapshot's thin fields (id, name, linkedin_profile, added_time_ms) so
 * projection can synthesize a body without re-fetching from D1 when the
 * legacy `candidates.body` cache is empty.
 */
async function tier1Fuzzy(env, query, limit, immutablePredicate = null) {
  const snap = await getSnapshot(env);
  const q = normalize(query);
  if (!q) return [];
  const scored = snap.rows
    .filter((r) => immutablePredicate == null || immutablePredicate(r))
    .map((r) => {
      const base = scoreString(q, r.prepared);
      const boost = recencyBoost({ added_time_ms: r.added_time_ms });
      return { id: r.id, name: r.name, score: base * (1 + boost), _thinRow: r };
    })
    .filter((r) => r.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Synthesize a candidate-shaped body from a snapshot thin row, used when the
 * legacy `candidates.body` blob is missing (post-Task 30 / new-thin-cache
 * inserts that didn't dual-write). Carries id, name, linkedin_profile,
 * and added_time (ISO string from added_time_ms). Other fields default to
 * undefined and projection drops them silently.
 */
function thinRowToBody(row) {
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
 * Project a list of `{id, name, ...}` matches (either tier-1 fuzzy hits or
 * RF candidate bodies) into the standard MCP response shape.
 *
 * Body source by precedence (per match):
 *   1. `m._body` — set by tier-2 RF match (full RF candidate body, JSON
 *      string). Used directly.
 *   2. Legacy `candidates.body` D1 read — single batched IN-list SELECT for
 *      every tier-1 match. Populated during the dual-write phase; absent
 *      post-Task 30. Caller pays at most one D1 read per call.
 *   3. `m._thinRow` — snapshot row, synthesized into a minimal candidate
 *      body. Final fallback so the post-thin-cache pure-fuzzy / immutable-
 *      filter paths still project sensibly.
 *
 * `userFields` is the caller-supplied `fields[]` — additive over defaults.
 */
async function projectMatches(env, matches, userFields) {
  // Single batched legacy-body lookup for everything missing a `_body`.
  // RF results already carry it; pure-fuzzy / tier-1 results don't.
  const idsNeedingBody = matches.filter((m) => !m._body).map((m) => m.id);
  let bodyById = new Map();
  if (idsNeedingBody.length) {
    const placeholders = idsNeedingBody.map(() => '?').join(', ');
    const { results } = await session(env)
      .prepare(`SELECT id, body FROM candidates WHERE id IN (${placeholders})`)
      .bind(...idsNeedingBody)
      .all();
    bodyById = new Map((results ?? []).map((r) => [r.id, r.body]));
  }

  return matches.map((m) => {
    let c;
    const bodyJson = m._body ?? bodyById.get(m.id);
    if (bodyJson) {
      c = JSON.parse(bodyJson);
    } else if (m._thinRow) {
      c = thinRowToBody(m._thinRow);
    } else {
      // Last-resort minimal shape — handler shouldn't reach here, but
      // guarantees `id`/`name` are populated even if both lookup + thin
      // row are absent.
      c = { id: m.id, name: m.name };
    }
    const { paths } = resolveFieldsWithDefaults(userFields, DEFAULT_FIELDS, c, c);
    const projected = projectWithLinkedIn(c, paths);
    // Preserve `score` when present (tier-1 fuzzy hits carry it; pure-RF
    // matches don't).
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
    if (!Number.isFinite(id)) return jsonResponse(400, { error: 'job_id must be numeric' });
    jobId = id;
  } else if (body.job != null) {
    const r = await resolveJob(env, body.job, { validateNumeric: false });
    if (!r.ok) {
      if (r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      return jsonResponse(400, { error: `job not found: ${JSON.stringify(body.job)}` });
    }
    jobId = r.value.id;
  }
  let ownerId = null;
  if (body.owner_id != null) {
    const id = Number(body.owner_id);
    if (!Number.isFinite(id)) return jsonResponse(400, { error: 'owner_id must be numeric' });
    ownerId = id;
  } else if (body.owner != null) {
    const r = await resolveOwner(env, body.owner);
    if (!r.ok) {
      if (r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      return jsonResponse(400, { error: `owner not found: ${JSON.stringify(body.owner)}` });
    }
    ownerId = r.value.id;
  }

  // ─── Custom-field fuzzy resolve (technology / segment / role) ──
  // Each input is matched against the corpus's distinct values via the
  // version-cached option universe; canonical case is substituted before
  // routing. Ambiguity returns the standard envelope; not_found falls
  // through (unknowns still return empty matches like they did
  // pre-resolver). NB: even though `buildRFPredicateFilters` currently
  // *drops* these (until `custom_field.<id>` mapping is wired), we still
  // resolve here so:
  //   (a) ambiguity surfaces as a disambiguation envelope (the contract
  //       Claude depends on), and
  //   (b) when the mapping eventually ships, only the `buildRFPredicateFilters`
  //       gap closes — no other code change.
  if (Array.isArray(body.technology) && body.technology.length) {
    const resolved = [];
    for (const v of body.technology) {
      const r = await fuzzyResolveCustomFieldValue(env, 'technology', v, true);
      if (!r.ok && r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      resolved.push(r.ok ? r.value.name : v);
    }
    body = { ...body, technology: resolved };
  }
  if (body.segment) {
    const r = await fuzzyResolveCustomFieldValue(env, 'segment', body.segment, false);
    if (!r.ok && r.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(r));
    }
    if (r.ok) body = { ...body, segment: r.value.name };
  }
  if (body.role) {
    const r = await fuzzyResolveCustomFieldValue(env, 'role', body.role, false);
    if (!r.ok && r.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(r));
    }
    if (r.ok) body = { ...body, role: r.value.name };
  }

  // ─── Stage fuzzy resolve (only with job context) ───────────────
  // Resolve against the distinct stage names recorded for that job in
  // candidate_jobs (legacy cache during the dual-write phase). Ambiguity
  // returns the standard envelope; not_found falls through and the
  // unresolved name is sent verbatim to RF (which will return zero rows
  // for an unknown stage — same observable behaviour as the pre-rev-5
  // fall-through-to-empty pattern).
  let stageName = null;
  if (body.stage && jobId != null) {
    const { results: stageRows } = await session(env)
      .prepare('SELECT DISTINCT stage_name FROM candidate_jobs WHERE job_id = ? AND stage_name IS NOT NULL')
      .bind(jobId)
      .all();
    const distinct = (stageRows ?? []).map((r) => r.stage_name).filter(Boolean);
    if (distinct.length > 0) {
      const resolvable = distinct.map((name) => ({ id: name, name }));
      const r = resolveStage(body.stage, resolvable);
      if (!r.ok && r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      if (r.ok) {
        stageName = r.value.name;
      } else {
        // Not found in the local distinct list — pass through verbatim.
        // RF treats unknown stage names as "no match" → empty result.
        stageName = String(body.stage);
      }
    } else {
      // No distinct stages cached yet (cold cache, edge case) — pass through.
      stageName = String(body.stage);
    }
  }

  // ─── Build the RF filter envelope ──────────────────────────────
  const { rfFilters, mutableKeysHit } = buildRFPredicateFilters(body, {
    jobId,
    ownerId,
    stageName,
  });

  const immutablePredicate = buildImmutableSnapshotFilter(body);
  const hasMutableFilters = rfFilters.length > 0;
  const hasImmutableFilters = immutablePredicate != null;
  const hasQuery = !!body.query;

  // Must have something to narrow on — query, mutable filter, OR immutable.
  if (!hasQuery && !hasMutableFilters && !hasImmutableFilters) {
    return jsonResponse(400, { error: 'must provide query or at least one filter' });
  }

  // ─── Pure-fuzzy short-circuit (no mutable filter) ──────────────
  // Either query+immutable or query alone. No RF round-trip.
  if (hasQuery && !hasMutableFilters) {
    const tier1 = await tier1Fuzzy(env, body.query, limit, immutablePredicate);
    const projected = await projectMatches(env, tier1, body.fields);
    return jsonResponse(200, { count: projected.length, matches: projected });
  }

  // ─── Immutable-only filter (no query, no mutable) ──────────────
  // Cache-side narrow over the snapshot. No fuzzy ranking; recency-DESC.
  if (!hasQuery && !hasMutableFilters && hasImmutableFilters) {
    const snap = await getSnapshot(env);
    const matches = snap.rows
      .filter(immutablePredicate)
      .sort((a, b) => (b.added_time_ms ?? 0) - (a.added_time_ms ?? 0))
      .slice(0, limit)
      .map((r) => ({ id: r.id, name: r.name }));
    const projected = await projectMatches(env, matches, body.fields);
    return jsonResponse(200, { count: projected.length, matches: projected });
  }

  // ─── Tier-2: mutable filter present, route through RF ──────────
  // 1. If there's a query, run tier-1 to narrow the id-pool first.
  // 2. Otherwise, predicate-only RF search (no id-list).
  let rfResult;
  let tier1ForFallback = [];

  if (hasQuery) {
    const tier1 = await tier1Fuzzy(env, body.query, TIER1_FUZZY_LIMIT, immutablePredicate);
    tier1ForFallback = tier1;
    if (tier1.length === 0) {
      // Tier-1 returned nothing — return empty without bothering RF.
      return jsonResponse(200, { count: 0, matches: [] });
    }
    try {
      rfResult = await searchCandidatesByIdsAndPredicate(
        { ids: tier1.map((r) => r.id), predicateFilters: rfFilters },
        env,
      );
    } catch (err) {
      console.warn({
        message: `[mcp/candidate-search] RF search failed; degrading to tier-1: ${err.message}`,
        source: 'mcp-candidate-search',
        mutableKeysHit,
        query: body.query,
      });
      const projected = await projectMatches(env, tier1.slice(0, limit), body.fields);
      return jsonResponse(200, {
        count: projected.length,
        matches: projected,
        warning: 'filter_unverified',
      });
    }
  } else {
    // No query → predicate-only RF search.
    try {
      rfResult = await searchCandidatesByPredicateOnly(
        { predicateFilters: rfFilters },
        env,
      );
    } catch (err) {
      console.warn({
        message: `[mcp/candidate-search] RF predicate-only search failed: ${err.message}`,
        source: 'mcp-candidate-search',
        mutableKeysHit,
      });
      // Without a tier-1 pool, we have nothing to degrade to. Return an
      // empty response with the filter_unverified warning so the caller
      // knows the filter wasn't applied.
      return jsonResponse(200, {
        count: 0,
        matches: [],
        warning: 'filter_unverified',
      });
    }
  }

  // ─── Project RF results ────────────────────────────────────────
  // RF returns full candidate bodies; preserve them as `_body` so
  // projectMatches doesn't re-fetch from D1.
  let rfMatches = (rfResult.candidates ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    _body: JSON.stringify(c),
  }));

  // If we ran tier-1, preserve its score-ordering on the RF result set:
  // RF intersects the id-list but doesn't preserve our recency-boosted
  // fuzzy ordering. Reorder by tier-1 score, then trim to limit.
  if (hasQuery && tier1ForFallback.length > 0) {
    const scoreById = new Map(tier1ForFallback.map((r) => [r.id, r.score]));
    rfMatches = rfMatches
      .map((m) => ({ ...m, score: scoreById.get(m.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }

  const trimmed = rfMatches.slice(0, limit);
  const projected = await projectMatches(env, trimmed, body.fields);
  return jsonResponse(200, { count: projected.length, matches: projected });
}
