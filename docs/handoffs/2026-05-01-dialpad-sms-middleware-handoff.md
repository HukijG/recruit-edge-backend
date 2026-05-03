# Dialpad SMS — Middleware Hand-off Spec

**Date:** 2026-05-01
**For:** the engineer modifying the Cloudflare Worker middleware
**From:** the extension side (this is the contract the extension will hit)
**Companion to:** `2026-05-01-dialpad-middleware-handoff.md` — same conventions
apply (auth header, JSON content type, `consultantFirstName` server-side
lookup, `{ ok, error }` response envelope).

## What I'm asking you to build

**One new endpoint:** `POST /dialpad-sms` — sends a single SMS to a candidate
via the consultant's Dialpad number. The extension already collects the
candidate's E.164 phone number, the caller-ID alias, and the message body
(with `{{firstName}}`-style variables substituted client-side). All you do
is decode the alias, hit Dialpad's SMS API, and ack.

No new context endpoint is needed — the existing `/dialpad-user-context`
already returns the caller IDs, and SMS uses the same `aliasId` tokens.

## Endpoint: `POST /dialpad-sms`

### Request the extension sends you

```http
POST /dialpad-sms HTTP/1.1
Host: <worker host>
Content-Type: application/json
X-Extension-Token: <per-user secret>

{
  "consultantFirstName": "Joel",
  "phoneNumber": "+447700900123",
  "callerAliasId": "<opaque token from /dialpad-user-context>",
  "text": "Hi John,\n\nI'm reaching out because I thought this role would be of interest to you.\n\nLet me know if you'd like to chat!\n\nJoel"
}
```

- `consultantFirstName` — name the middleware maps to a Dialpad user ID
  server-side. Same lookup `/dialpad-call` and `/candidate-details` already
  use.
- `phoneNumber` — E.164 destination. Already shown in the popover (came from
  `/candidate-details` for real candidates, or hardcoded `+447700900123` for
  the dev test view), so passing it through isn't a leak.
- `callerAliasId` — the alias the user picked from the **outbound caller ID**
  dropdown in the test-call view. Decode to the underlying E.164 number
  server-side, pass as the `from_number` to Dialpad. **Optional** in the
  request; if omitted, the middleware can fall back to the user's default
  sender. The extension currently always sends a value because the test-call
  view requires picking one.
- `text` — the message body **with `{{firstName}}` already substituted**
  client-side. Send to Dialpad as-is. Preserve newlines and whitespace
  exactly — the user has typed it that way deliberately. Do not auto-trim,
  re-flow, or normalise. Length: no upper bound enforced client-side; SMS
  segmenting (160 chars per segment, GSM-7 etc.) is the middleware's call.

### Response the extension needs back

**Success (200):**

```json
{ "ok": true }
```

Optionally include Dialpad's `id` / `message_id` if you want it for logging:

```json
{ "ok": true, "messageId": "..." }
```

The extension only checks `ok`. On `true` the popover closes immediately.

**Failure (4xx / 5xx):**

```json
{ "ok": false, "error": "<short human message>" }
```

The extension surfaces `error` inline below the "Are you sure?" prompt as a
red 13px line, reverts the Yes button from "Sending…" back to "Yes", and
preserves the textarea contents so the user can retry or edit. Common cases
to surface as friendly messages:

- 400 `"Missing phone number"` / `"Invalid phone number"` — if `phoneNumber`
  is malformed.
- 400 `"Empty message"` — if `text.trim()` is empty (extension validates
  this client-side too, but defence in depth).
- 400 `"Invalid caller-ID selection — please refresh and try again"` — alias
  expired or doesn't decode.
- 401 `"Authentication failed"` — bad / missing `X-Extension-Token`.
- 403 `"Consultant not found"` — name doesn't map to a Dialpad user.
- 502 `"Dialpad rejected the message: <Dialpad's message>"` — pass Dialpad's
  body through if it's safe to.

### What you do server-side

1. Auth check on `X-Extension-Token`.
2. Map `consultantFirstName` → Dialpad user ID (existing helper).
3. Decode `callerAliasId` → real E.164 sender. Fail with 400 if invalid /
   expired. Skip this step if the field is absent and you're falling back
   to the user's default.
4. POST to Dialpad's SMS endpoint
   (`POST https://dialpad.com/api/v2/sms`, body shape:

   ```json
   {
     "user_id": "<consultant's Dialpad user id>",
     "to_numbers": ["<extension's phoneNumber>"],
     "from_number": "<decoded caller-ID alias, or omit for default>",
     "text": "<extension's text, verbatim>",
     "infer_country_code": false
   }
   ```

   — confirm shape against current Dialpad docs; the extension only cares
   about the response).

   Headers: `Authorization: Bearer <Dialpad API key>`,
   `Content-Type: application/json`, `Accept: application/json`.
5. If Dialpad returns 200/201, respond `{ ok: true }` (optionally include
   the Dialpad message id). Otherwise proxy through with a useful `error`
   string.

## Operational notes

- **No retries server-side.** If Dialpad fails, return the error and let the
  user retry from the popover (the textarea is preserved, the Yes button
  re-enables). Auto-retry would risk double-sending and is much harder to
  reason about than a human-in-the-loop retry.
- **No rate limiting needed yet.** This ships test-call-only initially —
  one consultant, one number at a time. When production candidate-mode
  lights up, revisit.
- **Logging.** If you log the SMS body server-side, treat it as candidate
  PII at the same level you treat phone numbers (i.e. encrypted, retained
  briefly, not surfaced in unauth'd dashboards). Recruiters' canned
  templates are user-authored and not sensitive on their own, but the
  substituted `{{firstName}}` makes the rendered text candidate-identifying.

## What changes on the extension side (FYI)

- A new background message handler `sendDialpadSms` at
  `src/background/messages/sendDialpadSms.ts`. Reads the per-user
  `consultantFirstName` from local storage, validates `phoneNumber` and
  `text`, POSTs to `${MIDDLEWARE_URL}/dialpad-sms`. Already shipped on
  branch `feature/dialpad-sms` at commit `add8544`.
- `TextPopover.handleYes` is now async. Calls `sendToBackground({ name:
  "sendDialpadSms", body: { phoneNumber, callerAliasId, text, secret } })`.
  Shows "Sending…" while in flight, closes on `{ ok: true }`, or reverts +
  surfaces the `error` string inline on failure.
- Test-call view continues to dial the dev's hardcoded mobile
  (`+447700900123`). Real candidate-mode trigger is gated on lifting
  `TextSlotContext.Provider` into `sidepanel.tsx`'s candidate branch — that's
  a separate slice and not blocked by this endpoint.
