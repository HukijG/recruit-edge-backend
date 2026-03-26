# Apollo Enrichment Feature — Brainstorming Context

**STATUS: Spec written and review-fixed. Ready for user review.**
**Spec location:** the Apollo enrichment design (2026-03-26)

Originally saved for WSL switch, but conversation continued in Windows. This file is now STALE — use the spec file above as the source of truth.

## What We're Building

Three features:

1. **Apollo phone enrichment** on RF candidate creation (Joel's candidates only, RF user ID: 900001)
2. **LinkedIn verification** via Apollo (detect wrong profiles from RF extension)
3. **Contact info removal sync** between RF and Dialpad (fix existing gap)

## Approach Decided: Two-Phase Enrichment

### Phase 1 — Synchronous (during RF Created webhook)

1. Check `created_by` == Joel (900001) on the RF webhook payload (fall back to `getRFCandidate()` if field not in payload)
2. Every candidate WILL have a LinkedIn URL (it's a required field in RF). Enrich via Apollo `POST /people/match` with `linkedin_url`
3. **Verify** Apollo person matches RF candidate:
   - Name: case-insensitive first name + last name. If RF last name is single character (with or without `.`), compare first names only
   - Organization: normalized comparison (lowercase, strip Inc/Ltd/LLC/etc.)
   - Both must pass
4. If **MATCH**: trust LinkedIn, request phone reveal (`reveal_phone_number=true`, `webhook_url` = `/webhook/apollo?token=SECRET`)
5. If **MISMATCH**: search Apollo People Search API by name + org + title (free, no credits)
   - Search params: `q_keywords` = first name (skip single-char last name), `person_titles[]` = exact title, org filter
   - **Score each result**: first name exact match (REQUIRED), job title exact match (high), org name match (high), `has_direct_phone` (tiebreaker)
   - **1 result, high confidence** → enrich by Apollo ID → get correct LinkedIn + request phone reveal
   - **Multiple results, clear winner** (only one passes name+title+org) → proceed
   - **Multiple results, no clear winner** → SKIP. Log warning with ambiguous results for manual review. No LinkedIn correction, no phone enrichment.
   - **0 results** → SKIP, log warning
6. If LinkedIn was corrected: update RF directly with correct LinkedIn (we're in the RF webhook handler already) + update candidate data in-memory before Dialpad sync
7. Store pending enrichment in KV: `apollo_enrich:{rfId}` → `{apolloPersonId, rfCandidateId, correctedLinkedIn, candidateData}` (15-min TTL)
8. Continue normal flow: validate → Dialpad upsert (with correct LinkedIn) → debounce → cache

### Phase 2 — Async (Apollo phone webhook, "calendar pattern")

1. Apollo delivers phone number(s) to `/webhook/apollo?token=SECRET`
2. Auth: verify token query param against `APOLLO_WEBHOOK_SECRET`
3. Look up pending enrichment from KV: `apollo_enrich:{rfId}`
   - Not found → log warning (TTL expired or duplicate), return 200
4. Extract phone number(s) from webhook payload
5. **Update Dialpad contact directly** (calendar pattern — Dialpad-first, don't update RF directly)
6. Update KV cache with phone data
7. Dialpad fires Updated webhook → existing Dialpad→RF handler syncs phone to RF naturally
   - The 60s debounce from Phase 1 will have long expired (Apollo phone reveal takes "several minutes")

### Contact Removal Sync (fix)

**Dialpad→RF direction (code bug):**
- `convertDialpadContactToRFUpdate()` in `src/rf-client.js` currently only sets `phone_number` / `email` in updateData when the array has items
- If Dialpad sends empty phones/emails (field removed), the function skips them → RF keeps stale data
- Fix: explicitly send empty arrays to RF when Dialpad has no phones/emails

**RF→Dialpad direction (config change):**
- Code already handles this correctly (`prepareContactData` in `src/dialpad-client.js` sends `emails: []` and `phones: []` by default)
- But the RF webhook is configured to only fire when a number/email is ADDED, not removed
- Joel needs to reconfigure the RF webhook triggers to also fire on field removals

## Architecture Decisions

- **Apollo phone enrichment is async-only.** `reveal_phone_number=true` requires a `webhook_url`. Phone data arrives asynchronously ("several minutes"). Without this flag, the sync response does NOT include phone numbers for new contacts.
- **Calendar pattern for phone delivery.** When Apollo webhook arrives: update Dialpad first, let Dialpad→RF sync carry data to RF. Avoids duplicate RF update paths.
- **LinkedIn correction is synchronous.** Happens immediately in the RF webhook handler. RF is updated directly (we're already in the RF context). Dialpad gets the corrected LinkedIn via the normal sync.
- **Conservative on ambiguity.** When People Search returns multiple results with no clear winner, DON'T auto-correct. Log for manual review. Only auto-correct when confidence is high.

## New Infrastructure

### New Module: `src/apollo-client.js`
- `enrichPerson(params, options, env)` — Call `/people/match` with configurable params + optional `reveal_phone_number` / `webhook_url`
- `searchPeople(params, env)` — Call People Search API `/mixed_people/api_search`
- `verifyApolloMatch(apolloPerson, rfCandidate)` — Compare Apollo person against RF data (name + org fuzzy matching)
- `scoreSearchResults(results, rfCandidate)` — Score and rank search results, return best match or null if ambiguous

### New Endpoint: `/webhook/apollo`
- Method: POST
- Auth: `?token=` query param matched against `APOLLO_WEBHOOK_SECRET`
- Receives async phone number data from Apollo
- Follows calendar pattern: Dialpad-first update

### New KV Keys
- `apollo_enrich:{rfId}` → JSON context for pending phone enrichment (15-min TTL)

### New Secrets (Cloudflare dashboard)
- `APOLLO_API_KEY` — Apollo API key for enrichment + search
- `APOLLO_WEBHOOK_SECRET` — shared secret for Apollo webhook auth

### Modified Files
- `src/index.js` — RF webhook handler gains enrichment step; new Apollo webhook handler; route for `/webhook/apollo`
- `src/rf-client.js` — fix `convertDialpadContactToRFUpdate()` to handle empty arrays (removal sync)
- `src/dialpad-client.js` — no changes expected
- `wrangler.jsonc` — add `APOLLO_WEBHOOK_SECRET` to vars if needed, observability config
- `CLAUDE.md` — document new Apollo flow, endpoint, KV keys

## Apollo API Details

### People Enrichment (`POST /api/v1/people/match`)
- Auth: `x-api-key` header
- Params: `first_name`, `last_name`, `organization_name`, `linkedin_url`, `id`, `reveal_phone_number` (bool), `webhook_url` (required if reveal_phone_number=true)
- Returns: `{person: {id, first_name, last_name, name, linkedin_url, title, organization: {name, ...}, contact: {phone_numbers: [{raw_number, sanitized_number, status}]}}}`
- Consumes credits
- Phone numbers in sync response only if previously revealed; new reveals are async via webhook

### People Search (`POST /api/v1/mixed_people/api_search`)
- Auth: `x-api-key` header
- Params: `q_keywords`, `person_titles[]`, `q_organization_domains_list[]`, `person_locations[]`, etc.
- Returns: `{people: [{id, first_name, last_name_obfuscated, title, has_email, has_direct_phone, organization: {name}}]}`
- Does NOT return emails or phone numbers
- Does NOT consume credits
- Max 100 per page, 500 pages

### Apollo Phone Webhook Response (async)
- Delivers to the `webhook_url` provided during enrichment
- Contains: `{person_id, phone_numbers: [{sanitized_number, status, dnc_status}]}`

## User's Latest Feedback (needs response)

Joel's concern about the fallback search reliability:
- Some LinkedIn profiles show abbreviated names ("Andrew C.") when not connected — this causes the RF extension to find wrong profiles
- At large companies (Datadog), even name+title+org might return multiple results
- He doesn't want to replace one wrong LinkedIn with another wrong one
- **Our solution**: confidence-gating. Only auto-correct on unambiguous single matches. Skip and log when ambiguous. Use first name + exact title + org as the search combo. Skip single-char last names.

Joel confirmed:
- The flow looks mostly correct
- Name + org fallback is fine but title should also be used
- Every candidate WILL have a LinkedIn URL (required field in RF)
- RF link (LinkedIn URL in RF) needs to be updated too when corrected
- Updating just Dialpad to avoid duplicate hooks was considered but doesn't help since the webhook cascade happens regardless — existing debounce/sync state handles it fine
- RF webhook delay is annoying but polling adds too much overhead

## Brainstorming Process State

- [x] Explore project context
- [x] Ask clarifying questions (1 asked — async webhook OK)
- [x] Propose 2-3 approaches (Approach A: Two-Phase chosen)
- [x] Present design — Section 1 (Overall Flow) presented and reviewed
- [ ] Present design — remaining sections (data flow details, error handling, edge cases, testing)
- [ ] Write design spec document
- [ ] Spec review loop
- [ ] User reviews written spec
- [ ] Transition to implementation planning

## Existing Codebase Key References

- Joel's RF user ID: `900001` (hardcoded in `src/rf-client.js:193` and `:281`)
- RF webhook handler: `src/index.js:78-135`
- Dialpad sync function: `src/index.js:564-578`
- Calendar pattern (Dialpad-first): `src/index.js:514-539`
- Dialpad→RF sync: `src/index.js:249-336`
- `convertDialpadContactToRFUpdate`: `src/rf-client.js:220-245` (needs removal fix)
- `prepareContactData`: `src/dialpad-client.js:50-83`
- Cache functions: `src/cache.js`
- Cold call deferred pattern: `src/cold-call.js`
- Worker URL: `https://rf-dialpad-sync-dev.example-account.workers.dev`
- GitHub repo: `HukijG/rf-dialpad-sync`
- Deployment: push to `master` on GitHub, CF auto-deploys
- Secrets: managed via Cloudflare dashboard
