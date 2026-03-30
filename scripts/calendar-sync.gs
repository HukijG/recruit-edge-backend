/**
 * Calendar Event Email Sync — Google Apps Script
 *
 * Polls Google Calendar for Reclaim booking-form events and sends
 * candidate data to the Cloudflare Worker for RF/Dialpad sync.
 *
 * Trigger: Calendar EventUpdated (fires when any event is created/updated/deleted)
 *
 * Required Script Properties (Settings → Script Properties):
 *   WEBHOOK_URL    — e.g. https://rf-dialpad-sync-dev.<account>.workers.dev/webhook/calendar
 *   WEBHOOK_SECRET — shared secret matching CALENDAR_WEBHOOK_SECRET on the worker
 *   CALENDAR_ID    — Google Calendar ID to watch
 *   OWNER_EMAIL    — your email (excluded from guest list to find the candidate)
 */

function processNewBookings() {
  var props = PropertiesService.getScriptProperties();
  var config = {
    webhookUrl: props.getProperty('WEBHOOK_URL'),
    webhookSecret: props.getProperty('WEBHOOK_SECRET'),
    calendarId: props.getProperty('CALENDAR_ID'),
    ownerEmail: props.getProperty('OWNER_EMAIL')
  };

  if (!config.webhookUrl || !config.webhookSecret || !config.calendarId || !config.ownerEmail) {
    console.error('Missing configuration. Set WEBHOOK_URL, WEBHOOK_SECRET, CALENDAR_ID, OWNER_EMAIL in Script Properties.');
    return;
  }

  var calendar = CalendarApp.getCalendarById(config.calendarId);
  if (!calendar) {
    console.error('Calendar not found: ' + config.calendarId);
    return;
  }

  var now = new Date();
  var endDate = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  var events = calendar.getEvents(now, endDate);

  console.log('Scanning ' + events.length + ' events in next 14 days');

  var processedIds = loadProcessedIds(props);
  var newCount = 0;

  for (var i = 0; i < events.length; i++) {
    var event = events[i];
    var eventId = event.getId();

    if (processedIds.indexOf(eventId) !== -1) {
      continue;
    }

    var rawDescription = event.getDescription() || '';
    var description = stripHtml(rawDescription);
    var descLower = description.toLowerCase();
    var location = event.getLocation() || '';
    var title = event.getTitle() || '';

    // === BOOKING FILTER ===

    // Filter 1: LinkedIn pre-meeting question present (case-insensitive)
    if (descLower.indexOf('question: linkedin profile') === -1) {
      continue;
    }

    // Filter 2: Booking location — Dialpad meeting link OR Phone Call
    if (location.indexOf('meetings.dialpad.com/') === -1 && location.indexOf('Phone Call') === -1) {
      continue;
    }

    // Filter 3: Exactly 1 non-owner guest
    var guests = event.getGuestList();
    var nonOwnerGuests = [];
    for (var g = 0; g < guests.length; g++) {
      if (guests[g].getEmail().toLowerCase() !== config.ownerEmail.toLowerCase()) {
        nonOwnerGuests.push(guests[g]);
      }
    }

    if (nonOwnerGuests.length !== 1) {
      console.log('Skipping "' + title + '": expected 1 non-owner guest, found ' + nonOwnerGuests.length);
      continue;
    }

    // === DATA EXTRACTION ===

    var candidateGuest = nonOwnerGuests[0];
    var attendeeEmail = candidateGuest.getEmail();

    var attendeeName = '';
    var slashIndex = title.indexOf('//');
    if (slashIndex !== -1) {
      attendeeName = title.substring(0, slashIndex).trim();
    }
    if (!attendeeName) {
      attendeeName = candidateGuest.getName() || '';
    }

    var linkedinAnswer = '';
    var linkedinMatch = description.match(/Question:\s*Linkedin Profile[\s\S]*?Answer:\s*(.+?)(?:\n|$)/i);
    if (linkedinMatch) {
      linkedinAnswer = linkedinMatch[1].trim();
    }

    var phoneAnswer = '';
    var phoneMatch = description.match(/Question:\s*Please provide a number[^\n]*[\s\S]*?Answer:\s*(.+?)(?:\n|$)/i);
    if (phoneMatch) {
      phoneAnswer = phoneMatch[1].trim();
    }

    // === BUILD + SEND PAYLOAD ===

    var payload = {
      event_id: eventId,
      event_title: title,
      event_start: event.getStartTime().toISOString(),
      attendee_email: attendeeEmail,
      attendee_name: attendeeName,
      linkedin_answer: linkedinAnswer,
      phone_number: phoneAnswer || null
    };

    try {
      var response = UrlFetchApp.fetch(config.webhookUrl, {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'X-Calendar-Webhook-Token': config.webhookSecret
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      var code = response.getResponseCode();
      console.log('Webhook sent for "' + title + '": HTTP ' + code);

      if (code >= 200 && code < 300) {
        processedIds.push(eventId);
        newCount++;
      } else {
        console.error('Webhook failed for "' + title + '": ' + response.getContentText());
      }
    } catch (e) {
      console.error('Webhook error for "' + title + '": ' + e.message);
    }
  }

  if (processedIds.length > 100) {
    processedIds = processedIds.slice(processedIds.length - 100);
  }
  props.setProperty('PROCESSED_EVENTS', JSON.stringify(processedIds));

  console.log('Processed ' + newCount + ' new events. Total tracked: ' + processedIds.length);
}

function loadProcessedIds(props) {
  var raw = props.getProperty('PROCESSED_EVENTS') || '[]';
  try {
    return JSON.parse(raw);
  } catch (e) {
    return [];
  }
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
