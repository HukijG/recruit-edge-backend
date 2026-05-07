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
    return Math.max(0, 0.7 + 0.25 * coverage - extraPenalty);
  }

  if (tNorm.includes(q)) return 0.5 + 0.25 * (q.length / tNorm.length);

  // Per-token Levenshtein: every query token must have a close match among
  // target tokens. Tolerates typos like "jery" vs "jerry".
  const TOKEN_MAX_RATIO = 0.35;
  let allTokenLev = true;
  let levSum = 0;
  for (const qt of qTokens) {
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
    return 0.55 + 0.2 * (levSum / qTokens.length); // 0.55..0.75
  }

  const dist = levenshtein(q, tNorm);
  const maxLen = Math.max(q.length, tNorm.length);
  const ratio = dist / maxLen;
  if (ratio < 0.4) return 0.2 + 0.3 * (1 - ratio); // 0.38..0.50
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

/** Up to +20 % boost for records active in the last 180 days. */
export function recencyBoost(record, now = new Date()) {
  const dateStr = record.last_activity_at || record.added_time;
  if (!dateStr) return 0;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return 0;
  const ageDays = (now.getTime() - t) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 0.2;
  return Math.max(0, 0.2 * (1 - ageDays / 180));
}
