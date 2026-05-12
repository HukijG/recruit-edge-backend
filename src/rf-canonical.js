/**
 * Additive canonicaliser for raw RF candidate bodies.
 *
 * Recruiterflow's wire shape differs from the canonical names the MCP
 * projection layer (and the cache-worker's `normalize.js`) expect:
 *
 *  RF wire field        Canonical name used by MCP defaults / projection
 *  ────────────────     ─────────────────────────────────────────────────
 *  email: []            primary_email (first), emails (preserved)
 *  phone_number: []     phone_numbers
 *  current_designation  current_title
 *  jobs[].name          jobs[].job_name
 *
 * The cache-worker performs this mapping in `toCandidateRow` / `toCandidateThinRow`
 * before writing to D1, but every MCP live-fetch path (`/mcp/candidate-get`,
 * `/mcp/candidate-search` tier-2, `/mcp/job-pipeline` + `/mcp/job-candidates-filter`
 * expanded-hydration fan-outs) reads the raw RF body and projects directly. When
 * RF returns `current_designation` but `DEFAULT_FIELDS` asks for `current_title`,
 * `pick()` finds no `current_title` key and silently drops the field.
 *
 * This canonicaliser is purely **additive**: it sets canonical aliases when
 * they are missing and never overwrites existing keys. The raw fields stay in
 * the object so any consumer that still reads `email` / `phone_number` /
 * `current_designation` continues to work. It's the seam for both bug-fix
 * correctness and forward compatibility — when RF eventually flips field
 * names, the canonicaliser absorbs the change at the integration boundary.
 *
 * Idempotent on already-canonical input (the test mocks use canonical shape).
 */

/**
 * Extract a usable email string from one element of an `email: [...]` array.
 * RF has been observed returning each item as either:
 *   - a plain string ("jerry@example.com")
 *   - an object { value, is_primary, type } (the update / put shape)
 *   - an object { email, type } (older list/get shape)
 */
function extractEmail(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    if (typeof item.email === 'string') return item.email;
    if (typeof item.value === 'string') return item.value;
  }
  return null;
}

/**
 * Extract a usable phone-number string from one element of a `phone_number: [...]` array.
 * Mirrors `extractEmail`. RF's update shape uses {value, is_primary}; observed
 * GET responses use plain strings.
 */
function extractPhone(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    if (typeof item.phone_number === 'string') return item.phone_number;
    if (typeof item.value === 'string') return item.value;
  }
  return null;
}

/**
 * Additively rewrite a raw RF candidate body into the canonical MCP shape.
 *
 * - Never mutates the input.
 * - Never overwrites a key already present in the input (idempotent on
 *   canonical input — e.g. test mocks).
 * - Returns the input unchanged if it isn't a plain object.
 *
 * @param {unknown} rf
 * @returns {unknown}
 */
export function canonicalizeRFCandidate(rf) {
  if (!rf || typeof rf !== 'object' || Array.isArray(rf)) return rf;
  const out = { ...rf };

  // email ──► primary_email (first) + emails (flat string list)
  if (out.primary_email == null) {
    if (Array.isArray(out.email) && out.email.length > 0) {
      const first = extractEmail(out.email[0]);
      if (first) out.primary_email = first;
    } else if (typeof out.email === 'string' && out.email) {
      out.primary_email = out.email;
    }
  }
  if (out.emails == null && Array.isArray(out.email)) {
    const flat = out.email.map(extractEmail).filter(Boolean);
    if (flat.length > 0) out.emails = flat;
  }

  // phone_number ──► phone_numbers (flat string list)
  if (out.phone_numbers == null) {
    if (Array.isArray(out.phone_number) && out.phone_number.length > 0) {
      const flat = out.phone_number.map(extractPhone).filter(Boolean);
      if (flat.length > 0) out.phone_numbers = flat;
    } else if (typeof out.phone_number === 'string' && out.phone_number) {
      out.phone_numbers = [out.phone_number];
    }
  }

  // current_designation ──► current_title
  if (out.current_title == null && typeof out.current_designation === 'string' && out.current_designation) {
    out.current_title = out.current_designation;
  }

  // jobs[].name ──► jobs[].job_name (and preserve `name` so existing dot-paths still resolve)
  if (Array.isArray(out.jobs)) {
    out.jobs = out.jobs.map((j) => {
      if (!j || typeof j !== 'object') return j;
      if (j.job_name != null) return j;
      const job_name = (typeof j.name === 'string' && j.name)
        ? j.name
        : (typeof j.title === 'string' && j.title)
          ? j.title
          : null;
      return job_name != null ? { ...j, job_name } : j;
    });
  }

  return out;
}
