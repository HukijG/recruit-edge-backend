/**
 * Krisp webhook helpers
 *
 * Utilities for resolving consultant/candidate attribution and formatting
 * meeting notes from Krisp note_generated webhook payloads.
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
 * Format Krisp meeting notes as an HTML string suitable for posting as a
 * RecruiterFlow candidate note.
 *
 * `note_generated` delivers the notes as a single markdown string
 * (`data.raw_content`): `##`/`###` headings, `- ` bullets, `**bold**`, `---`
 * rules and emoji metadata lines. We render that subset to the small HTML tag
 * set RF notes support (`<b>`, `<br>`, `<ul>`/`<li>`, `<a>`), prefixed with a
 * clickable Krisp link + meeting metadata header.
 *
 * @param {Object} meeting     - data.meeting from the Krisp webhook
 * @param {string} rawContent  - data.raw_content (markdown) from the webhook
 * @returns {string} HTML string
 */
export function formatKrispNotesAsHtml(meeting, rawContent) {
  const time = formatTime(meeting.start_date);
  const date = formatDate(meeting.start_date);
  const duration = Math.round((meeting.duration || 0) / 60);

  const lines = [];

  // Metadata header: clickable Krisp link + when/how-long.
  lines.push(
    `\u{1F4CB} <a href="${escapeHtml(meeting.url || '')}">${escapeHtml(meeting.title || 'Krisp Meeting')} Call Notes</a><br>`
  );
  lines.push(`\u{1F55E} Started at ${time} on ${date}, lasted ${duration}m<br><br>`);

  // Body: the meeting notes markdown rendered to HTML. raw_content normally
  // leads with the meeting title as a heading — drop it so it isn't repeated
  // under the header link above.
  lines.push(markdownToHtml(stripLeadingTitleHeading(rawContent || '', meeting.title)));

  return lines.join('\n');
}

/**
 * Remove a leading ATX heading from `md` when its text equals `title` — Krisp's
 * `raw_content` opens with the meeting title as `## **Title**`, which the
 * metadata header link already shows. No-op if the first content line isn't a
 * matching heading.
 */
function stripLeadingTitleHeading(md, title) {
  if (!title) return md;
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const heading = lines[i]?.trim().match(/^#{1,6}\s+(.*)$/);
  if (heading && stripMarkdownBold(heading[1]).trim() === title.trim()) {
    lines.splice(i, 1);
    return lines.join('\n');
  }
  return md;
}

/**
 * Render the markdown subset Krisp emits in `raw_content` to the HTML tag set
 * RecruiterFlow notes support. Handles ATX headings (`#`..`######`), unordered
 * list items (`- `/`* `), horizontal rules (`---`/`***`), inline `**bold**`,
 * and treats every other non-blank line as a paragraph. All text is
 * HTML-escaped before tag insertion.
 *
 * Krisp separates every bullet with a blank line, so a blank line keeps an open
 * list open when the next non-blank line is another bullet (look-ahead) —
 * otherwise each bullet would render as its own single-item `<ul>`.
 */
function markdownToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      // Keep the list open across blank lines that sit between bullets.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (!/^[-*]\s+/.test(j < lines.length ? lines[j].trim() : '')) closeList();
      continue;
    }
    if (/^([-*])\1{2,}$/.test(line) || line === '---' || line === '***') {
      closeList();
      out.push('<br>');
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<b>${escapeHtml(stripMarkdownBold(heading[1]).trim())}</b><br>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inlineMarkdownToHtml(bullet[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`${inlineMarkdownToHtml(line)}<br>`);
  }

  closeList();
  return out.join('\n');
}

/**
 * Escape HTML, then convert inline `**bold**` spans to `<b>…</b>`. Escaping
 * first means candidate-supplied `<`/`>`/`&` can never inject markup; the
 * `**` markers survive escaping and are converted afterward.
 */
function inlineMarkdownToHtml(text) {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
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
