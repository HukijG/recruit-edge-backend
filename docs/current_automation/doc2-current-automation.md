# Candidate Lifecycle: Current Automation & Integration State

This document describes the automation and integrations currently in place that augment or replace manual steps in the candidate lifecycle. The central automation hub is a Cloudflare Worker that receives webhooks from multiple sources and orchestrates data sync between systems.

All webhook endpoints use generated secrets in request headers for authentication.

---

## Integration Architecture

```
RecruiterFlow ──webhook──→ Cloudflare Worker ──API──→ Dialpad
Google Calendar ──GAS webhook──→ Cloudflare Worker ──API──→ RecruiterFlow + Dialpad
Krisp ──webhook──→ Cloudflare Worker ──API──→ RecruiterFlow
Dialpad ──webhook──→ Cloudflare Worker ──API──→ RecruiterFlow
```

Krisp handles meeting recording, transcription (with diarization), and outline generation natively. It delivers results via webhook to the Cloudflare Worker. No external transcription service (Groq, Whisper, etc.) is needed for the current workflow.

A Cloudflare KV store is used for sync state caching and deduplication.

---

## Automation 1: Candidate Added to RF → Synced to Dialpad

**Trigger:** Candidate created in RecruiterFlow (via the Chrome extension or API).

**Flow:**
1. RF fires a webhook to the Cloudflare Worker with the candidate's data.
2. The Worker creates a corresponding contact in Dialpad with the candidate's details.

**Note:** The reverse direction (Dialpad → RF creation) is intentionally not implemented. UUID/deduplication mismatches between systems make it unreliable. RF is the authoritative source for candidate records.

---

## Automation 2: Phone Number Sync (Bidirectional)

**Trigger:** Phone number added or updated on either Dialpad or RecruiterFlow for a candidate that exists in both systems.

**Flow (RF → Dialpad):**
1. RF fires a webhook when a candidate's phone number is updated.
2. The Worker finds the corresponding Dialpad contact and updates the phone number.

**Flow (Dialpad → RF):**
1. Dialpad fires a webhook when a contact's phone number is updated.
2. The Worker finds the corresponding RF candidate and updates the phone number.

**Prerequisite:** The candidate must already be synced (exist in both systems) for bidirectional sync to work.

---

## Automation 3: Calendar Event → Email Sync to RF + Dialpad

**Trigger:** Google Calendar is updated with a new event (candidate books a call via the calendar link).

**Flow:**
1. A Google Apps Script monitors the calendar for updates.
2. When a new event is detected that matches specific constraints indicating it is a candidate call (not an internal meeting or other event type), the GAS fires a webhook to the Cloudflare Worker with the event details including the candidate's email.
3. The Worker searches RecruiterFlow for the candidate record (matched via name/details from the calendar event).
4. The Worker adds the candidate's email to their RF record.
5. The Worker updates the Cloudflare KV sync state store (used for caching and deduplication).
6. The Worker also updates the corresponding Dialpad contact record using the RF candidate ID found during the search.

**Result:** By the time the call happens, the candidate's email is already on their RF and Dialpad records.

---

## Automation 4: Krisp Meeting Notes → RF

**Trigger:** A meeting is recorded and processed by Krisp.

**Prerequisite:** The call must occur during a Google Calendar event block. When it does, Krisp automatically grabs the candidate's name, title, and email from the calendar event.

**Flow:**
1. After the meeting ends and Krisp processes the recording, Krisp fires a webhook to the Cloudflare Worker with the meeting outline and candidate details.
2. The Worker receives the webhook and searches for the candidate in RecruiterFlow using the candidate's email (which was added to their RF record in Automation 3 during the calendar booking step).
3. The Worker formats the Krisp outline notes into the correct structure.
4. The Worker adds the formatted notes to the candidate's RF record via the RF API.

**Result:** Call notes appear on the candidate's RF profile automatically after the call, without manual copy-paste from Krisp.

---

## Automation 5: LinkedIn Profile Scrape → RF via TextBlaze (NOT YET IMPLEMENTED)

**Status:** Significant development work completed but not yet deployed into the live workflow. The TextBlaze snippet can scrape candidate data from LinkedIn's messaging side panel and format it as JSON matching the RF API schema, but the end-to-end integration is still pending due to implementation edge cases.

**Intended flow (when completed):**
1. When a TextBlaze message template is triggered during the messaging step, the snippet simultaneously scrapes the candidate's profile data from LinkedIn's messaging side panel.
2. Data scraped: name, title, company, location (geocoded via Komoot Photon API), experience history, education history, profile image URL, LinkedIn URL.
3. The snippet sends a POST request to the RecruiterFlow API to create the candidate and add them to the job.

**Current state:** Candidates are still added to RF manually via the Chrome extension (Event 3 in the manual lifecycle). Messaging happens separately via TextBlaze templates and hotkeys. These are two distinct manual steps.

---

## What Is Automated vs Manual (Current State)

| Lifecycle Event | Manual Steps | Automated Steps |
|----------------|-------------|-----------------|
| 1. Candidate Search | Fully manual (hotkey-assisted) | — |
| 2. Save to LinkedIn Project | Fully manual (hotkey-assisted) | — |
| 3. Add to RecruiterFlow | Manual via RF Chrome Extension (hotkey-assisted) | Planned: TextBlaze scrape + API POST (Automation 5, not yet implemented) |
| 4. Message Candidate | Manual send (template-assisted via TextBlaze + hotkeys) | — |
| 5. Candidate Replied | Manual stage update via RF extension | — |
| 6. Call Booked | Manual stage update via RF extension, send calendar link | Email auto-synced to RF + Dialpad on booking (Automation 3) |
| 7. Candidate Call | Manual (make the call) | Krisp auto-records, auto-transcribes |
| 8. Post-Call CRM Update | Manual: custom fields, stage update, contact info | Call notes auto-added to RF (Automation 4), phone sync bidirectional (Automation 2) |
| 9. Follow-Up Email | Fully manual | — |
| 10. Resume Upload | Fully manual | — |
| 11. Candidate Writeup | Manual trigger of AIRA, but generation is AI | — |
| 12. CV Sent to Client | Fully manual | — |

---

## Remaining Gaps / Not Yet Automated

1. **TextBlaze → RF candidate creation (Automation 5):** Significant development work done (profile scraping, JSON formatting, geocoding, experience/education parsing all working). Not yet deployed into the live workflow due to implementation edge cases. Currently candidates are still added manually via the RF Chrome extension.

2. **Custom field extraction from call transcript:** Currently filled manually after the call. The Krisp outline is synced but custom field values (role type, tenure, technology vertical, sells-to, compensation) still require manual selection. A future AI/LLM step (likely Groq) could automate this by extracting structured field values from the transcript/outline.

3. **Job stage updates:** All stage changes (Replied, Call Booked, Shortlist, Rejected, CV Received, CV Sent) are still manual via the RF extension. Some could potentially be event-driven (e.g., auto-set Call Booked when a calendar event is created matching a candidate).

4. **Resume handling:** Upload and formatting are fully manual.

5. **Writeup generation trigger:** AIRA is triggered manually. Could potentially be auto-triggered when a candidate reaches a specific stage, or augmented with an AI step (likely Groq) to pre-generate or improve the writeup before AIRA formatting.

6. **Follow-up email:** Fully manual. Could be templated or triggered by stage change.

---

## Security

- All webhook endpoints on the Cloudflare Worker use generated secrets passed in request headers for authentication.
- HTTPS is enforced on all endpoints (Cloudflare handles TLS termination). Request headers including auth secrets are encrypted in transit as part of the TLS connection and are not exposed to intermediaries.
