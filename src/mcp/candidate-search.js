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

const DEFAULT_FIELDS = ['id', 'name'];
const FUZZY_THRESHOLD = 0.35;

/**
 * Translate the request body's structured filters into a SQL fragment +
 * bound args. All user input is bound (?) — never concatenated into SQL.
 */
function buildFilterSql(body) {
  const where = [];
  const args = [];
  if (body.email) {
    where.push('c.primary_email = ?');
    args.push(String(body.email).toLowerCase());
  }
  if (body.owner) {
    where.push('c.lead_owner_id = ?');
    args.push(Number(body.owner));
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
  if (body.job != null) {
    // Default: only non-disqualified job links. `include_disqualified=true`
    // drops the guard so DQ'd links are included.
    const dqGuard = body.include_disqualified ? '' : ' AND cj.disqualified = 0';
    from += ' JOIN candidate_jobs cj ON cj.candidate_id = c.id' + dqGuard;
    where.push('cj.job_id = ?');
    args.push(Number(body.job));
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
  const filterShape = buildFilterSql(body);
  const hasFilters = !!filterShape.where || body.job != null;
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
