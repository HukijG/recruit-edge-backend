import { normalize, scoreString } from "./fuzzy.js";

/**
 * Aliases from user-facing words to real dot-paths against the
 * CandidateSummary / candidate record shape. Left-hand side is lowercased
 * before lookup.
 *
 * Multiple words can map to the same path — on purpose. We want the
 * projection to be forgiving.
 */
const ALIASES: Record<string, string> = {
  // ─── Identity ─────────────────────────────────────────────────
  name: "name",
  "full name": "name",
  fullname: "name",
  full_name: "name",
  "candidate name": "name",
  candidate: "name",
  who: "name",

  first: "first_name",
  "first name": "first_name",
  firstname: "first_name",
  "given name": "first_name",
  given: "first_name",
  forename: "first_name",

  last: "last_name",
  "last name": "last_name",
  lastname: "last_name",
  surname: "last_name",
  "family name": "last_name",

  // ─── Contact: email ───────────────────────────────────────────
  email: "primary_email",
  "primary email": "primary_email",
  "e-mail": "primary_email",
  "e mail": "primary_email",
  mail: "primary_email",
  contact: "primary_email",
  "contact email": "primary_email",
  "main email": "primary_email",

  emails: "emails",
  "all emails": "emails",
  mails: "emails",
  "e-mails": "emails",
  "email addresses": "emails",

  // ─── Contact: phone ───────────────────────────────────────────
  phone: "phone_numbers",
  phones: "phone_numbers",
  "phone number": "phone_numbers",
  "phone numbers": "phone_numbers",
  number: "phone_numbers",
  numbers: "phone_numbers",
  mobile: "phone_numbers",
  cell: "phone_numbers",
  cellphone: "phone_numbers",
  telephone: "phone_numbers",
  tel: "phone_numbers",
  "contact number": "phone_numbers",

  // ─── Role / title ─────────────────────────────────────────────
  title: "current_title",
  "current title": "current_title",
  role: "current_title",
  "current role": "current_title",
  position: "current_title",
  "current position": "current_title",
  designation: "current_title",
  "job title": "current_title",
  "current job title": "current_title",

  // ─── Organisation / company ───────────────────────────────────
  company: "current_organization",
  "current company": "current_organization",
  current_company: "current_organization",
  employer: "current_organization",
  "current employer": "current_organization",
  organization: "current_organization",
  organisation: "current_organization",
  "current organization": "current_organization",
  "current organisation": "current_organization",
  org: "current_organization",
  "works at": "current_organization",
  "works for": "current_organization",
  "company name": "current_organization",

  // ─── Location ─────────────────────────────────────────────────
  location: "location",
  where: "location",
  based: "location",
  "based in": "location",
  "where based": "location",
  residence: "location",
  address: "location",

  city: "location.city",
  town: "location.city",
  locality: "location.city",

  state: "location.state",
  province: "location.state",
  region: "location.state",

  country: "location.country",
  nation: "location.country",

  postal: "location.postal_code",
  "postal code": "location.postal_code",
  zip: "location.postal_code",
  "zip code": "location.postal_code",
  zipcode: "location.postal_code",

  // ─── Socials ──────────────────────────────────────────────────
  linkedin: "linkedin_profile",
  "linked in": "linkedin_profile",
  li: "linkedin_profile",
  "linkedin profile": "linkedin_profile",
  "linkedin url": "linkedin_profile",
  "li profile": "linkedin_profile",

  github: "github_profile",
  gh: "github_profile",
  "github profile": "github_profile",
  "github url": "github_profile",

  twitter: "twitter_profile",
  x: "twitter_profile",
  "twitter handle": "twitter_profile",

  // ─── Classifications ──────────────────────────────────────────
  tags: "tags",
  labels: "tags",
  tag: "tags",

  skills: "skills",
  skill: "skills",
  expertise: "skills",
  capabilities: "skills",
  // Note: "tech", "tech stack", "stack", "technologies" intentionally left
  // out of the `skills` alias set — in this account they map to the
  // Technology / Tech Stack custom fields instead (see further down).

  source: "source",
  from: "source",
  channel: "source",
  "lead source": "source",
  "acquired via": "source",
  "how found": "source",

  // ─── Communications / do-not ──────────────────────────────────
  "do not email": "do_not_email",
  dne: "do_not_email",
  unsubscribed: "do_not_email",
  "do not contact": "do_not_email",

  // ─── Timestamps ───────────────────────────────────────────────
  added: "added_time",
  "added on": "added_time",
  "added at": "added_time",
  added_on: "added_time",
  created: "added_time",
  "created on": "added_time",
  "creation date": "added_time",
  signup: "added_time",
  "signup date": "added_time",
  "when added": "added_time",

  "last activity": "last_activity_at",
  "last activity at": "last_activity_at",
  last_active: "last_activity_at",
  "last active": "last_activity_at",
  "latest activity": "last_activity_at",
  "last engaged": "last_engaged",
  "last engagement": "last_engaged",
  "last contacted": "last_contacted",
  "last contact": "last_contacted",
  "last touch": "last_contacted",
  "last touchpoint": "last_contacted",

  rating: "rating",
  score: "rating",
  rank: "rating",
  grade: "rating",
  stars: "rating",

  // ─── Jobs / pipeline ──────────────────────────────────────────
  stage: "jobs.*.stage_name",
  stages: "jobs.*.stage_name",
  "current stage": "jobs.*.stage_name",
  "pipeline stage": "jobs.*.stage_name",
  step: "jobs.*.stage_name",
  status: "jobs.*.stage_name",
  "stage moved": "jobs.*.stage_moved",
  "last moved": "jobs.*.stage_moved",
  // Per-job "added on" — distinct from candidate-level `added_time`
  // (which maps "added" / "added on" / "added at" further up). These
  // aliases must mention "job" so the per-job timestamp wins for
  // queries like "when was X added to this job".
  "added to job": "jobs.*.added_to_job",
  "added to job on": "jobs.*.added_to_job",
  "added to job at": "jobs.*.added_to_job",
  "added to this job": "jobs.*.added_to_job",
  "job added on": "jobs.*.added_to_job",
  "applied on": "jobs.*.added_to_job",
  "joined job": "jobs.*.added_to_job",
  "added to position": "jobs.*.added_to_job",

  job: "jobs.*.job_name",
  jobs: "jobs",
  "job name": "jobs.*.job_name",
  "job title at": "jobs.*.job_name",
  applications: "jobs",
  apps: "jobs",
  "applied jobs": "jobs",
  positions: "jobs.*.job_name",
  openings: "jobs.*.job_name",

  "client company": "jobs.*.client_company_name",
  client: "jobs.*.client_company_name",
  "job client": "jobs.*.client_company_name",
  department: "jobs.*.department_name",

  disqualified: "jobs.*.disqualified",
  "disqualification reason": "jobs.*.disqualification_reason",
  "disqualified reason": "jobs.*.disqualification_reason",
  "dq reason": "jobs.*.disqualification_reason",

  // ─── Owner / internal ─────────────────────────────────────────
  owner: "lead_owner",
  "lead owner": "lead_owner",
  "assigned to": "lead_owner",
  "owned by": "lead_owner",
  assignee: "lead_owner",
  "assigned user": "lead_owner",
  recruiter: "lead_owner",

  // ─── Misc ─────────────────────────────────────────────────────
  "custom fields": "custom_fields",
  "all custom fields": "custom_fields",
  cf: "custom_fields",

  // ─── Account-specific custom-field shortcuts ──────────────────
  // These map natural phrasings to the exact custom_fields_by_name path
  // for fields known to exist in this account (from /candidate/custom-field/list).
  // If a user renames one of these, update the path on the right.
  "expected salary": "custom_fields_by_name.expected compensation.value",
  "expected comp": "custom_fields_by_name.expected compensation.value",
  "expected compensation": "custom_fields_by_name.expected compensation.value",
  "desired salary": "custom_fields_by_name.expected compensation.value",
  "desired comp": "custom_fields_by_name.expected compensation.value",
  "salary expectation": "custom_fields_by_name.expected compensation.value",
  "comp expectation": "custom_fields_by_name.expected compensation.value",
  "target salary": "custom_fields_by_name.expected compensation.value",
  "asking salary": "custom_fields_by_name.expected compensation.value",

  "current salary": "custom_fields_by_name.current compensation.value",
  "current comp": "custom_fields_by_name.current compensation.value",
  "current compensation": "custom_fields_by_name.current compensation.value",
  "existing salary": "custom_fields_by_name.current compensation.value",

  "role type": "custom_fields_by_name.role.value",
  "role category": "custom_fields_by_name.role.value",

  segment: "custom_fields_by_name.segment.value",
  "market segment": "custom_fields_by_name.segment.value",

  tenure: "custom_fields_by_name.tenure.value",
  seniority: "custom_fields_by_name.tenure.value",
  level: "custom_fields_by_name.tenure.value",

  tech: "custom_fields_by_name.technology.value",
  technology: "custom_fields_by_name.technology.value",
  technologies: "custom_fields_by_name.technology.value",
  stack: "custom_fields_by_name.tech stack.value",
  "tech stack": "custom_fields_by_name.tech stack.value",
  "tech stacks": "custom_fields_by_name.tech stack.value",

  industry: "custom_fields_by_name.sells to (industry).value",
  "sells to": "custom_fields_by_name.sells to (industry).value",
  vertical: "custom_fields_by_name.sells to (industry).value",
  "target industry": "custom_fields_by_name.sells to (industry).value",
  verticals: "custom_fields_by_name.sells to (industry).value",

  "product category": "custom_fields_by_name.product category.value",
  "product cat": "custom_fields_by_name.product category.value",

  "engineering role": "custom_fields_by_name.engineering role.value",
  "eng role": "custom_fields_by_name.engineering role.value",
};

/** Custom-field prefix — `cf.expected_salary` → custom_fields_by_name.expected_salary.value. */
const CF_PREFIXES = ["cf.", "custom.", "custom_field.", "customfield.", "custom fields."];

/** Get a dot-path from an object, with array / `*` wildcard support. */
export function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  function walk(cur: unknown, i: number): unknown {
    if (cur === null || cur === undefined) return undefined;
    if (i === parts.length) return cur;
    const p = parts[i];
    if (p === "*") {
      if (!Array.isArray(cur)) return undefined;
      const rest = parts.slice(i + 1).join(".");
      return cur
        .map((item) => (rest ? getPath(item, rest) : item))
        .filter((v) => v !== undefined);
    }
    if (Array.isArray(cur)) {
      return cur.map((item) => walk(item, i)).filter((v) => v !== undefined);
    }
    return walk((cur as Record<string, unknown>)[p], i + 1);
  }
  return walk(obj, 0);
}

export interface CandidateLike {
  custom_fields_by_name?: Record<string, { name: string }>;
  [key: string]: unknown;
}

/** A dictionary of custom-field-name fuzzy hits to hoist into aliases. */
function extractCustomFieldNames(
  candidate: CandidateLike | undefined,
): string[] {
  if (!candidate?.custom_fields_by_name) return [];
  return Object.keys(candidate.custom_fields_by_name);
}

export type FieldResolution =
  | { path: string; alias?: string; custom_field?: string }
  | { error: string };

/**
 * Resolve one user-supplied field token into a dot-path. If a candidate is
 * passed, its custom_fields_by_name keys participate in the fuzzy lookup.
 */
export function resolveFieldName(
  input: string,
  topLevelKeys: string[],
  candidate?: CandidateLike,
): FieldResolution {
  const norm = input.toLowerCase().trim();
  if (!norm) return { error: "empty field name" };

  // cf. / custom. / custom_field. → direct custom-field path.
  for (const prefix of CF_PREFIXES) {
    if (norm.startsWith(prefix)) {
      const name = norm.slice(prefix.length).trim();
      if (!name) return { error: `empty custom-field name after "${prefix}"` };
      if (candidate?.custom_fields_by_name?.[normalize(name)]) {
        return {
          path: `custom_fields_by_name.${normalize(name)}.value`,
          custom_field: candidate.custom_fields_by_name[normalize(name)].name,
        };
      }
      // Fuzzy-match against available custom fields on this candidate.
      if (candidate?.custom_fields_by_name) {
        const cfKeys = extractCustomFieldNames(candidate);
        const scored = cfKeys
          .map((k) => ({ k, s: scoreString(name, k) }))
          .filter((x) => x.s >= 0.5)
          .sort((a, b) => b.s - a.s);
        if (scored.length === 1 || (scored.length > 1 && scored[0].s - scored[1].s >= 0.05)) {
          return {
            path: `custom_fields_by_name.${scored[0].k}.value`,
            custom_field: candidate.custom_fields_by_name[scored[0].k].name,
          };
        }
        if (scored.length > 1) {
          return {
            error: `ambiguous custom field "${input}" — could be ${scored
              .slice(0, 4)
              .map((x) => candidate.custom_fields_by_name![x.k].name)
              .join(", ")}`,
          };
        }
      }
      return { error: `no custom field matches "${input}"` };
    }
  }

  // Canonical form — treat underscores and extra spaces as equivalent.
  const canonical = norm.replace(/_/g, " ").replace(/\s+/g, " ").trim();

  // 1. Exact alias hit (try original + canonical form).
  if (ALIASES[norm]) return { path: ALIASES[norm], alias: norm };
  if (ALIASES[canonical]) return { path: ALIASES[canonical], alias: canonical };

  // 2. Exact top-level key hit.
  if (topLevelKeys.includes(norm)) return { path: norm };
  if (topLevelKeys.includes(canonical)) return { path: canonical };

  // 3. Dot-path literal whose first segment resolves.
  if (norm.includes(".")) {
    const first = norm.split(".")[0];
    if (topLevelKeys.includes(first)) return { path: norm };
    if (ALIASES[first])
      return { path: ALIASES[first].split(".")[0] + norm.slice(first.length) };
  }

  // 4. Try custom fields by name on the actual candidate.
  if (candidate?.custom_fields_by_name) {
    const cfKeys = extractCustomFieldNames(candidate);
    // Exact normalized match wins unambiguously.
    const direct = cfKeys.find((k) => k === normalize(norm));
    if (direct) {
      return {
        path: `custom_fields_by_name.${direct}.value`,
        custom_field: candidate.custom_fields_by_name[direct].name,
      };
    }
    const scored = cfKeys
      .map((k) => ({ k, s: scoreString(norm, k) }))
      .filter((x) => x.s >= 0.65)
      .sort((a, b) => b.s - a.s);
    if (
      scored.length === 1 ||
      (scored.length > 1 && scored[0].s - scored[1].s >= 0.08)
    ) {
      if (scored[0]) {
        return {
          path: `custom_fields_by_name.${scored[0].k}.value`,
          custom_field: candidate.custom_fields_by_name[scored[0].k].name,
        };
      }
    }
  }

  // 5. Fuzzy against top-level + alias keyset (last resort).
  const universe = [...topLevelKeys, ...Object.keys(ALIASES)];
  const scored = universe
    .map((k) => ({ k, s: scoreString(norm, k) }))
    .filter((x) => x.s >= 0.7)
    .sort((a, b) => b.s - a.s);
  if (scored.length === 0) return { error: `unknown field "${input}"` };
  if (scored.length > 1 && Math.abs(scored[0].s - scored[1].s) < 0.05) {
    return {
      error: `ambiguous field "${input}" — could be ${scored
        .slice(0, 4)
        .map((x) => x.k)
        .join(", ")}`,
    };
  }
  const best = scored[0].k;
  return ALIASES[best]
    ? { path: ALIASES[best], alias: best }
    : { path: best };
}

/** Build a picker tree from dot paths. `__leaf__` flag marks a terminal node. */
type Tree = Record<string, unknown> & { __leaf__?: boolean };

function buildTree(paths: string[]): Tree {
  const root: Tree = {};
  for (const p of paths) {
    const parts = p.split(".");
    let cur: Tree = root;
    for (const part of parts) {
      if (!cur[part] || typeof cur[part] !== "object") cur[part] = {};
      cur = cur[part] as Tree;
    }
    cur.__leaf__ = true;
  }
  return root;
}

function pick(obj: unknown, tree: Tree): unknown {
  if (obj === null || obj === undefined) return obj;
  if (tree.__leaf__) return obj;
  const keys = Object.keys(tree).filter((k) => k !== "__leaf__");
  if (keys.length === 0) return obj;
  if (Array.isArray(obj)) {
    const starTree = tree["*"];
    if (starTree && typeof starTree === "object") {
      return obj.map((item) => pick(item, starTree as Tree));
    }
    return obj.map((item) => pick(item, tree));
  }
  if (typeof obj !== "object") return obj;
  const result: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "*") continue;
    if (k in (obj as Record<string, unknown>)) {
      const sub = tree[k];
      result[k] = pick(
        (obj as Record<string, unknown>)[k],
        (sub && typeof sub === "object" ? (sub as Tree) : {}) as Tree,
      );
    }
  }
  return result;
}

/** Project an object to the given paths. Omitting paths returns the input. */
export function project(obj: unknown, paths?: string[]): unknown {
  if (!paths || paths.length === 0) return obj;
  const tree = buildTree(paths);
  return pick(obj, tree);
}

/**
 * Resolve a batch of user field names against an object, returning canonical
 * paths (for use with `project`) plus any errors / alias mappings.
 * If `candidate` is passed (the actual target), custom-field names are in scope.
 */
export function resolveFields(
  inputs: string[],
  sample: Record<string, unknown>,
  candidate?: CandidateLike,
): { paths: string[]; notes: string[]; errors: string[] } {
  const topKeys = Object.keys(sample);
  const paths: string[] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  for (const input of inputs) {
    const r = resolveFieldName(input, topKeys, candidate);
    if ("error" in r) {
      errors.push(r.error);
    } else {
      paths.push(r.path);
      if (r.custom_field) {
        notes.push(`"${input}" → custom_field:"${r.custom_field}"`);
      } else if (r.alias && r.alias !== r.path) {
        notes.push(`"${input}" → ${r.path}`);
      }
    }
  }
  return { paths, notes, errors };
}
