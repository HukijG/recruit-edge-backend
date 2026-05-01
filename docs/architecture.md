# Architecture & Data Flow

## System Overview

A single Cloudflare Worker (`rf-dialpad-sync-dev`) that keeps candidate/contact records in sync across RecruiterFlow (RF), Dialpad, Google Calendar, Krisp, and a custom LinkedIn Recruiter Chrome extension. RF is the source of truth for candidate records. A KV-backed cache provides fast lookups for integrations that don't have an RF candidate ID, and short-TTL snapshot caches make the extension's sidepanel responsive when recruiters walk through bulk-added candidate queues.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ RecruiterFlow │  │   Dialpad    │  │  Dialpad     │  │   Google     │  │    Krisp     │  │   LinkedIn   │
│   (RF)       │  │  (contacts)  │  │  (calls)     │  │  Calendar    │  │              │  │  Extension   │
│              │  │              │  │              │  │  + Reclaim   │  │              │  │ (Chrome)     │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │ webhook         │ webhook         │ webhook         │ Apps Script      │ webhook         │ POST (X-Extension-Token)
       ▼                 ▼                 ▼                 ▼                 ▼                 ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Cloudflare Worker (rf-dialpad-sync-dev)                                      │
│                                                                                                              │
│  /webhook/recruiterflow  /webhook/dialpad  /webhook/dialpad/calls  /webhook/dialpad/extension-calls         │
│  /webhook/calendar  /webhook/krisp  /webhook/apollo                                                         │
│  /candidates  /candidates/add-to-job  /candidate-details  /candidate-mark-invalid                           │
│  /dialpad-user-context  /dialpad-call  /dialpad-sms  /dialpad-hangup  /extension-call-stream (SSE)          │
│  /health                                                                                                     │
│                                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐       │
│  │                    KV: SYNC_STATE                                                                  │       │
│  │  candidate:{rfId}                       → slim JSON record           (60-day TTL)                 │       │
│  │  linkedin:{url}                         → rfId                       (60-day TTL)                 │       │
│  │  email:{addr}                           → rfId                       (60-day TTL)                 │       │
│  │  name:{first}:{last}                    → rfId or "AMBIGUOUS"        (60-day TTL)                 │       │
│  │  sync:RF{id}                            → "true"                     (60-sec TTL)                 │       │
│  │  krisp:note:{hash}                      → "true"                     (24-hour TTL)                │       │
│  │  coldcall:{call_id}                     → "true"                     (5-min TTL)                  │       │
│  │  apollo_enrich:{rfId}                   → JSON                       (15-min TTL)                 │       │
│  │  consultant:job{jobId}:cand{rfId}       → rfUserId or "none"         (30-day TTL)                 │       │
│  │  details:{rfId}                         → full RF candidate JSON     (20-min TTL)                 │       │
│  │  activities:{rfId}                      → activity-list array        (20-min TTL)                 │       │
│  │  batch:job{jobId}                       → ordered rfId array         (30-day TTL)                 │       │
│  │  prewarm:rec{rfUserId}:job{jobId}       → { lastPrewarmIdx }         (1-hour TTL)                 │       │
│  │  ratelimit:call:{dialpadUserId}         → JSON [{t,phone}]           (120-sec TTL)                │       │
│  │  extcall:watch:{dialpadUserId}          → { phone, initiatedAt }     (90-sec TTL)                 │       │
│  │  extcall:active:{dialpadUserId}         → { callId, phone, ... }     (30-min TTL)                 │       │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘       │
│                                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐       │
│  │                    Durable Object: EXT_CALL_CHANNEL                                                │       │
│  │  ExtensionCallStateChannel — one instance per Dialpad user (getByName(dialpadUserId)).             │       │
│  │  In-memory Set<WriterStream> of subscribed SSE writers; no persistent storage.                     │       │
│  │  fetch() → SSE stream + KV-replayed initial state. pushState() RPC fans out.                       │       │
│  │  alarm() → 25s heartbeat while writers exist.                                                      │       │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘       │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Source Files

| File | Purpose |
|------|---------|
| `src/index.js` | Worker entry point, request routing, all webhook handlers, extension routes, sync orchestration, neighbor-prewarm logic |
| `src/users.js` | Team registry: hardcoded `USERS` array of `{ firstName, rfUserId, dialpadId }` records + accessors (`getUserByFirstName`, `getUserByDialpadId`, `getUserByRFUserId`, `resolveRFUserId`, `getRFUserIdByDialpadId`, `isMonitoredDialpadUser`). Single source of truth for cold-call attribution, calendar Joel-only logic, the extension's `consultantFirstName` resolution, and Apollo's Joel-only enrichment trigger |
| `src/cache.js` | KV cache: canonical records, index keys (linkedin, email, name), consultant_id per job-link, details + activities snapshots, batch index, prewarm state, invalidation helper |
| `src/rf-client.js` | RF API client: search/get/update, LinkedIn URL validation & normalization, Dialpad↔RF data conversion, custom-field consultant_id read/write/resolve, activity-list, phone normalization (`normalizeToE164`), job disambiguation (`pickConsultantJob`), stage-move filter, prewarm helper, single-retry-on-502 in `getRFCandidate` |
| `src/dialpad-client.js` | Dialpad API client: contact PUT (create/update), data preparation from RF candidate format, `getUserCallerId` (fetch the consultant's caller-IDs) and `initiateCall` (POST `/users/{id}/initiate_call`) for the LinkedIn extension calling flow, plus the pure `buildCallerIdsFromDialpad` transform that turns Dialpad's flat `caller_id` shape into the extension-facing `callerIds[]` array with opaque aliases. Also `sendSMS` (POST `/sms`) — rolled-params wrapper backing `/dialpad-sms`; required: `userId`, `toNumbers`, `text`; optional pass-throughs for `fromNumber`, `inferCountryCode`, `media`, `senderGroupId`, `senderGroupType`, `channelHashtag`. And `hangupCall({ callId })` (PUT `/call/{id}/actions/hangup`) — no body, returns `{ ok, status, body }` |
| `src/extension-calls.js` | Extension call-state machine + push wrapper. `processExtensionCallEvent(payload, env, ctx)` filters Dialpad calling/hangup webhook events (outbound-only on `calling`, registry-user-only via `getUserByDialpadId`, phone-match on watch, call_id-match on hangup), transitions `extcall:watch` → `extcall:active` and back, and calls `notifyExtensionCallState`. `notifyExtensionCallState` resolves the per-user DO via `EXT_CALL_CHANNEL.getByName(dialpadUserId)` and broadcasts via `pushState({ state, phoneNumber })` RPC (the call_id is intentionally never on the wire to the extension) |
| `src/extension-call-do.js` | `ExtensionCallStateChannel` Durable Object — per-Dialpad-user SSE fan-in. `fetch()` returns an SSE Response, replays current state from KV (active or watch) on connect, registers a writer, schedules a heartbeat alarm if not already scheduled. `pushState(event)` RPC iterates writers, dropping dead ones. `alarm()` sends `: keepalive\n\n` every 25s while writers exist; reschedules itself. No persistent storage used — subscribers are in-memory only; on DO eviction the streams die and the extension reconnects with replay |
| `src/dialpad-aliases.js` | Opaque caller-ID alias signing/verifying for the calling endpoints (HS256 JWT via `jose`, audience `dialpad-caller-id`, 7-day TTL). Keeps raw E.164 numbers off the wire to the extension |
| `src/rate-limit.js` | Rolling-window rate-limit + cheap dedup gate for `/dialpad-call`. Pure `decideCallRateLimit({timestamps, now, phoneNumber})` returns `{allowed, reason?, retryAfterSec?, nextTimestamps?}`. KV-backed `checkAndRecordCall` reads SYNC_STATE, decides, persists on allow. 5 calls/60s rolling per Dialpad user_id, plus a 3s per-(user,phone) dedup window for double-clicks |
| `src/krisp.js` | Krisp helpers: note formatting (HTML), candidate email extraction from meeting participants |
| `src/cold-call.js` | Cold call detection: monitored-user filter (registry-driven), Dialpad transcript fetch, Workers AI classification (Llama 3.3 70B), per-outcome summary extraction (Llama 3.1 8B), RF custom activity + tag/source update + Sourced→Replied stage move, generic `mergeTag(tags, value)` helper, `parseColdCallActivity` for the extension shape |
| `src/apollo-client.js` | Apollo API client: enrichment, search, verification, scoring |
| `src/enrichment.js` | Enrichment orchestration: ownership check (sourced from `users.js`), LinkedIn verify, fallback search, phone reveal |
| `src/auth.js` | JWT verification for Dialpad webhooks (HS256 via `jose`) |
| `scripts/calendar-sync.gs` | Google Apps Script: detects Reclaim bookings on Google Calendar, extracts candidate data, posts to worker |
| `wrangler.jsonc` | Worker config: KV binding, env vars, compatibility settings (no secrets — those are Cloudflare-managed) |
| `vitest.config.js` | Vitest + miniflare config; test-only secret bindings live here, not in wrangler.jsonc |
| `test/index.spec.js`, `test/e2e.spec.js`, `test/users.spec.js` | Vitest tests using `@cloudflare/vitest-pool-workers` |

---

## Endpoints

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/health` | GET | None | Health check |
| `/webhook/recruiterflow` | POST | `X-RF-Webhook-Token` header | RF candidate Created/Updated events |
| `/webhook/recruiterflow/manual` | POST | `?token=` query param (`RF_WEBHOOK_SECRET`) | Manual RF candidate sync (flat payload) |
| `/webhook/dialpad` | POST | JWT Bearer (HS256) | Dialpad contact Updated events |
| `/webhook/calendar` | POST | `X-Calendar-Webhook-Token` header | Calendar booking events (from Apps Script) |
| `/webhook/krisp` | POST | `X-Krisp-Webhook-Token` header | Krisp meeting note webhooks |
| `/webhook/dialpad/calls` | POST | JWT Bearer (HS256) | Dialpad call transcription/voicemail webhooks |
| `/webhook/dialpad/extension-calls` | POST | JWT Bearer (HS256, same `DIALPAD_WEBHOOK_SECRET`) | Dialpad call-state webhooks (calling/hangup) — drives extension button toggle |
| `/webhook/apollo` | POST | `?token=` query param (`APOLLO_WEBHOOK_SECRET`) | Async phone reveal delivery from Apollo |
| `/candidates` | POST | `X-Extension-Token` header | LinkedIn extension batch upsert (sets `lead_owner_id`) |
| `/candidates/add-to-job` | POST | `X-Extension-Token` header | Add candidates to a job + write `consultant_id` custom field |
| `/candidate-details` | POST | `X-Extension-Token` header | Sidepanel data: rfId, phone (E.164), picked job, cold-call activities |
| `/candidate-mark-invalid` | POST | `X-Extension-Token` header | Tag candidate `"Number Invalid"` (idempotent) |
| `/dialpad-user-context` | POST | `X-Extension-Token` header | Caller-ID picker data: `{ callerIds: [{ aliasId, country, label?, isDefault? }] }` (opaque aliases, no raw E.164) |
| `/dialpad-call` | POST | `X-Extension-Token` header | Initiate call via Dialpad `initiate_call`. Decodes `callerAliasId`; Dialpad auto-rings the consultant's eligible devices. Writes `extcall:watch` before invoking Dialpad. Response is `{ ok: true }` only (no `callId` — worker holds it server-side) |
| `/dialpad-sms` | POST | `X-Extension-Token` header | Send a single SMS via Dialpad `/sms`. Decodes `callerAliasId` (optional → Dialpad default sender); text is forwarded verbatim |
| `/dialpad-hangup` | POST | `X-Extension-Token` header | Terminate the consultant's active call. Body is just `{ consultantFirstName }`; worker reads `call_id` from `extcall:active`. 409 if no active call |
| `/extension-call-stream` | GET | **None (intentionally — see Auth section below)** | SSE stream consumed via `EventSource`. State events (`idle | calling | active | ended`) pushed per-Dialpad-user via the `EXT_CALL_CHANNEL` Durable Object |

---

## Data Flow: RF → Dialpad

**Trigger**: RF fires webhook when a candidate is created or updated.

```
RF webhook (Created/Updated)
  → POST /webhook/recruiterflow
  → Verify X-RF-Webhook-Token (fail closed)
  → Parse candidate from payload
  → Validate: must have name + organization + title
  → Create/update Dialpad contact (PUT /contacts with UID=RF{id})
  → Set debounce: sync:RF{id} = "true" (60s TTL)
  → Cache candidate (canonical record + all index keys)
```

**Validation rules**: Candidates without name (first+last or combined `name` field), organization, or title are silently skipped. These fields are required by Dialpad for useful contact records.

**ID mapping**: RF candidate ID `12345` → Dialpad UID `RF12345` → Full Dialpad contact ID `shared_contact_pool_Company:0000000000000000_uid_RF12345`.

---

## Data Flow: Dialpad → RF

**Trigger**: Dialpad fires JWT-signed webhook when a contact is updated. "Created" events are ignored (they're just echoes of RF→Dialpad sync).

```
Dialpad webhook (Updated only)
  → POST /webhook/dialpad
  → Verify JWT (HS256) from Authorization header or raw body
  → Extract RF candidate ID from Dialpad contact ID (regex: /uid_RF(\d+)$/)
  → Check debounce: if sync:RF{id} exists → skip (RF just synced this)
  → Convert Dialpad data to RF format (email, phone, LinkedIn only)
  → POST /candidate/update to RF
  → Set debounce: sync:RF{id} = "true" (60s TTL)
  → Update cache: merge Dialpad changes into cached record
    (cache miss → fetch fresh from RF API and cache)
```

**Sync scope**: Only email, phone, and LinkedIn URL flow from Dialpad → RF. Name, organization, title, and other fields are RF-managed.

---

## Data Flow: Calendar → RF + Dialpad

**Trigger**: Google Apps Script detects a Reclaim booking event on Google Calendar (via EventUpdated trigger, runs every invocation scanning next 14 days).

### Booking Types

The worker now handles two booking types:

1. **Dialpad meeting link** - event location contains `"meetings.dialpad.com/"`
   - Merges attendee email into candidate's email array
2. **Phone Call** - event location contains `"Phone Call"`
   - Merges attendee phone number into candidate's phone array
   - Merges attendee email into candidate's email array

### Apps Script Filtering (3-signal combo)

All three must be present for an event to be processed:
1. Description contains `"Looking forward to meeting!"` (custom Reclaim booking phrase)
2. Description contains `"Question: LinkedIn Profile"` (pre-meeting question)
3. Location contains either `"meetings.dialpad.com/"` (Dialpad meeting link) or `"Phone Call"`

Plus: exactly 1 non-owner guest (the candidate).

### Worker Processing

```
Apps Script → POST /webhook/calendar
  → Verify X-Calendar-Webhook-Token (fail closed)
  → Validate: attendee_email required

  → Find RF candidate (three-tier lookup):
      Tier 1: LinkedIn cache lookup (if valid LinkedIn URL)
      Tier 2: RF search API (fallback on cache miss, warms cache)
      Tier 3: Email cache lookup (if no candidateId yet)
      Tier 4: Name cache lookup (unambiguous matches only)

  → GET /candidate/get?id=X (fetch current data — RF update REPLACES, not appends)

  → For Dialpad meeting link bookings:
      - Check if email already exists on candidate → skip if yes
      - Merge new email into existing array (first email gets is_primary=1)

  → For Phone Call bookings:
      - Extract phone number from event
      - Check if phone already exists on candidate → skip if yes
      - Merge new phone into existing array
      - Merge new email into existing array

  → POST /candidate/update with merged data
  → Set debounce: sync:RF{id} = "true" (60s TTL)
  → Upsert Dialpad contact directly (don't wait for RF webhook — 6-7 hour delay)

  → Check if candidate is eligible for stage movement:
      - Current stage is Sourced, Replied, or Replied (Cold)
      - Find most-recently-moved job on candidate
      - If eligible job found → POST /api/external/candidate/move-to-stage (move to "Call Booked")

  → Update candidate cache with new email/phone data
```

**Stage Movement**: After successful email/phone merge and RF update, the worker calls `findEligibleJob()` (in `rf-client.js`) to check if the candidate can be moved to "Call Booked". The job must:
- Have current stage in: Sourced, Replied, or Replied (Cold)
- Be the most-recently-moved job on the candidate

If eligible, `moveToCallBooked()` calls `POST /api/external/candidate/move-to-stage` with the stage ID.

> **Stage-move helpers in `rf-client.js`** — there are two pairs:
> - `findEligibleJob` / `moveToCallBooked` — calendar-booking flow only. Hardcoded to "Call Booked" target and the most-recently-moved-job heuristic.
> - `findJobsForStageMove` / `moveJobsToStage` — generalised pair (parameterised by `currentStage`, `targetStage`, optional `addedByUserId`, optional `openOnly`). Used by the cold-call Sourced→Replied flow; reusable for future stage transitions without touching the calendar pair.

---

## Data Flow: Krisp → RF

**Trigger**: Krisp fires `summary_generated` webhook after a meeting ends and the AI summary is ready.

```
Krisp webhook (summary_generated)
  → POST /webhook/krisp
  → Verify X-Krisp-Webhook-Token (fail closed)
  → Check KV dedup: krisp:note:{hash} — skip if already processed (24-hour TTL)
  → Extract non-Joel email from meeting participants
  → Find RF candidate (two-tier lookup):
      Tier 1: Email cache lookup
      Tier 2: RF search API (by email)
  → Format meeting content as HTML note (summary, action items, key points, etc.)
  → POST /candidate/notes/add to RF
  → Set dedup flag: krisp:note:{hash} = "true" (24-hour TTL)
```

**Scope**: One-way, read-only integration. Krisp data flows to RF as candidate notes only. No data flows back to Krisp, no Dialpad sync triggered, no cache updates needed.

**Dedup**: Uses a hash of meeting ID + candidate email to generate the KV dedup key. The 24-hour TTL prevents reprocessing if Krisp retries the webhook.

---

## Data Flow: Dialpad Calls → RF (Cold Call Detection)

**Trigger**: Dialpad fires `call_transcription` or `transcription` (voicemail) webhook event after a call ends and the transcript is ready. Cold-call contacts are always pre-linked via the LinkedIn extension, so the call payload arrives with an RF candidate UID embedded in `contact.id`.

```
Dialpad call event (call_transcription or transcription state)
  → POST /webhook/dialpad/calls
  → Verify JWT (HS256, DIALPAD_WEBHOOK_SECRET)

  → Pre-LLM filters (cheap, fail-fast, exit before any KV / Dialpad / AI call):
      - target.id must be in DIALPAD_TO_RF_USER_ID (Joel 8000000000000001 → RF 900001,
        Alice 8000000000000002 → RF 900002)
      - direction must be "outbound"
      - contact.id must contain an RF UID (uid_RF regex, String() coerced)

  → Set KV dedup: coldcall:{call_id} = "true" (5-min TTL) BEFORE transcript fetch
  → Get transcript:
      - transcription state: transcription_text from payload (voicemails)
      - call_transcription state: GET /api/v2/transcripts/{call_id}
  → Truncate to 5,000 chars
  → Classify via CF Workers AI (Llama 3.3 70B fp8 fast)
  → If not cold call → log + done

  → Cold call detected:
      1. GET /candidate/get?id=X — required because RF /candidate/update REPLACES
         array fields (including tags), so we must read existing tags before
         writing the merged set back. Logs raw `existingTags` for shape verification.
      2. Build activity_text = "Cold call with {contactName} — {outcomeLabel}"
         For connected_positive: append "\n\nNext steps:\n{bullets}" (Llama 3.1 8B,
           1500-char transcript tail, ACTION_ITEMS_PROMPT).
         For connected_negative: append "\n\nNotes:\n{bullets}" (same model + tail,
           NEGATIVE_NOTES_PROMPT focused on the candidate's situation/intent —
           explicit "each bullet on its own line" directive).
      3. addHtmlLineBreaks(activity_text): "\n" → "<br>\n". RF activity_text only
         honours <br>; bare \n collapses to a space at render time.
      4. POST /custom-activity/create (activity_type_id=1002,
         activity_user_id = DIALPAD_TO_RF_USER_ID[target.id])
      5. POST /candidate/update with single combined body
         { source: "Cold Call", tags: [...existingTags, "Cold Called"] }
         (de-duped on "Cold Called", defensive against missing/non-array tags field)

  → For connected_positive OR connected_negative outcomes (NOT voicemail):
      6. moveJobsToStage(candidateId, candidate, {
            currentStage: 'Sourced',
            targetStage: 'Replied',
            userId: activityUserId,
            recruiterRfUserId: activityUserId,   // filter via cached consultant_id
         }, env)
         → findJobsForStageMove walks candidate.jobs, builds the eligible set
           (open + stage_name === 'Sourced' + has 'Replied' stage). For each
           eligible job it resolves the consultant_id via resolveJobConsultantId
           (KV `consultant:job{jobId}:cand{rfId}` first, RF GET on miss).
         → Returns the FIRST job whose consultant_id matches the recruiter.
         → Falls back to jobs[0] if eligible when no match — preserves legacy
           behavior for older job-candidate links that lack the custom field.
         → For the matched (or fallback) job, POST /candidate/move-to-stage with
           user_id = recruiter.
```

### Key design decisions

**LLM Classification**: No keyword matching. System prompt describes cold call characteristics conceptually — first contact, introducing yourself, unfamiliar tone, plus DEFINITE indicators ("headhunter", LinkedIn-message references). Model returns JSON with `is_cold_call` + outcome (`voicemail` / `connected_positive` / `connected_negative`) + reasoning. Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI binding. Workers AI may return the response as an already-parsed object or a JSON string — code handles both.

**Per-outcome enrichment**: connected_positive and connected_negative each get a separate cheap-model pass over the trailing 1500 chars of transcript. Positive uses ACTION_ITEMS_PROMPT (commitments, follow-up method, next steps); negative uses NEGATIVE_NOTES_PROMPT (general candidate context — situation, plans, timing, perspective). Bullet character is left to the model; the negative prompt additionally enforces "each bullet on its own line" so the `<br>` transform reliably breaks up the rendered output.

**Tag handling**: The "Cold Called" tag is written via the same `/candidate/update` call as `source`. `updateRFCandidate` uses spread (`{ id, ...updateData }`) so `tags` is only present when the caller passes it — other update paths (Dialpad→RF, calendar) leave existing tags untouched. The cold-call flow is the only writer of tags currently.

**Stage move attribution**: `addedByUserId` is the *filter* (only progress jobs the calling recruiter sourced), and `userId` is the *actor* (who RF records as performing the move). Both come from `DIALPAD_TO_RF_USER_ID[target.id]`, so each recruiter's stage moves attribute to their own RF user.

**Synchronous, fail-fast, no retries**: The whole cold-call write chain (activity → tag/source → stage move) runs synchronously. Any failure aborts and surfaces via CF Logs; we'd rather lose an event than risk silent partial state, duplicate activities, or wiped tags. Volume is low enough (~100 calls/day) that manual fix-ups are tractable.

**Dedup before AI**: The dedup flag is set immediately after the dedup check, before transcript fetch or AI classification. This prevents Dialpad retry storms from re-hitting Workers AI on failures. If a step fails after dedup is set, the call won't be retried until the 5-min TTL expires.

**Scope**: Currently Joel + Alice via `DIALPAD_TO_RF_USER_ID`. Adding a new recruiter = adding one entry to that map (plus subscribing them on the Dialpad webhook side).

**Numeric IDs**: Dialpad sends `target.id` and `contact.id` as numbers in call webhooks. `isMonitoredDialpadUser()`, `getRFUserIdForDialpadUser()`, and `extractRFIdFromDialpadContact()` all use `String()` coercion.

**Neuron budget**: ~35-40 neurons for classification + an additional ~5-10 for the cheap-model summary on connected calls. Dedup-before-AI ensures each call only hits AI once regardless of Dialpad retries.

---

## Data Flow: LinkedIn Extension → RF + Dialpad

**Trigger**: A custom Chrome extension overlaying LinkedIn Recruiter. Recruiters bulk-add candidates from a pipeline view, then walk through them one-by-one in LinkedIn opening the sidepanel for each profile to cold-call via Dialpad. Authed via `X-Extension-Token` header.

Every request body includes `consultantFirstName: string`, resolved through `src/users.js:resolveRFUserId` to an RF user ID for attribution.

### `POST /candidates` — batch upsert

```
Extension → POST /candidates (consultantFirstName, candidates[])
  → Verify X-Extension-Token (fail closed)
  → resolveRFUserId(consultantFirstName) → consultantRfUserId | null

  → For each candidate (chunks of 5, parallel):
      → searchRFCandidateByLinkedIn(linkedinUrl) — slug-filtered for true matches
      → Reconcile linkedin cache against RF (self-heals stale linkedin → rfId)

      If existing → processExistingRFCandidate (no lead_owner_id touched):
          → GET Dialpad contact
          → If missing: full Dialpad creation; if present: PATCH company/title only
          → Apollo phone reveal if no Dialpad phone + linkedin URL + no prior attempt

      If new:
          → mapExtensionToRFCandidate(ext, consultantRfUserId)
              — sets lead_owner_id from registry when consultantRfUserId is a number
          → POST /candidate/add (recover from 409 by re-routing to existing path)
          → Build slim candidate record from extension data (no GET round-trip needed —
            new candidates have no email/phone yet)
          → syncCandidateToDialpad → cacheCandidate
          → Apollo phone reveal (LinkedIn URL → enrichPerson, request reveal with
            run_waterfall_phone, write apollo_enrich:{rfId} flag, 15-min TTL)

  → listOpenJobs → response includes { total, created, updated, skipped, errors,
                                       results, jobs }
```

### `POST /candidates/add-to-job` — add to job + write consultant_id

```
Extension → POST /candidates/add-to-job (consultantFirstName, rfIds[], jobId)
  → Verify X-Extension-Token
  → resolveRFUserId(consultantFirstName) → consultantRfUserId | null

  → Per row (parallel):
      Step 1: addCandidateToJob(rfId, jobId, env)
          → 502 retry up to 3 attempts
          → Recognizes "already in pipeline" error → status: 'already_in_job'
          → Defensive null-guard: if loop exits without addResult, treat as error

      Step 2: only when status ∈ {'added', 'already_in_job'} AND consultantRfUserId !== null
          → setJobCandidateConsultantId(rfId, jobId, consultantRfUserId, env)
              POST /job-candidate/custom-field/value/update
              { candidate_id, job_id, custom_fields: [{ id: 16, value: rfUserId }] }
          → cacheConsultantForJobLink(rfId, jobId, rfUserId, env)
          → On failure: addResult.consultantWriteFailed = true (non-fatal)

      Append: appendToJobBatchIndex(jobId, rfId, env) — idempotent dedupe

  → Response: { jobId, added, alreadyInJob, errors, results }
```

Re-adds (status=`already_in_job`) DO write consultant_id and DO append to the batch index. This is intentional: the extension is the only path hitting this route, recruiters only re-add candidates they're now driving themselves, and re-adding is the user-facing way to refresh the cache + reattribute attribution for older job-candidate links.

### `POST /candidate-details` — sidepanel data

```
Extension → POST /candidate-details (consultantFirstName, profileUrl)
  → Verify X-Extension-Token
  → Resolve rfId:
      → lookupByLinkedIn (KV linkedin:{slug}) — fast path
      → searchRFCandidateByLinkedIn fallback (caches the result on hit)
      → 404 if neither yields a match

  → Try cache first (parallel):
      → getCachedCandidateDetails(rfId) (KV details:{rfId}, 20-min TTL)
      → getCachedCandidateActivities(rfId) (KV activities:{rfId}, 20-min TTL)

  → Cache MISS branches:
      → Parallel-fetch only the missing pieces:
          getRFCandidate(rfId) and/or listCandidateActivities(rfId)
      → Cache the freshly-fetched pieces

  → pickConsultantJob(candidate, consultantRfUserId, env):
      → Filter to open jobs, sort by stage_moved desc
      → For each, resolveJobConsultantId (KV → RF fallback, per-job try/catch)
      → Return first match against consultantRfUserId, else jobs[0] if open

  → normalizeToE164(first phone_number entry) → E.164 string or null

  → activities.filter(type.id === 1002).map(parseColdCallActivity).sort(asc time)

  → Fire-and-forget: ctx.waitUntil(handleNeighborPrewarm(rfId, jobId, recruiterRfId, env))

  → Response: { rfId, fullName, phoneNumber, job, activities }
```

### `POST /candidate-mark-invalid` — tag-only invalidation

```
Extension → POST /candidate-mark-invalid (consultantFirstName, rfId)
  → Verify X-Extension-Token
  → 400 if rfId missing
  → getRFCandidate(rfId) — read existing tags
  → If tags already includes "Number Invalid" → { ok: true } (no RF write)
  → Else: mergeTag(existingTags, "Number Invalid") → updateRFCandidate(rfId, { tags: merged })
  → invalidateCandidateDetailsCache(rfId) — drops details:{rfId} + activities:{rfId}
  → Response: { ok: true }
```

Phone is left in place. No custom activity is written. consultantFirstName is logged for traceability but doesn't drive any attribution write (RF tag updates don't carry per-action attribution).

### `POST /dialpad-user-context` — caller-ID picker data

```
Extension → POST /dialpad-user-context (consultantFirstName)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(name)
  → 403 ok=false if not in the registry
  → GET https://dialpad.com/api/v2/users/{user.dialpadId}/caller_id
  → 502 ok=false if Dialpad fetch fails (upstream details in CF Logs only)
  → buildCallerIdsFromDialpad(response, signCallerIdAlias):
      - Walk: phone_numbers ("My number"), groups[] (display_name)
      - office_main_line is intentionally skipped — never used in practice
      - De-dupe by E.164 (first occurrence wins for label)
      - Skip empty / non-E.164 entries silently
      - Mark isDefault=true on the entry whose number === response.caller_id
      - Country: +44 → UK, +1 → US, anything else → OTHER
      - Replace each E.164 with an opaque alias via signCallerIdAlias()
  → Response: { callerIds: [{ aliasId, country, label, isDefault? }] }
```

The response body never contains a raw phone number. The extension caches the response locally (TTL ~1h, keyed by consultant) and uses the aliases verbatim on `/dialpad-call`.

### `POST /dialpad-call` — initiate a call

```
Extension → POST /dialpad-call (consultantFirstName, phoneNumber, callerAliasId)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(name)
  → 403 ok=false if not in the registry
  → 400 ok=false if phoneNumber missing or non-E.164
  → 400 ok=false if callerAliasId missing
  → verifyCallerIdAlias(callerAliasId) → outboundCallerId (E.164)
  → 400 ok=false ("Invalid caller-ID selection — please refresh and try again") if alias is tampered/expired/unknown
  → checkAndRecordCall({ dialpadUserId: user.dialpadId, phoneNumber }) — rolling-window gate
       - Reads ratelimit:call:{dialpadUserId} (JSON [{t,phone}]) from SYNC_STATE
       - Drops entries older than 60s
       - If any entry within last 3s has same phoneNumber → 429 reason=duplicate
       - Else if recent count >= 5 → 429 reason=rate_limit
       - Else: append {t: now, phone}, write back (TTL 120s), allow
  → 429 ok=false (reason: "rate_limit" | "duplicate", retryAfterSec, Retry-After header) if blocked

  → clearExtensionCallState(user.dialpadId)   ← one-in-one-out: every fresh
                                                 call wipes any prior watch +
                                                 active state for this user
  → setExtensionCallWatch(user.dialpadId, phoneNumber)   ← MUST happen BEFORE
                                                 initiateCall — Dialpad's
                                                 'calling' webhook can land in
                                                 milliseconds and the extension-
                                                 calls handler matches against
                                                 this watch entry

  → POST https://dialpad.com/api/v2/users/{user.dialpadId}/initiate_call
       body: { phone_number, outbound_caller_id }   (NO device_id — Dialpad auto-rings)
  → On 502: clearExtensionCallWatch(user.dialpadId) (no calling event will fire)
  → 502 ok=false ("Dialpad rejected the call: <upstream message>") if non-2xx
  → Response: { ok: true }   ← callId is NOT returned anymore; worker holds it
```

The rate-limit + dedup is intentionally per-Dialpad-user (i.e. per recruiter), not per-candidate or per-call-id, because Dialpad's own 5/min cap is per outbound user. Mirroring it locally turns "Dialpad silently rejected this" into a clean 429 with a `retryAfterSec` the extension can render directly. Denied attempts deliberately don't consume budget — only allowed calls write back to KV. The read-decide-write isn't transactional; in the worst case two near-simultaneous edge requests both pass through, which Dialpad would reject anyway.

The `extcall:watch` write happens AFTER rate-limit but BEFORE invoking Dialpad. This ordering is critical: if we wrote the watch after `initiateCall` returned, Dialpad's `calling` event could land while the watch slot was still empty and the handler would have nothing to match against, leaving the extension stuck in `calling` state until its 15s client-side timeout.

### `POST /dialpad-sms` — send an SMS

```
Extension → POST /dialpad-sms (consultantFirstName, phoneNumber, callerAliasId?, text)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(name)
  → 403 ok=false if not in the registry
  → 400 ok=false if phoneNumber missing or non-E.164
  → 400 ok=false if text.trim() empty
  → IF callerAliasId provided: verifyCallerIdAlias → from_number (E.164)
       400 ok=false ("Invalid caller-ID selection — please refresh and try again") if invalid/expired
       (callerAliasId omitted → Dialpad uses the user's default sender)
  → POST https://dialpad.com/api/v2/sms
       body: { user_id, to_numbers: [phoneNumber], from_number?, text, infer_country_code: false }
  → 502 ok=false ("Dialpad rejected the message: <upstream message>") if non-2xx
  → Response: { ok: true, messageId? }
```

Design notes:
- **Text forwarded verbatim.** Recruiters write `{{firstName}}`-templated copy and the extension does the substitution client-side. Whitespace + newlines are typed deliberately for readability — the worker never trims, re-flows, or normalises. Empty messages (after trim) are still rejected so we don't ship a blank SMS.
- **No rate-limit gate yet.** The SMS handoff explicitly says "ships test-call-only initially — one consultant, one number at a time. When production candidate-mode lights up, revisit." When that day comes, `src/rate-limit.js` is reusable: lift the pure decision function to take a configurable window/limit and add an `ratelimit:sms:{dialpadUserId}` key.
- **No retries.** If Dialpad rejects, the extension's popover keeps the textarea contents and re-enables the Yes button so the recruiter retries manually. Auto-retry would risk double-sending — much harder to reason about than human-in-the-loop retry.
- **PII-aware logging.** We log `textLength` but never the message body itself — once `{{firstName}}` is substituted client-side, the rendered text is candidate-identifying.

Dialpad's `initiate_call` endpoint deliberately does not take a `device_id` — Dialpad auto-rings every eligible autocallable device the consultant has registered (Electron desktop app, web, CRM embeds), and the recruiter just picks up wherever rings. This is why `/dialpad-user-context` only returns caller IDs, not devices.

### `POST /dialpad-hangup` — terminate the consultant's active call

```
Extension → POST /dialpad-hangup (consultantFirstName)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(name)
  → 403 ok=false if not in the registry
  → getActiveExtensionCall(user.dialpadId) → { callId } or null
  → 409 ok=false ("No active call") if no active entry
  → PUT https://dialpad.com/api/v2/call/{callId}/actions/hangup   (no body)
  → clearExtensionCallState(user.dialpadId)   ← clears regardless of upstream
                                                 outcome (per the one-in-one-
                                                 out invariant)
  → 502 ok=false ("Dialpad rejected the hangup: <upstream message>") if non-2xx
  → Response: { ok: true }
```

The extension never sees the Dialpad `call_id` — the worker holds it in `extcall:active` from the moment the matching `calling` webhook lands. The hangup body is just `{ consultantFirstName }`, the worker reads the call_id server-side.

The KV clear runs **after** the Dialpad call but **regardless of its outcome**. Reasons:
- Dialpad rejection is most often "call already terminated" — state is reset upstream too, so clearing locally is correct.
- A stuck "active" entry would prevent the user from making a new call until its 30min TTL expired.
- Spam-clicking the Hangup button is safe: the second click 409s ("No active call") instead of double-firing.

If the user hangs up via the Dialpad app instead of the extension, the `hangup` webhook event handles state cleanup (see below). Either path leaves the system consistent.

### `POST /webhook/dialpad/extension-calls` — call-state webhook handler

A separate Dialpad webhook subscription, scoped at the company level with category `"all"` (Dialpad doesn't support per-state filtering). We filter to `calling` and `hangup` server-side. Same JWT auth as `/webhook/dialpad/calls` (shared `DIALPAD_WEBHOOK_SECRET`).

```
Dialpad event (any state) → POST /webhook/dialpad/extension-calls
  → JWT verify (HS256, DIALPAD_WEBHOOK_SECRET)
  → processExtensionCallEvent(payload, env, ctx):
       targetId = payload.target.id
       getUserByDialpadId(targetId) → skip if not in registry
       (Dialpad's company-wide subscription delivers every user's events;
        this filter is what limits action to monitored users.)

       IF state === 'calling':
         direction !== 'outbound' → ignore
         watch = getExtensionCallWatch(dialpadUserId)
         no watch → ignore (untracked outbound call)
         external_number !== watch.phone → ignore (different destination)
         setActiveExtensionCall(dialpadUserId, call_id, external_number)
         clearExtensionCallWatch(dialpadUserId)
         notifyExtensionCallState({ state: 'active', phoneNumber })
           → EXT_CALL_CHANNEL.getByName(dialpadUserId).pushState(...)

       IF state === 'hangup':
         active = getActiveExtensionCall(dialpadUserId)
         no active → ignore (hangup for a call we weren't tracking)
         active.callId !== call_id → ignore (different call)
         clearActiveExtensionCall(dialpadUserId)
         notifyExtensionCallState({ state: 'ended', phoneNumber })

       all other states → ignored (we only care about calling + hangup)

  → 200 (always, even on ignored events — Dialpad just needs the ack)
```

The hangup branch handles BOTH user-driven hangups (extension → `/dialpad-hangup` → Dialpad PUT) AND "hung up elsewhere" cases (consultant uses the Dialpad app directly). The first case will hit this handler with `active` already cleared by `/dialpad-hangup` — the `no active → ignore` branch fires, and that's correct (the extension already updated its UI on the 200 response). The second case is the only path that emits a `state: ended` SSE event to flip the button back.

Out-of-order events: Dialpad explicitly warns events may arrive out of order. The `event_timestamp` field is available on every payload; we don't currently sort because the watch/active state machine is naturally idempotent — a stale `calling` event finds no matching watch and is ignored.

### `GET /extension-call-stream` — Server-Sent Events stream

```
Extension → GET /extension-call-stream?consultantFirstName=Joel
  → 400 if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(name)
  → 403 if not in the registry
  → 500 if EXT_CALL_CHANNEL binding missing (deploy issue)
  → stub = EXT_CALL_CHANNEL.getByName(user.dialpadId)
  → DO request: GET https://do/subscribe?userId={dialpadUserId}
       (request.signal forwarded so client disconnects propagate to the DO)
  → ExtensionCallStateChannel.fetch():
       create TransformStream, get writer
       send `event: hello\ndata: {"ok":true}\n\n`
       _readCurrentState(dialpadUserId):
         active KV → { state: 'active', phoneNumber: active.phone }
         else watch KV → { state: 'calling', phoneNumber: watch.phone }
         else { state: 'idle' }
       send `event: state\ndata: <initial state>\n\n` (replay)
       writers.add(writer)
       request.signal.addEventListener('abort', remove + close)
       schedule alarm (25s) if not already scheduled
       return Response(readable, { 'content-type': 'text/event-stream', ... })
  → Worker merges CORS headers onto DO response, returns to extension
```

**Auth**: Currently unauthenticated. `EventSource` (the browser primitive the extension uses) cannot send custom request headers, and putting `LINKEDIN_EXTENSION_SECRET` in the URL would just leak it into CF Logs. The shared secret isn't a real security boundary anyway (it's bundled into the extension binary). Will gate behind the OTP + session-token auth flow when that lands. The route handler has an explanatory comment so future-me/agents know this isn't an oversight. — see `2026-05-01-dialpad-call-state-handoff.md`.

**Push path**:
```
notifyExtensionCallState (called from processExtensionCallEvent):
  stub = EXT_CALL_CHANNEL.getByName(dialpadUserId)
  stub.pushState({ state, phoneNumber })   ← RPC, NOT fetch — typed call
  → DO iterates writers Set
       for each: write `event: state\ndata: <event>\n\n`
       collect dead writers (write threw); drop from Set
  → returns { delivered: writers.size } for logging
```

The pushed payload deliberately omits `callId`. The extension never holds the Dialpad call_id; the worker's `extcall:active` entry holds it for use on `/dialpad-hangup`.

**Heartbeat** (DO `alarm()`):
- Fires every 25s while writers exist
- Broadcasts `: keepalive\n\n` (SSE comment line — `EventSource` silently swallows these)
- Reschedules itself if writers remain
- Cancels itself naturally when last writer disconnects (no writers → alarm body returns early without rescheduling)

**Reconnect**: handled entirely by `EventSource` natively (browser-managed backoff, no custom client code needed). On every reconnect the DO replays current state from KV in its `_readCurrentState` step, so missed transitions during a disconnect are silently corrected — no polling endpoint exists or is needed.

**Multi-tab**: every tab the consultant has open subscribes to the same DO instance (`getByName(dialpadUserId)` is deterministic). The DO holds one writer per open stream and broadcasts every state event to all of them. Cross-tab coordination is automatic.

**State machine summary (extension-side)**:
```
        (sidepanel mounts)         (button clicked)
   ╔═════════╗  ──────────►  ╔═══════════╗  ──────►  ╔═══════════╗
   ║  idle   ║  ◄──────────  ║  calling  ║          ║  active   ║
   ╚═════════╝              ╚═══════════╝            ╚═══════════╝
        ▲                          ▲                       │
        │                          │                       │
        │ SSE                      │ SSE state=calling     │ button → /dialpad-hangup
        │ state=ended              │ (mid-call replay)     │ OR Dialpad app hangup
        │                          │                       │ OR SSE state=ended
        │                          │                       ▼
        └─────────────────────────────────────────► ╔═══════════╗
                                                    ║   ended   ║
                                                    ╚═══════════╝
```

### Caller-ID alias signing

`src/dialpad-aliases.js` mints HS256 JWTs to swap raw E.164 numbers for opaque tokens before they leave the worker:

- **Signing key**: `LINKEDIN_EXTENSION_SECRET` (the same secret the extension already uses for `X-Extension-Token` auth — no new secret to provision).
- **Audience**: `dialpad-caller-id`. Domain-separates these from anything else signed with the same secret. A token minted for caller-ID lookup can never be replayed against another JWT-using path.
- **Expiry**: 7 days. Caller-ID lists rarely change in practice and the extension's local 1h cache typically expires long before the alias does — picking a longer TTL avoids any race where the cached alias outlives its server-side validity.
- **Payload**: `{ n: "+1...", iat, exp, aud }`.
- **Verification failures** (tampered, expired, wrong audience, malformed, missing) all return `null` — never throw. The route handler turns `null` into a 400 with a stable user-facing message.

Tradeoff: the JWT format means a determined extension user could base64-decode the body to read the underlying number. That number is one of their own consultant's caller IDs, fetched seconds earlier from Dialpad — there's no real secret to leak. The crucial property is tamper-resistance: the extension can't forge an alias for an arbitrary number and trick the worker into dialling out from it. HMAC handles that.

### Extension Caching Strategy

The bulk-add → cold-call session pattern (50-200 candidates added at once, walked through one-by-one over 1-3 days) is the primary perf target. Two cooperating layers:

**1. Snapshot caches** (`details:{rfId}`, `activities:{rfId}`, both 20-min TTL):
- First `/candidate-details` for a candidate is a RF round-trip + KV write
- Subsequent reads within 20 min are KV-only (~30-50ms total)
- `/candidate-mark-invalid` invalidates so tag changes show up immediately

**2. Neighbor prewarm via per-job batch index**:
- `/candidates/add-to-job` appends successful rows (added OR already_in_job, deduped) to `batch:job{jobId}` — an ordered JSON array of rfIds in add-order, 30-day TTL
- On `/candidate-details`, after picking the job, fire `ctx.waitUntil(handleNeighborPrewarm(rfId, jobId, recruiterRfUserId, env))`:
  - Find the candidate's index in the batch list. Skip if not in any batch index.
  - Read `prewarm:rec{rfUserId}:job{jobId}` for last prewarm position (1-hour TTL).
  - **First call** (no state): prewarm 30 candidates either side (clipped to list bounds), set `lastPrewarmIdx = currentIdx`.
  - **Subsequent calls**: if `|currentIdx - lastPrewarmIdx| >= 20`, prewarm the next 30 in the direction of motion. Update state.
  - Otherwise: no-op.
- Prewarm uses `prewarmCandidatesIfMissing(rfIds, env)` which only fetches RF for pieces not already cached.

This pattern means:
- Recruiter walks through profiles 1, 2, 3, ... in a job
- Profile #1: ~600ms (RF GET + activity-list + cache writes + prewarms #2-30)
- Profiles #2-30: ~30-50ms each (KV-only)
- At profile #21: directional prewarm fetches #31-60 in background
- Profile #31: still ~30-50ms (already prewarmed)

`getRFCandidate` retries once on 502 — RF's edge produces transient 502s and a single retry is far cheaper than failing the whole sidepanel response.

All four extension routes return `{ "error": "Internal Server Error" }` on 500 (server-side `console.error` still carries `error.message` + stack — full debug context stays in CF Logs, generic body keeps RF internals from leaking to clients).

Cache hit/miss is logged at multiple layers — filter `source:prewarm`, `source:consultant-cache`, or look for `cacheHit:` fields to verify behavior in CF Observability.

---

## Loop Prevention

Both RF→Dialpad and Dialpad→RF sync directions write a KV debounce flag (`sync:RF{id}`, 60-second TTL) after a successful sync. The opposite direction checks for this flag before proceeding. This prevents infinite loops:

```
RF webhook fires → sync to Dialpad → set sync:RF{id}
  → Dialpad fires webhook (echo) → check sync:RF{id} → exists → skip
  → 60s later → flag expires → normal Dialpad updates proceed
```

The calendar handler also sets this flag after updating RF, preventing the subsequent RF webhook from re-syncing to Dialpad (the calendar handler already upserted Dialpad directly).

---

## KV Candidate Cache

### Purpose

A general-purpose cache that stores candidate records and provides O(1) lookups by LinkedIn URL, email address, or name. Designed so any integration without an RF candidate ID (calendar events, Krisp webhooks, etc.) can quickly find the RF ID.

### Key Structure

| Key Pattern | Value | TTL |
|-------------|-------|-----|
| `candidate:{rfId}` | Slim JSON: `{id, first_name, last_name, email, emails[], linkedin_profile, current_organization, current_title, phone_number, cached_at}` | 60 days |
| `linkedin:{normalized_url}` | RF candidate ID string | 60 days |
| `email:{lowercase_address}` | RF candidate ID string (one key per email in array) | 60 days |
| `name:{first_lower}:{last_lower}` | RF candidate ID string, or `"AMBIGUOUS"` | 60 days |
| `sync:RF{id}` | `"true"` (debounce flag) | 60 seconds |
| `krisp:note:{hash}` | `"true"` (dedup flag) | 24 hours |
| `coldcall:{call_id}` | `"true"` (dedup flag, set before AI classification) | 5 minutes |
| `apollo_enrich:{rfId}` | JSON enrichment context (`apolloPersonId` or `noMatch:true`) | 15 minutes |
| `consultant:job{jobId}:cand{rfId}` | RF user_id string or `"none"` sentinel | 30 days |
| `details:{rfId}` | Full RF `/candidate/get` response (extension fast path) | 20 minutes |
| `activities:{rfId}` | Full `/candidate/activity/list` data array | 20 minutes |
| `batch:job{jobId}` | JSON array of rfId strings in extension-add order | 30 days |
| `prewarm:rec{rfUserId}:job{jobId}` | `{ lastPrewarmIdx }` per-recruiter+job state | 1 hour |
| `ratelimit:call:{dialpadUserId}` | JSON `[{t: ms-epoch, phone: E164}]` rolling-window state for `/dialpad-call` rate-limit + dedup | 120 sec |
| `extcall:watch:{dialpadUserId}` | JSON `{ phone, initiatedAt }` — armed by `/dialpad-call`, matched by Dialpad's `calling` webhook to identify which call belongs to which extension click | 90 sec |
| `extcall:active:{dialpadUserId}` | JSON `{ callId, phone, startedAt }` — holds the live Dialpad call_id once the watch matches. Read by `/dialpad-hangup` and by the SSE DO's initial-state replay | 30 min |

### Cache Freshness

All webhook flows keep the cache up to date (Krisp is the exception — it only reads the cache for lookups, does not write):

| Webhook | When cache is written |
|---------|----------------------|
| RF (Created/Updated) | After Dialpad sync — caches full candidate data from RF payload |
| Dialpad (Updated) | After RF update — merges email/phone/LinkedIn changes into cached record. Cache miss → fetches fresh from RF API. Also checks pending cold calls by phone |
| Calendar | After RF search API hit (warms cache). After successful email merge (updates cached emails) |
| Dialpad Calls | Writes `coldcall:{call_id}` dedup. Reads candidate via `getRFCandidate` for tag merge and Sourced→Replied stage move (cache itself is not written by this flow) |

### Name Ambiguity

The name index uses an `"AMBIGUOUS"` sentinel to prevent wrong-candidate matches:

1. First candidate with name "John Smith" → `name:john:smith` = `"12345"`
2. Second different candidate "John Smith" → `name:john:smith` = `"AMBIGUOUS"`
3. Lookups against `"AMBIGUOUS"` return null — the name match is too risky
4. Same candidate re-cached → no change (rfId matches, skip)
5. Ambiguity persists until TTL expires (60 days)

### LinkedIn URL Normalization

URLs are normalized before cache key generation: strip protocol (`https?://`), strip `www.`, strip query params/fragments, strip trailing slashes, lowercase. Both `/in/` and `/pub/` LinkedIn URL formats are supported.

Example: `https://www.LinkedIn.com/in/John-Smith/?utm_source=share` → `linkedin.com/in/john-smith`

---

## Environment

### Secrets (set via `wrangler secret put`)

| Secret | Used by |
|--------|---------|
| `DIALPAD_API_KEY` | Dialpad API (Bearer token auth) |
| `RF_API_KEY` | RF API (`RF-Api-Key` header) |
| `DIALPAD_WEBHOOK_SECRET` | JWT verification for Dialpad webhooks |
| `RF_WEBHOOK_SECRET` | Shared secret verification for RF webhooks |
| `CALENDAR_WEBHOOK_SECRET` | Shared secret verification for calendar webhooks |
| `KRISP_WEBHOOK_SECRET` | Shared secret verification for Krisp webhooks |
| `APOLLO_API_KEY` | Apollo API (Bearer auth) |
| `APOLLO_WEBHOOK_SECRET` | Token query param verification for Apollo phone webhooks |
| `LINKEDIN_EXTENSION_SECRET` | Shared secret for `X-Extension-Token` on extension routes; also used as the HMAC key for opaque caller-ID aliases on `/dialpad-user-context` and `/dialpad-call` (domain-separated by JWT audience) |

### Test bindings (in `vitest.config.js`, never deployed)

`vitest.config.js`'s `poolOptions.workers.miniflare.bindings` provides non-secret stand-ins for `LINKEDIN_EXTENSION_SECRET`, `RF_API_KEY`, and `DIALPAD_API_KEY` so e2e tests can hit the worker without real credentials. `wrangler.jsonc` is intentionally clean of these values to avoid overwriting Cloudflare-managed production secrets on deploy.

### Vars (in `wrangler.jsonc`)

| Var | Default |
|-----|---------|
| `DIALPAD_API_BASE_URL` | `https://dialpad.com/api/v2` |
| `RF_API_BASE_URL` | `https://api.recruiterflow.com/api/external` |

### KV Namespace

`SYNC_STATE` — single namespace for both debounce flags and candidate cache.

- Production ID: `REDACTED_KV_NAMESPACE_ID`
- Preview ID: `REDACTED_KV_PREVIEW_NAMESPACE_ID`

### Durable Object

`EXT_CALL_CHANNEL` → class `ExtensionCallStateChannel` (defined in `src/extension-call-do.js`, re-exported from `src/index.js` so wrangler picks it up). Migration tag `v1` declares the class via `new_sqlite_classes` (no persistent storage actually used — declaration is required for any new DO class).

- One DO instance per Dialpad user, named deterministically via `getByName(dialpadUserId)`.
- Holds an in-memory `Set<WritableStreamDefaultWriter<Uint8Array>>` of subscribed SSE writers.
- `fetch()` is the SSE subscribe entry point — returns a streaming `Response` with `Content-Type: text/event-stream`. The worker's `/extension-call-stream` route forwards to this via `stub.fetch(request)` and proxies the response back with CORS headers merged in.
- `pushState(event)` is the RPC method `notifyExtensionCallState` calls to broadcast a state change to every writer.
- `alarm()` fires every 25s while writers exist, sending `: keepalive\n\n` (SSE comment lines — `EventSource` silently swallows them) and detecting dead writers via the broadcast write returning rejected.
- Effectively free for our scale — at most ~2 active instances (one per consultant on registry), billed only while writers are connected. DO is evicted naturally when the last writer disconnects.

---

## External API Patterns

### RF API

- **Auth**: `RF-Api-Key` header
- **Search**: `POST /candidate/search` with `filters[]`, `conjunction: "match-all"`, `current_page: 1`, `items_per_page: N`
- **Get**: `GET /candidate/get?id=X`
- **Update**: `POST /candidate/update` with `{id, ...fields}` — **REPLACES arrays, does not append**. Always GET first to merge.
- **Add note**: `POST /candidate/notes/add` with `{candidate_id, notes}` — used by Krisp integration to attach meeting notes as HTML.
- **Webhook delay**: RF webhooks can take ~2 hours to fire after a candidate edit. Delivery is fast once they fire.

### Dialpad API

- **Auth**: `Authorization: Bearer {DIALPAD_API_KEY}`
- **Upsert contact**: `PUT /contacts` with UID-based idempotency
- **UID format**: `RF{candidateId}` → Dialpad generates full ID `shared_contact_pool_Company:{companyId}_uid_RF{candidateId}`
- **Webhook auth**: JWT (HS256) in Authorization header or raw body
- **User caller-IDs**: `GET /users/{userId}/caller_id` → flat shape `{ caller_id, phone_numbers, office_main_line, groups[], ... }` (NOT wrapped in `caller_id_proto` despite some old docs samples)
- **Initiate call**: `POST /users/{userId}/initiate_call` with `{ phone_number, outbound_caller_id }`. We deliberately omit `device_id` — Dialpad auto-rings every eligible autocallable device the user has registered, which is exactly what we want
- **Send SMS**: `POST /sms` with `{ user_id, to_numbers (array, ≤10), text, ... }`. Rate-limited 100/min (Tier 0) or 800/min (Tier 1). `from_number` overrides the user's default sending number when provided

---

## Deployment

- **Auto-deploy**: Push to `master` triggers deployment via GitHub integration
- **Manual**: `npm run deploy` (runs `wrangler deploy`)
- **Worker name**: `rf-dialpad-sync-dev` (the `-dev` suffix is intentional — it's the live production URL)
