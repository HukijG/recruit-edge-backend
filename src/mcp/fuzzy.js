export function normalize(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokens(s) {
  return normalize(s)
    .split(/[\s,._\-()/\\|&]+/)
    .filter(Boolean);
}

// ─── Recruiting phrase aliases ────────────────────────────────────────
// Folds phrases and their acronyms to a single canonical token so fuzzy
// match works across "Eon Tech CS" and "Eon.io Technical Customer
// Success Manager". Only called on the job-matching path — candidate /
// user / stage names don't have recruiting jargon and shouldn't be
// rewritten.
//
// Pipeline is deliberately two-step:
//   1. Word pass (short → long): expand single-token abbreviations to
//      their canonical long form ("tech" → "technical", "mgr" →
//      "manager"). Running first guarantees both sides reach the same
//      long-form vocabulary before any phrase collapses.
//   2. Phrase pass: collapse long phrases to a single acronym token
//      ("customer success manager" → "csm"). Ordered longest-first so
//      specific phrases fire before their prefix-subsets.

// Canonical long form → list of short-form aliases. A single reader-
// friendly table; flattened below for O(1) lookup at replace time.
const WORD_CANONICAL = {
  technical: ["tech"],
  engineer: ["eng"],
  engineering: ["engg"],
  manager: ["mgr"],
  management: ["mgmt"],
  representative: ["rep"],
  director: ["dir"],
  senior: ["sr", "snr"],
  junior: ["jr", "jnr"],
  marketing: ["mktg"],
  enterprise: ["ent"],
  administrator: ["admin"],
  development: ["dev"],
  president: ["pres"],
  operations: ["ops"],
};

const WORD_ALIASES_MAP = (() => {
  const m = {};
  for (const [canonical, aliases] of Object.entries(WORD_CANONICAL)) {
    for (const a of aliases) m[a] = canonical;
  }
  return m;
})();

// Phrase → acronym. Ordered longest-first. The `manag(er|ement)` group
// lets one rule cover both "Account Manager" and "Account Management"
// (RF users write both for lead / head-of roles).
const PHRASE_ALIASES = [
  // Collapse "Pre-Sales" / "Pre Sales" to "presales" so the hyphen's
  // implicit word boundary doesn't let `sales\s+engineer` below fire
  // inside "pre-sales engineer" and mangle the phrase.
  [/\bpre[- ]?sales\b/g, "presales"],
  [/\btechnical\s+account\s+manag(er|ement)\b/g, "tam"],
  [/\bcustomer\s+success\s+manag(er|ement)\b/g, "csm"],
  [/\bsales\s+development\s+representative\b/g, "sdr"],
  [/\bbusiness\s+development\s+representative\b/g, "bdr"],
  [/\bmarket\s+development\s+representative\b/g, "mdr"],
  [/\bproduct\s+marketing\s+manag(er|ement)\b/g, "pmm"],
  [/\bproduct\s+marketing\s+lead\b/g, "pmm"],
  [/\bproduct\s+marketing\b/g, "pmm"],
  [/\bregional\s+vice\s+president\b/g, "rvp"],
  [/\bchief\s+marketing\s+officer\b/g, "cmo"],
  [/\bchief\s+executive\s+officer\b/g, "ceo"],
  [/\bchief\s+revenue\s+officer\b/g, "cro"],
  [/\bchief\s+operating\s+officer\b/g, "coo"],
  [/\bchief\s+technology\s+officer\b/g, "cto"],
  [/\bchief\s+financial\s+officer\b/g, "cfo"],
  [/\bvice\s+president\b/g, "vp"],
  [/\brevenue\s+operations\b/g, "revops"],
  [/\brev\s+operations\b/g, "revops"],
  [/\bsales\s+operations\b/g, "salesops"],
  [/\bmarketing\s+operations\b/g, "mktgops"],
  [/\bcustomer\s+success\b/g, "cs"],
  [/\bsales\s+engineer(ing)?\b/g, "se"],
  [/\bsolutions?\s+engineer(ing)?\b/g, "se"],
  [/\bsolutions?\s+architect\b/g, "sa"],
  [/\baccount\s+executive\b/g, "ae"],
  [/\baccount\s+manag(er|ement)\b/g, "am"],
  [/\bproduct\s+manag(er|ement)\b/g, "pm"],
  [/\bbusiness\s+development\b/g, "bd"],
];

/**
 * Fold recruiting phrases and common abbreviations to a shared canonical
 * form so fuzzy match works across "Eon Tech CS" and "Eon.io Technical
 * Customer Success Manager". Idempotent — running it twice produces the
 * same output. Called by cache.searchJobs on both the query and each
 * scoring target before they hit scoreAny.
 */
export function canonicalizeJobPhrase(s) {
  if (!s) return "";
  let out = s.toLowerCase();
  // Step 1: expand abbreviations to their canonical long form so the
  // phrase rules below see a uniform vocabulary regardless of how the
  // user typed it.
  out = out.replace(/\b[a-z]+\b/g, (w) => WORD_ALIASES_MAP[w] ?? w);
  // Step 2: collapse long phrases to acronyms.
  for (const [re, repl] of PHRASE_ALIASES) {
    out = out.replace(re, repl);
  }
  return out;
}

/**
 * Words on a target that imply seniority / scope / a qualifier role —
 * "Sales Engineer" vs "Sales Engineering Manager", "Customer Success" vs
 * "VP Customer Success". When the target carries one of these and the
 * query doesn't, the target is structurally MORE specific than what the
 * user asked for; we knock the score down by `EXTENSION_PENALTY` so the
 * IC / bare-role variant wins.
 *
 * Includes both raw forms and their canonical-fold expansions (the
 * fuzzy.js pipeline runs canonicalizeJobPhrase first, so "VP" becomes
 * "vp" lowercased — keep "vp" in the set, not "vice president").
 *
 * The set is intentionally CONSERVATIVE — only words that almost
 * universally signal "more senior" or "qualifier" in a recruiting
 * context. "Lead" is included because it's a near-universal qualifier
 * (Team Lead, Engineering Lead) in this corpus.
 */
const EXTENSION_WORDS = new Set([
  'manager', 'mgr', 'mgmt', 'management',
  'lead',
  'vp', 'svp', 'evp',
  'senior', 'sr', 'snr',
  'head',
  'director', 'dir',
  'chief',
  'principal',
]);

/** Score penalty when target has an unmatched extension word. */
const EXTENSION_PENALTY = 0.10;

function hasUnmatchedExtensionWord(qTokens, tTokens) {
  const qSet = new Set(qTokens);
  for (const tt of tTokens) {
    if (EXTENSION_WORDS.has(tt) && !qSet.has(tt)) return true;
  }
  return false;
}

/** Escape a string for use inside a RegExp source. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True iff `q` appears in `tNorm` on word boundaries — i.e. neither edge
 * sits inside another alphanumeric run. For multi-token queries (q
 * contains spaces) the original includes(q) shape doesn't survive a
 * single \b<q>\b pattern (\b is per-token), so we additionally require
 * every individual qToken to be present on word boundaries somewhere
 * in the target.
 *
 * `q` is the normalized whole query string; `qTokens` is the same string
 * tokenised. Both inputs come from the caller — no extra normalisation
 * here.
 */
function substringOnWordBoundary(q, tNorm, qTokens) {
  if (!q || !tNorm) return false;
  // Fast path: whole query on word boundaries.
  if (new RegExp(`\\b${escapeRegExp(q)}\\b`).test(tNorm)) return true;
  // Multi-token query — every token must hit a word boundary somewhere.
  // Single-token queries already failed the fast path so we're done.
  if (qTokens.length <= 1) return false;
  for (const qt of qTokens) {
    if (!new RegExp(`\\b${escapeRegExp(qt)}\\b`).test(tNorm)) return false;
  }
  return true;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/**
 * Pre-computed search target — `normalized` (lowercased + diacritics
 * stripped + whitespace collapsed) plus its tokens. Cache.searchCandidates
 * and Cache.searchJobs precompute one of these per candidate / job target
 * at insert time, so per-search work scales with the QUERY tokens (small)
 * instead of all 26k targets being re-tokenised on every call.
 */
export function prepareTarget(s) {
  const n = normalize(s);
  return { normalized: n, tokens: tokens(n) };
}

/** Score a query against a single target; 0 = no match, 1 = exact. */
export function scoreString(query, target) {
  const q = normalize(query);
  if (!q) return 0;
  const tNorm =
    typeof target === "string" ? normalize(target) : target.normalized;
  if (!tNorm) return 0;
  if (q === tNorm) return 1;

  const qTokens = tokens(q);
  const tTokens = typeof target === "string" ? tokens(tNorm) : target.tokens;
  if (qTokens.length === 0 || tTokens.length === 0) return 0;

  // Every query token is a prefix of some unique target token.
  const used = new Array(tTokens.length).fill(false);
  let allPrefix = true;
  let prefixCoverage = 0;
  for (const qt of qTokens) {
    let matchedIdx = -1;
    for (let i = 0; i < tTokens.length; i++) {
      if (!used[i] && tTokens[i].startsWith(qt)) {
        matchedIdx = i;
        break;
      }
    }
    if (matchedIdx === -1) {
      allPrefix = false;
      break;
    }
    used[matchedIdx] = true;
    prefixCoverage += qt.length / tTokens[matchedIdx].length;
  }
  if (allPrefix) {
    // Penalize extra unused target tokens so "call booked" doesn't score
    // equally against "Call Booked" and "Video Call Booked".
    const denom = Math.max(qTokens.length, tTokens.length);
    const coverage = prefixCoverage / denom;
    // Additional fixed penalty per extra target token: pushes IC roles
    // above their qualifier-suffixed siblings ("Sales Engineer" vs "Sales
    // Engineering Manager", "Tech CS" vs "Tech CS Lead") so the bare
    // role is the default match. Two extras cost 0.10 — enough to
    // exceed UNIQUE_GAP (0.08) and break ambiguity in favour of the IC.
    // Caller can still hit the qualifier role by including the
    // qualifier word ("manager", "lead") in the query.
    const extraTargetTokens = Math.max(0, tTokens.length - qTokens.length);
    const extraPenalty = 0.05 * extraTargetTokens;
    // Extension-word penalty: when target carries a seniority/qualifier
    // word that the query does NOT, knock the score down by EXTENSION_PENALTY
    // (≥ UNIQUE_GAP). Stacks with the extra-target-token penalty above so
    // "Sales Engineer" vs "Sales Engineering Manager" gets a decisive split.
    const extensionPenalty = hasUnmatchedExtensionWord(qTokens, tTokens)
      ? EXTENSION_PENALTY
      : 0;
    // Exact-word-count bonus: when qTokens.length === tTokens.length AND
    // every query token matched (allPrefix), the target is structurally
    // the same length as the query. A small bonus tips this above
    // longer-target siblings without distorting partial-coverage cases.
    const equalLengthBonus = qTokens.length === tTokens.length ? 0.03 : 0;
    // Floor of 0.85 puts prefix-exact matches comfortably above the
    // per-token Levenshtein ceiling (0.65) — even after the max recency
    // boost (×1.2) a Lev near-miss tops out around 0.78, so a stale
    // prefix-exact match still wins. Prior 0.7 floor was too close to
    // Lev max (0.75) and let recency tip the balance toward false
    // first-name look-alikes (e.g. "Bill Ferry" beating actual Jerrys
    // for query "jerry" — observed in the 2026-05-12 smoke test).
    return Math.max(0, 0.85 + 0.10 * coverage + equalLengthBonus - extraPenalty - extensionPenalty);
  }

  // Word-boundary substring match. Earlier this branch used
  // `tNorm.includes(q)` which let "Eon" score against "Neon Security"
  // (substring leak across a word boundary — observed in the 2026-05-12
  // smoke test where a "Eon" company filter pulled Neon-Security candidates
  // in). `\b<q>\b` requires the query to start/end at word boundaries; for
  // multi-token queries `q` may contain spaces so we also check each token
  // individually and require ALL to land on word boundaries.
  if (substringOnWordBoundary(q, tNorm, qTokens)) {
    const baseScore = 0.5 + 0.25 * (q.length / tNorm.length);
    const extensionPenalty = hasUnmatchedExtensionWord(qTokens, tTokens)
      ? EXTENSION_PENALTY
      : 0;
    return Math.max(0, baseScore - extensionPenalty);
  }

  // Per-token Levenshtein: every query token must have a close match among
  // target tokens. Tolerates typos like "jery" vs "jerry".
  //
  // Short tokens (≤ 3 chars) are NOT eligible for Lev fallback — at that
  // length a single edit-distance unit is meaningless coincidence
  // ("eon" vs "neon" is ratio 0.25, well inside TOKEN_MAX_RATIO, but the
  // operator's smoke test caught this exact pattern letting "Neon
  // Security" leak into "Eon" queries via the company-name scoring
  // path). Short tokens must hit either the prefix-match or
  // word-boundary substring branches above to score.
  const TOKEN_MAX_RATIO = 0.35;
  const MIN_TOKEN_LEN_FOR_LEV = 4;
  let allTokenLev = true;
  let levSum = 0;
  for (const qt of qTokens) {
    if (qt.length < MIN_TOKEN_LEN_FOR_LEV) {
      allTokenLev = false;
      break;
    }
    let bestRatio = Infinity;
    for (const tt of tTokens) {
      const r = levenshtein(qt, tt) / Math.max(qt.length, tt.length);
      if (r < bestRatio) bestRatio = r;
    }
    if (bestRatio > TOKEN_MAX_RATIO) {
      allTokenLev = false;
      break;
    }
    levSum += 1 - bestRatio;
  }
  if (allTokenLev) {
    // Lev max pulled from 0.75 → 0.65 so it sits cleanly below the
    // prefix-exact floor (0.85). Paired with the prefix-floor bump above,
    // this guarantees an exact first-name token match outranks a "one edit
    // away" name look-alike regardless of recency boost. See § Fuzzy fix
    // in `docs/mcp-middleware.md` for the worked example.
    const base = 0.55 + 0.10 * (levSum / qTokens.length); // 0.55..0.65
    const extensionPenalty = hasUnmatchedExtensionWord(qTokens, tTokens)
      ? EXTENSION_PENALTY
      : 0;
    return Math.max(0, base - extensionPenalty);
  }

  const dist = levenshtein(q, tNorm);
  const maxLen = Math.max(q.length, tNorm.length);
  const ratio = dist / maxLen;
  if (ratio < 0.4) {
    const base = 0.2 + 0.3 * (1 - ratio); // 0.38..0.50
    const extensionPenalty = hasUnmatchedExtensionWord(qTokens, tTokens)
      ? EXTENSION_PENALTY
      : 0;
    return Math.max(0, base - extensionPenalty);
  }
  return 0;
}

/** Pick best score across a set of candidate targets (raw or prepared). */
export function scoreAny(query, targets) {
  let best = 0;
  for (const t of targets) {
    if (!t) continue;
    const s = scoreString(query, t);
    if (s > best) best = s;
  }
  return best;
}

/**
 * Up to +20% boost for records active in the last 30 days. Decays linearly
 * to 0 at day 30, stays 0 beyond that.
 *
 * Tightened from the original 180-day curve so a recently-active record
 * (`Jerry` you spoke to last week) wins outright over a stale one
 * (`Jerry` from two months ago) when their name scores are otherwise within
 * UNIQUE_GAP. Recruiters typing first names almost always mean the recent
 * person; the tighter window matches that expectation.
 */
export function recencyBoost(record, now = new Date()) {
  // New thin-cache shape: added_time_ms is an integer (ms since epoch).
  // Legacy shape: last_activity_at / added_time are ISO 8601 strings.
  // Support both during the dual-write phase.
  let t;
  if (typeof record.added_time_ms === 'number') {
    t = record.added_time_ms;
  } else {
    const dateStr = record.last_activity_at || record.added_time;
    if (!dateStr) return 0;
    t = Date.parse(dateStr);
    if (Number.isNaN(t)) return 0;
  }
  const ageDays = (now.getTime() - t) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 0.2;
  return Math.max(0, 0.2 * (1 - ageDays / 30));
}
