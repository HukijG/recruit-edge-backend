/**
 * /mcp/candidate-search — two query paths over the D1-backed candidate cache.
 *
 * 1. **Filter path**: any structured filter (job, stage, owner, company, email,
 *    technology, segment, role, dates) → indexed D1 SELECT with WHERE clauses.
 *    If `query` is also set, the SQL results are fuzzy-scored in JS and sorted
 *    by score (filter → narrow, fuzzy → rank).
 * 2. **Pure-fuzzy path**: only `query` is set with no other filters →
 *    `getSnapshot(env)` over the in-memory snapshot, scored against every row,
 *    top-K returned. No D1 read on the scoring step (snapshot is version-cached).
 *
 * After matches are determined, full bodies are hydrated via a single
 * `SELECT body FROM candidates WHERE id IN (...)` (the pure-fuzzy path doesn't
 * carry bodies). Field projection runs last; `_meta.unresolved_fields` and
 * `_meta.notes` aggregate (deduped) across every match.
 */

import { jsonResponse } from './router.js';
import { session } from './d1-read.js';
import { resolveFields, project } from './projection.js';
import { getSnapshot } from './snapshot.js';
import { scoreString, recencyBoost, normalize } from './fuzzy.js';
import { resolveJob, resolveOwner, resolveStage, disambiguationPayload } from './resolvers.js';

const DEFAULT_FIELDS = ['id', 'name'];
const FUZZY_THRESHOLD = 0.35;

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
 * SQL — preserves zero-regression on canonical inputs and on inputs that
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
 * Translate the request body's structured filters into a SQL fragment +
 * bound args. All user input is bound (?) — never concatenated into SQL.
 *
 * `resolved` carries the post-resolver numeric ids (or `null`) for `job` and
 * `owner` so this builder doesn't have to know about fuzzy resolution.
 */
function buildFilterSql(body, resolved = {}) {
  const where = [];
  const args = [];
  if (body.email) {
    where.push('c.primary_email = ?');
    args.push(String(body.email).toLowerCase());
  }
  if (resolved.ownerId != null) {
    where.push('c.lead_owner_id = ?');
    args.push(resolved.ownerId);
  }
  if (body.added_after) {
    where.push('c.added_time >= ?');
    args.push(body.added_after);
  }
  if (body.added_before) {
    where.push('c.added_time <= ?');
    args.push(body.added_before);
  }
  if (body.updated_after) {
    where.push('c.last_updated >= ?');
    args.push(body.updated_after);
  }
  if (body.updated_before) {
    where.push('c.last_updated <= ?');
    args.push(body.updated_before);
  }
  if (body.company) {
    where.push('c.current_organization LIKE ?');
    args.push(`%${body.company}%`);
  }

  // Single-value custom-field exact matches (`segment`, `role`). Each scans the
  // `custom_fields` array via JSON1 looking for the field by case-insensitive
  // name, then exact-matches the value.
  if (body.segment) {
    where.push("EXISTS (SELECT 1 FROM json_each(c.body, '$.custom_fields') WHERE LOWER(json_extract(value, '$.name')) = 'segment' AND json_extract(value, '$.value') = ?)");
    args.push(body.segment);
  }
  if (body.role) {
    where.push("EXISTS (SELECT 1 FROM json_each(c.body, '$.custom_fields') WHERE LOWER(json_extract(value, '$.name')) = 'role' AND json_extract(value, '$.value') = ?)");
    args.push(body.role);
  }

  // Multi-select `technology`: ANY-match across the requested array. The
  // candidate's Technology custom field is itself a JSON array of strings, so
  // we OR-group one EXISTS-over-json_each per requested value.
  if (Array.isArray(body.technology) && body.technology.length) {
    const orClauses = body.technology
      .map(() =>
        "EXISTS (SELECT 1 FROM json_each(c.body, '$.custom_fields') AS cf WHERE LOWER(json_extract(cf.value, '$.name')) = 'technology' AND EXISTS (SELECT 1 FROM json_each(json_extract(cf.value, '$.value')) AS tv WHERE tv.value = ?))"
      )
      .join(' OR ');
    where.push(`(${orClauses})`);
    for (const tech of body.technology) args.push(tech);
  }

  let from = 'FROM candidates c';
  if (resolved.jobId != null) {
    // Default: only non-disqualified job links. `include_disqualified=true`
    // drops the guard so DQ'd links are included.
    const dqGuard = body.include_disqualified ? '' : ' AND cj.disqualified = 0';
    from += ' JOIN candidate_jobs cj ON cj.candidate_id = c.id' + dqGuard;
    where.push('cj.job_id = ?');
    args.push(resolved.jobId);
    if (body.stage) {
      where.push('cj.stage_name = ?');
      args.push(body.stage);
    }
  }

  return {
    from,
    where: where.length ? 'WHERE ' + where.join(' AND ') : '',
    args,
  };
}

/**
 * Pure-fuzzy path: score every snapshot row against `query`, apply recency
 * boost, threshold, sort by score, take top-`limit`. No D1 read here — the
 * snapshot is cached in memory and version-checked against `last_tail_sync_at`.
 */
async function pureFuzzy(env, body, limit) {
  const snap = await getSnapshot(env);
  const q = normalize(body.query);
  if (!q) return [];
  const scored = snap.rows
    .map((r) => {
      const base = scoreString(q, r.prepared);
      const boost = recencyBoost({ last_activity_at: r.last_activity_at });
      return { id: r.id, name: r.name, score: base * (1 + boost) };
    })
    .filter((r) => r.score >= FUZZY_THRESHOLD)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function handleCandidateSearch({ env, body }) {
  const limit = Math.min(body.limit ?? 5, 50);

  // Resolve `job` (number or fuzzy name) and `owner` (RF id, our-team name,
  // or full RF user fuzzy match). Ambiguous → 200 disambiguation; not_found
  // on either is a 400 since the user gave a filter we couldn't apply.
  let jobId = null;
  if (body.job != null) {
    // search itself emits {count:0, matches:[]} when the job has no candidates,
    // so a numeric id that doesn't appear in the jobs table is fine — the
    // join just returns zero rows.
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
  if (body.owner != null) {
    const r = await resolveOwner(env, body.owner);
    if (!r.ok) {
      if (r.reason === 'ambiguous') {
        return jsonResponse(200, disambiguationPayload(r));
      }
      return jsonResponse(400, { error: `owner not found: ${JSON.stringify(body.owner)}` });
    }
    ownerId = r.value.id;
  }

  // Custom-field fuzzy resolve — segment/role (single string) and technology
  // (multi-select array). Each input is matched against the corpus's
  // distinct values via the version-cached option universe; canonical case is
  // substituted before SQL. Ambiguity returns the standard envelope; not_found
  // falls through to literal exact-match (so unknowns still return empty
  // matches like they did pre-resolver).
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

  // Stage fuzzy resolve — only applies when a job is set (the SQL only filters
  // by stage inside the candidate_jobs JOIN, which only fires for `jobId !=
  // null`). Resolve against the distinct stage names recorded for that job in
  // candidate_jobs so "sourced" / "1st" / "call booked" land on canonical
  // names without a round-trip. Ambiguity returns the standard envelope;
  // not_found falls through to the literal exact-match below — preserves
  // pre-resolver behaviour for genuinely unknown stages (returns empty).
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
      if (r.ok) body = { ...body, stage: r.value.name };
    }
  }

  const filterShape = buildFilterSql(body, { jobId, ownerId });
  const hasFilters = !!filterShape.where || jobId != null;
  const hasQuery = !!body.query;

  let matches;

  if (hasQuery && !hasFilters) {
    // ── Pure-fuzzy path ────────────────────────────────────────────
    matches = await pureFuzzy(env, body, limit);
  } else if (hasFilters) {
    // ── Filter path (with optional fuzzy ranking) ──────────────────
    // When `query` is present we widen the SQL fetch to 200 rows so we have
    // a meaningful pool to rank; without it we just respect the user limit.
    const sqlLimit = hasQuery ? 200 : limit;
    const sql =
      `SELECT c.id, c.name, c.body ` +
      `${filterShape.from} ${filterShape.where} ` +
      `ORDER BY c.last_updated DESC LIMIT ?`;
    const { results } = await session(env)
      .prepare(sql)
      .bind(...filterShape.args, sqlLimit)
      .all();
    matches = (results ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      _body: r.body,
    }));
    if (hasQuery) {
      const q = normalize(body.query);
      matches = matches
        .map((m) => {
          const c = JSON.parse(m._body);
          const base = scoreString(q, c.name ?? '');
          const boost = recencyBoost(c);
          return { ...m, score: base * (1 + boost) };
        })
        .filter((m) => m.score >= FUZZY_THRESHOLD)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }
  } else {
    return jsonResponse(400, { error: 'must provide query or at least one filter' });
  }

  // Hydrate bodies for projection (pure-fuzzy results don't carry _body).
  if (matches.length && !matches[0]._body) {
    const ids = matches.map((m) => m.id);
    const placeholders = ids.map(() => '?').join(', ');
    const { results } = await session(env)
      .prepare(`SELECT id, body FROM candidates WHERE id IN (${placeholders})`)
      .bind(...ids)
      .all();
    const byId = new Map((results ?? []).map((r) => [r.id, r.body]));
    matches = matches.map((m) => ({ ...m, _body: byId.get(m.id) }));
  }

  // Project + aggregate unresolved-field errors / alias notes (deduped).
  const requested = body.fields ?? DEFAULT_FIELDS;
  const errs = [];
  const notesAgg = [];
  const projected = matches.map((m) => {
    const c = JSON.parse(m._body || '{}');
    const { paths, errors, notes } = resolveFields(requested, c, c);
    for (const e of errors) if (!errs.includes(e)) errs.push(e);
    for (const n of notes) if (!notesAgg.includes(n)) notesAgg.push(n);
    return { ...project(c, paths), score: m.score };
  });

  const response = { count: projected.length, matches: projected };
  if (errs.length || notesAgg.length) {
    response._meta = {};
    if (errs.length) response._meta.unresolved_fields = errs;
    if (notesAgg.length) response._meta.notes = notesAgg;
  }
  return jsonResponse(200, response);
}
