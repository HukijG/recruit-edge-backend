# Dialpad Call Flow — Middleware Hand-off Spec

**Date:** 2026-05-01
**For:** the engineer modifying the Cloudflare Worker middleware
**From:** the extension side (this is the contract the extension will hit)

## What I'm asking you to build

**Two new endpoints on the middleware:**

1. **`POST /dialpad-user-context`** — returns the consultant's available devices + caller IDs, with the actual Dialpad device IDs and phone numbers replaced by opaque alias tokens. The extension caches this locally so we don't have to round-trip the middleware on every candidate page open.
2. **`POST /dialpad-call`** — initiates a call. The extension sends the candidate's phone number plus the device + caller-ID alias tokens it received from `/dialpad-user-context`. The middleware decodes the aliases back to the real Dialpad IDs and POSTs to Dialpad's `initiate_call`.

You already have a Dialpad client file in the middleware repo — what follows is **guidance, not gospel**. Use whatever client shape fits the worker's existing patterns. The bits that matter are the request/response contracts the extension is locked into.

## Conventions you can already assume

These are the same conventions `/candidate-details` uses (look at how the extension calls that endpoint via `src/background/messages/fetchCandidateDetails.ts` for the reference pattern):

- **Auth header:** `X-Extension-Token: <per-user secret>` on every request. 401 if missing/invalid.
- **Content type:** `Content-Type: application/json` request and response.
- **Consultant identity:** the request body always carries `consultantFirstName: "Joel"` (or whoever) — the middleware maps that name → Dialpad user ID server-side using whatever lookup it already does for `/candidate-details`. The extension never sees, stores, or sends a Dialpad user ID.
- **Errors:** non-2xx responses return `{ "ok": false, "error": "<short human message>" }`. The extension surfaces `error` in a toast / inline message.

---

## Endpoint 1: `POST /dialpad-user-context`

Called when the extension needs to populate the device + caller-ID picker. Currently that's when the dev test-call view mounts; the production candidate view will call it the first time candidate mode activates per session and then read from the local cache thereafter.

### Request the extension sends you

```http
POST /dialpad-user-context HTTP/1.1
Host: <worker host>
Content-Type: application/json
X-Extension-Token: <per-user secret>

{
  "consultantFirstName": "Joel"
}
```

That's it. No device ID, no caller ID, no Dialpad user ID — you look those up server-side from the consultant name.

### Response the extension needs back

```json
{
  "devices": [
    {
      "aliasId": "<opaque token, ~32-128 chars, URL-safe>",
      "name": "Joel-PC · Desktop",
      "lastSeen": "2026-05-01T13:31:24.731Z"
    },
    {
      "aliasId": "<opaque token>",
      "name": "Edge on Windows · Web",
      "lastSeen": "2026-05-01T12:59:06.247Z"
    }
  ],
  "callerIds": [
    {
      "aliasId": "<opaque token>",
      "country": "US",
      "label": "Office main line",
      "isDefault": true
    },
    {
      "aliasId": "<opaque token>",
      "country": "UK",
      "label": "My number"
    }
  ]
}
```

#### Field meanings

**`devices[]`** — autocallable devices only, sorted in the order the picker should display them (the extension does no client-side sorting):

- `aliasId` (string, required) — opaque token. The extension echoes this back verbatim in the `/dialpad-call` request body. Must be valid for at least 1 hour, ideally 24 h. JWT, HMAC-signed blob, or KV-stored UUID — your call. Must be deterministically reversible to the underlying Dialpad device ID server-side.
- `name` (string, required) — single canonical human label. Bake the device kind into the name (e.g. `· Desktop`, `· Web`) — the extension doesn't get a separate type field, so do the normalisation work middleware-side. See "Display-name normalisation" below for the rules I'm currently applying client-side; please mirror.
- `lastSeen` (ISO 8601 string, optional) — newest of `date_updated` / `date_registered` / `date_created` from the Dialpad device record. Extension renders this as relative time ("2h ago"). Omit if Dialpad gives nothing useful.

**`callerIds[]`** — every caller ID the consultant can use, sorted by display order:

- `aliasId` (string, required) — same conventions as device `aliasId`. Must decode to an E.164 phone number server-side.
- `country` (string, required, enum `"UK" | "US" | "OTHER"`) — derived from the E.164 prefix. `+44` → `UK`, `+1` → `US`, anything else → `OTHER`. Used by the picker to render a small country chip / flag. **Do not return the actual phone number under any field name.** That's the whole point of the alias.
- `label` (string, optional) — human label like `"Office main line"`, `"Sales group"`, `"My number"`. Lifted from Dialpad's `groups[].display_name` when applicable, otherwise a category name (`"My number"` for entries from `phone_numbers`, `"Office main line"` for the `office_main_line` field). Helps when a consultant has multiple UK / multiple US numbers — without `label` they'd all read the same.
- `isDefault` (boolean, optional) — `true` on the entry whose decoded number matches the user's current `caller_id` field from Dialpad. The extension uses this to pre-select that option in the picker. At most one entry should have `isDefault: true`.

### What you do server-side to build this response

(Loose guidance, take what's useful.)

1. Look up the consultant's Dialpad user ID from `consultantFirstName`.
2. Hit Dialpad `GET /api/v2/userdevices?user_id={userId}` — returns `{ items: [...] }` with raw device records.
3. **Filter** out devices `initiate_call` won't ring. Per the Dialpad enum (`android, ata, audiocodes, c2t, ciscompp, dect, dpmroom, grandstream, mini, mitel, obi, polyandroid, polycom, sip, tickiot, yealink, iphone, ipad, proxy, public_api, packaged_app`), drop those. Keep `native, web, harness, msteams, salesforce, iframe_*, cti`.
4. **Sort** `native` first (most reliable for `initiate_call` — it's the Electron desktop app), then `web/harness` (browser), then CRM embeds (`iframe_*`, `msteams`, `salesforce`), then anything else. Within each bucket, most-recently-seen first (newest of `date_updated` / `date_registered` / `date_created`).
5. **Normalise display names** (see next section).
6. **Encrypt / alias** the device `id` field into `aliasId`.
7. Hit Dialpad `GET /api/v2/users/{userId}/caller_id` — returns a flat object (NOT wrapped in `caller_id_proto`, despite some old docs samples claiming so):

   ```json
   {
     "caller_id": "+14155551212",
     "phone_numbers": ["+14155551212", "+14155551213"],
     "office_main_line": "+14155551216",
     "groups": [{ "caller_id": "+14155551215", "display_name": "Sales Team" }],
     "forwarding_numbers": [...],
     "primary_phone": "...",
     "id": 12345
   }
   ```

8. Build the `callerIds` list by walking `phone_numbers` (label `"My number"`) + `office_main_line` (label `"Office main line"`) + `groups[]` (label = `display_name`). De-dupe on the underlying E.164 number. Mark the entry whose number matches `caller_id` as `isDefault: true`.
9. **Encrypt / alias** each E.164 number into `aliasId`. Compute `country` from the `+` prefix.

### Display-name normalisation rules I'm currently applying

Mirror these in the middleware so the canonical `name` is consistent. From the live data we've seen, raw `display_name` values include `"Joel-PC"`, `"Mozilla/5.0 (Windows NT 10.0; ...) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0"`, and short random tokens like `"26ws7engeur"`. Rules:

- If `display_name` starts with `"Mozilla/"`, parse the User-Agent into `{Browser} on {OS}`:
  - Browser: check for `Edg/` first (Edge ships Chrome in its UA), then `OPR/`, `Chrome/`, `Firefox/`, `Safari/`. Fallback `"Browser"`.
  - OS: `Windows`, `Macintosh|Mac OS X` → `macOS`, `Android`, `iPhone|iPad|iOS`, `Linux`. Fallback to no-OS suffix.
  - Result example: `"Edge on Windows"`.
- If `display_name` looks like a placeholder Dialpad token (8–16 chars, all `[a-z0-9]`, contains both letters and digits) — e.g. `"26ws7engeur"`, `"nn8k8jyr12"` — replace with a friendly type fallback (`"Web app"` for `web/harness`, `"Desktop app"` for `native`, etc.).
- Otherwise use `display_name` as-is (covers `"Joel-PC"`, `"SM-S921B"`, etc.).

Type label appended to the cleaned name with ` · `:
- `native` → `"Desktop"`
- `web`, `harness` → `"Web"`
- `msteams` → `"Teams"`
- `salesforce` → `"Salesforce"`
- `iframe_<name>` → `"Embed (<name with underscores → spaces>)"`
- anything else → title-cased type

So the final `name` field looks like `"Joel-PC · Desktop"`, `"Edge on Windows · Web"`, `"Web app · Web"` (for the random-token fallback).

### Operational notes

- **Caching.** The extension caches the response in `chrome.storage.local` keyed by consultant name with a TTL (initial proposal: 1 hour). It will only re-hit the endpoint when the cache is stale. So if you cache server-side too, keep that TTL short (say 5 min) so a colleague signing into a new browser session gets reflected reasonably fast.
- **`isAutocallable` filtering**: the extension trusts every device you return is callable. Don't ship non-autocallable devices — they error on `initiate_call` or get silently bypassed and the user ends up confused (they pick "phone" and the desktop app rings instead).
- **Refresh trigger.** Right now the extension has no manual "refresh devices" button. If we need one we can add it, but design assuming a 1-hour stale window is fine.

---

## Endpoint 2: `POST /dialpad-call`

Called when the user clicks the Call button.

### Request the extension sends you

```http
POST /dialpad-call HTTP/1.1
Host: <worker host>
Content-Type: application/json
X-Extension-Token: <per-user secret>

{
  "consultantFirstName": "Joel",
  "phoneNumber": "+447700900123",
  "deviceAliasId": "<opaque token from /dialpad-user-context>",
  "callerAliasId": "<opaque token from /dialpad-user-context>"
}
```

- `consultantFirstName` — same as endpoint 1.
- `phoneNumber` — E.164 number to dial. The extension already shows this on screen (it came from `/candidate-details` for real candidates, or is hardcoded `+447700900123` for the test view), so passing it through isn't a leak.
- `deviceAliasId` — the alias the user picked from the device dropdown. Decode to a real device ID, pass as `device_id` in the Dialpad request body.
- `callerAliasId` — the alias the user picked from the caller-ID dropdown. Decode to an E.164 number, pass as `outbound_caller_id` in the Dialpad request body.

Both alias fields are **required** in normal flow, but if you want to allow either to be omitted (and let Dialpad fall back to account defaults), document it and the extension can do the same.

### Response the extension needs back

**Success (200):**

```json
{ "ok": true }
```

Optionally include Dialpad's `call_id` or any other useful identifier:

```json
{ "ok": true, "callId": "..." }
```

The extension currently only checks `ok`. The button shows "Calling… → Ringing → Call" based on it.

**Failure (4xx / 5xx):**

```json
{ "ok": false, "error": "<short human message>" }
```

The extension surfaces `error` in the button label ("Failed — retry") and logs it. Common cases to surface as friendly messages:

- 400 `"Missing phone number"` / `"Invalid phone number"` — if `phoneNumber` is malformed.
- 400 `"Invalid device selection — please refresh and try again"` — alias expired or doesn't decode.
- 400 `"Invalid caller-ID selection — please refresh and try again"` — same for caller alias.
- 401 `"Authentication failed"` — bad / missing `X-Extension-Token`.
- 403 `"Consultant not found"` — name doesn't map to a Dialpad user.
- 502 `"Dialpad rejected the call: <Dialpad's message>"` — pass Dialpad's body through if it's safe to.

### What you do server-side

1. Auth check on `X-Extension-Token`.
2. Map `consultantFirstName` → Dialpad user ID.
3. Decode `deviceAliasId` → real `device_id`. Fail with 400 if invalid / expired.
4. Decode `callerAliasId` → real `outbound_caller_id` (E.164 number). Fail with 400 if invalid / expired.
5. POST `https://dialpad.com/api/v2/users/{userId}/initiate_call` with body:

   ```json
   {
     "phone_number": "<extension's phoneNumber>",
     "device_id": "<decoded>",
     "outbound_caller_id": "<decoded>",
     "custom_data": "<optional — could include candidate rfId or campaign for call attribution>"
   }
   ```

   Headers: `Authorization: Bearer <Dialpad API key>`, `Content-Type: application/json`, `Accept: application/json`.
6. If Dialpad returns 200, respond `{ ok: true }`. Otherwise proxy through with a useful `error` string.

---

## Reference: what the extension currently calls Dialpad with

So you have ground truth, here are the live Dialpad calls the extension is making today (about to be ripped out):

**1. `POST https://dialpad.com/api/v2/users/{userId}/initiate_call`**

Headers: `Authorization: Bearer <key>`, `Content-Type: application/json`.

Body:

```json
{
  "phone_number": "+447700900123",
  "device_id": "<optional>",
  "outbound_caller_id": "<optional>",
  "custom_data": "<optional>"
}
```

Response on success: `200` with `{ "device": { "id": "...", "type": "native", ... } }`.

Note from docs: "The user must have at least one active autocallable device (the web or desktop Dialpad app, or a CTI application). The Dialpad mobile apps and physical deskphones do not support this API call."

**2. `GET https://dialpad.com/api/v2/userdevices?user_id={userId}`**

Returns `{ items: [...] }` with raw device records. Sample shape (from live data):

```json
{
  "app_version": "2603.3.5",
  "date_created": "2026-04-17T10:51:28.328000",
  "date_registered": "2026-05-01T13:31:23.776000",
  "date_updated": "2026-05-01T13:31:24.731000",
  "display_name": "Joel-PC",
  "id": "+5555550101-user-8000000000000001-client-000000000000",
  "type": "native",
  "user_id": "8000000000000001"
}
```

**3. `GET https://dialpad.com/api/v2/users/{userId}/caller_id`**

Returns the flat shape documented above (NOT wrapped in `caller_id_proto`).

---

## What changes on the extension side (FYI)

So you know what to expect:

- The two existing direct-Dialpad background message handlers (`listDialpadDevices`, `listDialpadCallerIds`) get replaced by a single `getDialpadUserContext` that calls your new `/dialpad-user-context`.
- The existing `initiateDialpadCall` background handler gets rewired to call your new `/dialpad-call`.
- The extension drops the `PLASMO_PUBLIC_DIALPAD_DEV_API_KEY` / `PLASMO_PUBLIC_DIALPAD_DEV_USER_ID` / `PLASMO_PUBLIC_DIALPAD_BASE_URL` env vars.
- The `https://dialpad.com/*` host_permission is removed from the manifest — the extension only ever talks to the worker.
- Local cache layer added for `/dialpad-user-context` response (TTL ~1 h, key tied to consultant name).
- The dev test-call view stays — it just sources data from the middleware now instead of directly. Test phone number stays hardcoded as `+447700900123`. Once the production candidate view is wired up to use the same context + call path, the test view can be deleted (or kept as a sanity-check regression target).
