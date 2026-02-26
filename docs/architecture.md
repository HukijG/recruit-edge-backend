# Architecture & Data Flow

## System Overview

A single Cloudflare Worker (`rf-dialpad-sync-dev`) that keeps candidate/contact records in sync across RecruiterFlow (RF), Dialpad, Google Calendar, and Krisp. RF is the source of truth for candidate records. A KV-backed cache provides fast lookups for integrations that don't have an RF candidate ID.

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ RecruiterFlow │    │   Dialpad    │    │  Dialpad     │    │   Google     │    │    Krisp     │
│  (RF)        │    │  (contacts)  │    │  (calls)     │    │  Calendar    │    │              │
│              │    │              │    │              │    │  + Reclaim   │    │              │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │ webhook           │ webhook           │ webhook           │ Apps Script        │ webhook
       ▼                   ▼                   ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                          Cloudflare Worker (rf-dialpad-sync-dev)                                 │
│                                                                                                  │
│  /webhook/recruiterflow  /webhook/dialpad  /webhook/dialpad/calls  /webhook/calendar             │
│  /webhook/krisp          /health                                                                 │
│                                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────────────────────┐     │
│  │                    KV: SYNC_STATE                                                        │     │
│  │  candidate:{rfId}    → JSON canonical record       (60-day TTL)                          │     │
│  │  linkedin:{url}      → rfId                        (60-day TTL)                          │     │
│  │  email:{addr}        → rfId                        (60-day TTL)                          │     │
│  │  name:{first}:{last} → rfId or AMBIGUOUS           (60-day TTL)                          │     │
│  │  sync:RF{id}         → "true"                      (60-sec TTL)                          │     │
│  │  krisp:note:{hash}   → "true"                      (24-hour TTL)                         │     │
│  │  coldcall:{call_id}  → "true"                      (5-min TTL)                           │     │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Source Files

| File | Purpose |
|------|---------|
| `src/index.js` | Worker entry point, request routing, all webhook handlers, sync orchestration |
| `src/cache.js` | KV candidate cache: canonical records, index keys (linkedin, email, name), lookup functions |
| `src/rf-client.js` | RF API client: candidate search/get/update, LinkedIn URL validation & normalization, Dialpad↔RF data conversion |
| `src/dialpad-client.js` | Dialpad API client: contact PUT (create/update), data preparation from RF candidate format |
| `src/krisp.js` | Krisp helpers: note formatting (HTML), candidate email extraction from meeting participants |
| `src/cold-call.js` | Cold call detection: Dialpad transcript fetch, Workers AI classification (Llama 3.3 70B), RF custom activity + source update |
| `src/auth.js` | JWT verification for Dialpad webhooks (HS256 via `jose`) |
| `scripts/calendar-sync.gs` | Google Apps Script: detects Reclaim bookings on Google Calendar, extracts candidate data, posts to worker |
| `wrangler.jsonc` | Worker config: KV binding, env vars, compatibility settings |
| `test/index.spec.js` | Vitest tests using `@cloudflare/vitest-pool-workers` |

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

### Apps Script Filtering (3-signal combo)

All three must be present for an event to be processed:
1. Description contains `"Looking forward to meeting!"` (custom Reclaim booking phrase)
2. Description contains `"Question: LinkedIn Profile"` (pre-meeting question)
3. Location contains `"meetings.dialpad.com/"` (Dialpad meeting link)

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
  → Check if email already exists on candidate → skip if yes
  → Merge new email into existing array (first email gets is_primary=1)
  → POST /candidate/update with merged email array
  → Set debounce: sync:RF{id} = "true" (60s TTL)
  → Upsert Dialpad contact directly (don't wait for RF webhook — 6-7 hour delay)
  → Update candidate cache with new email data
```

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

**Trigger**: Dialpad fires `call_transcription` or `transcription` (voicemail) webhook event after a call ends and the transcript is ready.

```
Dialpad call event (call_transcription or transcription state)
  → POST /webhook/dialpad/calls
  → Verify JWT (HS256, existing DIALPAD_WEBHOOK_SECRET)
  → Filter: target.id must be Joel (8000000000000001)
  → Filter: direction must be "outbound"
  → Extract RF candidate ID from contact.id (uid_RF regex)
  → Check KV dedup: coldcall:{call_id} — skip if already processed (5-min TTL)
  → Get transcript:
      - transcription state: transcription_text from payload (voicemails)
      - call_transcription state: GET /api/v2/transcripts/{call_id}
  → Truncate to 5,000 chars
  → Classify via CF Workers AI (Llama 3.3 70B fp8 fast)
  → If not cold call → log + done
  → If cold call:
      1. POST /api/external/custom-activity/create (activity_type_id=1002)
      2. POST /api/external/candidate/update (source="Cold Call")
  → Set dedup: coldcall:{call_id} = "true" (5-min TTL)
```

**LLM Classification**: No keyword matching. System prompt describes cold call characteristics conceptually — first contact, introducing yourself, unfamiliar tone. Model returns JSON with `is_cold_call` boolean and reasoning. Uses `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via Workers AI binding.

**Scope**: Joel's calls only (Dialpad user ID 8000000000000001). Activity logged under RF user 900001. Hardcoded — will add team member IDs when rolling out.

**Neuron budget**: ~61 neurons per full call (5k chars), ~25 per voicemail. At worst case ~215 calls/day = ~5,915 neurons (59% of free 10k/day).

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
| `candidate:{rfId}` | JSON: `{id, first_name, last_name, email, emails[], linkedin_profile, current_organization, current_title, phone_number, cached_at}` | 60 days |
| `linkedin:{normalized_url}` | RF candidate ID string | 60 days |
| `email:{lowercase_address}` | RF candidate ID string (one key per email in array) | 60 days |
| `name:{first_lower}:{last_lower}` | RF candidate ID string, or `"AMBIGUOUS"` | 60 days |
| `sync:RF{id}` | `"true"` | 60 seconds |
| `krisp:note:{hash}` | `"true"` | 24 hours |
| `coldcall:{call_id}` | `"true"` | 5 minutes |

### Cache Freshness

All webhook flows keep the cache up to date (Krisp is the exception — it only reads the cache for lookups, does not write):

| Webhook | When cache is written |
|---------|----------------------|
| RF (Created/Updated) | After Dialpad sync — caches full candidate data from RF payload |
| Dialpad (Updated) | After RF update — merges email/phone/LinkedIn changes into cached record. Cache miss → fetches fresh from RF API |
| Calendar | After RF search API hit (warms cache). After successful email merge (updates cached emails) |

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

### Vars (in `wrangler.jsonc`)

| Var | Default |
|-----|---------|
| `DIALPAD_API_BASE_URL` | `https://dialpad.com/api/v2` |
| `RF_API_BASE_URL` | `https://api.recruiterflow.com/api/external` |

### KV Namespace

`SYNC_STATE` — single namespace for both debounce flags and candidate cache.

- Production ID: `REDACTED_KV_NAMESPACE_ID`
- Preview ID: `REDACTED_KV_PREVIEW_NAMESPACE_ID`

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

---

## Deployment

- **Auto-deploy**: Push to `master` triggers deployment via GitHub integration
- **Manual**: `npm run deploy` (runs `wrangler deploy`)
- **Worker name**: `rf-dialpad-sync-dev` (the `-dev` suffix is intentional — it's the live production URL)
