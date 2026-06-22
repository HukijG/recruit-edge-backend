/**
 * Phone-number merge + ranking engine for Apollo phone-reveal enrichment.
 *
 * PURE functions — no I/O, no env. The Apollo webhook handler
 * (`applyApolloEnrichment` in index.js) does the I/O (RF GET, Dialpad GET, writes,
 * cache) and calls `buildPhoneOrder` for the ordering decision.
 *
 * Design rules (phone-enrichment design notes):
 *  - Store ALL desirable numbers in both RF + Dialpad, identical set + order.
 *  - Exclude work_* / extension / invalid_number entries entirely. `other` IS kept.
 *  - Ranking is encoded purely as array ORDER (RF `type` stays 1). The extension reads
 *    element [0], so [0] must be the best number: pre-existing manual numbers stay on
 *    top, then enrichment numbers by type (mobile > home > other).
 *
 * NOTE: there is deliberately no "re-run the waterfall for a better source" logic.
 * Apollo's `/people/match` always runs its own DB first and short-circuits the rest
 * (`request_already_fulfilled`) on every call, so a re-reveal can never reach ContactOut
 * — verified 2026-06-22 (see investigation report § 6b). `run_waterfall_phone` still
 * helps via the pass-1 fall-through when Apollo has no number; that needs no re-run.
 */

import { normalizeToE164 } from './rf-client.js';

// Apollo `type_cd` values we never store or dial. Anything starting "work" (work_direct,
// work_hq, work_mobile, …) is an office/HQ/direct-dial number — excluded entirely.
const EXCLUDED_TYPE_RE = /^work/i;

// Ranking of the KEPT phone types (lower = better). Unknown types sort last.
const TYPE_RANK = { mobile: 0, home: 1, other: 2 };

/** Reduce a phone string to digits only — the cross-source match key. */
export function digitsOnly(s) {
  return (typeof s === 'string' ? s : '').replace(/\D/g, '');
}

/** Dedupe a list of E.164 strings by digits, preserving first-seen order. */
export function dedupeByDigits(numbers) {
  const seen = new Set();
  const out = [];
  for (const n of numbers || []) {
    const d = digitsOnly(n);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(n);
  }
  return out;
}

/** Does this Apollo phone entry carry an extension? We never dial extension numbers. */
export function hasExtension(entry) {
  const blob = `${entry?.raw_number || ''} ${entry?.sanitized_number || ''}`;
  return /ext/i.test(blob);
}

/**
 * True if the entry must be excluded:
 *  - work_* type (office/HQ/direct-dial),
 *  - carries an extension (we never dial extensions), or
 *  - Apollo marked it `invalid_number` (genuinely malformed/disconnected).
 *
 * Note: we do NOT treat the POSITIVE `status_cd`/`confidence_cd` values
 * (valid_number/high) as a quality signal — Apollo self-certifies everything. We
 * only act on the explicitly-negative `invalid_number`.
 */
export function isExcludedEntry(entry) {
  if (EXCLUDED_TYPE_RE.test(entry?.type_cd || '')) return true;
  if (hasExtension(entry)) return true;
  if ((entry?.status_cd || '') === 'invalid_number') return true;
  return false;
}

function typeRank(type_cd) {
  const r = TYPE_RANK[(type_cd || '').toLowerCase()];
  return r === undefined ? 3 : r;
}

/**
 * Build the canonical best-first ordered phone list to write to BOTH RF and Dialpad.
 *
 * @param {Object} args
 * @param {string[]} args.existingNumbers - numbers already on the candidate (RF ∪ Dialpad), original strings, current order
 * @param {Array}    args.apolloEntries - this webhook's `people[0].phone_numbers[]`
 * @returns {{ ordered: string[], droppedUnnormalizable: string[] }}
 */
export function buildPhoneOrder({ existingNumbers, apolloEntries }) {
  const rawAnnotated = (apolloEntries || []).map((entry) => {
    const source = entry?.sanitized_number || entry?.raw_number || '';
    return { entry, e164: normalizeToE164(source), excluded: isExcludedEntry(entry), rawDigits: digitsOnly(source) };
  });

  // Kept entries with a valid E.164, ranked by phone type (mobile > home > other).
  const ranked = rawAnnotated
    .filter((r) => !r.excluded && r.e164)
    .map((r) => ({ e164: r.e164, digits: digitsOnly(r.e164), typeRank: typeRank(r.entry?.type_cd) }))
    .sort((a, b) => a.typeRank - b.typeRank); // stable: ties keep Apollo's delivery order

  // Kept-type entries we couldn't normalize to E.164 — surfaced so the orchestrator can
  // log them rather than dropping a real number silently.
  const droppedUnnormalizable = rawAnnotated
    .filter((r) => !r.excluded && !r.e164 && r.rawDigits)
    .map((r) => r.rawDigits);

  const rankedDigits = new Set(ranked.map((r) => r.digits));

  // Pre-existing manual numbers (not contributed by this enrichment) stay at the top,
  // in their current order — enrichment never displaces human-curated data.
  const manual = dedupeByDigits((existingNumbers || []).filter((n) => !rankedDigits.has(digitsOnly(n))));

  const ordered = dedupeByDigits([...manual, ...ranked.map((r) => r.e164)]);

  return { ordered, droppedUnnormalizable };
}
