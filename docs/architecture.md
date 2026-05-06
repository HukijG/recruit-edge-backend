# Architecture & Data Flow

> **Status note (2026-05-05):** Call-state architecture has settled on **webhook-driven Durable Object** storage. Per-user `ExtCallState` DO holds the active Dialpad `call_id` with strong consistency. The Dialpad `calling`+`hangup` webhook (`/webhook/dialpad/extension-calls`) is the only writer; `/dialpad-call`, `/dialpad-hangup`, and `/extension-call-status` are read-only. The detailed call-state code-flow section below is current.

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
│  /webhook/recruiterflow  /webhook/dialpad  /webhook/dialpad/calls                                          │
│  /webhook/dialpad/extension-calls  /webhook/calendar  /webhook/krisp  /webhook/apollo                      │
│  /candidates  /candidates/add-to-job  /candidate-details  /candidate-mark-invalid                           │
│  /dialpad-user-context  /dialpad-call  /dialpad-sms  /dialpad-hangup  /extension-call-status               │
│  /my-sourcing-jobs  /job-pipeline                                                                            │
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
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘       │
│                                                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────────────────┐       │
│  │                    Durable Objects: EXT_CALL_STATE                                                 │       │
│  │  ExtCallState (per-user, idFromName(dialpadUserId))                                                │       │
│  │    storage.callId  → active Dialpad call_id     (20-min self-clearing alarm)                      │       │
│  │  Strong consistency — every poll reads the latest webhook write regardless of origin PoP.         │       │
│  └──────────────────────────────────────────────────────────────────────────────────────────────────┘       │
│                                                                                                              │
│  Migration history: v1 created `ExtensionCallStateChannel`; v2 deleted it; v3 added `ExtCallState`.         │
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
| `src/dialpad-aliases.js` | Opaque caller-ID alias signing/verifying for the calling endpoints (HS256 JWT via `jose`, audience `dialpad-caller-id`, 7-day TTL). Keeps raw E.164 numbers off the wire to the extension |
| `src/rate-limit.js` | Rolling-window rate-limit + cheap dedup gate for `/dialpad-call`. Pure `decideCallRateLimit({timestamps, now, phoneNumber})` returns `{allowed, reason?, retryAfterSec?, nextTimestamps?}`. KV-backed `checkAndRecordCall` reads SYNC_STATE, decides, persists on allow. 5 calls/60s rolling per Dialpad user_id, plus a 3s per-(user,phone) dedup window for double-clicks |
| `src/krisp.js` | Krisp helpers: note formatting (HTML), candidate email extraction from meeting participants |
| `src/cold-call.js` | Cold call detection: monitored-user filter (registry-driven), Dialpad transcript fetch, Workers AI classification (Llama 3.3 70B), per-outcome summary extraction (Llama 3.1 8B), RF custom activity + tag/source update + Sourced→Replied stage move, generic `mergeTag(tags, value)` helper, `parseColdCallActivity` for the extension shape |
| `src/extension-calls.js` | Extension Call/Hangup webhook dispatcher. `processExtensionCallEvent`: filters Dialpad webhook payloads (outbound + monitored target), routes `calling`/`hangup` events to the per-user `ExtCallState` DO (set / clear-if-match). Drops everything else with a structured-log reason |
| `src/extension-call-do.js` | `ExtCallState` Durable Object class. Per-user store (one instance per Dialpad user, `idFromName(dialpadUserId)`) for the active Dialpad `call_id`. RPC: `setCallId`, `getCallId`, `clearCallIdIfMatch`. 20-min self-clearing alarm on `setCallId`. Replaces the previous KV-backed `extcall:callid:*` design — KV's cross-PoP eventual consistency caused visible lag between calling-webhook write and polling read |
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
| `/webhook/apollo` | POST | `?token=` query param (`APOLLO_WEBHOOK_SECRET`) | Async phone reveal delivery from Apollo |
| `/candidates` | POST | `X-Extension-Token` header | LinkedIn extension batch upsert (sets `lead_owner_id`) |
| `/candidates/add-to-job` | POST | `X-Extension-Token` header | Add candidates to a job + write `consultant_id` custom field |
| `/candidate-details` | POST | `X-Extension-Token` header | Sidepanel data: rfId, phone (E.164), picked job, cold-call activities |
| `/candidate-mark-invalid` | POST | `X-Extension-Token` header | Tag candidate `"Number Invalid"` (idempotent) |
| `/dialpad-user-context` | POST | `X-Extension-Token` header | Caller-ID picker data: `{ callerIds: [{ aliasId, country, label?, isDefault? }] }` (opaque aliases, no raw E.164) |
| `/dialpad-call` | POST | `X-Extension-Token` header | Initiate call via Dialpad `initiate_call`. Decodes `callerAliasId`; Dialpad auto-rings eligible devices. Worker doesn't write call-state — the Dialpad `calling` webhook does. Response is `{ ok: true }` only (no `callId` — extension never sees it) |
| `/dialpad-sms` | POST | `X-Extension-Token` header | Send a single SMS via Dialpad `/sms`. Decodes `callerAliasId` (optional → Dialpad default sender); text is forwarded verbatim |
| `/dialpad-hangup` | POST | `X-Extension-Token` header | Terminate whatever call is currently stored. Body is just `{ consultantFirstName }`; worker reads `call_id` from the user's `ExtCallState` DO. Worker doesn't clear the DO — the `hangup` webhook does. 409 if no call_id is set |
| `/extension-call-status` | POST | `X-Extension-Token` header | Polled ~every 500ms by extension after a `/dialpad-call`. Reads from the user's `ExtCallState` DO (strongly consistent). Returns `{ state: "in_progress" \| "ended" }`. Never calls Dialpad |
| `/webhook/dialpad/extension-calls` | POST | JWT Bearer (HS256) | Dialpad call-state webhook driving the extension button. `calling` event → `DO.setCallId(payload.call_id)`. `hangup` event → `DO.clearCallIdIfMatch(payload.call_id)`. Subscription must be configured for both `calling` and `hangup` states |
| `/my-sourcing-jobs` | POST | `X-Extension-Token` header | Mobile PWA home screen. Returns open jobs filtered to: consultant on `hiring_team` as Recruiter AND `job_status.name === "Sourcing"` |
| `/job-pipeline` | POST | `X-Extension-Token` header | Mobile PWA pipeline view. Returns Sourced-stage candidates for a job ordered by `added_time` ASC, as `{ rfId, linkedinUrl }` pairs |

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

**Scope**: Currently Joel + Alice + Bob + Carol + Dave + Erin via `DIALPAD_TO_RF_USER_ID`. The Dialpad webhook subscription is configured org-wide (no `target_id` filter), so adding a new recruiter is just a `src/users.js` edit — there is no Dialpad-side per-user subscription step.

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

  → POST https://dialpad.com/api/v2/users/{user.dialpadId}/initiate_call
       body: { phone_number, outbound_caller_id }   (NO device_id — Dialpad auto-rings)
  → 502 ok=false ("Dialpad rejected the call: <upstream message>") if non-2xx
  → Response: { ok: true }   ← worker holds the call_id; extension never sees it
```

The rate-limit + dedup is intentionally per-Dialpad-user (i.e. per recruiter), not per-candidate or per-call-id, because Dialpad's own 5/min cap is per outbound user. Mirroring it locally turns "Dialpad silently rejected this" into a clean 429 with a `retryAfterSec` the extension can render directly. Denied attempts deliberately don't consume budget — only allowed calls write back to KV. The read-decide-write isn't transactional; in the worst case two near-simultaneous edge requests both pass through, which Dialpad would reject anyway.

The worker does **not** write call-state from this endpoint. The Dialpad `calling` webhook is the single writer of the active-call store (see `/webhook/dialpad/extension-calls` below). So `/dialpad-call` is purely "ask Dialpad to ring the consultant's phone"; everything else flows from the resulting webhooks.

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
  → stub = EXT_CALL_STATE.get(idFromName(user.dialpadId))
  → callId = await stub.getCallId()
  → 409 ok=false ("No active call") if callId is null
  → PUT https://dialpad.com/api/v2/call/{callId}/actions/hangup   (no body)
  → 502 ok=false ("Dialpad rejected the hangup: <upstream message>") if non-2xx
  → Response: { ok: true }   ← worker does NOT clear the DO; the resulting
                                Dialpad `hangup` webhook is the only path
                                that clears
```

The extension never sees the Dialpad `call_id` — the worker reads it from the per-user `ExtCallState` Durable Object, populated by the matching `calling` webhook. The hangup body is just `{ consultantFirstName }`.

If the user hangs up via the Dialpad app instead of the extension, no `/dialpad-hangup` request fires — but the `hangup` webhook still does, and it clears the DO. Either path leaves the system consistent.

### `POST /webhook/dialpad/extension-calls` — call-state webhook handler

The single writer/clearer of the per-user `ExtCallState` Durable Object. Subscription is configured Dialpad-side for **both `calling` and `hangup`** states with no `target_id` / `target_type` filter — the subscription is company-wide and survives team-registry changes; per-user filtering happens server-side via `getUserByDialpadId`. Everything else (`connected`, `voicemail`, inbound, events from non-registered users) is filtered server-side and dropped silently. Same JWT auth as `/webhook/dialpad/calls` (shared `DIALPAD_WEBHOOK_SECRET`).

```
Dialpad event → POST /webhook/dialpad/extension-calls
  → JWT verify (HS256, DIALPAD_WEBHOOK_SECRET)
  → processExtensionCallEvent(payload, env):
       direction !== 'outbound' → drop (reason: not-outbound)
       payload.call_id missing → drop (reason: no-callid-in-payload)
       getUserByDialpadId(payload.target.id) → null → drop (reason: unmonitored-target)

       stub = EXT_CALL_STATE.get(idFromName(user.dialpadId))

       IF state === 'calling':
         await stub.setCallId(payload.call_id)   ← overwrite-on-write,
                                                    schedules a 20-min
                                                    self-clearing alarm
         return { processed: true, reason: 'set-active', callId, ... }

       IF state === 'hangup':
         result = await stub.clearCallIdIfMatch(payload.call_id)
         match → DO clears; reason: 'cleared-on-hangup'
         mismatch → DO untouched (stale event for an old call); reason: 'callid-mismatch'
         no record → reason: 'no-active-record'

       any other state → drop (reason: 'unsupported-state')

  → 200 (always — Dialpad would retry on non-200 and we don't want that)
```

The `clearCallIdIfMatch` guard protects against stale events: if a new call's `calling` event has already overwritten the DO with `callId_B`, a delayed `hangup` event for the old `callId_A` won't wipe the new state. This is why hangup match-or-ignore is the right semantics, not unconditional clear.

### `POST /extension-call-status` — extension polling endpoint

Polled by the extension every ~500ms while a call is active.

```
Extension → POST /extension-call-status (consultantFirstName)
  → Verify X-Extension-Token (401 ok=false on miss)
  → 400 ok=false if consultantFirstName missing
  → resolve consultantFirstName → user via getUserByFirstName(name)
  → 403 ok=false if not in the registry
  → stub = EXT_CALL_STATE.get(idFromName(user.dialpadId))
  → callId = await stub.getCallId()
  → callId set → { state: "in_progress" }
  → callId null → { state: "ended" }
```

Pure DO read — never calls Dialpad. The DO's strong consistency means every poll reads the latest webhook write regardless of which PoP each request hit (KV's cross-PoP eventual consistency was producing 1-5 second visible lag where the calling webhook had landed but polling reads still returned `ended`).

The extension owns the give-up decision via its own ~10-second clock from the `/dialpad-call` 200 — if the calling webhook never lands at all, after 10s the extension reverts the button to Call. The worker has no server-side discovery timeout.

**Lifecycle**:
1. Click Call → `POST /dialpad-call` → 200; extension shows transient `Calling…` disabled-button, starts polling, starts 10s clock.
2. Polling returns `{state: "in_progress"}` → extension flips to live Hangup, cancels 10s clock, keeps polling.
3. Polling returns `{state: "ended"}` (after Hangup state) → extension flips back to Call, stops polling.
4. 10s clock fires while still in `Calling…` (calling webhook never landed) → extension reverts to Call, stops polling.

### Mobile PWA endpoints

Two routes power the mobile PWA's home + pipeline screens. The PWA reuses the rest of the extension routes (`/candidate-details`, `/dialpad-user-context`, `/dialpad-call`, `/dialpad-sms`, `/dialpad-hangup`, `/extension-call-status`) verbatim.

- **`POST /my-sourcing-jobs`** — body `{ consultantFirstName }`. Wraps RF `GET /job/list?only_open=1` (paginated). Filters worker-side to jobs where the consultant is on `hiring_team` as `Recruiter` (case-insensitive) AND `job_status.name === "Sourcing"` (case-insensitive). Returns `{ jobs: [{id, name, company}] }`.

- **`POST /job-pipeline`** — body `{ consultantFirstName, jobId }`. Wraps RF `POST /candidate/search` with `{key:"job", values:[jobId]}` + `{key:"stage", values:["Sourced"]}` filters and `include_count: true`. Filters out candidates with no usable `linkedin_profile` (RF returns the literal string `"None"` for missing values), normalizes RF's bare slugs to full `https://www.linkedin.com/in/...` URLs, sorts by `added_time` ASC. Returns `{ jobId, stage: "Sourced", total, candidates: [{rfId, linkedinUrl}] }`.

The PWA loads `/job-pipeline` once per session, then iterates locally with prev/next, calling `/candidate-details` per card. The hand-off doc is at `docs/handoffs/2026-05-06-pwa-handoff.md`.

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

(Active Dialpad `call_id` per consultant — formerly `extcall:callid:{dialpadUserId}` in KV — now lives in the `ExtCallState` Durable Object, see "Durable Object" below.)

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

`vitest.config.js`'s `poolOptions.workers.miniflare.bindings` provides non-secret stand-ins for `LINKEDIN_EXTENSION_SECRET`, `RF_API_KEY`, `DIALPAD_API_KEY`, and `DIALPAD_WEBHOOK_SECRET` so e2e tests can hit the worker (and mint valid Dialpad webhook JWTs) without real credentials. `wrangler.jsonc` is intentionally clean of these values to avoid overwriting Cloudflare-managed production secrets on deploy.

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

`EXT_CALL_STATE` → class `ExtCallState` (defined in `src/extension-call-do.js`, re-exported from `src/index.js` so wrangler picks it up). One DO instance per Dialpad user, named deterministically via `idFromName(dialpadUserId)`. Strong consistency: every read sees every prior write, regardless of which PoP each request hit.

- **Storage**: a single `callId` key. Holds the active Dialpad `call_id` for the user, or absent.
- **RPC methods**:
  - `setCallId(callId)` — overwrite-on-write; schedules a 20-min self-clearing alarm.
  - `getCallId()` — returns the stored value or `null`.
  - `clearCallIdIfMatch(callId)` — clears iff the stored value matches; otherwise drops with a reason. Used by the hangup webhook to avoid wiping a newer call when a stale event arrives.
- **Alarm**: fires 20 min after the last `setCallId`. Cleans up abandoned records (Dialpad never delivered a matching hangup webhook). A new `setCallId` resets the alarm.
- **Migration history**: `v1` created the now-deleted `ExtensionCallStateChannel` (the SSE-fan-out DO from the previous architecture); `v2` deleted it; `v3` added `ExtCallState`.

The previous KV-backed `extcall:callid:*` design was eventually consistent across PoPs — a `calling` webhook landing at one PoP and a poll at another could be 1-5 seconds out-of-sync, producing visible "no active call → ended" windows after the call had already started. Routing every request through a single DO instance eliminates that staleness window.

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
