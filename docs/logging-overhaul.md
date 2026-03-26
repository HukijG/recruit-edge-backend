# Logging Overhaul Plan

## Problem Statement

Across 97 log statements in the codebase, ZERO log the full raw webhook request body. Every handler cherry-picks a few fields from the payload and discards the rest. When debugging production issues, there is no way to see what was actually sent to the webhook.

The Cloudflare dashboard compounds the problem: `$workers` and `$metadata` wrappers are auto-injected by CF on every log event, mixing with custom fields. Invocation logs (auto-generated per request by CF) duplicate info already logged manually, adding noise.

## Current State (Audit)

97 total console statements (73 log, 24 error) across these files:

- **`src/index.js`** — 50+ statements: webhook handlers log cherry-picked fields (candidate ID, name, email, event type) but never the raw payload. Calendar/Krisp/Dialpad/RF handlers all follow the same pattern.
- **`src/cold-call.js`** — 30+ statements: processing steps, classification results, dedup tracking. Well-structured but no raw call webhook payload.
- **`src/rf-client.js`** — 9 error statements: API error responses with status + error text. Appropriate.
- **`src/dialpad-client.js`** — 1 error statement. Appropriate.
- **`src/auth.js`** — 1 error statement. Appropriate.
- **`src/cache.js`**, **`src/krisp.js`** — No logging at all.

**Key finding:** No file anywhere logs the complete incoming webhook request body.

## Proposed Fixes

### 1. Log full raw payload at entry point of every webhook handler

Add a single `console.log` as the FIRST action in each handler that captures:

- Full request body (parsed JSON)
- Relevant headers (auth token presence, event type headers, content-type)
- Request method and URL

Handlers that need this:

- `handleRecruiterflowWebhook` (src/index.js)
- `handleManualRFWebhook` (src/index.js)
- `handleDialpadWebhook` (src/index.js)
- `handleCalendarWebhook` (src/index.js)
- `handleKrispWebhook` (src/index.js)
- `handleDialpadCallWebhook` (src/index.js)

Pattern:

```js
const body = await request.json();
console.log({
  source: 'rf',
  step: 'webhook_received',
  method: request.method,
  url: request.url,
  headers: {
    contentType: request.headers.get('Content-Type'),
    eventType: request.headers.get('RF-Event-Type'),
    // don't log auth secrets, just presence
    hasAuth: !!request.headers.get('X-RF-Webhook-Token'),
  },
  body: body,
});
```

**Note:** For Dialpad webhooks where the body is JWT-encoded, log both the raw token (or its presence) AND the decoded payload after verification.

For Dialpad call webhooks, be careful with transcript data — it can be large. Consider logging body with transcript truncated to first 500 chars.

### 2. Disable Cloudflare invocation logs

In `wrangler.jsonc`, add:

```jsonc
"observability": {
  "enabled": true,
  "logs": {
    "invocation_logs": false
  }
}
```

This removes the auto-generated invocation log events that duplicate our custom logging and add the noisy `$workers`/`$metadata` fields. Our custom `console.log({...})` fields already appear as top-level filterable fields in the Workers Observability dashboard.

### 3. Keep existing per-step logs

The current per-step structured logs (with `source`, `action`, `candidateId` fields) are actually useful for filtering and tracing flow. They just were not sufficient as the ONLY logging. With the raw payload log as the ground truth, the per-step logs become complementary.

## Cloudflare Workers Logging Key Facts

- `console.log({...})` with flat objects is CF's recommended approach — object keys become top-level filterable fields
- `$workers` and `$metadata` wrappers are auto-injected by CF and cannot be removed
- Custom fields from console.log ARE top-level and queryable in the dashboard
- 256KB limit per invocation for all console output combined
- Invocation logs can be disabled separately from custom logs
- `console.error()` automatically gets "error" severity in the dashboard
- Workers Observability dashboard has Events view (chronological) and Invocations view (grouped by request)

## Implementation Notes

- This is a straightforward change — add one log statement at the top of each handler + one config change in `wrangler.jsonc`.
- Existing tests should not be affected (they don't assert on console output).
- Be mindful of the 256KB per-invocation limit — Krisp webhook payloads with full meeting notes could be large. If a payload exceeds ~200KB, log a truncated version with a note.
- For the Dialpad webhook specifically: the body arrives as JWT text, not JSON. Log the decoded JWT payload after verification, not the raw JWT string.
