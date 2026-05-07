import { jsonResponse } from './router.js';
import { getCandidateById } from './d1-read.js';
import { resolveFields, project } from './projection.js';

const DEFAULT_FIELDS = [
  'id', 'first_name', 'last_name', 'primary_email', 'phone_numbers',
  'jobs.*.client_company_name', 'jobs.*.job_name', 'jobs.*.stage_name',
];

export async function handleCandidateGet({ env, body }) {
  if (body.id == null && !body.query) {
    return jsonResponse(400, { error: 'must provide id or query' });
  }
  let candidate = null;
  if (body.id != null) {
    candidate = await getCandidateById(env, Number(body.id));
  } else {
    return jsonResponse(501, { error: 'fuzzy candidate-get not yet implemented (Task 18)' });
  }
  if (!candidate) return jsonResponse(404, { error: 'No match' });

  const requested = body.fields ?? DEFAULT_FIELDS;
  const { paths, errors, notes } = resolveFields(requested, candidate, candidate);
  const projected = project(candidate, paths);
  const response = { candidate: projected };
  if (errors.length || notes.length) {
    response._meta = {};
    if (errors.length) response._meta.unresolved_fields = errors;
    if (notes.length) response._meta.notes = notes;
  }
  return jsonResponse(200, response);
}
