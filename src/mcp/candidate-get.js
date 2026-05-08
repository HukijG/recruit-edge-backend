import { jsonResponse } from './router.js';
import { getCandidateById } from './d1-read.js';
import { resolveFieldsWithDefaults } from './projection.js';
import { projectWithLinkedIn } from './linkedin.js';
import { getSnapshot } from './snapshot.js';
import { scoreString, recencyBoost, normalize } from './fuzzy.js';

const DEFAULT_FIELDS = [
  'id', 'name', 'first_name', 'last_name',
  'primary_email', 'phone_numbers',
  'current_title', 'current_organization', 'linkedin_profile',
  'jobs.*.client_company_name', 'jobs.*.job_name', 'jobs.*.stage_name',
];

const FUZZY_THRESHOLD = 0.35;
const UNIQUE_GAP = 0.08;

export async function handleCandidateGet({ env, body }) {
  if (body.id == null && !body.query) {
    return jsonResponse(400, { error: 'must provide id or query' });
  }
  let candidate = null;
  if (body.id != null) {
    candidate = await getCandidateById(env, Number(body.id));
  } else {
    const snap = await getSnapshot(env);
    const q = normalize(body.query);
    const scored = snap.rows
      .map((r) => {
        const base = scoreString(q, r.prepared);
        const boost = recencyBoost({ last_activity_at: r.last_activity_at });
        return { id: r.id, name: r.name, score: base * (1 + boost) };
      })
      .filter((r) => r.score >= FUZZY_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return jsonResponse(404, { error: 'No match' });
    if (scored.length >= 2 && scored[0].score - scored[1].score < UNIQUE_GAP) {
      return jsonResponse(200, {
        needs_disambiguation: true,
        kind: 'candidate',
        options: scored.slice(0, 5).map((s) => ({ id: s.id, name: s.name, score: s.score })),
      });
    }
    candidate = await getCandidateById(env, scored[0].id);
  }
  if (!candidate) return jsonResponse(404, { error: 'No match' });

  const { paths } = resolveFieldsWithDefaults(body.fields, DEFAULT_FIELDS, candidate, candidate);
  const projected = projectWithLinkedIn(candidate, paths);
  return jsonResponse(200, { candidate: projected });
}
