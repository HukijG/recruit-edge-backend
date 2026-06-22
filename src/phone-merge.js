/**
 * Phone-number merge + ranking engine for Apollo phone-reveal enrichment.
 *
 * PURE functions — no I/O, no env. Everything here is unit-tested. The Apollo
 * webhook handler (`applyApolloEnrichment` in index.js) does the I/O (RF GET,
 * Dialpad GET, writes, KV state) and calls `buildPhoneOrder` for the decisions.
 *
 * Design rules (phone-enrichment design notes):
 *  - Store ALL desirable numbers in both RF + Dialpad, identical set + order.
 *  - Exclude work_* / extension numbers entirely (never store, never dial). `other` IS kept.
 *  - Ranking is encoded purely as array ORDER (RF `type` stays 1; no source proxy).
 *    The extension reads element [0], so [0] must be the best number.
 *  - Source (Apollo vs ContactOut) is derived transiently by matching the delivered
 *    number's digits against the webhook's `waterfall` block — it is not persisted as a field.
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
 * "Apollo-like" sources: Apollo itself, or a number we couldn't attribute to any
 * vendor. Treated as Apollo for the EU re-run decision (we keep re-running until we
 * get a CONFIRMED non-Apollo source like ContactOut).
 */
export function isApolloLikeSource(source) {
  return !source || source === 'unknown' || /apollo/i.test(source);
}

/**
 * Attribute a delivered number to its waterfall vendor by matching digits against
 * `waterfall.phone_numbers[].vendors[].phone_numbers[]`. Returns the vendor name
 * (e.g. "Apollo", "ContactOut") or "unknown" when no match is found.
 */
export function attributeSource(e164, waterfall) {
  const target = digitsOnly(e164);
  if (!target) return 'unknown';
  const steps = waterfall?.phone_numbers;
  if (!Array.isArray(steps)) return 'unknown';
  for (const step of steps) {
    for (const vendor of step?.vendors || []) {
      for (const vn of vendor?.phone_numbers || []) {
        if (digitsOnly(vn) === target) return vendor?.name || 'unknown';
      }
    }
  }
  return 'unknown';
}

/** NANP (+1, US/Canada) number — Apollo's DB is strong here. */
function isNANP(e164) {
  return /^\+1\d{10}$/.test(e164 || '');
}

/**
 * Where Apollo's own DB is strong (US/Canada) we trust its number; elsewhere
 * (Europe etc.) we prefer a non-Apollo source and re-run the waterfall to find one.
 * Country comes from the RF candidate; falls back to the number's country code.
 */
export function regionFor(candidateCountry, sampleE164) {
  // The RETURNED number's own country code is the reliable signal: a NANP (+1) number
  // means Apollo found a US/Canada number — its strong zone — so there's no reason to
  // chase ContactOut. RF's `location.country` is unreliable (observed in prod: a
  // "Greater St. Louis" candidate geocoded to France), so it's only a fallback when we
  // have no number to judge from.
  if (sampleE164) return isNANP(sampleE164) ? 'apollo_strong' : 'apollo_weak';
  // Normalize away punctuation/spacing so "U.S.A.", "United States of America" etc. all collapse.
  const c = (candidateCountry || '').toLowerCase().replace(/[.\s]/g, '');
  if (c) {
    const STRONG = new Set(['unitedstates', 'unitedstatesofamerica', 'usa', 'us', 'america', 'canada', 'ca']);
    return STRONG.has(c) ? 'apollo_strong' : 'apollo_weak';
  }
  return 'apollo_strong'; // unknown country, no number: don't over-rerun
}

/** Does this number's country match the region we expect (used as a ranking nudge)? */
function countryMatches(region, e164) {
  return region === 'apollo_strong' ? isNANP(e164) : !isNANP(e164);
}

/**
 * Comparator for the enrichment-added pool (ascending = best first).
 *  - apollo_weak (EU): source dominates — a confirmed non-Apollo number wins.
 *  - apollo_strong (US): type dominates — a mobile wins.
 * Country-match and the remaining axis are tie-breakers in each case.
 */
function comparePhones(a, b, region) {
  const aApollo = isApolloLikeSource(a.source);
  const bApollo = isApolloLikeSource(b.source);
  const aMatch = countryMatches(region, a.e164);
  const bMatch = countryMatches(region, b.e164);

  if (region === 'apollo_weak') {
    if (aApollo !== bApollo) return aApollo ? 1 : -1;       // non-Apollo first
    if (aMatch !== bMatch) return aMatch ? -1 : 1;          // local number first
    if (a.typeRank !== b.typeRank) return a.typeRank - b.typeRank;
    return 0; // full tie → stable sort keeps poolMap insertion order (prior-pass before this-pass)
  }
  // apollo_strong
  if (a.typeRank !== b.typeRank) return a.typeRank - b.typeRank; // mobile first
  if (aMatch !== bMatch) return aMatch ? -1 : 1;                 // NANP first
  if (aApollo !== bApollo) return aApollo ? 1 : -1;             // prefer extra-source coverage
  return 0; // full tie → stable sort keeps poolMap insertion order (prior-pass before this-pass)
}

/**
 * Core decision function. Given the candidate's existing numbers, the prior
 * enrichment state, and this webhook's Apollo entries + waterfall, produce the
 * canonical best-first ordered list to write to BOTH systems, plus the signals the
 * handler needs to decide whether to re-run the waterfall.
 *
 * @param {Object} args
 * @param {string[]} args.existingNumbers - E.164 numbers already on the candidate (RF ∪ Dialpad), current order
 * @param {Object}   args.state - prior `apollo_reveal_state` ({ seen, added, rerunCount }) or {} on first webhook.
 *                   `rerunCount` is pass-through only (copied into nextState); the orchestrator owns it.
 * @param {Array}    args.apolloEntries - this webhook's `people[0].phone_numbers[]`
 * @param {Object}   args.waterfall - this webhook's `people[0].waterfall`
 * @param {string}   args.candidateCountry - RF `location.country`
 * @returns {{
 *   ordered: string[], region: string, best: Object|null, bestIsApolloLike: boolean,
 *   survivorsCount: number, producedSomethingNew: boolean, droppedUnnormalizable: string[], nextState: Object
 * }}
 */
export function buildPhoneOrder({ existingNumbers, state, apolloEntries, waterfall, candidateCountry }) {
  const prevSeen = new Set(Array.isArray(state?.seen) ? state.seen : []);
  const prevAdded = Array.isArray(state?.added) ? state.added : [];

  // Normalize + classify every raw entry from this webhook. `rawDigits` comes straight
  // from the delivered string (independent of E.164 normalization) so exhaustion
  // detection sees exactly what Apollo returned — even numbers we can't normalize.
  const rawAnnotated = (apolloEntries || []).map((entry) => {
    const source = entry?.sanitized_number || entry?.raw_number || '';
    const e164 = normalizeToE164(source);
    return { entry, e164, digits: digitsOnly(e164 || ''), rawDigits: digitsOnly(source), excluded: isExcludedEntry(entry) };
  });

  // "Produced something new" = the waterfall returned at least one number (even an
  // excluded or un-normalizable one) we hadn't seen in a prior pass. Drives re-run
  // exhaustion: if a pass surfaces nothing new, the waterfall is tapped out and we stop.
  // Key on the NORMALIZED digits when available (falling back to raw for un-normalizable
  // entries) so a number redelivered in a different surface format across passes isn't
  // mistaken for new — which would waste a re-run.
  const seenKeys = rawAnnotated.map((r) => r.digits || r.rawDigits).filter(Boolean);
  const producedSomethingNew = seenKeys.some((d) => !prevSeen.has(d));

  // Kept-type entries we couldn't normalize to E.164 — surfaced so the orchestrator can
  // log them rather than dropping a real number silently.
  const droppedUnnormalizable = rawAnnotated
    .filter((r) => !r.excluded && !r.e164 && r.rawDigits)
    .map((r) => r.rawDigits);

  // Survivors = kept entries with a valid E.164, annotated with source + type rank.
  const survivors = rawAnnotated
    .filter((r) => !r.excluded && r.e164)
    .map((r) => ({
      e164: r.e164,
      digits: r.digits,
      source: attributeSource(r.e164, waterfall),
      typeRank: typeRank(r.entry?.type_cd),
    }));

  const sample = survivors[0]?.e164 || existingNumbers?.[0] || null;
  const region = regionFor(candidateCountry, sample);

  // Enrichment pool = numbers we've contributed across this sequence (prior + new),
  // keyed by digits so re-runs refresh metadata rather than duplicate.
  const poolMap = new Map();
  for (const p of prevAdded) {
    if (p?.digits) poolMap.set(p.digits, { e164: p.e164, digits: p.digits, source: p.source, typeRank: p.typeRank === undefined ? 3 : p.typeRank });
  }
  for (const s of survivors) poolMap.set(s.digits, s);
  const pool = [...poolMap.values()].sort((a, b) => comparePhones(a, b, region));
  const poolDigits = new Set(pool.map((p) => p.digits));

  // Manually pre-existing numbers (human-curated, not contributed by enrichment) stay
  // at the top, in their current order — enrichment never displaces them.
  const manual = dedupeByDigits((existingNumbers || []).filter((n) => !poolDigits.has(digitsOnly(n))));

  const ordered = dedupeByDigits([...manual, ...pool.map((p) => p.e164)]);
  const best = pool[0] || null;

  const nextState = {
    seen: [...new Set([...prevSeen, ...seenKeys])],
    added: pool.map((p) => ({ digits: p.digits, e164: p.e164, source: p.source, typeRank: p.typeRank })),
    rerunCount: state?.rerunCount || 0,
  };

  return {
    ordered,
    region,
    best,
    bestIsApolloLike: best ? isApolloLikeSource(best.source) : false,
    survivorsCount: survivors.length,
    producedSomethingNew,
    droppedUnnormalizable,
    nextState,
  };
}
