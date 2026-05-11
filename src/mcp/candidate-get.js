import { jsonResponse } from './router.js';
import { resolveCandidateThin, disambiguationPayload } from './resolvers.js';
import { getRFCandidate, RFRateLimitedError } from '../rf-client.js';
import { resolveFieldsWithDefaults } from './projection.js';
import { projectWithLinkedIn } from './linkedin.js';

const DEFAULT_FIELDS = [
  'id', 'name', 'first_name', 'last_name',
  'primary_email', 'phone_numbers',
  'current_title', 'current_organization', 'linkedin_profile',
  'jobs.*.client_company_name', 'jobs.*.job_name', 'jobs.*.stage_name',
];

export async function handleCandidateGet({ env, body }) {
  if (body.id == null && !body.query) {
    return jsonResponse(400, { error: 'must provide id or query' });
  }

  // 1. Resolve the candidate reference (numeric id or fuzzy name) to a thin
  //    row — `resolveCandidateThin` avoids the live-fetch the full resolver
  //    does so we don't double-fetch in step 2. Ambiguous results surface a
  //    needs_disambiguation envelope.
  const candRes = await resolveCandidateThin(env, body.id != null ? body.id : body.query);
  if (!candRes.ok) {
    if (candRes.reason === 'ambiguous') {
      return jsonResponse(200, disambiguationPayload(candRes));
    }
    // not_found — keep the legacy 404 status so existing callers don't break.
    return jsonResponse(404, { error: 'No match' });
  }

  const candidateId = candRes.value.id;

  // 2. Live-fetch the full candidate body from RF. getRFCandidate already
  //    handles 502 retry (once) and unwraps the `{candidate: {...}}` envelope.
  //    RF rate-limit surfaces as the lean rate_limited envelope.
  let full;
  try {
    full = await getRFCandidate(candidateId, env);
  } catch (err) {
    if (err instanceof RFRateLimitedError) {
      return jsonResponse(200, {
        ok: false, kind: 'rate_limited', recoverable: false,
        retry_after_ms: err.retryAfterMs ?? null,
        error: 'RF rate limited',
      });
    }
    return jsonResponse(200, {
      ok: false, recoverable: true, kind: 'rf_unavailable',
      error: err.message,
    });
  }

  // 3. Apply Claude-requested fields[] projection (additive over defaults).
  const { paths } = resolveFieldsWithDefaults(body.fields, DEFAULT_FIELDS, full, full);
  const projected = projectWithLinkedIn(full, paths);
  return jsonResponse(200, { ok: true, candidate: projected });
}
