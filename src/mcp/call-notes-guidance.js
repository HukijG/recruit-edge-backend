/**
 * Build-time text import of the call-notes rendering brief.
 *
 * Source of truth: docs/references/call_notes_guidance.md. Wrangler's text
 * loader (configured in wrangler.jsonc) resolves the import below to the
 * file's contents as a string at bundle time. Edit the .md to change the
 * guidance; redeploy to pick it up.
 */
import callNotesGuidance from '../../docs/references/call_notes_guidance.md';

export const CALL_NOTES_GUIDANCE = callNotesGuidance;
