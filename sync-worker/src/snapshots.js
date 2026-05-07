/**
 * snapshots.js — per-job snapshot builder + KV rebuild orchestrator.
 *
 * The MCP read surface serves pre-shaped per-job snapshots from KV:
 *   - `mcp:pipeline:{jobId}`        — stages with grouped candidates
 *   - `mcp:job-candidates:{jobId}`  — flat matched-candidates list
 *
 * Both are derived from the same indexed JOIN against D1's
 * `candidate_jobs` + `candidates` tables (filtered to non-disqualified
 * links of a given job_id, which matches the leading column of
 * `idx_cj_job_stage_dq`). Stage grouping is done worker-side rather
 * than via SQL GROUP BY so we keep the full per-candidate field set
 * inside each stage bucket.
 *
 * `buildJobSnapshots` is pure (returns objects, no I/O beyond the SQL
 * read). `rebuildMcpSnapshots` is the side-effecty orchestrator that
 * picks the job set and writes both KV keys per job. Sequential across
 * jobs — the open-job count is small enough at this scale that
 * parallelising the outer loop isn't worth the added KV-write
 * concurrency (and would break the implicit "fail fast on first
 * broken job" behaviour).
 */

const SELECT_FOR_SNAPSHOT = `
  SELECT cj.candidate_id AS id, c.name, c.body,
         cj.stage_name, cj.stage_moved, cj.added_to_job, cj.disqualified,
         c.primary_email, c.linkedin_profile, c.current_title,
         c.current_organization, c.lead_owner_id, c.last_activity_at
  FROM candidate_jobs cj
  JOIN candidates c ON c.id = cj.candidate_id
  WHERE cj.job_id = ? AND cj.disqualified = 0
  ORDER BY c.name ASC
`;

/**
 * Shape one D1 row (joined cj + c + body JSON) into the wide candidate
 * entry surfaced in MCP responses. Every documented field is present,
 * even if null, so callers don't need to defensively check existence.
 */
function buildEntry(row) {
  const body = JSON.parse(row.body || '{}');
  return {
    id: row.id,
    name: row.name,
    first_name: body.first_name ?? null,
    last_name: body.last_name ?? null,
    stage_name: row.stage_name,
    stage_moved: row.stage_moved,
    added_to_job: row.added_to_job,
    primary_email: row.primary_email,
    emails: body.emails ?? null,
    phone_numbers: body.phone_numbers ?? null,
    primary_phone: body.phone_numbers?.[0]?.phone_number ?? null,
    linkedin_profile: row.linkedin_profile,
    github_profile: body.github_profile ?? null,
    twitter_profile: body.twitter_profile ?? null,
    current_title: row.current_title,
    current_organization: row.current_organization,
    location: body.location ?? null,
    source: body.source ?? null,
    tags: body.tags ?? null,
    skills: body.skills ?? null,
    lead_owner: body.lead_owner ?? { id: row.lead_owner_id ?? null },
    last_activity_at: row.last_activity_at,
  };
}

/**
 * Pure helper: run the indexed JOIN for one job and shape the results
 * into the `pipeline` + `list` snapshot pair.
 *
 * @param {object} env     - Worker env with `RF_MCP_CACHE` D1 binding
 * @param {number} jobId   - target job id
 * @param {object} jobMeta - row from `jobs` table (or compatible shape)
 * @returns {Promise<{ pipeline: object, list: object }>}
 */
export async function buildJobSnapshots(env, jobId, jobMeta) {
  const { results } = await env.RF_MCP_CACHE
    .prepare(SELECT_FOR_SNAPSHOT)
    .bind(jobId)
    .all();

  const entries = results.map(buildEntry);

  // Extract this job's pipeline order from any candidate's `body.jobs[k].stages`.
  // RF's `/candidate/get` response carries the full pipeline definition on
  // each job link, so any non-DQ candidate on this job is sufficient. Falls
  // back to [] if no candidate has it — main worker's reader treats absent
  // `pipeline_stages` as "no range filter possible" and returns the populated
  // stages unfiltered.
  let pipelineStages = [];
  for (const row of results ?? []) {
    const body = JSON.parse(row.body || '{}');
    const link = (body.jobs ?? []).find((j) => Number(j.job_id) === Number(jobId));
    if (Array.isArray(link?.stages) && link.stages.length > 0) {
      pipelineStages = link.stages.map((s) => ({ id: s.id, name: s.name }));
      break;
    }
  }

  // Group by stage worker-side. Map preserves insertion order (which is
  // c.name ASC from the SQL ORDER BY), so candidates inside each stage
  // bucket also stay in that name order.
  const stagesMap = new Map();
  for (const e of entries) {
    if (!stagesMap.has(e.stage_name)) stagesMap.set(e.stage_name, []);
    stagesMap.get(e.stage_name).push(e);
  }

  const pipeline = {
    job: {
      id: jobId,
      name: jobMeta?.name ?? null,
      client_company_name: jobMeta?.client_company_name ?? null,
    },
    pipeline_stages: pipelineStages,
    stages: [...stagesMap.entries()].map(([stage_name, candidates]) => ({
      stage_name,
      count: candidates.length,
      candidates,
    })),
  };

  const list = {
    job: { id: jobId, name: jobMeta?.name ?? null },
    total: entries.length,
    matched: entries,
  };

  return { pipeline, list };
}

/**
 * Rebuild MCP-side snapshots in KV.
 *
 * - `affectedJobIds = null` (or empty) → rebuild every open job
 *   (`is_open = 1`).
 * - `affectedJobIds = [...]` → rebuild only those jobs, regardless of
 *   open/closed status. The caller is expected to have pre-filtered
 *   to the set they actually want refreshed.
 *
 * KV writes use a 3600s TTL — the next scheduled tick (15 min) will
 * overwrite long before TTL fires; the TTL is just defence against
 * orphaned snapshots if a job disappears entirely.
 *
 * Sequential across jobs (small N at this scale, easier to reason
 * about partial-failure behaviour). Both KV writes per job are
 * issued in parallel.
 *
 * @param {object} env
 * @param {number[]|null} affectedJobIds
 */
export async function rebuildMcpSnapshots(env, affectedJobIds) {
  let jobs;
  if (affectedJobIds && affectedJobIds.length) {
    const placeholders = affectedJobIds.map(() => '?').join(', ');
    const { results } = await env.RF_MCP_CACHE
      .prepare(`SELECT id, name, client_company_name FROM jobs WHERE id IN (${placeholders})`)
      .bind(...affectedJobIds)
      .all();
    jobs = results;
  } else {
    const { results } = await env.RF_MCP_CACHE
      .prepare(`SELECT id, name, client_company_name FROM jobs WHERE is_open = 1`)
      .all();
    jobs = results;
  }

  for (const job of jobs) {
    const { pipeline, list } = await buildJobSnapshots(env, job.id, job);
    await Promise.all([
      env.SYNC_STATE.put(
        `mcp:pipeline:${job.id}`,
        JSON.stringify(pipeline),
        { expirationTtl: 3600 },
      ),
      env.SYNC_STATE.put(
        `mcp:job-candidates:${job.id}`,
        JSON.stringify(list),
        { expirationTtl: 3600 },
      ),
    ]);
  }
}
