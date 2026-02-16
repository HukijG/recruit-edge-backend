# Deploying the Calendar Sync Apps Script

## 1. Create the Apps Script project

1. Go to https://script.google.com
2. Click **New project**
3. Rename the project to something like `Calendar Email Sync`
4. Delete the default `Code.gs` content
5. Copy-paste the entire contents of `scripts/calendar-sync.gs` into the editor

## 2. Set Script Properties

1. In the Apps Script editor, click the **gear icon** (Project Settings) in the left sidebar
2. Scroll down to **Script Properties**
3. Click **Add script property** for each:

| Property | Value |
|----------|-------|
| `WEBHOOK_URL` | `https://rf-dialpad-sync-dev.<your-account>.workers.dev/webhook/calendar` |
| `WEBHOOK_SECRET` | The same value you set for `CALENDAR_WEBHOOK_SECRET` on the worker |
| `CALENDAR_ID` | Your Google Calendar ID (usually your email, or find it in Calendar Settings → Integrate calendar) |
| `OWNER_EMAIL` | Your email address (used to exclude yourself from the guest list) |

## 3. Set up the Calendar trigger

1. In the Apps Script editor, click the **clock icon** (Triggers) in the left sidebar
2. Click **+ Add Trigger** (bottom right)
3. Configure:
   - **Function**: `processNewBookings`
   - **Event source**: From calendar
   - **Calendar details**: Calendar updated
   - **Calendar owner email**: Your email (same as `OWNER_EMAIL`)
4. Click **Save**
5. You'll be prompted to authorize — grant calendar read access

This fires automatically whenever any event on your calendar is created, updated, or deleted. No polling — it only runs when something changes.

## 4. Test manually

1. In the Apps Script editor, select `processNewBookings` from the function dropdown (top bar)
2. Click **Run**
3. Check the **Execution log** (View → Execution log) for output
4. If you have a correctly-formatted event on your calendar, you should see a webhook sent log
5. Check the Cloudflare Worker logs to verify the payload arrived

## 5. Verify with a test event

Create a calendar event manually with these properties:
- **Title**: `Test Candidate // Alex Recruiter Intro Call`
- **Location**: `https://meetings.dialpad.com/<your-handle>`
- **Description**: Must include all three signals (copy-paste this):
  ```
  Looking forward to meeting!

  Pre-meeting questions:

  Question: LinkedIn Profile

  Answer: https://www.linkedin.com/in/test-candidate
  ```
- **Guest**: Add a personal email address as a guest

Then run the script manually and check worker logs for the payload.

## Updating the script

The Apps Script editor does NOT auto-sync with this repo. When you make changes to `scripts/calendar-sync.gs`, manually copy-paste the updated code into the Apps Script editor.
