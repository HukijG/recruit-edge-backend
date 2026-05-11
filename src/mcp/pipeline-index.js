/**
 * Shared helper for indexing an RF `/job/pipeline` `detail[]` array into
 * stage-keyed candidate-id buckets, used by both `/mcp/job-pipeline` and
 * `/mcp/job-candidates-filter`.
 *
 * The two pipeline tools share this function byte-for-byte; keeping it in one
 * place is the only sensible shape — a divergent fork between handlers would
 * silently desynchronise the two surfaces. Spec rev 5 normalisation rules:
 *
 *   • Each `detail[]` entry has the form
 *     `{candidate: {id, name}, stages: [{from, time, to}]}`.
 *   • The "current stage" is the `to` field of the entry with the latest
 *     `stages[].time` (entries are not guaranteed ordered).
 *   • Disqualified candidates are kept in a separate bucket so the read-time
 *     `include_disqualified` flag can opt them in without a re-fetch.
 *
 * Returns `{active: {stageName: id[]}, disqualified: id[]}`.
 */
export function indexPipelineDetail(detail) {
  const active = {};
  const disqualified = [];
  if (!Array.isArray(detail)) return { active, disqualified };
  for (const entry of detail) {
    const id = entry?.candidate?.id;
    if (id == null) continue;
    const stages = Array.isArray(entry.stages) ? entry.stages : [];
    if (stages.length === 0) continue;
    let latest = stages[0];
    for (let i = 1; i < stages.length; i++) {
      if (Date.parse(stages[i].time) > Date.parse(latest.time)) latest = stages[i];
    }
    const current = latest?.to;
    if (!current) continue;
    if (current === 'Disqualified') {
      disqualified.push(id);
    } else {
      (active[current] ??= []).push(id);
    }
  }
  return { active, disqualified };
}
