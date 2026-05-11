import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyMigration } from './helpers/d1-migrate.js';
import { applyUsersMigration } from './helpers/users-migrate.js';
import { _resetCacheForTests } from '../src/users.js';
import { resetSnapshot } from '../src/mcp/snapshot.js';
import worker from '../src';
import { formatTranscript } from '../src/mcp/candidate-call-notes.js';
import { CALL_NOTES_GUIDANCE } from '../src/mcp/call-notes-guidance.js';

const originalFetch = globalThis.fetch;

async function call(body) {
  return worker.fetch(new Request('http://x/mcp/candidate-call-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env, createExecutionContext());
}

beforeEach(async () => {
  await applyMigration(env);
  await applyUsersMigration(env);
  _resetCacheForTests();
  await env.RF_MCP_CACHE.exec('DELETE FROM candidates');
  resetSnapshot();
  await env.RF_MCP_CACHE
    .prepare("INSERT INTO sync_state (key, value) VALUES ('last_tail_sync_at', ?)")
    .bind(new Date().toISOString())
    .run();
  // Seed one candidate matching Priya Sharma / id 50976.
  await env.RF_MCP_CACHE.prepare(
    'INSERT INTO candidates (id, body, name, cached_at) VALUES (50976, ?, ?, ?)',
  ).bind(
    JSON.stringify({ id: 50976, name: 'Priya Sharma', primary_email: 's@x.com' }),
    'Priya Sharma',
    new Date().toISOString(),
  ).run();
});

afterEach(() => { globalThis.fetch = originalFetch; });

describe('CALL_NOTES_GUIDANCE text-import', () => {
  it('resolves to the markdown source from docs/references/call_notes_guidance.md', () => {
    expect(typeof CALL_NOTES_GUIDANCE).toBe('string');
    // The file is the structured-note brief, several KB in the current shape.
    expect(CALL_NOTES_GUIDANCE.length).toBeGreaterThan(500);
    // Header from the real file; if this stops matching, someone replaced the
    // markdown with a pointer/placeholder by mistake.
    expect(CALL_NOTES_GUIDANCE).toMatch(/Description\/context prompt/);
  });
});

describe('formatTranscript', () => {
  it('filters to type=transcript and renders "name: content" per line', () => {
    const lines = [
      { type: 'moment', name: 'X', content: 'voicemail', time: '2026-05-08T17:14:54Z' },
      { type: 'transcript', name: 'Sarah', content: 'Hi Joel, thanks.', time: '2026-05-08T17:15:00Z' },
      { type: 'moment', name: 'X', content: 'call_purpose_category' },
      { type: 'transcript', name: 'Joel', content: 'Of course — start by telling me…' },
    ];
    expect(formatTranscript(lines)).toBe(
      'Sarah: Hi Joel, thanks.\nJoel: Of course — start by telling me…',
    );
  });

  it('all moments → empty string', () => {
    expect(formatTranscript([{ type: 'moment', name: 'a', content: 'b' }])).toBe('');
  });

  it('missing name → "Unknown:"', () => {
    expect(formatTranscript([{ type: 'transcript', content: 'hi' }])).toBe('Unknown: hi');
  });

  it('missing content → empty after colon', () => {
    expect(formatTranscript([{ type: 'transcript', name: 'A' }])).toBe('A: ');
  });

  it('null / undefined → empty string', () => {
    expect(formatTranscript(null)).toBe('');
    expect(formatTranscript(undefined)).toBe('');
  });
});
