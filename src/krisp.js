/**
 * Krisp webhook helpers
 *
 * Utilities for extracting candidate info and formatting meeting notes
 * from Krisp summary_generated webhook payloads.
 */

const OWNER_EMAIL = 'owner@example.com';

/**
 * Extract the candidate's email from a Krisp meeting participants array.
 * Filters out the hardcoded owner email and returns the first remaining
 * participant's email, or null if none found.
 *
 * @param {Array<{email: string}>} participants - data.meeting.participants
 * @returns {string|null}
 */
export function extractCandidateEmail(participants) {
  if (!Array.isArray(participants)) return null;
  const candidate = participants.find(
    (p) => p.email && p.email.toLowerCase() !== OWNER_EMAIL
  );
  return candidate ? candidate.email : null;
}

/**
 * Format Krisp meeting notes as an HTML string suitable for posting
 * as a RecruiterFlow candidate note.
 *
 * @param {Object} meeting  - data.meeting from the Krisp webhook
 * @param {Array}  content  - data.content from the Krisp webhook
 * @returns {string} HTML string
 */
export function formatKrispNotesAsHtml(meeting, content) {
  const time = formatTime(meeting.start_date);
  const date = formatDate(meeting.start_date);
  const duration = Math.round((meeting.duration || 0) / 60);

  const lines = [];

  // Outline header
  lines.push('<b>Outline</b><br>');
  lines.push(
    `\u{1F4CB} <a href="${escapeHtml(meeting.url)}">${escapeHtml(meeting.title)} Call Notes</a><br>`
  );
  lines.push(
    `\u{1F55E} Started at ${time} on ${date}, lasted ${duration}m<br><br>`
  );

  // Content sections
  if (Array.isArray(content)) {
    for (const section of content) {
      const title = stripMarkdownBold(section.title || '');
      lines.push(`<b>${escapeHtml(title)}</b>`);

      const bullets = (section.description || '')
        .split('\n')
        .filter((line) => line.trim() !== '');

      if (bullets.length > 0) {
        lines.push('<ul>');
        for (const bullet of bullets) {
          lines.push(`<li>${escapeHtml(bullet.trim())}</li>`);
        }
        lines.push('</ul>');
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO 8601 date string as time in America/New_York timezone.
 * e.g. "7:00 PM"
 */
function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/New_York',
  });
}

/**
 * Format an ISO 8601 date string as a short date in America/New_York timezone.
 * e.g. "Feb 10, 2026"
 */
function formatDate(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

/**
 * Strip markdown bold markers (**) from a string.
 */
function stripMarkdownBold(str) {
  return str.replace(/\*\*/g, '');
}

/**
 * Minimal HTML escaping for user-generated text inserted into HTML.
 */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
