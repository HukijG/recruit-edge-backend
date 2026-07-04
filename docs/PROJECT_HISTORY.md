# recruit-edge-backend — project history

This is the backbone of the system: the edge service that keeps Recruiterflow, Dialpad,
Apollo, Krisp, a browser extension, a mobile PWA, a wall-mounted dashboard, and a
conversational MCP client in sync for a small recruiting team. It started in September
2025 as a single Cloudflare Worker doing a one-way webhook copy, written by a working
recruiter who had never touched serverless before. Nine months later it was five
deployed Workers, several Durable Objects, three D1 databases, a vendored tracing library,
and an observability pipeline — every piece of it added because a real workflow demanded
it, and several pieces of it deleted again once production evidence showed they didn't
earn their keep.

The thread running through the whole thing: the users are non-technical salespeople with
near-zero patience for a tool that is slow or flaky. Anything that broke, stalled, or
needed a second click simply would not get used. That bar — fast, durable, effortless —
is why the architecture keeps reaching for stronger consistency guarantees and more
defensive design. The budget was effectively zero: the
Cloudflare paid plan, an old office PC, and the TV already on the wall. Everything here
was built inside that envelope.

Dates below are the commit dates. The short commit hashes are the receipts.

---

## September–October 2025 — a one-way webhook copy, by someone new to the stack

The repo opens on 2025-09-02 with a bare `create-cloudflare` scaffold `03539b3` —
wrangler, vitest, prettier, nothing more. Cloudflare Workers was chosen for the plainest
possible reason: it was the easiest free way to stand up an always-on HTTP endpoint, not
because of any platform expertise.

The first real week of work landed on 2025-09-06 `e776f0c`: JWT auth for Dialpad's
webhooks, handlers for Recruiterflow's webhooks, Dialpad contact creation, and then
two-way candidate sync working end to end. The code split into the shape it would keep
for a long time — an auth module, a Recruiterflow client, a Dialpad client, and sync
handlers. This was the simple core: when a candidate changes in one system, mirror the
change into the other.

Then it went quiet. A couple of tiny sync-rule tweaks a month apart `1230b10`
`6b53a3d`, and on 2025-10-20 the first `CLAUDE.md` documenting the sync flow and the
convention for embedding a Recruiterflow ID inside a Dialpad shared-contact record, plus contact phone-number webhook processing `4846f53`. The tool was
live and low-touch, so it sat untouched for roughly four months. That gap matters,
because what came back in February 2026 reads like it was written by a different, more
platform-aware person.

---

## February 2026 — prototype to production, and the discipline that stuck

The return, on 2026-02-11, was a hardening pass that reads as the pivot from "it works on
my machine" to "it has to survive the real world" `05376e5`. A broken `if/else` had
meant only one event type was ever actually handled; that was fixed. Duplicate handlers
were merged into one path. KV-based debounce was added in both sync directions to kill
the silent infinite-loop problem where each system's write triggers the other's webhook
forever. The Worker was made to fail closed on a missing webhook secret rather than fail
open. These are the instincts of someone who now understands that webhooks retry, that
sync loops are silent killers, and that secrets must fail closed. The same day, the
Dialpad API key was moved out of the query string and into an `Authorization` header
`343b2cd` — query-string keys leak into logs and URLs, a small correction that
signals the shift in platform literacy.

The next two weeks established the operating discipline that shows up for the rest of the
project's life: research a capability, write a design spec, write a task-by-task
implementation plan, build against it, review, and archive the plan when it's done.

- **Calendar-to-email backfill (2026-02-15 → 02-16).** Candidates booked intro calls
  through a scheduling tool, but Recruiterflow records often had no email at creation
  time. The plan was to detect bookings on a calendar and backfill the missing contact
  details. This is where a gotcha that haunts the whole codebase was first
  written down: **Recruiterflow's update endpoint replaces the email and phone arrays
  wholesale rather than appending**, so every write has to GET-then-merge first. The
  feature was built in phases `fca5965`, and Phase 4 quietly introduced the thing
  the rest of this document keeps circling back to — a KV candidate cache with canonical
  records and index keys for O(1) lookup. That cache is the seed; its redesign is a
  months-long arc. Phase 5 added `docs/architecture.md` as a living system reference, kept in sync with the code from then on.

- **Krisp meeting notes (2026-02-16).** A complete, clean spec-driven arc in a single
  day `99588aa`: design doc, a seven-task plan, the client functions, pure helpers,
  a webhook handler with dedup, integration tests, and — notably — a code-review pass
  that caught real bugs before merge (only set the dedup flag *after* a successful post;
  coerce an ID to a string; guard empty content arrays), then the finished plan archived.
  This design→plan→build→test→review→archive loop is the template the project reuses
  dozens of times.

- **Structured logging (2026-02-23).** The logging was collapsed to one receive-line and
  one outcome-line per handler, tagged by source, then switched entirely to structured
  JSON so Cloudflare's log platform could index fields directly `7ac2292`. This is
  the first seed of what later becomes a dedicated observability effort.

- **A scope boundary drawn on purpose (2026-02-23).** A from-scratch description of the
  candidate lifecycle recorded a deliberate decision `36b9435`: the Dialpad→
  Recruiterflow *creation* direction would not be implemented, because dedup and
  UUID-mismatch risk made it unsafe. Recruiterflow stays the single source of truth for
  candidate records. Deciding what *not* to build is a recurring move here.

The month's big new capability was **cold-call tracking**, starting 2026-02-26: a Dialpad call-transcription webhook feeds Cloudflare Workers AI (Llama
3.3 70B), which classifies whether the call was a cold outreach call, then logs a custom
Recruiterflow activity and updates the candidate's source. It shipped and immediately
hit a chain of real-world bugs `65993c8` — Dialpad sending numeric IDs where strings
were expected, the model's JSON reasoning containing braces that broke a regex, Workers
AI sometimes returning an already-parsed object instead of a JSON string, and, most
instructively, the dedup key being written *after* the AI call, so any downstream failure
let Dialpad's webhook retries re-invoke the LLM over and over. The fix — move the dedup
write to immediately after the initial check — is the same retry-storm lesson the project
keeps relearning in new contexts.

Two more cold-call beats close the month. A genuine event-ordering problem — a transcript
arriving before the phone number had been linked to a synced contact — was solved with a
small durable queue: park the call in KV by phone number with a short TTL and pick it up
when the contact-update webhook associates the number `8d2a8b5`. And a backfill
endpoint for historical calls, built on 2026-02-27 with a cheaper model to save AI
budget `8cadca2`, was reverted the same day `1257a6b` with a one-line reason:
**"batch-processing via HTTP endpoint didn't work well in practice."** Built, measured,
cut — no defence of the sunk cost.

---

## March – 1 April 2026 — Apollo enrichment and the Dialpad-clobbering saga

March's centrepiece was Apollo enrichment, and its design record is a decide-then-build
artifact `511598e`. The design was explicitly two-phase. Phase 1 runs synchronously when a candidate is created: verify
Apollo's matched person against the Recruiterflow record on name and organisation before
trusting it, and on a mismatch fall back to Apollo's free People Search and score the
results — *skipping auto-correction entirely when the results are ambiguous*.
"Conservative on ambiguity" was written down as a design principle, not discovered later.
Phase 2 delivers a phone number asynchronously via an Apollo webhook, reusing what the
notes called "the calendar pattern": update Dialpad first and let the existing Dialpad→
Recruiterflow sync carry the change forward, rather than opening a second write path into
Recruiterflow. The feature was gated to the owner's own candidates. (Preceding this, on
2026-03-25, the calendar integration had been extended to detect phone-call booking
types and move candidates to a "call booked" stage `91bfe41`.)

Implementation ran 2026-03-26 to 03-30 `6ce9868`, and on 2026-03-30 the naive
scorer was deliberately replaced with a gated pipeline — a free pre-filter followed by a
confidence-scored disambiguation step against the full Recruiterflow record, with a
60%-confidence threshold — backed by 31 new end-to-end tests over every webhook flow with
real KV and signed JWTs `adee99f`. That's the pattern: ship the simple version, learn
its failure modes, then replace it with the stricter one once you know what "strict" has
to mean.

What followed was a dense run of integration reality landing on the code, all in late
March and the first day of April — the kind of thing that only surfaces once several
features coexist against third-party APIs that don't behave the way their docs imply:

- The scheduling tool silently changed its template wording, breaking the calendar
  filter; Recruiterflow sometimes stores a middle initial inside the last-name field,
  breaking name verification; Apollo's real phone-webhook payload was shaped differently
  from what was assumed `bf133de`.
- Recruiterflow's GET endpoint returns extra fields on email/phone objects that its own
  UPDATE endpoint then rejects with a 400 — fixed by normalising to the minimal shape
  before merging `d29983c`.
- Dialpad fires a "Created" event even for upserts of existing contacts, corrupting the
  loop-prevention debounce; the fix was to PATCH first and fall back to PUT only on a 404
  `55628c4`.
- An ordering bug where enrichment ran *before* the Dialpad sync, so Apollo's corrected
  (and sometimes truncated) data overwrote good values — fixed by re-ordering to sync the
  original data to Dialpad first, then let enrichment update both systems afterward
  `d9ed7d7`. A subtle interaction that could only appear once both features existed.

The densest of these was the **Dialpad-clobbering chain** on 2026-04-01 `ac3efa5`:
Dialpad's contact PATCH silently clears any field it receives as empty. The fix arrived
as a sequence of corrections, each catching the previous one's blind spot — stop sending
empty values at all; scope each update to only the fields it owns instead of rebuilding
the whole contact from partial data; try GET-then-merge (abandoned a commit later over a
field-name mismatch); and finally settle on the right primitive: *only send fields that
have actual values, and add a targeted patch helper for genuinely single-field updates*.
Wrong hypothesis, corrected hypothesis, right abstraction — visible in the commit
sequence.

The last beat of this stretch is quiet but important for everything after it: on 2026-04-01
a `/candidates` endpoint appeared to accept batched payloads from a LinkedIn scraper
browser extension — the first integration point with what becomes **recruit-extension**
`79bf908`. It dedups by LinkedIn URL, maps into Recruiterflow's format, and feeds the
existing Dialpad sync and cache flow, explicitly bypassing Recruiterflow's own multi-hour
webhook delay. Enrichment was wired in for these candidates too, with the verification
step skipped because the extension's data is already trusted. A companion `/candidates/
add-to-job` batch endpoint followed the same day `48a2e2e`.

---

## April – 3 May 2026 — one-recruiter tool becomes a team tool

Through early April the extension pipeline was hardened into something the browser side
could rely on — distinguishing "created" from "already present" `02a4e0d`, adding an
extension auth token `9824893`, retrying on transient upstream errors `63a40a5`. That upstream change
then *removed* code: on 2026-04-13 the deferred cold-call queue from February was deleted
outright `27308d6`, with the reasoning quoted plainly — contacts are now always
pre-linked through the extension, so transcript webhooks always have the candidate ID,
and there's nothing left to park. A whole queue-and-poll-back mechanism retired because a
change in the workflow's *shape* made it unnecessary.

On 2026-04-23 came a durable lesson written into the codebase for good `68459ee`. Two
things landed together. First, a cache-drift bug: KV cache entries can go stale silently
(enrichment overwriting a record's LinkedIn URL, say), so trusting them to match a new
"add candidate" call could route it to the wrong record — the fix made a live
Recruiterflow search authoritative over the cache for matching, and re-cached the
authoritative result to self-heal. Second, the discovery that Cloudflare's log platform
only indexes the top-level `message` field, so all the carefully structured `error` and
`responseBody` fields were being *stored but were invisible to queries*. Every handler
was changed to inline the real error text directly into the message string. This
"put it in the message or you can't see it" lesson recurs, painfully, more than once.

The milestone of the month — and of the whole "one recruiter → team" arc the project is
really about — landed 2026-04-29 `08614e3`. The cold-call pipeline had a hardcoded
single-user target; it was generalised into a Dialpad→Recruiterflow user map so a second
recruiter's calls are classified and attributed to *their own* Recruiterflow identity, not
the owner's. The same batch taught the codebase two more Recruiterflow quirks: tags have
to be GET-merged-then-PUT because the update endpoint replaces arrays wholesale (the
February lesson, now applied to tags), and Recruiterflow's activity text only honours
`<br>` rather than `\n`, so multi-line summaries were rendering as one run-on line.

That multi-user work was formalised the next day, 2026-04-30, in the largest single arc
of the spring: a spec and a nineteen-task, eight-phase, TDD-shaped implementation plan for
a unified team registry, per-job consultant attribution, and new endpoints for candidate
details and marking a number invalid. The build worked through it one
green-tested task per commit `9d25e3e`, ending in a caching strategy tuned for a
browser side-panel's responsiveness — short-TTL detail/activity caches, an append-only
per-job index, and neighbour pre-warming that fetches the candidates on either side of the
one you're looking at so the next click is instant `782c8af`. The side-panel had to
feel instant or it wouldn't get used; the pre-warming exists for exactly that reason.

**Server-side calling and the call-state stack that didn't survive.** On 2026-05-01 the
Dialpad calling flow was moved out of the extension and into the Worker `d6003d8`, so
raw caller-ID phone numbers never leave the server — they're exchanged as opaque signed
JWT aliases, behind a rate-limit and dedup gate that mirrors Dialpad's own 5-calls-per-
minute cap so a mashed button gets a clean 429 instead of a silent upstream rejection.
Then live call-state was pushed to the extension over Server-Sent Events from a per-user
Durable Object `89efb20`, and three consecutive roadblocks were fought and won the
same day: an SSE deadlock from awaiting a stream write before returning the response;
Cloudflare's opaque "internal error" wrapper swallowing the real Durable Object error;
and KV's eventual consistency letting a hangup see a stale null seconds after a webhook
wrote the active-call state — resolved by moving call-state into Durable Object storage,
which is transactionally consistent per instance. The known-flaky modes were then written
up honestly as a hand-off, along with a cleaner long-term alternative (per-user Dialpad
WebSocket subscriptions) that was deliberately documented rather than silently forgotten
`8f06fca`.

It didn't hold. On 2026-05-03 the entire Durable-Object/SSE/webhook call-state stack was
torn down `b20afb7`, with the reason stated flatly: it was fragile under realistic
conditions — CPU-exceeded push invocations, clients disconnecting on every URL change,
state going sticky across calls when Dialpad's events arrived out of order. The modules
were deleted, the binding dropped, and the design doc renamed to a deprecated form
specifically to preserve its failure-mode analysis as history rather than erase it. The
replacement direction was the opposite of what had just been built: the extension polls,
and the Worker answers from Dialpad's REST API and KV. The replacement design was then
iterated three times before a line of it was implemented, each revision killing the previous one's flaw — a per-poll Dialpad call
that would have eaten the rate limit under any concurrency, then a call-ID discovery step
in the wrong place because Dialpad's call list lags the initiate response.

---

## Early May 2026 — the call-state saga ends, and the MCP layer begins

The polling design shipped on 2026-05-05 with 31 new tests `d0d981f` — and then
failed silently in rollout, because Dialpad's list-calls endpoint 404'd on every poll and
the Worker's logs were bare `edaac93`. That is the "put it in the message" lesson from
April, landing a second time, and it was fixed the same way: verbose structured logging
across every branch of the polling flow. The consistency saga wasn't over either. A
webhook-only design `426a6e5` was chosen once it turned out Dialpad's call list only
returns *concluded* calls, so a live call-ID couldn't be bound from it at all. And the KV
version still produced a visible "no active call → ended" flicker right after a call
started — the webhook writing at one Cloudflare location, the extension polling at another
— so on 2026-05-05 the state moved, again, into a per-user Durable Object for strong
consistency, keeping the external poll contract unchanged `f4789f0`. The domain lesson,
earned twice over: real-time call UI cannot tolerate eventual consistency, even for a
second. A "calls today" counter was added alongside it `5402284`, with its trade-offs
(non-atomic increment, UTC day boundaries) documented as deliberate choices fine for an
internal team's volume.

Alongside this, on 2026-05-05, two thin endpoints were built to power a mobile PWA's home
and pipeline screens `06a6bb3`, reusing the extension routes — the same backend now
feeding a third client surface.

The big new direction started 2026-05-07: an **MCP middleware layer** so a conversational
client could ask about candidates and jobs in natural language. The design spec itself
shows the "propose → narrow → build" loop in its own revision history — an initial dual
substrate (D1 plus an R2-backed AI-search layer for fuzzy discovery) was scoped
down to D1-only, with the fancier half explicitly pinned as future work. The build
introduced the **second Worker** in the system: a dedicated cache/sync Worker as its own
deployable subtree, with a D1 schema, a Recruiterflow list-client with cursor-safe paging,
a canonical normaliser, a 15-minute tail-sync, and a Cloudflare Workflow for admin-
triggered full rebuilds `9418c10`. The main Worker gained a seven-endpoint `/mcp/*`
surface `79a76d9`, and the merge `2cfe966` landed a `fields[]` projection system
built on an explicit principle — *the client never sees Recruiterflow's raw schema*; the
backend hides it. Before merge, a probe-driven run of fixes corrected the code from the
Recruiterflow API's *assumed* contract to its *real* one — page sizes, bare-array
responses, real field names, a "disqualified" boolean the API doesn't actually expose
`2eb5ea3`. Don't trust the vendor docs; probe and adapt.

The MCP layer's most interesting decision was the entity resolver, added 2026-05-07
`a45a74a`: fuzzy name-to-ID resolution for candidates, jobs, stages and owners, each
returning a discriminated `ok / not_found / ambiguous` result rather than throwing or
guessing, with numeric inputs short-circuiting to direct lookups. This is where the system
moves from "accepts raw IDs" to "accepts natural-language references and only asks a
clarifying question when genuinely ambiguous." It was then refined so the write tools
enumerate every valid `(candidate, job, stage)` tuple and only ask a question when two or
more full tuples remain — and when they must ask, they ask about the smallest axis of
variation `09c3ec8`. Two same-named candidates auto-resolve if only one is on the
named job. That is a UX decision about a conversational client, made in a backend.

---

## May 8–10 2026 — a third Worker, the auth rearchitecture, and a write-storm

On 2026-05-08 the pipeline caches were rebuilt around a `job_pipelines` D1 table sourced
from Recruiterflow's own pipeline endpoint as canonical stage order `f9bb88c`, and the
old KV-snapshot module was deleted outright once the D1-backed workflow proved out
`873d855` — measure, then delete. On 2026-05-09 a third Worker was stood up: a
standalone TypeScript MCP Worker as a sibling subtree with its own config and test setup,
chosen over extending an existing Worker. This is the seed of the eventual
multi-Worker hub.

Then, on 2026-05-10, production evidence produced a clean measure-then-fix
sequence `35e27c1`: **a D1 write-storm.** Every 15-minute cron tick fired
two jobs, each doing a blind `INSERT OR REPLACE` over the full pipeline and jobs tables
regardless of whether anything had changed — on the order of a million D1 writes a day on
a Worker with zero active MCP consumers. The conservative immediate fix was to disable the
whole cron (webhooks still keep the cache fresh in real time), with an explicit rule left
behind: do not re-enable until the writers gate on "is this row actually different" before
writing. That rule drives an architecture redesign the very next day, and the underlying
problem drives one again a few days after that.

The same day carried the **semi-trust → full-command** auth rearchitecture, and it's the
clearest place in the history where the owner is directing the platform rather than
following it. The trigger was concrete: claude.ai's MCP-connector UI accepts
only OAuth, not arbitrary headers, so the freshly-built MCP Worker worked from an inspector
but not as a real team connector. The response was a full move to Cloudflare Access — an
Access application fronting the MCP Worker, a `verifyAccessJwt` helper, and a users
database — retiring the old shared-secret headers. When a review pass flagged loose schema
constraints, they were tightened "to do it right the first time," including a uniqueness
constraint on first name specifically to prevent a silent "two Joels" collision
`96055e5`. The pivot commit replaced shared-secret auth with Access JWT validation on
the MCP surface `4a6f653`, a `docs/security.md` became the canonical auth reference,
and one hard rule was written into the project's rules doc: **every user-facing endpoint
goes through Cloudflare Access OAuth, no exceptions** `3a4323d`.

Two discipline moments bracket that day. The **observability design was revised three times
in a single day** — an initial OpenTelemetry-to-Logfire design, superseded by
a LaunchDarkly design once re-research found Cloudflare's native OTLP export made a
Workers-side SDK unnecessary and LaunchDarkly's offering matched the owner's stated UI
preference and free-tier shape, trimmed to a single destination on the
owner's "timing belt" feedback, and finally rebuilt from scratch after a
harsh review found the whole approach was *provably non-implementable as of May 2026* and
replaced it with a working, docs-grounded design. A design corrected twice
in a day because its assumptions were checked against reality before code was written, not
after. And a project rule was born from repeated correction: a hard ban on
the scope-cutting language ("v1 / MVP / minimum viable / skip for now / iterate later")
that agents kept reaching for — YAGNI applies only to genuinely unrequested additions, not
to doing the requested thing properly. The day closed with an architecture audit confirming
the now-three-Worker shape as documented reality `db77842`.

---

## May 11–13 2026 — the thin-immutable cache, observability, and dual auth

The write-storm rule from 2026-05-10 became a from-scratch cache redesign on 2026-05-11,
and its design spec preserves the actual reasoning conversation. The trigger
was narrow — the new call-notes tool's list step was slow because it hit Dialpad live every
time. But the scope was broadened deliberately, the operator's own words later recorded in the
spec: candidates *"don't even seem to be being updated even before we disabled cron"*, which led to the governing principle — cache only the fields that don't
change; for anything mutable, the cache is just an ID index and authoritative reads go live
to Recruiterflow. That reframes the entire cache layer. Two more recorded pivots: an instinct that D1 "felt
wrong" for log-shaped immutable data prompted a survey of every Cloudflare storage option,
which concluded *stay on D1* — every alternative failed on consistency, latency, or
retention at this scale; and the KV pipeline-warm layer was dropped entirely
because per-job stage lists, ordering and visibility filtering all live in Recruiterflow's
composition logic, so a cache of it "isn't cacheable in a contract-honest way" — the bust
paths would multiply faster than the read savings.

The discipline around this redesign is worth naming. Before implementation, the spec was
rewritten to be self-contained for a fresh work session, with a twenty-item list of API
assumptions requiring verification and an explicit instruction that **implementation
should not start until verification is complete** — build on verified facts,
not on assumptions. Only once every assumption was checked off did the executable plan
land, and the new thin `_v2` schema and an additive-only sync orchestrator
were built against it, the latter running its subtasks under `Promise.allSettled` so one
failing source can't block the others `3d6e613`.

Two supporting decisions from the same day. The OpenTelemetry library was **vendored** —
forked wholesale into the repo as a first-party package, with a `VENDOR.md` documenting the
rationale and the upstream defects to patch `0f25fca` — a choice immediately justified
by a bug fix *inside* the fork the same day `473a54d`. And a review pass caught that the
new internal cross-Worker routes had no authentication at all; a timing-safe internal token
was added and checked before any routing `9af10f5`. The observability build-out then ran
across the main Worker `9c14cb7` — body capture with secret redaction, a logs SDK
bridged from console calls — and promptly produced its own regression: the earlier
console-trimming sweep had silently stopped surfacing errors in traces, fixed by restoring
error span-status and per-event attributes across all five webhook entry points
`005c3a9`. The whole effort was then written up in `docs/observability.md`, with the
body-capture PII trade-off documented as a deliberate, justified choice rather than an
accident `1880026`. On the same branch that day a fourth Worker — **metrics-poller** —
was bootstrapped to push Cloudflare's own platform metrics into LaunchDarkly `1ac9ae9`.

On 2026-05-12 the parallel observability branch was merged into the mainline with each of
eight conflict resolutions reasoned individually in the commit message `656799f`, the
two helper Workers were renamed repo-side to **cache-worker** and **mcp-remote** to
disambiguate them (with the live Cloudflare names left unchanged so no bindings needed
re-registration) `a1daa2a`, and the thin-cache cron was switched on as a staged cutover
step `a9f2f35`.

The mainline also reworked fuzzy matching that day. A two-phase resolver replaced the
single-pass version — Phase 1 scores candidates against the cache, Phase 2 reranks the
survivors against a live Recruiterflow query `7af6111` — and a follow-up widened the
Phase 1 pool, truncated the long tail, and added an option to include closed jobs
`648487c`. This is the mainline choosing to solve fuzzy matching thoroughly; a parallel
branch's smaller fix for the same problem, a few days later, is measured against exactly
this decision.

The extension's auth got a fresh start too. On 2026-05-12 the earlier dual-auth draft was
explicitly binned for stale route names and a missing fail-safe, and rewritten from scratch
to cover all twelve user-facing routes with a helper that prefers a Cloudflare Access JWT
and falls back to the legacy shared secret, with a fail-safe written into the
spec: the JWT branch must refuse to run if its audience config is unset rather than accept
any audience. Then reality corrected the plan twice in a single late-night session on 2026-05-13, and the
trail was kept both times. First, an inspection of a real token showed that Cloudflare's
SaaS-OIDC apps don't expose the audience tag the spec had assumed — the verifier was
reworked and the spec annotated with the original hypothesis preserved beside the
correction `6230dff`. Minutes later, a deeper one: Cloudflare uses per-app signing keys
for those apps rather than a tenant-wide keyset, so every JWT had been *silently failing
signature verification*; fixed with a per-app key-source override `01095b8`. Two
corrections against a real token inside sixteen minutes, documented each time.

And the era ends where the next redesign begins. On 2026-05-13 a follow-up spec pointed
out that the thin tail-sync was doing roughly nineteen hundred D1 reads per tick just to
confirm rows it already had — a full index scan plus per-row conflict checks — which
directly *contradicts the immutable cache's own contract* that each row enters once with
zero per-row reads. The operator turned the thin cron back off pending a
watermark-based rewrite. The write-storm problem, in a subtler form, had come back.

---

## Mid-May 2026 — a fork in the road that never merged

That watermark rewrite has a second, physical life off the mainline. On 2026-05-14 a branch
opened with two small commits, both citing live incidents. One raised the fuzzy-matching
floor and added prefix-match and order-penalty passes, prompted by an
operator report that roughly half of fuzzy candidate-name searches were returning nothing
or the wrong record — candidates stored under LinkedIn-masked names were unreachable by
their full names because every matching branch scored zero. The other implemented exactly
the watermark-based cron the mainline spec had described: a per-source
watermark replacing the full-table re-confirm scan, named in the commit as the direct cause
of the write-storm that had disabled cron. But this was a smaller, parallel fix for a
problem the mainline had already chosen to solve more thoroughly with the thin-immutable
redesign — so it never merged back. It's the physical evidence of the road not taken.

The branch then spent 2026-05-17 to 05-18 on something the shipped tree never got: a
rigorous evaluation harness for the fuzzy-matching code. A frozen copy of the production
matcher was run entirely in Node against a real production-sized dataset, scored
against a held-out query corpus with an independently-set pass-rate ceiling. Its discipline
is the point: every new tunable had to default to the exact value already in production, so
an unmodified config stayed bit-identical to shipped behaviour and a parity test suite
caught any accidental drift — the harness was explicitly *not allowed to silently improve on
production*. A rule emerged that one commit could change only one scoring mechanism, after a
bundled two-change iteration produced a net-zero result that hid a real regression (a gain
from one change cancelling a loss from the other). It moved the pass rate from about 75% to
84% — and its own retrospective was candid that tuning had hit a ceiling: most of the
remaining failures were legitimate multi-candidate ambiguity that a name-matcher can't
resolve without a different signal entirely. The conclusion was
that the next real gain was a *structural* change outside the harness's scope, so the
harness was consciously kept as a local-only tool and never merged — later confirmed on the
mainline when it was added to the ignore list `f85d7c5`. Measure, learn, and choose not
to ship the measuring apparatus.

---

## June 2026 — the music worker and the maturity wave

June opens with the fifth Worker and, in the wider system, the most interesting one:
music-worker, scaffolded 2026-06-01 as an isolated subtree touching nothing existing
`b986428`. It is the repo's first WebSocket-Hibernation Durable Object, and at birth
it's a remote-control relay between the extension and the wall-mounted recruit-tv-dashboard
— a now-playing fan-out and a command proxy, with its own living doc
`docs/music-worker.md` per the repo's "new sphere, new doc" convention `0f0d1c3`. Over
the following days it becomes the cross-repo coordination point between the extension and
the dashboard, both of which drive it.

Its first days are a compressed replay of the whole project's lessons in a new runtime. A
review caught a demand-count leak where the last subscriber's own closing socket was still
counted, so the upstream connection never died `891832f`. A Durable-Object runtime
subtlety bit: `ctx.waitUntil` is a no-op inside a Durable Object, so wrapping the upstream
handler in it silently swallowed rejections — the reflexive web-Worker idiom that doesn't
hold in a DO, caught and replaced with an explicit `.catch` `24d01a5`. And an operator
decision trimmed surface rather than adding it `d9f0fa5`: a read-only user-registry
lookup was judged redundant once a valid Cloudflare Access JWT is itself the authorization,
since Access already gates token issuance to the team — so it was removed rather than kept
as defence-in-depth. Cross-repo contract mismatches against the parallel-built dashboard
were shaken out too: the Worker was pre-computing a volume delta when the dashboard wanted a
bare direction and owned the step size itself, and it opened the upstream socket over a
scheme the Workers runtime rejects, which had silently broken the whole live feed
`cf72cd7`.

The most instructive music-worker arc was command rate-limiting, because multiple people
now drive one shared TV remote `ba3d940`. A naive global FIFO queue was the first pass;
it let one person's slow command block everyone else's fast ones behind it `652a47c`;
the redesign split commands into four per-category modes — throttle, burst, latest-wins,
queue — tuned to the dashboard's actual playback bottleneck `210527f`. Iterating past
"just queue it" once real multi-user behaviour showed its limits.

The rest of June is a maturity wave across the older features, each beat driven by
production evidence:

- **The Apollo delivery incident (2026-06-03).** Over two days, roughly 60% of Apollo
  phone reveals were being silently discarded `a8e420e`. Root cause: a single KV flag
  was doing double duty as both a request-time dedup guard *and* a delivery gate, and
  Apollo's async delivery was observed lagging from seconds to well past the flag's
  15-minute lifetime. The fix separated the two concerns — always deliver a revealed phone
  regardless of arrival time, and shorten the now-purely-dedup cooldown. The logs named the
  exact defect and its blast radius.

- **Krisp changes shape twice in a week (2026-06-04).** The meeting-notes webhook, stubbed
  out on 2026-05-10 `1731f43`, was re-activated with per-consultant note attribution
  `be0b972`. Then
  Krisp silently renamed its webhook event, caught only because live traces showed every
  delivery being dropped `ee3056d`; and once that was fixed, the payload itself had
  changed to a single markdown string instead of a content array, met with a small
  XSS-safe markdown-to-HTML renderer `11a7917`. A third-party API mutating twice in one
  week, each break caught by live traces rather than by assuming stability.

- **Recruiterflow error-handling (2026-06-08).** Recruiterflow's expected "already in
  pipeline" 409 had been logged as an error and was killing the calendar flow; it was
  reclassified as a normal outcome, and a non-destructive phone/email de-dupe was built into
  the shared contact-update path so any caller hitting a uniqueness constraint against a
  stale duplicate resolves it automatically `47a64bd`. A second review pass caught a
  real wrong-record-strip bug before it shipped.

- **The stage-stats plane (2026-06-10 → 06-11).** A full new analytics feature — a
  dedicated D1 database logging stage-movement events, fed by a webhook plus an hourly
  reconcile plus a backfill path all sharing one primitive `bc2c2e8`, and the main
  Worker's first scheduled handler. Its redesign is a domain-knowledge unlock: a hardcoded,
  never-verified stage-name denylist was misclassifying custom per-job stages, and the fix
  was **positional classification against each job's own pipeline order**, reusing the same
  landmark-based "is submitted" logic already proven in the MCP layer rather than deriving
  stage semantics a second time `ce25e0f`. Then three explicit review passes hardened
  it — cache poisoning on an empty pipeline response, honest surfacing of search-page
  truncation instead of silent under-counting, retry parity `6441e4d`. Its living
  reference is `docs/stage-stats.md`.

- **Billing observability (2026-06-11).** The metrics poller had only covered storage, KV
  bytes and AI neurons — none of the actual Cloudflare billing dimensions — which was named
  directly as *why* the earlier write-storm had been visible only in Cloudflare's own
  dashboard and not in the team's observability `bd1ac62`. Full billing coverage was
  added across Workers, D1, KV and Durable Objects as five independently-failing queries
  (so one schema drift can't take several datasets down together), then pivoted from rolling
  gauges to month-to-date and day-to-date snapshots after direct dashboard-user feedback
  that billing wants period totals, not rolling tails `5fb481c`, with the dashboards
  rebuilt through reproducible commands rather than one-off UI clicks `71bc15b`.

- **The Apollo waterfall, built and then partly deleted (2026-06-22).** Single-number phone
  handling was replaced with a full multi-number waterfall — reveals ranked and written into
  both systems in identical order, with a bounded automatic re-run loop meant to dig deeper
  `6e047b5`. Then a live probe against Apollo's real API proved the re-run loop *can
  never work*: a settled re-reveal always returns the same number because Apollo's endpoint
  short-circuits on its own database and exposes no parameter to change that `69c687d`.
  So the entire re-run machinery — state, trace propagation, region ordering, the rerun cap
  — was deleted as pure wasted credits and complexity `8522f55`: build it, verify
  against reality that the mechanism can't reach its goal, and cut it rather than keep it
  "just in case."

The last beat, on 2026-06-29, is a small, well-scoped Durable Object doing exactly one job
`c3e19c4`. Cancelled and never-connected outbound calls produced no transcript and were
invisible to the AI cold-call flow, quietly understating cold-call counts. A per-call
arbiter Durable Object now races a transcript's arrival against a grace timer — tuned from
the measured call-end-to-transcript lag rather than guessed — so a legitimate transcript
always wins over a cancelled-call record regardless of which webhook arrives first. The DO
is used purely as an arbitration mechanism, not a data store. The same pass fixed a real
bug — the cold-call flow had been running regardless of pipeline stage, and was now gated to
candidates actually in the sourcing stage. It closes the arc where the record opens: the
earliest feature in the system, cold-call tracking from February, getting one more precise
correction from production four months on.

---

## Reflection

The shape of this repo is a recruiter learning a platform in public. September's author
picked Cloudflare because it was free and reached for the obvious idiom every time; June's
author vendors a tracing library to own a bug fix, turns crons off on production evidence,
and tells a design it is provably non-implementable before a line of it ships. The commit
record carries that trajectory in its own markers — "operator decision," "do it right the
first time," the recorded pivots inside the design specs.

A few habits made the difference and are visible throughout. Decisions were written down
before they were built, and the plans were kept honest as running worklogs rather than
frozen as aspirations. Docs were treated as a first-class part of each feature — a new
sphere got a new living doc, and stale version-scaffolding got swept out. And features were
deleted as readily as they were added: the batch backfill, the deferred cold-call queue,
the SSE call-state stack, the Apollo re-run loop, a whole evaluation harness — each cut on
evidence that it wasn't earning its place.

What made all of it necessary is the constraint the system was built under: non-technical
users who would abandon anything slow or flaky, and effectively no budget to paper over the
gap with hardware or hosting. The durability that can look like over-engineering here — the
strong-consistency storage swaps, the retry-storm guards, the fail-closed auth, the pre-
warmed caches — was the price of adoption, not gold-plating. The tool is fast, durable and
effortless because it had to be, or it would not have been used at all.
