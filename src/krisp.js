/**
 * Krisp webhook helpers
 *
 * Utilities for resolving consultant/candidate attribution and formatting
 * meeting notes from Krisp summary_generated webhook payloads.
 */

import { getUserByEmail } from './users.js';

/**
 * The Krisp account owner. Single owner constant; the owner's RF user id is
 * always derived from the registry (getUserByEmail) so no RF id is hardcoded.
 */
export const OWNER_EMAIL = 'owner@example.com';

/**
 * Whether a participant looks like an external guest (the candidate) rather
 * than the Krisp account-holder (a consultant). Krisp populates `id` and
 * `first_name` for the account-holder; an external participant has them null.
 * Used only to disambiguate the no-consultant-resolved fallback.
 */
function looksLikeGuest(p) {
  return !p?.id || !p?.first_name;
}

/**
 * Resolve who the consultant (note author) and the candidate are from a Krisp
 * meeting's participants. Team membership (getUserByEmail) is the primary
 * discriminator; the structural guest signal disambiguates the fallback case
 * where the consultant's Krisp email isn't registered.
 *
 * @param {Array<{email?: string, id?: string|null, first_name?: string|null}>} participants
 * @param {Object} env
 * @returns {Promise<{consultant: object|null, candidateEmail: string|null}>}
 *   consultant: the resolved team-member record (has rfUserId) or null.
 *   candidateEmail: the external participant's email (original casing) or null.
 */
export async function resolveKrispAttribution(participants, env) {
  if (!Array.isArray(participants)) return { consultant: null, candidateEmail: null };

  // First pass: resolve the consultant and collect non-team participants.
  let consultant = null;
  const unresolved = [];
  for (const p of participants) {
    const email = typeof p?.email === 'string' ? p.email.trim().toLowerCase() : null;
    if (!email) continue;
    const user = await getUserByEmail(env, email);
    if (user) {
      if (!consultant) consultant = user;
    } else {
      unresolved.push(p);
    }
  }

  // Second pass: pick the candidate. If the consultant is known, any non-team
  // participant is a candidate (first wins). If not, only trust a guest-shaped
  // participant so an unregistered consultant isn't mistaken for the candidate.
  const candidate = consultant
    ? unresolved[0] ?? null
    : unresolved.find(looksLikeGuest) ?? null;

  return { consultant, candidateEmail: candidate?.email ?? null };
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
