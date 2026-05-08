/**
 * pipeline-normalize.js — RF /job/pipeline `detail[]` → per-stage candidate-id map.
 *
 * Each `detail[]` entry carries a candidate's full stage-movement history.
 * The current stage is the `to` field of the entry with the latest `time`.
 * Candidates whose current stage is "Disqualified" are dropped — pipeline
 * views are active-pipeline by default. (Opt-in via `include_disqualified`
 * at read time, which queries the candidates table separately.)
 *
 * Pure function, no I/O.
 */

export function normalizePipelineDetail(detail) {
  const byStage = {};
  if (!Array.isArray(detail)) return byStage;
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
    if (current === 'Disqualified') continue;
    (byStage[current] ??= []).push(id);
  }
  return byStage;
}
