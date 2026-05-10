/**
 * Server-side Markdown → HTML for MCP write tools that accept prose bodies
 * (e.g. /mcp/candidate-add-note). Centralised so future tools share the same
 * renderer options.
 *
 *   - `breaks: true`  — a bare \n becomes <br>, matching recruiter dictation
 *                       patterns where each new thought is a new line.
 *   - `gfm: true`     — GitHub-flavoured: lists, fenced code, tables, autolinks.
 *
 * Whitespace-only input renders to '' so callers can short-circuit cheaply.
 */
import { marked } from 'marked';

const RENDERER_OPTS = { breaks: true, gfm: true };

export function mdToHtml(md) {
  const trimmed = String(md ?? '').trim();
  if (!trimmed) return '';
  return marked.parse(trimmed, RENDERER_OPTS);
}
