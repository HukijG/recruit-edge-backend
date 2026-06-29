#!/usr/bin/env node
/**
 * One-off backfill: recover historical cancelled / missed cold calls for the
 * owner (Joel) that never reached RF, for candidates currently in `Sourced` on
 * jobs 981 / 973 / 996.
 *
 * Why: a Dialpad outbound call that rang but never connected (no talk time)
 * produces no transcript, so the live cold-call flow never logged it. The
 * cold count is therefore understated. This finds those calls from Dialpad's
 * call list and writes them to the RF_MCP_CACHE `missed_cold_calls` table, which
 * /candidate-details merges into the owner's cold-call list at read time.
 *
 * It does NOT write to RF (we're not back-populating 2 months of activity for
 * the whole team) — it only fills the owner-only D1 display table.
 *
 * Classification (uses real Dialpad /call fields — there is NO date_connected):
 *   - `duration` is talk time (excludes ring), 0/absent when never connected.
 *   - Connected calls AND outbound voicemails-left have duration > 0 and were
 *     recorded live (transcript flow) → already in RF → SKIP.
 *   - The only missed category is no-talk hangups (duration 0) = 'cancelled'.
 *     RF stores zero cancelled today, so every selected row is inserted; no
 *     transcript probe or voicemail dedup is needed.
 *   - SQL is INSERT OR IGNORE on call_id (PK) → re-runs are idempotent.
 *
 * Usage:
 *   RF_API_KEY=… DIALPAD_API_KEY=… JOEL_DIALPAD_ID=… \
 *     node scripts/backfill-cancelled-cold-calls.mjs [--months=2] [--out=path.sql]
 *
 * Produces a .sql file and prints the apply command (run it yourself — this
 * script never writes to prod D1):
 *   cd cache-worker && npx wrangler d1 execute RF_MCP_CACHE --remote \
 *     --config wrangler.cache.jsonc --file ../<out>.sql
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RF_API_KEY = process.env.RF_API_KEY;
const DIALPAD_API_KEY = process.env.DIALPAD_API_KEY;
const JOEL_DIALPAD_ID = process.env.JOEL_DIALPAD_ID;
const RF_BASE = process.env.RF_API_BASE_URL || 'https://api.recruiterflow.com/api/external';
const DIALPAD_BASE = process.env.DIALPAD_API_BASE_URL || 'https://dialpad.com/api/v2';

const JOBS = [981, 973, 996];
const SOURCED = 'Sourced';
const RF_UID_RE = /uid_RF(\d+)$/;

const monthsArg = Number((process.argv.find(a => a.startsWith('--months=')) || '').split('=')[1]) || 2;
const outArg = (process.argv.find(a => a.startsWith('--out=')) || '').split('=')[1] || `missed-cold-calls-backfill.sql`;
const WINDOW_MS = Math.round(monthsArg * 30.5 * 24 * 60 * 60 * 1000);

if (!RF_API_KEY || !DIALPAD_API_KEY || !JOEL_DIALPAD_ID) {
  console.error('ERROR: set RF_API_KEY, DIALPAD_API_KEY and JOEL_DIALPAD_ID.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rfPost(path, body) {
  const res = await fetch(`${RF_BASE}${path}`, {
    method: 'POST',
    headers: { 'RF-Api-Key': RF_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RF POST ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function rfGet(path) {
  const res = await fetch(`${RF_BASE}${path}`, { headers: { 'RF-Api-Key': RF_API_KEY } });
  if (!res.ok) throw new Error(`RF GET ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
async function dpGet(path) {
  const res = await fetch(`${DIALPAD_BASE}${path}`, { headers: { Authorization: `Bearer ${DIALPAD_API_KEY}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Dialpad GET ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Current stage for a /job/pipeline detail item: the stages[] entry with the
 * latest `time`, its `to` field (verified shape: [{from,to,time}] ascending). */
function currentStage(detailItem) {
  const c = detailItem?.candidate || detailItem;
  if (typeof c?.stage_name === 'string') return c.stage_name;
  const stages = Array.isArray(detailItem?.stages) ? detailItem.stages : [];
  if (!stages.length) return null;
  let best = null, bestT = -Infinity;
  for (const s of stages) {
    const t = Date.parse(s?.time);
    if (Number.isFinite(t) && t >= bestT) { bestT = t; best = s; }
  }
  return best?.to ?? stages[stages.length - 1]?.to ?? null;
}

/** Set of RF candidate ids currently in Sourced across the target jobs. */
let _dumpedPipelineShape = false;
async function sourcedCandidateIds() {
  const ids = new Set();
  for (const jobId of JOBS) {
    const pipeline = await rfGet(`/job/pipeline?job_id=${jobId}`);
    const detail = Array.isArray(pipeline?.detail) ? pipeline.detail : [];
    // The /job/pipeline shape isn't independently verified here — dump one item
    // + the stage summary so the operator can confirm `currentStage()` derives
    // the right value BEFORE trusting the Sourced counts / applying the SQL.
    if (!_dumpedPipelineShape && detail[0]) {
      _dumpedPipelineShape = true;
      console.log('  [verify] sample detail[0] keys:', Object.keys(detail[0]));
      console.log('  [verify] sample detail[0]:', JSON.stringify(detail[0]).slice(0, 600));
      console.log('  [verify] derived currentStage(detail[0]):', currentStage(detail[0]));
      if (Array.isArray(pipeline?.summary)) console.log('  [verify] summary stages:', pipeline.summary.map(s => s?.name));
    }
    let n = 0;
    for (const item of detail) {
      const id = item?.candidate?.id ?? item?.id;
      if (id != null && currentStage(item) === SOURCED) { ids.add(Number(id)); n++; }
    }
    console.log(`  job ${jobId}: ${n} candidates in ${SOURCED} (of ${detail.length} in pipeline)`);
    await sleep(400);
  }
  return ids;
}

/** All of Joel's calls in the window, deduped by call_id. Dialpad's /call list
 * caps the started_after..started_before range at 30 days, so we walk the window
 * in <30-day chunks and paginate each by cursor. */
async function listJoelCalls() {
  const now = Date.now();
  const overallAfter = now - WINDOW_MS;
  const CHUNK_MS = 29 * 24 * 60 * 60 * 1000; // safely under Dialpad's 30-day cap
  const byId = new Map();
  let chunkStart = overallAfter;
  while (chunkStart < now) {
    const chunkEnd = Math.min(chunkStart + CHUNK_MS, now);
    let cursor = null;
    let pages = 0;
    do {
      const qs = new URLSearchParams({
        target_id: String(JOEL_DIALPAD_ID), target_type: 'user',
        started_after: String(chunkStart), started_before: String(chunkEnd),
      });
      if (cursor) qs.set('cursor', cursor);
      const page = await dpGet(`/call?${qs.toString()}`);
      for (const it of (page.items || [])) {
        const id = it?.call_id ?? it?.id;
        if (id != null) byId.set(String(id), it);
      }
      cursor = page.cursor || null;
      pages++;
      await sleep(300);
    } while (cursor);
    console.log(`  chunk ${new Date(chunkStart).toISOString().slice(0,10)}..${new Date(chunkEnd).toISOString().slice(0,10)}: ${pages} page(s), running unique=${byId.size}`);
    chunkStart = chunkEnd;
  }
  return [...byId.values()];
}

const sqlEsc = (v) => String(v).replace(/'/g, "''");

/** Coerce a Dialpad timestamp/duration to a finite number of ms, or NaN. The
 * REST /call list returns numeric ms epochs (cache-worker does `Number(...)`),
 * but be defensive against string/ISO so a stray value can't emit `NaN` into
 * the SQL and fail the whole INSERT batch. */
function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const p = Date.parse(v);
  return Number.isFinite(p) ? p : NaN;
}

async function main() {
  console.log(`Backfill cancelled cold calls — jobs ${JOBS.join(',')}, last ${monthsArg} month(s), Joel dialpad=${JOEL_DIALPAD_ID}\n`);

  console.log('1) Resolving Sourced candidates…');
  const sourced = await sourcedCandidateIds();
  console.log(`   → ${sourced.size} unique Sourced candidates\n`);

  console.log('2) Listing Joel\'s Dialpad calls…');
  const calls = await listJoelCalls();
  console.log(`   → ${calls.length} calls in window\n`);

  console.log('3) Selecting cancelled (never-connected) calls to in-scope candidates…');
  if (calls[0]) {
    console.log('  [verify] sample call keys:', Object.keys(calls[0]));
    console.log('  [verify] sample duration/total_duration/voicemail_link:',
      calls[0].duration, '/', calls[0].total_duration, '/', !!calls[0].voicemail_link);
  }
  // Never-connected = no talk time. Dialpad's `duration` is talk-time (excludes
  // ring), 0/absent when the call never connected; there is NO date_connected
  // field. Connected calls AND outbound voicemails-left both have duration > 0
  // and were recorded live (transcript flow), so they're already in RF — the
  // ONLY missed category is the no-talk cancelled calls (RF has zero of these),
  // so every selected row is 'cancelled' and no transcript probe / dedup is
  // needed. (A short ring-then-hangup with no talk is exactly a cancelled call.)
  const rows = [];
  let skippedBadTime = 0, connectedSkipped = 0;
  for (const call of calls) {
    const callId = call?.call_id ?? call?.id;
    if (callId == null) continue;
    if (call?.direction !== 'outbound') continue;
    const talkMs = toMs(call?.duration);
    if (Number.isFinite(talkMs) && talkMs > 0) { connectedSkipped++; continue; } // connected / VM-left → already in RF
    const contactId = call?.contact?.id;
    const m = typeof contactId === 'string' ? contactId.match(RF_UID_RE) : null;
    const rfCandidateId = m ? Number(m[1]) : null;
    if (rfCandidateId == null || !sourced.has(rfCandidateId)) continue;

    const dateStartedMs = toMs(call?.date_started ?? call?.event_timestamp);
    if (!Number.isFinite(dateStartedMs)) {
      // Never interpolate NaN — it would fail the entire INSERT batch.
      skippedBadTime++;
      console.warn(`  [skip] call ${callId}: unparseable date_started=${call?.date_started}`);
      continue;
    }
    const ringMs = toMs(call?.total_duration);
    rows.push({
      callId: String(callId),
      rfCandidateId,
      dateStartedMs,
      durationMs: Number.isFinite(ringMs) ? Math.round(ringMs) : null, // store ring time for reference
      outcome: 'cancelled',
    });
  }
  console.log(`   → ${rows.length} cancelled calls to Sourced candidates (connected/VM skipped=${connectedSkipped}${skippedBadTime ? `, bad-timestamp=${skippedBadTime}` : ''})\n`);

  const nowMs = Date.now();
  const values = rows.map(r =>
    `('${sqlEsc(r.callId)}', ${r.rfCandidateId}, '${sqlEsc(JOEL_DIALPAD_ID)}', ${r.dateStartedMs}, '${r.outcome}', ${Number.isFinite(r.durationMs) ? r.durationMs : 'NULL'}, ${nowMs})`
  );
  const sql = values.length
    ? `INSERT OR IGNORE INTO missed_cold_calls\n  (call_id, rf_candidate_id, target_dialpad_id, date_started_ms, outcome, duration_ms, cached_at_ms)\nVALUES\n${values.join(',\n')};\n`
    : '-- no rows to insert\n';

  const outPath = join(__dirname, outArg);
  writeFileSync(outPath, sql, 'utf8');
  console.log(`Wrote ${rows.length} rows → ${outPath}`);
  console.log(`\nApply with:\n  cd cache-worker && npx wrangler d1 execute RF_MCP_CACHE --remote --config wrangler.cache.jsonc --file ../scripts/${outArg}\n`);
}

main().catch((err) => { console.error('FATAL:', err.message); process.exit(1); });
