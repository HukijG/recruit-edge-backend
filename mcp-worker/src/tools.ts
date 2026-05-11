import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mwFetch, MwClientError } from "./mw-client.js";
import type { RequestCtx } from "./index.js";

// ~140k chars ≈ 35k tokens — leaves headroom in Claude's tool-result budget.
const MAX_RESULT_CHARS = 140_000;

const ref = z.union([z.string(), z.number().int()]);

type ToolReturn = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function respond(value: unknown): ToolReturn {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  let truncated = false;
  if (text.length > MAX_RESULT_CHARS) {
    text = text.slice(0, MAX_RESULT_CHARS);
    truncated = true;
  }
  if (truncated) {
    text += `\n\n[truncated: response exceeded ${MAX_RESULT_CHARS} chars. Narrow the filter or pass a smaller "fields" projection.]`;
  }
  return { content: [{ type: "text", text }] };
}

function fail(msg: string): ToolReturn {
  return { content: [{ type: "text", text: msg }], isError: true };
}

async function guarded(fn: () => Promise<ToolReturn>): Promise<ToolReturn> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof MwClientError) {
      return fail(`Middleware error (HTTP ${e.status}): ${e.bodyText.slice(0, 500)}`);
    }
    return fail(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function registerTools(server: McpServer, ctx: RequestCtx) {
  // ─── rf_candidate_search ────────────────────────────────────────────
  server.registerTool(
    "rf_candidate_search",
    {
      title: "Find candidates by filter and/or fuzzy name (ranked list, multi-match)",
      description: [
        "USE WHEN: ranked-list / multi-match / non-name-narrowing intent. The prompt has structured filter context (company, owner, technology, stage, role, segment, date window), wants multiple candidates, or pairs a fuzzy name with non-name context. NOT for single-candidate lookups — use `rf_candidate_get` for those.",
        "",
        "Intent → call examples:",
        "  • 'find candidates with kubernetes' → { technology: ['Kubernetes'] }",
        "  • 'who's at Eon for the SE role' → { company: 'Eon', job: 'Sales Engineer' }",
        "  • 'Jerry at Acme' → { query: 'jerry', company: 'Acme' }  ← ROUTES HERE, not candidate_get (candidate_get can't use 'at Acme')",
        "  • 'candidates I added for Eon SE last month' → { job: 'Eon SE', owner: 'Joel', added_after: '2026-04-08' }",
        "  • 'all K8s people in Sourced for SE' → { technology: ['Kubernetes'], stage: 'Sourced', job: 'Sales Engineer' }",
        "",
        "Filter knobs (combine freely):",
        "  • `query` — fuzzy NAME only (recency-boosted; not email/company/title)",
        "  • `email` — exact, case-insensitive",
        "  • `company` — substring match on current_organization (no fuzzy; not robust to spelling drift)",
        "  • `job`, `owner` — fuzzy-resolved; numeric short-circuits",
        "  • `stage` — fuzzy against the JOB's stage names; ONLY honoured when paired with `job` (ignored standalone)",
        "  • `technology[]` — multi-select OR; per-element fuzzy against the live custom-field universe",
        "  • `segment`, `role` — single-value custom fields, fuzzy-resolved",
        "  • `added_after / added_before / updated_after / updated_before` — ISO dates",
        "  • `include_disqualified` — only matters with `job`; default excludes DQ'd",
        "At least one of `query` or any filter must be set (400 otherwise). Numeric (or numeric-string) ids bypass fuzzy on `job` / `owner`.",
        "",
        "Ordering depends on what's set:",
        "  • Only `query` → in-memory snapshot scan, ranked by name similarity + recency.",
        "  • Filter only → recency-ordered (`last_updated DESC`).",
        "  • Filter + `query` → SQL narrows, then fuzzy-rank by score.",
        "",
        "Lean rows: `{id, name, current_title, linkedin_profile, score}` (linkedin is a full URL; `score` absent on filter-only paths). `fields[]` is additive over defaults — NO fixed allow-list, real fields resolve, anything else silently drops.",
        "",
        "Disambiguation envelopes (`needs_disambiguation: true`, `kind: 'job' | 'owner' | 'stage' | 'technology' | 'segment' | 'role'`) come back at HTTP 200 when a fuzzy filter is too ambiguous. Render `options[]`, let the user pick, re-call with the chosen id.",
        "",
        "`count` is the size of returned `matches`, NOT a total — raise `limit` (default 5, max 50) if you need to confirm completeness. Don't request fields already implied by a filter.",
      ].join("\n"),
      inputSchema: {
        query: z
          .string()
          .min(1)
          .optional()
          .describe("Candidate name (partial OK), email, or identifying text. Optional — when omitted, results are ordered by recent updates and filters do all the narrowing."),
        job: ref.optional(),
        stage: ref.optional(),
        owner: ref.optional().describe("Lead owner — name, email, or numeric RF user id."),
        company: z.string().optional(),
        email: z.string().optional(),
        technology: z
          .array(z.string())
          .optional()
          .describe("Multi-select on the Technology custom field (ANY match)."),
        segment: z.string().optional(),
        role: z.string().optional(),
        added_after: z.string().optional().describe("ISO date."),
        added_before: z.string().optional().describe("ISO date."),
        updated_after: z.string().optional().describe("ISO date."),
        updated_before: z.string().optional().describe("ISO date."),
        include_disqualified: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        fields: z
          .array(z.string())
          .optional()
          .describe(
            "Additive over defaults. No fixed allow-list — pass any reasonable English name matching what you want; real fields resolve, anything else silently drops. Stay lean (only what serves the user's intent); don't constrain to a predetermined set.",
          ),
        filters: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Long-tail filter bag for fields not yet first-class. Try anything reasonable — unknown keys silently drop.",
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/candidate-search", args as Record<string, unknown>);
        return respond(data);
      }),
  );

  // ─── rf_candidate_get ───────────────────────────────────────────────
  server.registerTool(
    "rf_candidate_get",
    {
      title: "Fetch ONE specific candidate by id or fuzzy name (auto-disambiguates; rich profile defaults)",
      description: [
        "USE WHEN: the user wants ONE specific person — 'show me Jerry', 'fetch his profile', 'who is candidate 50976', 'pull up Sarah'. For ranked-list / filter-narrowed / multi-match intents, route to `rf_candidate_search` instead.",
        "",
        "Pass either `id` (number) or `query` (fuzzy string). Numeric id is the canonical fast path when you already have one. Ambiguous fuzzy queries return `needs_disambiguation: true` at HTTP 200 with `kind: 'candidate'` and lean `options[]` — render to the user, let them pick, re-call with the chosen id.",
        "",
        "DOES NOT accept filter context. If the prompt narrows by anything beyond name (company, owner, stage, technology, role, etc.) — 'Jerry at Acme', 'the K8s candidate', 'the Eon SE one' — route to `rf_candidate_search`. This tool ignores everything but `id` / `query` and will auto-disambiguate among ALL Jerrys regardless of any company/owner/stage hint the user gave.",
        "",
        "Lean defaults (a STARTING SET, NOT the full record): `{id, name, first_name, last_name, primary_email, phone_numbers, current_title, current_organization, linkedin_profile, jobs:[{client_company_name, job_name, stage_name}]}` (linkedin is a full URL). RF holds many more fields per candidate.",
        "",
        "`fields[]` is additive over defaults — defaults always come back, you opt into more. NO fixed allow-list — pass any reasonable English name; real fields resolve, anything else silently drops. Trust the resolver — request whatever fits the user's intent.",
        "",
        "When to expand `fields`:",
        "  • Generic asks ('fetch his details', 'tell me about X') → request fields plausibly relevant to user's intent. Stay lean (don't pad), but don't undershoot — defaults are not exhaustive.",
        "  • Specific asks ('what's his email') → defaults usually cover; only add what the user explicitly named.",
        "",
        "NEVER frame a defaults-only response as 'that's everything RF has' — it never is.",
      ].join("\n"),
      inputSchema: {
        id: z.number().int().optional(),
        query: z.string().optional(),
        fields: z
          .array(z.string())
          .optional()
          .describe(
            "Extra fields beyond defaults. No fixed allow-list — pass any reasonable English name matching what you want; real fields resolve, anything else silently drops. Stay lean (only what plausibly serves the prompt); expand on generic 'details / tell me about' asks since defaults are not exhaustive.",
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { "anthropic/alwaysLoad": true },
    },
    async (args) =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/candidate-get", args as Record<string, unknown>);
        return respond(data);
      }),
  );

  // ─── rf_candidate_move_stage ────────────────────────────────────────
  server.registerTool(
    "rf_candidate_move_stage",
    {
      title: "Move a candidate to a pipeline stage",
      description: [
        "Pass natural strings — middleware fuzzy-matches candidate, job, and stage. Numeric (or numeric-string) ids bypass fuzzy. Fastest path: pass all three as numerics when known — direct commit, no resolver round-trip.",
        "",
        "`job` is optional. Omitted → uses the candidate's single non-disqualified job; multiple match → returns `needs_disambiguation: 'job'` at HTTP 200. `stage` resolves against THAT job's pipeline (per-job, no canonical list).",
        "",
        "Post-narrow auto-commit: even if `candidate` alone is ambiguous, if (candidate, job, stage) uniquely identifies a single tuple after applying all three refs, the move commits with no extra round-trip. Success returns the resolved identity in `moved`.",
        "",
        "Recoverable failures (no candidate match, unknown stage on this job, etc.) come back at HTTP 200 as `{ok: false, kind, error, ...recovery_hints}`. Use the hints to clarify with the user; don't crash.",
        "",
        "Attribution is always the consultant whose Access JWT signed this MCP session — there is no override field.",
      ].join("\n"),
      inputSchema: {
        candidate: ref,
        stage: ref,
        job: ref.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/candidate-move-stage", args as Record<string, unknown>);
        return respond(data);
      }),
  );

  // ─── rf_candidate_log_interview ─────────────────────────────────────
  server.registerTool(
    "rf_candidate_log_interview",
    {
      title: "Log an interview on a candidate's RF timeline (calendar handoff via response)",
      description: [
        "Writes a custom-activity entry of type Interview on the RF timeline. Pass natural strings — middleware fuzzy-matches candidate and job; post-narrow auto-commits when the tuple is unique.",
        "",
        "DOES NOT create a calendar event itself. Response carries calendar handoff data — inspect `next_step`:",
        "  • `outlook_url` — surface to the user as a clickable Markdown link, e.g. `[Add to Outlook](outlook_url)`. They click and save.",
        "  • `gcal_hint` — pass to the Google Calendar connector with summary/description/start/end/calendarId verbatim.",
        "  • Both → prefer `outlook_url`.",
        "NEVER add the candidate as an attendee — recruiter-only calendar block.",
        "",
        "`kind` is verbatim ('1st Interview' / '2nd Interview' / ... / 'Final Interview'). `start_time` MUST include a timezone offset. Default duration is 60 min.",
        "",
        "Attribution is always the consultant whose Access JWT signed this MCP session — there is no override field.",
      ].join("\n"),
      inputSchema: {
        candidate: ref,
        kind: z
          .string()
          .min(1)
          .describe(
            "Interview label, used verbatim in the activity title. Expected: '1st Interview' / '2nd Interview' / '3rd Interview' / '4th Interview' / 'Final Interview'.",
          ),
        start_time: z
          .string()
          .describe(
            "ISO 8601 with timezone offset, e.g. '2026-04-27T15:00:00-05:00'. The offset is REQUIRED — never pass a bare local datetime.",
          ),
        end_time: z
          .string()
          .optional()
          .describe("ISO 8601 with timezone offset. Defaults to start_time + 60 minutes."),
        job: ref.optional(),
        context: z
          .string()
          .optional()
          .describe(
            "Extra detail rendered under the title, one line per \\n. Leave empty unless the user explicitly gave context.",
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/candidate-log-interview", args as Record<string, unknown>);
        return respond(data);
      }),
  );

  // ─── rf_job_candidates_filter ───────────────────────────────────────
  server.registerTool(
    "rf_job_candidates_filter",
    {
      title: "Flat candidate list on a job — NOT grouped by stage (prefer rf_job_pipeline for pipeline views)",
      description: [
        "DO NOT use this for pipeline-style reads — use `rf_job_pipeline` instead. Pipeline queries ('pipeline', 'submitted', 'in <stage>', 'progress on <job>', stage-by-stage views) belong on `rf_job_pipeline` because it groups by stage and resolves stage names per-job.",
        "",
        "Use THIS tool only when the user wants a flat (non-grouped) candidate list on a job — e.g. extracting custom field projections (`fields`) or applying long-tail filters (`filters: {...}`) for analytics-style reads where stage grouping isn't wanted.",
        "",
        "Pass natural strings — middleware fuzzy-matches job and stage. Numeric ids bypass fuzzy.",
        "",
        "Lean rows: `{id, name, linkedin_profile}` (linkedin is a full URL). `fields` is additive — defaults always present. Unresolved field names silently drop. `filters: {...}` is the long-tail bag; unknown keys silently drop.",
        "",
        "Capped at `limit` (default 100, max 500). Response includes `truncated: true` when total exceeds.",
        "",
        "Don't request fields already implied by the filter (no `job` if you filtered by job, no `stage` if you filtered by stage).",
      ].join("\n"),
      inputSchema: {
        job: ref,
        stage: ref.optional(),
        fields: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(500).optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (args) =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/job-candidates-filter", args as Record<string, unknown>);
        return respond(data);
      }),
  );

  // ─── rf_job_pipeline ────────────────────────────────────────────────
  server.registerTool(
    "rf_job_pipeline",
    {
      title: "Job pipeline view — candidates grouped by stage (use for ANY 'pipeline' query)",
      description: [
        "USE THIS for any pipeline-style read on a job: 'show me the pipeline', 'who's in CV Sent', 'submitted candidates', 'progress on <job>', stage-by-stage views, 'from <stage> to <stage>'. Prefer over `rf_job_candidates_filter` whenever intent involves stages or pipeline progress.",
        "",
        "Pass natural strings — middleware fuzzy-matches the job (numeric ids bypass fuzzy). Each job has its own stage pipeline; `stage` / `from` / `to` resolve against THAT job's stages — don't assume a canonical list.",
        "",
        "Response shape: `{job, stage_breakdown: [{stage_name, count}, ...], stages: {<stage_name>: [<candidates>]}}`. `stage_breakdown` is the ordered funnel (canonical pipeline order, restricted to requested window, includes empty buckets so you see funnel shape). `stages` is keyed by stage name for O(1) bucket access — iterate via `stage_breakdown` for order. Per-candidate defaults: `{id, name, linkedin_profile}` (linkedin is a full URL); pass `fields` to extend additively.",
        "",
        "Stage windowing (pick one, or none for default):",
        "  • `stage: '<name>'` — single stage",
        "  • `from: '<name>'` + `to: '<name>'` — fuzzy lower/upper bounds on this job's pipeline",
        "  • `submitted: true` — exact 'CV Sent' → end of pipeline",
        "  • none → actively-progressing window (CV Sent → Offer)",
        "",
        "Cold-cache state: a job opened in RF in the last ~15 min may return `stage_breakdown: []`, `stages: {}`, and `_meta.warnings: ['pipeline cache not yet built...']`. NOT an error — surface to the user as 'try again in ~15 min'.",
        "",
        "Default excludes disqualified; pass `include_disqualified: true` to include. Open jobs only (closed jobs reachable via explicit numeric `job` id). Long-tail filters go in `filters: {...}`; unknown keys silently drop.",
      ].join("\n"),
      inputSchema: {
        job: ref,
        stage: z.string().optional(),
        from: z.string().optional().describe("Fuzzy lower bound stage on this job's pipeline."),
        to: z.string().optional().describe("Fuzzy upper bound stage on this job's pipeline."),
        submitted: z
          .boolean()
          .optional()
          .describe("Shortcut: exact 'CV Sent' → end of pipeline."),
        include_disqualified: z
          .boolean()
          .optional()
          .describe("Default false; pass true to include DQ'd candidates."),
        fields: z.array(z.string()).optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { "anthropic/alwaysLoad": true },
    },
    async (args) =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/job-pipeline", args as Record<string, unknown>);
        return respond(data);
      }),
  );

  // ─── rf_cache_status ────────────────────────────────────────────────
  server.registerTool(
    "rf_cache_status",
    {
      title: "Cache freshness diagnostic (read-only)",
      description: [
        "Returns counts and last-sync timestamps for the server-side D1 cache. Does NOT trigger a refresh — sync runs server-side every 15 min.",
        "",
        "Use ONLY when the user questions data freshness or asks about the cache directly. Don't preempt-call before normal reads.",
      ].join("\n"),
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/cache-status", {});
        return respond(data);
      }),
  );

  // ─── rf_candidate_add_note ──────────────────────────────────────────
  server.registerTool(
    "rf_candidate_add_note",
    {
      title: "Add a note to a candidate's RF timeline (markdown body)",
      description: [
        "Writes a note onto a candidate's RF profile. Pass natural strings — middleware fuzzy-matches candidate (and the optional `job` for auto-narrow when multiple candidates match the name). Numeric (or numeric-string) ids bypass fuzzy.",
        "",
        "`note` is markdown; the worker renders to HTML before sending to RF. A bare newline becomes <br>; bold/italic/lists/links/autolinks all supported.",
        "",
        "Optional `job` is purely a disambiguator — notes attach to the candidate, not to a job link. Post-narrow auto-commit: even when candidate is fuzzy-ambiguous, if exactly one candidate is on the requested job, the note commits with no round-trip.",
        "",
        "Recoverable failures (no candidate match, no candidate on the requested job, etc.) come back at HTTP 200 as `{ok:false, kind, error}` — apologise, clarify with the user, retry. 4xx / 5xx are loud install or transport errors.",
        "",
        "Attribution is always the consultant whose Access JWT signed this MCP session — there is no override field.",
      ].join("\n"),
      inputSchema: {
        candidate: ref,
        note: z.string().min(1).describe("Markdown body of the note. Server renders to HTML before sending to RF."),
        job: ref.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/candidate-add-note", args as Record<string, unknown>);
        return respond(data);
      }),
  );

  // ─── rf_candidate_call_notes ────────────────────────────────────────
  server.registerTool(
    "rf_candidate_call_notes",
    {
      title: "Write structured call notes from a recent Dialpad screening call (three-step flow)",
      description: [
        "USE WHEN: the user asks you to write up / draft / create structured call notes for a recent call with a candidate (e.g. 'for my most recent screening call with Sarah, write up the structured call notes').",
        "",
        "Three stages keyed by `step`. ONE round-trip per stage. The tool is stateless across calls — each response carries the identifiers needed for the next.",
        "",
        "─── step='list_calls' ──────────────────────────────────────────",
        "Find the consultant's recent calls of 2+ minutes with the named candidate.",
        "  Required: candidate (fuzzy name or numeric RF id).",
        "  Time window: PREFER passing started_after/started_before as ISO 8601 — you usually know the user's TZ and can compute the window. Fall back to time_query only for short common phrases ('today', 'yesterday', 'last hour', 'this afternoon', 'last 3 days', 'last week', 'YYYY-MM-DD', '<weekday>'). Anything outside the small fallback set defaults to last 7 days with a warning; convert to ISO instead.",
        "  Response: {ok: true, candidate: {id, name}, calls: [{call_id, started_at, duration_minutes, direction}, …], window?}",
        "  IMPORTANT: NEVER surface `call_id` to the user — describe the call instead ('24 min outbound on Monday at 3:15pm'). The user picks one, you re-call step='get_transcript' with that call_id.",
        "  Recoverable: {ok:false, kind:'no_long_calls' | 'no_dialpad_id' | 'no_candidate'}, or {needs_disambiguation, kind:'candidate', options}.",
        "",
        "─── step='get_transcript' ──────────────────────────────────────",
        "Pull the transcript + rendering brief for one chosen call.",
        "  Required: call_id (opaque string from step='list_calls' response).",
        "  Response: {ok: true, candidate: {id, name}, call: {…}, transcript: '<formatted plain text>', guidance: '<markdown template>'}",
        "  Read the guidance carefully — it defines the exact section layout the team uses. Apply it to the transcript and draft the note in chat for the user to review. Do NOT call step='submit_notes' until the user confirms.",
        "  Recoverable: {ok:false, kind:'not_your_call' | 'no_rf_candidate' | 'no_candidate' | 'no_transcript' | 'rate_limited' | 'call_not_found'}.",
        "",
        "─── step='submit_notes' ────────────────────────────────────────",
        "Post the finished structured notes to the candidate's RF profile.",
        "  Required: note (markdown — server converts to HTML), and ONE of: candidate_id (preferred, the numeric id echoed back in stages 1/2) or candidate_fallback (fuzzy name when you lost the id).",
        "  Response: {ok: true} on success — fully consistent with rf_candidate_add_note.",
        "  Recoverable on fallback path: {needs_disambiguation, kind:'candidate', options} (rare; only if Claude lost the id and the fuzzy name resolves to multiple).",
        "",
        "Attribution is always the consultant whose Access JWT signed this MCP session — no override field.",
      ].join("\n"),
      inputSchema: {
        step: z.enum(["list_calls", "get_transcript", "submit_notes"])
          .describe("Which stage of the flow: 'list_calls' (find candidate's recent calls) → 'get_transcript' (fetch transcript + rendering guidance) → 'submit_notes' (post finished notes to RF)."),
        candidate: ref.optional()
          .describe("Required when step='list_calls'. Fuzzy name or numeric RF id. Numeric short-circuits the resolver."),
        started_after: z.string().optional()
          .describe("ISO 8601 (any TZ offset). Preferred time-window input. Required when step='list_calls' unless time_query is set."),
        started_before: z.string().optional()
          .describe("ISO 8601 upper bound; defaults to 'now' when started_after is set without it."),
        time_query: z.string().optional()
          .describe("Fallback natural-language window. Supported: 'most recent', 'last hour', 'last <N> hours', 'today', 'yesterday', 'this morning'/'afternoon'/'evening', 'yesterday afternoon'/'evening', 'this week', 'last week', 'last <N> days', 'last <N> weeks', '<weekday>', 'YYYY-MM-DD'. Anything else defaults to 7 days + warning."),
        call_id: z.string().optional()
          .describe("Required when step='get_transcript'. The Dialpad call_id from a previous step='list_calls' response."),
        candidate_id: z.number().int().optional()
          .describe("Numeric RF id from a previous stage. Use this on step='submit_notes' when you have it (fast path)."),
        candidate_fallback: ref.optional()
          .describe("Fuzzy candidate ref for step='submit_notes' when candidate_id was lost. Goes through the full disambiguation flow."),
        note: z.string().optional()
          .describe("Required when step='submit_notes'. Markdown body of the structured call notes."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) =>
      guarded(async () => {
        const data = await mwFetch(ctx, "/mcp/candidate-call-notes", args as Record<string, unknown>);
        return respond(data);
      }),
  );
}
