# Recruitment Middleware: Infrastructure Migration Architecture

LOGIC TO UPDATE LATER ON, EVENTS SHOULD BE NORMALISED TO FINAL ACTIONS, NOT DESCRIPTIONS OF THE WEBHOOK ITSELF. SO DO SHOULD STORE "RF CANDIDATE DATA IS X" BASED ON THE HOOK IT SENT, SO IF DIALPAD SENDS AN UPDATE, RF DOESN'T NEED TO BE UPDATED, THE HOOK FAILS.    

## Context

This document defines the target architecture for migrating a webhook-driven recruitment sync system off its current single-Cloudflare-Worker deployment. The system syncs candidate data between RecruiterFlow (RF), Dialpad, Google Calendar, Apollo.io, and Krisp.

The current implementation works logically but fails operationally due to Cloudflare KV's eventual consistency across edge nodes. Specifically:

1. **Echo loops**: Bidirectional sync (RF↔Dialpad) writes a debounce flag to KV after updating the target system. The target system's return webhook arrives at a different CF edge before the flag is visible. The echo gets processed as a real event.
2. **Concurrent execution**: Multiple Worker isolates process events for the same candidate simultaneously, causing API race conditions (RF 409 errors, partial overwrites, duplicate enrichments).
3. **Webhook retries**: RF and Dialpad sometimes redeliver identical webhooks. The KV-based dedup flags suffer the same eventual consistency problem.

The design principles that must be preserved:

- Events arrive in any order, and that's fine
- Every handler is self-contained and idempotent
- Deterministic UUID (`RF{candidateId}`) anchors a candidate across all systems
- No ordered pipelines or lifecycle state machines
- Every legitimate event must be processed; dedup must never drop real edits

---

## Recommended Architecture: Cloudflare Native (Queue + Durable Objects)

### Overview

The architecture uses two CF primitives, each solving a distinct problem:

- **CF Queues**: The event bus. Decouples webhook ingestion from processing. Provides buffering, automatic retry with backoff, dead letter queues, backpressure management, and observability (backlog metrics, consumer concurrency). This is the backbone of the event-driven architecture.
- **CF Durable Objects**: The per-candidate serialization and consistency layer. One DO instance per candidate ID guarantees single-threaded execution (no concurrent processing of events for the same candidate) and provides strongly consistent SQLite storage for dedup/echo flags. This is a thin coordination lock, not a replacement for the queue.

Neither primitive alone solves both problems. Queues don't support message groups (two events for the same candidate can be consumed by different parallel consumer invocations), so they can't prevent concurrent execution per-candidate. DOs provide serialization and consistent storage, but they're not an event bus (no buffering, no DLQ, no retry backoff, no backlog observability). Together, they cover everything.

### Why Stay on Cloudflare

- **Cost**: Already on the $5/mo Workers Paid plan. Queues, DOs, Workers, KV are all included with generous free tiers. At current volume (~300 events/day), there are zero overage charges. At 10x volume, still likely zero.
- **No external dependencies**: No additional vendor accounts, authentication layers, or webhook callback endpoints to manage.
- **Migration simplicity**: Code stays JavaScript on CF Workers. No new SDK, no new deployment targets. The existing handler logic is being reorganized, not rewritten.
- **Native integration**: Queue to Worker to DO to KV all communicate via bindings. No HTTP overhead between internal components. Service binding calls between Workers on the same account are free.

### Four-Layer Architecture

```
┌─────────────────────────────────────────────────────┐
│  LAYER 1: INGRESS WORKER (edge, stateless)          │
│  Receives raw webhooks from all external sources.    │
│  Validates, normalizes, resolves candidate ID.       │
│  Publishes normalized event to the Queue.            │
│  Returns 200 immediately. Zero business logic.       │
└────────────────────┬────────────────────────────────┘
                     │ queue.send()
                     ▼
┌─────────────────────────────────────────────────────┐
│  LAYER 2: CF QUEUE (event bus)                       │
│  Buffers events. Retries failed deliveries.          │
│  Routes to DLQ after max retries.                    │
│  Scales consumer concurrency automatically.          │
│  Provides backlog metrics and observability.          │
└────────────────────┬────────────────────────────────┘
                     │ batch delivery to consumer
                     ▼
┌─────────────────────────────────────────────────────┐
│  LAYER 3: CONSUMER WORKER → CANDIDATE DO             │
│  Consumer receives batched messages from Queue.      │
│  For each message, routes to CandidateDO by          │
│  candidate ID. DO provides:                          │
│   - Single-threaded execution (serialization)        │
│   - Strongly consistent SQLite (dedup + echo flags)  │
│   - Coordination: checks dedup, suppresses echoes,   │
│     then delegates to processing logic.              │
└────────────────────┬────────────────────────────────┘
                     │ service binding / internal call
                     ▼
┌─────────────────────────────────────────────────────┐
│  LAYER 4: PROCESSING LOGIC (stateless functions)     │
│  All business logic: sync, enrichment, classification│
│  Talks to external APIs (RF, Dialpad, Apollo, etc.)  │
│  Reads/writes KV cache (candidate records).          │
│  Returns results to DO for state tracking.           │
└─────────────────────────────────────────────────────┘
```

### How a Typical Event Flows Through

Example: Recruiter updates a candidate's phone number in RecruiterFlow.

1. **Ingress Worker** receives RF webhook. Validates signature. Extracts candidate ID and changed fields. Publishes `{ type: "rf.candidate.updated", candidateId: "RF123", data: { phone: "+44..." } }` to the Queue. Returns 200 to RF.

2. **Queue** buffers the message. Delivers it to the Consumer Worker in the next batch (within seconds, configurable).

3. **Consumer Worker** receives the batch. For this message, calls `env.CANDIDATE_DO.get(idFromName("RF123")).handleEvent(event)`.

4. **CandidateDO (RF123)** receives the event. Checks `processed_events` table in SQLite: has this exact event payload been processed recently? No. Proceeds. Calls the processing function `syncRfToDialpad(event)`.

5. **Processing logic** updates the Dialpad contact with the new phone number. Returns `{ fieldsWritten: { hash: "abc123" } }` to the DO.

6. **CandidateDO** writes an echo marker to SQLite: `{ target_system: "dialpad", field_hash: "abc123", created_at: now }`. Writes the event to `processed_events`. Returns success.

7. **Moments later**, Dialpad fires a "contact updated" webhook (the echo). Ingress Worker receives it, resolves candidate ID from the contact UUID, publishes `{ type: "dialpad.contact.updated", candidateId: "RF123", data: { phone: "+44..." } }` to the Queue.

8. **CandidateDO (RF123)** receives this event. Because execution is serialized, step 6 has already completed. DO checks echo markers: the incoming change hash matches what was just written to Dialpad. This is an echo. Skips processing. Done.

If step 7 had arrived while step 4-6 was still executing, the DO would queue it internally (single-threaded). It would process after step 6 completes. The echo marker would be visible. The echo would be suppressed. This is the guarantee that KV could never provide.

---

## Layer 1: Ingress Worker

### Responsibilities

1. Receive incoming HTTP requests from all webhook sources
2. Authenticate/validate the request (JWT for Dialpad, signature checks where applicable)
3. Parse the raw payload and extract:
   - Event type (e.g., `rf.candidate.updated`, `dialpad.contact.updated`, `apollo.phone_reveal`)
   - Candidate routing key (RF candidate ID where available, or a lookup key)
   - Normalized event payload (cleaned, typed, minimal)
4. Resolve candidate ID where it isn't directly present (see Routing Logic below)
5. Publish normalized event to the CF Queue
6. Return 200 immediately to the webhook sender

### Event Taxonomy

Every webhook source maps to a normalized event type. The ingress worker is the only place that knows about raw webhook formats.

| Source | Raw Trigger | Normalized Event Type | Routing Key |
|--------|------------|----------------------|-------------|
| RecruiterFlow | Candidate created/updated webhook | `rf.candidate.created` / `rf.candidate.updated` | `RF{candidateId}` (deterministic UUID) |
| Dialpad | Contact updated webhook (JWT-signed) | `dialpad.contact.updated` | Extract RF ID from Dialpad contact UUID field |
| Apollo | Async phone reveal callback | `apollo.phone_reveal` | RF candidate ID (from request metadata) |
| Dialpad | Call transcription webhook | `dialpad.call.transcribed` | Phone number (may not have candidate ID yet) |
| Google Calendar | Booking notification (from Apps Script) | `calendar.meeting.booked` | Candidate lookup key (LinkedIn URL, email, or name) |
| Krisp | Meeting notes webhook | `krisp.meeting.completed` | Non-host email from participants list |

### Routing / Candidate ID Resolution

The ingress worker resolves the routing key to an RF candidate ID before publishing to the Queue. For events that arrive without a direct candidate ID:

- **Dialpad contact update**: The Dialpad contact UUID contains the RF ID by construction (`RF{candidateId}`). Extract it.
- **Apollo phone reveal**: The original enrichment request should include the RF candidate ID in Apollo's metadata/callback URL. Extract it.
- **Cold call transcription**: Keyed by phone number initially. If the phone number maps to a known candidate (via KV cache lookup), include the candidate ID. If not, publish with `candidateId: null` and `lookupKey: { type: "phone", value: "+44..." }` for deferred processing.
- **Calendar booking**: Requires a tiered lookup (LinkedIn cache → RF API → email cache → name cache) to resolve to a candidate ID. This lookup happens in the ingress worker.
- **Krisp meeting**: Extract non-host email, look up candidate in RF/cache. If found, include candidate ID.

If a candidate ID cannot be resolved, the event is published to the Queue with `candidateId: null`. The consumer worker routes these to a `DeferredEventDO` (see Deferred Processing section) rather than a `CandidateDO`.

### What This Worker Does NOT Do

- No business logic (no field mapping, no merge decisions, no stage transitions)
- No external API calls beyond what's needed for candidate ID resolution
- No cache writes
- No state management

---

## Layer 2: CF Queue

### Configuration

A single queue handles all event types. The message body is the normalized event object.

```
Queue name: candidate-events
Max batch size: 10 (default)
Max batch timeout: 5 seconds (deliver smaller batches faster at low volume)
Max retries: 3
Dead letter queue: candidate-events-dlq
Consumer concurrency: auto (scales based on backlog)
Message retention: 4 days (default, adjustable up to 14)
```

### Why a Single Queue

Multiple queues (one per event type) would add operational complexity without benefit. The consumer worker inspects the event type and routes accordingly. A single queue keeps the architecture simple and lets CF manage concurrency scaling across all event types uniformly.

If a specific event type needs different retry/DLQ behavior in future, it can be split out to its own queue at that point.

### Dead Letter Queue

Events that fail processing after max retries land in `candidate-events-dlq`. A separate DLQ consumer (or manual inspection via the dashboard/pull consumer API) handles these. At current volume, this is a "check it occasionally" manual process, not an automated recovery system.

### What the Queue Provides

- **Decoupling**: Ingress returns 200 immediately. Processing happens asynchronously. Webhook senders never time out waiting for downstream API calls.
- **Buffering**: If processing is temporarily slower than ingestion (e.g., an API is rate-limiting), messages queue up and drain naturally.
- **Retry with backoff**: If a consumer invocation fails (processing worker throws), the message is retried automatically.
- **Dead letter routing**: Persistently failing messages are isolated rather than blocking the queue.
- **Backlog observability**: CF dashboard shows queue depth, consumer concurrency, and throughput metrics.
- **Scaling**: Consumer concurrency auto-scales up to 250 invocations based on backlog depth. At current volume this is irrelevant (1 concurrent consumer is plenty), but it's there when volume grows.

### What the Queue Does NOT Provide

- **Per-key ordering or serialization**: Two messages for the same candidate can be delivered to two different consumer invocations simultaneously. This is why the DO layer exists.
- **Content-based deduplication**: The Queue delivers every message. Dedup is handled downstream in the DO.

---

## Layer 3: Consumer Worker + Candidate Durable Object

### Consumer Worker

The consumer worker is a thin router. It receives batches of messages from the Queue and dispatches each one to the appropriate Durable Object.

```javascript
// Conceptual structure
export default {
    async queue(batch, env) {
        for (const message of batch.messages) {
            try {
                const event = message.body;
                if (event.candidateId) {
                    // Route to the candidate's DO
                    const doId = env.CANDIDATE_DO.idFromName(event.candidateId);
                    const stub = env.CANDIDATE_DO.get(doId);
                    await stub.handleEvent(event);
                } else {
                    // No candidate ID resolved — route to deferred processing
                    const deferKey = `${event.lookupKey.type}:${event.lookupKey.value}`;
                    const doId = env.DEFERRED_DO.idFromName(deferKey);
                    const stub = env.DEFERRED_DO.get(doId);
                    await stub.storeEvent(event);
                }
                message.ack();
            } catch (err) {
                // Message will be retried by the Queue
                message.retry();
            }
        }
    }
};
```

Individual message ack/retry means a failure processing one event in a batch doesn't block the others. A transient API failure for candidate RF123 doesn't delay processing of an unrelated event for candidate RF456.

### CandidateDO

One DO class: `CandidateDO`. Instances are created on-demand, keyed by the deterministic RF candidate UUID.

Because DOs are single-threaded per instance:
- Only one event for candidate `RF123` executes at a time
- Events for `RF123` and `RF456` execute in parallel (different instances)
- If a second event for `RF123` arrives while the first is processing, it queues at the DO level automatically

The DO's role is narrow: coordination. It checks dedup, checks echo suppression, delegates to processing logic, and records state. It does NOT contain business logic itself.

### SQLite Storage Schema

Each DO instance has its own embedded SQLite database. This replaces all KV-based dedup and debounce flags for that candidate.

```sql
-- Echo suppression: tracks what this system last wrote to each external system
-- Used to detect and suppress echo webhooks
CREATE TABLE echo_markers (
    target_system TEXT NOT NULL,     -- 'dialpad' or 'rf'
    field_hash TEXT NOT NULL,        -- hash of the fields that were written
    created_at INTEGER NOT NULL,     -- unix timestamp ms
    PRIMARY KEY (target_system)
);

-- Event dedup: prevents processing identical webhook payloads
CREATE TABLE processed_events (
    event_hash TEXT PRIMARY KEY,     -- hash of normalized event payload
    event_type TEXT NOT NULL,
    processed_at INTEGER NOT NULL,
    ttl_seconds INTEGER NOT NULL     -- how long to retain (varies by event type)
);

-- Enrichment tracking: prevents duplicate Apollo enrichment runs
CREATE TABLE enrichment_state (
    source TEXT PRIMARY KEY,         -- 'apollo'
    status TEXT NOT NULL,            -- 'requested', 'completed', 'failed'
    apollo_person_id TEXT,
    requested_at INTEGER,
    completed_at INTEGER
);
```

### Echo Suppression Logic

When the processing logic updates Dialpad (or RF), it returns the hash of what it wrote. The DO stores this in `echo_markers`.

When a webhook arrives from the system that was just updated:
1. DO checks `echo_markers` for the source system
2. Computes the hash of the incoming changes
3. If the hash matches and the marker is recent (within TTL), this is an echo. Skip processing.
4. If the hash differs, or the marker is expired, this is a legitimate update. Process it.

This works because the SQLite write and the subsequent read happen in the same single-threaded DO instance. The marker is always visible. This is the guarantee that KV could never provide.

### Event Dedup Logic

For true duplicate webhooks (retries with identical payloads):
1. Hash the normalized event payload
2. Check `processed_events` for a matching hash within the TTL window
3. If found, this is a retry. Return success without processing.
4. If not found, process the event, then write the hash.

TTL varies by event type:
- Sync events (RF/Dialpad updates): 60 seconds
- Apollo enrichment: 15 minutes
- Cold call classification: 5 minutes
- Krisp notes: 5 minutes

For the "rapid legitimate update" scenario (recruiter edits a candidate twice in 30 seconds), the payloads differ (different field values), so the hashes differ, and both events process. No legitimate events are dropped.

### Housekeeping

Expired rows in `processed_events` and `echo_markers` should be cleaned up periodically. Use the DO's Alarm API to schedule a cleanup pass, or prune on every Nth event to prevent unbounded storage growth.

### DO Lifecycle

- DOs hibernate automatically when idle (no billing while hibernated)
- SQLite state persists across hibernation
- On first access for a new candidate ID, the DO is created and tables are initialized
- DO instances are geographically placed near where they're first accessed

---

## Layer 4: Processing Logic

### Structure

All business logic lives here, organized as discrete functions. These start as imported modules within the consumer/DO codebase. Extract to a separate Worker via service binding only if the codebase outgrows a single deployment unit.

### Function Inventory

These map to the existing event flows. The logic stays the same; only the execution context changes.

#### `syncRfToDialpad(event, candidateContext)`
- Validates candidate has name/org/title
- Creates or updates Dialpad contact using deterministic UUID
- Returns: `{ dialpadContactId, fieldsWritten: { hash, fields } }`

#### `syncDialpadToRf(event, candidateContext)`
- Extracts email/phone/LinkedIn from Dialpad contact data
- Updates RF candidate (update-only, never creates)
- Returns: `{ rfFieldsWritten: { hash, fields } }`

#### `enrichWithApollo(event, candidateContext)`
- Looks up candidate in Apollo by LinkedIn URL
- Verifies match (falls back to People Search if mismatch)
- Requests async phone number reveal
- Returns: `{ apolloPersonId, matchScore, phoneRevealRequested }`

#### `processPhoneReveal(event, candidateContext)`
- Receives Apollo's async phone callback
- Updates Dialpad contact with phone number
- Updates candidate cache
- Returns: `{ phoneNumber, dialpadUpdated, fieldsWritten: { hash } }`

#### `classifyColdCall(event, candidateContext)`
- Sends transcript to LLM for classification (CF Workers AI)
- If cold call: creates RF activity, updates candidate source
- Returns: `{ isColdCall, rfActivityCreated }`

#### `processCalendarBooking(event, candidateContext)`
- Merges attendee email/phone into candidate
- Upserts Dialpad contact
- Moves candidate to "Call Booked" stage if eligible
- Returns: `{ stageUpdated, dialpadFieldsWritten: { hash } }`

#### `processKrispNotes(event, candidateContext)`
- Formats meeting notes as HTML
- Posts to RF as a candidate note
- Returns: `{ rfNoteId }`

### Error Handling

Each processing function should:
- Throw on transient errors (network timeout, 5xx from external API): the Queue's retry mechanism handles this (message gets retried)
- Return an error result on permanent failures (4xx, validation errors): the DO logs and moves on
- Never throw on partial success: return what succeeded and what failed so the DO can track state

### External Dependencies

- **KV namespace**: Candidate record cache (60-day TTL). Stays in KV because it's read-heavy, eventually-consistent is fine for cache, and it's cheap.
- **CF Workers AI**: Cold call transcript classification. No change needed.
- **External APIs via fetch**: RF API, Dialpad API, Apollo API.

---

## Deferred Processing (Events Without a Candidate ID)

Some events arrive before a candidate association exists. The primary case is cold call transcriptions where the phone number hasn't been linked to a Dialpad contact yet.

### Implementation

A separate DO class: `DeferredEventDO`, keyed by the deferred lookup value (phone number, email, etc.).

When a cold call arrives with no candidate association:
1. Ingress worker cannot resolve a candidate ID
2. Publishes to Queue with `candidateId: null` and `lookupKey: { type: "phone", value: "+44..." }`
3. Consumer worker routes to `DeferredEventDO` keyed by phone number
4. DO stores the call data in its SQLite

When a Dialpad contact update later arrives with that phone number:
1. After processing the contact update in the candidate's DO, check for deferred events
2. The processing logic queries `DeferredEventDO` by phone number via RPC
3. If deferred events exist, process them within the candidate's DO context
4. DeferredEventDO cleans up the consumed event

Deferred events should have a TTL (e.g., 24 hours). The DeferredEventDO uses an Alarm to expire stale events.

---

## Storage Architecture

| Data | Store | Consistency | TTL | Rationale |
|------|-------|-------------|-----|-----------|
| Echo markers | CandidateDO SQLite | Strong | 60s-5min | Must be immediately visible after write. Per-candidate. |
| Event dedup hashes | CandidateDO SQLite | Strong | 60s-15min | Must be immediately visible. Per-candidate. |
| Enrichment state | CandidateDO SQLite | Strong | Permanent (per candidate) | Prevents duplicate Apollo runs. Per-candidate. |
| Candidate record cache | KV | Eventual | 60 days | Read-heavy, latency-tolerant. Global lookup. |
| Deferred events | DeferredEventDO SQLite | Strong | 24 hours | Must not be lost. Keyed by phone/email. |
| Event buffer | CF Queue | N/A | 4-14 days | Retry, DLQ, buffering. Managed by platform. |

No external Redis or other database is required. DO SQLite handles everything that needs strong consistency. KV handles the cache layer. The Queue handles event buffering and delivery.

---

## Cost Summary

At current volume (~300 events/day, ~9,000/month):

| Component | Monthly Usage | Included Free | Overage |
|-----------|--------------|---------------|---------|
| Worker requests (ingress + consumer) | ~18K | 10M | $0 |
| Worker CPU time | ~90K ms | 30M ms | $0 |
| Queue operations | ~27K | 1M | $0 |
| DO requests | ~9K | 1M | $0 |
| DO compute duration | Negligible | 400K GB-s | $0 |
| DO SQLite storage | ~KB total | 1GB included | $0 |
| KV reads | Candidate cache only | 10M | $0 |

**Estimated monthly cost: $5 (unchanged from current plan)**

At 10x volume (~3,000 events/day): still within all included free tiers.

---

## Migration Strategy

### Phase 1: Deploy New Infrastructure

1. Create the Queue (`candidate-events` + DLQ)
2. Create the CandidateDO class with SQLite schema
3. Create the consumer worker with Queue binding and DO binding
4. Deploy the ingress worker as a new route (don't replace the existing worker yet)
5. Port one flow (Krisp: simplest, single webhook, one-directional, no echo concerns)
6. Test end-to-end with manual webhook triggers

### Phase 2: Cut Over Flow by Flow

Migrate flows in order of complexity/risk:
1. **Krisp meeting notes** (simplest, one-directional)
2. **Calendar booking** (one-directional, but with candidate resolution logic)
3. **RF → Dialpad sync** (bidirectional, echo suppression critical: test thoroughly)
4. **Dialpad → RF sync** (counterpart to above)
5. **Cold call classification + deferred processing**
6. **Apollo enrichment** (most complex: async callback, multiple API calls)

For each flow:
- Switch the ingress worker to route that event type through the Queue path
- Monitor Queue metrics and DO execution for 24-48 hours
- Remove the old direct-processing code path for that flow

### Phase 3: Cleanup

- Remove all KV debounce/dedup flags (replaced by DO SQLite)
- Remove defensive concurrency workarounds from processing logic
- Retire the old single-worker entry point
- Archive the old codebase

---

## Open Questions for Implementation

1. **Echo field hashing**: The hash must be computed from the specific fields written to the target system, not the full payload. Verify that the return webhook from Dialpad/RF contains enough information to reconstruct the same hash. If the return webhook includes server-generated fields (timestamps, version numbers), those must be excluded from the hash on both sides.

2. **Candidate ID resolution for calendar bookings**: The tiered lookup (LinkedIn cache → RF API → email cache → name cache) is currently inline. Keep in ingress worker; accept that this one source has a slightly heavier ingress path.

3. **Apollo callback routing**: The Apollo phone reveal callback needs to include the RF candidate ID so the ingress worker can route it. Verify that Apollo's API allows passing custom metadata in the reveal request that gets echoed back in the callback. If not, store a mapping in KV (apolloRequestId → rfCandidateId) during the initial reveal request.

4. **Apps Script integration**: The Google Calendar Apps Script currently posts directly to the existing worker. It needs to post to the new ingress worker's endpoint. This is a URL change in the Apps Script only.

5. **Processing logic packaging**: Start with processing functions as imported modules within the DO/consumer codebase. Extract to a separate Worker via service binding only if the codebase outgrows a single deployment unit.

6. **Observability**: The Queue dashboard provides backlog/throughput metrics. For per-event debugging, consider structured logging from the DO (event type, candidate ID, dedup decision, processing result) to `wrangler tail` or a logging pipeline. Nice-to-have, not a blocker.

---

## Fallback: Inngest Hybrid Approach

If the CF-native approach proves insufficient (e.g., need for event replay, visual debugging dashboard, or more sophisticated flow control like debounce/rate-limit as config), the alternative is:

- Keep the Ingress Worker on CF (edge webhook reception)
- Replace the Queue + DO layers with Inngest (concurrency key = candidate ID, limit 1; event ID = payload hash for retry dedup)
- Keep processing logic on CF (Inngest calls back via HTTP to a serve endpoint)
- Add Upstash Redis for echo markers (Inngest functions are stateless, need an external strongly-consistent store)

This adds two external dependencies (Inngest + Upstash Redis) and potentially $0-25/month more, but provides a managed event platform with replay, visual run history, and built-in flow control primitives.

The CF-native approach should be tried first. Inngest is the escape hatch if operational complexity outweighs architectural simplicity.
