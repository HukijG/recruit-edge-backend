# Infrastructure Migration Briefing

## What This System Does

A webhook-driven middleware that syncs recruitment candidate data between three systems: RecruiterFlow (RF), Dialpad (phone/contacts), and Google Calendar — with Apollo.io for data enrichment and Krisp for meeting notes. Built for a small recruiting team (currently one person, scaling to a team).

It's internal tooling, not customer-facing. No SLA, no uptime requirements beyond "it works reliably when I'm doing cold calls."

## Architecture Philosophy

**Event-driven, order-agnostic, eventually consistent.**

The system is designed around the principle that real-world events (candidate created, contact updated, call made, meeting booked) arrive in unpredictable order and often overlap. The architecture explicitly does NOT depend on events arriving in sequence. Instead:

1. **RF is the source of truth for candidates.** Every candidate originates in RF. A deterministic UUID (`RF{candidateId}`) anchors the candidate across all systems. This UUID is the invariant — as long as it exists, any system can sync to any other in any order.

2. **Every webhook handler is self-contained.** Each can look up what it needs, merge data idempotently, and write results. No handler assumes another handler ran first (with one exception: the candidate must exist in RF before anything else happens, which is guaranteed by the workflow).

3. **Sync is bidirectional but asymmetric.** RF→Dialpad syncs all candidate fields. Dialpad→RF syncs only email, phone, and LinkedIn (update-only, never creates). Calendar and Apollo flows merge data into both systems independently.

4. **Loop prevention via debounce flags.** When flow A updates system B, it writes a short-lived flag. When system B fires a webhook back, flow B checks the flag and skips processing. This prevents RF→Dialpad→RF→... infinite loops.

## Concrete Event Flows

### RF → Dialpad (candidate sync)
- RF fires webhook → worker validates candidate has name/org/title → creates/updates Dialpad contact using deterministic UUID → writes KV debounce flag (60s TTL) → caches candidate record

### Dialpad → RF (contact update)
- Dialpad fires JWT-signed webhook → worker extracts RF ID from Dialpad contact UUID → checks debounce flag → if clear, syncs email/phone/LinkedIn changes back to RF → writes reverse debounce flag → updates cache

### Apollo Enrichment (on candidate creation)
- Triggered during RF→Dialpad sync for new candidates → looks up candidate in Apollo by LinkedIn URL → verifies match (falls back to People Search if mismatch) → requests async phone number reveal → Apollo delivers phone via webhook minutes later → worker updates Dialpad directly + cache

### Dialpad Calls → RF (cold call detection)
- Dialpad fires call transcription webhook → worker sends transcript to LLM (Cloudflare Workers AI) for classification → if cold call, creates RF activity + updates candidate source
- **Deferred processing:** When a call happens before the contact is associated in Dialpad, call data is stored by phone number in KV. When the contact is later updated with that phone number, the deferred call is picked up and processed.

### Calendar → RF + Dialpad (meeting bookings)
- Google Apps Script detects calendar booking → posts to worker → worker finds RF candidate via tiered lookup (LinkedIn cache → RF API → email cache → name cache) → merges attendee email/phone → upserts Dialpad contact → moves candidate to "Call Booked" stage if eligible

### Krisp → RF (meeting notes)
- Krisp fires webhook → worker extracts non-Joel email from participants → looks up RF candidate → posts formatted HTML note to RF

## Current Implementation

**Stack:** Single Cloudflare Worker (JavaScript), KV namespace for cache + debounce flags.

**What works well:**
- The UUID-anchored sync model is solid. Deterministic IDs mean any flow can create or update a Dialpad contact without coordination.
- Individual flows work correctly in isolation. RF→Dialpad, Dialpad→RF, Calendar, Krisp, cold calls — all fine when they're not overlapping.
- Apollo enrichment logic (LinkedIn verification, fallback search, scoring) works ~50% of the time (Apollo data quality issue, not architectural).

**What's breaking:**

### The Debounce Problem
Debounce flags live in Cloudflare KV, which is **eventually consistent across edges**. When the worker updates Dialpad (or RF), the target system fires a webhook back within milliseconds. If that return webhook hits a different CF edge than the one that wrote the debounce flag, the flag isn't visible yet. Result: the "echo" webhook gets processed as if it's a real update, causing duplicate processing, redundant API calls, and sometimes data conflicts.

### The Duplicate Webhook Problem
Both Dialpad and RF retry failed webhooks and sometimes send duplicate deliveries. The dedup mechanism (KV flags) suffers the same eventual-consistency issue. In one session, Apollo enrichment was triggered 2-3 times for the same candidate because duplicate RF webhooks all passed the dedup check before any of them wrote the flag.

### The Concurrency Problem
When processing candidates in rapid succession (manual webhook → enrichment → call → next candidate), multiple webhook handlers for the same candidate can be in flight simultaneously across different Worker isolates. They race on:
- KV reads (debounce checks)
- External API calls (RF GET for current data)
- KV writes (cache updates, debounce flags)
- External API writes (RF update, Dialpad upsert)

This caused: enrichment running multiple times, RF 409 errors ("phone number already exists" — two flows trying to add the same phone to different candidates, or the same candidate via different code paths), and intermittent data loss (candidates synced to Dialpad missing job title/company because one flow overwrote another's partial update).

### The Dedup-Timing Problem
In enrichment specifically, the dedup flag (`apollo_enrich:{rfId}`) is written AFTER the enrichment completes (including the async phone reveal request). If two webhook deliveries enter enrichment before either finishes, both will request phone reveals, both will get Apollo callbacks, and both will try to update Dialpad/RF.

## What I Need Help With

I need to move this system to infrastructure that can properly support its architecture. The design principles are sound — I don't want to change them:

- Events arrive in any order, and that's fine
- Every handler is self-contained and idempotent
- UUID is the anchor across systems
- No ordered pipelines or lifecycle state machines

What I need from the infrastructure:

1. **Reliable deduplication** — when two identical webhooks arrive within seconds, only one should be processed. This needs to be strongly consistent, not eventually consistent.

2. **Per-candidate serialization (soft)** — not a strict ordered queue, but a guarantee that two handlers for the same RF candidate ID aren't executing simultaneously. This eliminates the race conditions without imposing global ordering.

3. **Scalability** — currently ~300 webhook events/day. Adding team members to cold calling, adding more integrations, and increasing candidate volume could push this to thousands/day within months. The solution shouldn't require re-architecture at that scale.

4. **Operational simplicity** — this is internal tooling for a small team. I don't want to manage Kafka clusters. Managed/serverless is strongly preferred.

5. **Keep the existing logic** — the webhook handlers, sync logic, enrichment flow, cache layer etc. are all correct. I want to move them to better infrastructure, not rewrite them.

### Constraints
- Currently all JavaScript (ES modules)
- External dependencies: RF API, Dialpad API, Apollo API, Krisp webhooks, Google Calendar (Apps Script)
- Uses Cloudflare Workers AI for LLM classification (cold calls) — would need a replacement if leaving CF entirely
- KV is used for both caching (60-day TTL records) and short-lived flags (debounce, dedup) — these have very different consistency requirements
- Budget-conscious (this is a small recruiting operation, not a VC-funded startup)

### What I'm NOT looking for
- "Just add more KV checks" or "use Cloudflare Durable Objects" — unless there's a genuinely architecturally sound case for staying on CF, I'd rather move to something purpose-built
- Ordered event pipelines — the whole point is that order doesn't matter
- Over-engineering — this is a recruitment sync tool, not a distributed database

### What I AM looking for
- Infrastructure options that give me strongly-consistent dedup + soft per-key serialization + managed/serverless
- Trade-offs between options (cost, complexity, migration effort, scaling ceiling)
- Whether there's a way to keep the webhook-receiver layer lightweight (edge/serverless) while routing processing through something more robust (hybrid approach)
- Concrete recommendations, not a survey of every cloud service that exists
