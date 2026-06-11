import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { applyStageEventsMigration } from '../helpers/stage-events-migrate.js';
import { upsertRows, computeAggregate } from '../../src/stage-stats.js';

const DAVE = 900005;
const CAROL = 900004;

// Week of Mon 2026-06-08 (BST): [Sun 23:00Z, next Sun 23:00Z)
const WEEK_START = Date.parse('2026-06-07T23:00:00Z');
const WEEK_END = Date.parse('2026-06-14T23:00:00Z');

const row = (over = {}) => ({
  candidateId: 50256,
  jobId: 984,
  enteredRaw: '2026-06-08T08:45:00+0000',
  enteredMs: Date.parse('2026-06-08T08:45:00Z'),
  fromStage: 'Sourced',
  toStage: 'CV Sent',
  moverRfId: DAVE,
  isCvCross: true,
  isIvLanding: false,
  ...over,
});

const selectAll = async () =>
  (await env.STAGE_EVENTS.prepare('SELECT * FROM stage_events ORDER BY entered_ms').all()).results;

beforeEach(async () => {
  await applyStageEventsMigration(env);
});

describe('upsertRows', () => {
  it('is idempotent on the (candidate, job, entered_raw) identity', async () => {
    await upsertRows(env, [row()], 'webhook', 1000);
    await upsertRows(env, [row()], 'reconcile', 2000);
    const rows = await selectAll();
    expect(rows).toHaveLength(1);
    // source + first_seen_ms keep their original values (first-sighting provenance)
    expect(rows[0].source).toBe('webhook');
    expect(rows[0].first_seen_ms).toBe(1000);
  });

  it('updates classification flags in place on conflict (label-change re-run heals)', async () => {
    await upsertRows(env, [row({ isCvCross: false, isIvLanding: false })], 'backfill', 1000);
    await upsertRows(env, [row({ isCvCross: true, isIvLanding: true })], 'backfill', 2000);
    const rows = await selectAll();
    expect(rows[0].is_cv_cross).toBe(1);
    expect(rows[0].is_iv_landing).toBe(1);
  });

  it('COALESCEs the mover: an attributed sighting is never overwritten by an unattributed one', async () => {
    await upsertRows(env, [row({ moverRfId: null })], 'webhook', 1000);
    let rows = await selectAll();
    expect(rows[0].mover_rf_id).toBeNull();

    // attribution arrives later
    await upsertRows(env, [row({ moverRfId: DAVE })], 'reconcile', 2000);
    rows = await selectAll();
    expect(rows[0].mover_rf_id).toBe(DAVE);

    // a later unattributed sighting does NOT erase it
    await upsertRows(env, [row({ moverRfId: null })], 'reconcile', 3000);
    rows = await selectAll();
    expect(rows[0].mover_rf_id).toBe(DAVE);
  });

  it('stores a missing to_stage as the empty string (NOT NULL column)', async () => {
    await upsertRows(env, [row({ toStage: null, isCvCross: false })], 'webhook', 1000);
    const rows = await selectAll();
    expect(rows[0].to_stage).toBe('');
  });

  it('an unchanged replay writes NOTHING (changed=0); a real change writes', async () => {
    expect(await upsertRows(env, [row()], 'webhook', 1000)).toEqual({ attempted: 1, changed: 1 });
    // idempotent replay — the conditional DO-UPDATE WHERE skips the write
    expect(await upsertRows(env, [row()], 'reconcile', 2000)).toEqual({ attempted: 1, changed: 0 });
    // a flag fix (label/pipeline change re-run) IS a write
    expect(await upsertRows(env, [row({ isIvLanding: true })], 'backfill', 3000)).toEqual({
      attempted: 1,
      changed: 1,
    });
  });

  it('mover changes count honestly: attribution arriving = changed, null replay = no-op', async () => {
    await upsertRows(env, [row({ moverRfId: null })], 'webhook', 1000);
    expect((await upsertRows(env, [row({ moverRfId: DAVE })], 'reconcile', 2000)).changed).toBe(1);
    expect((await upsertRows(env, [row({ moverRfId: null })], 'reconcile', 3000)).changed).toBe(0);
    expect((await selectAll())[0].mover_rf_id).toBe(DAVE);
  });
});

describe('computeAggregate — latest-event-wins per (candidate, job) pair', () => {
  it('reproduces the spec §3 worked example: 1 CV for dave, 1 IV for carol', async () => {
    // candidate 50256 / job 984, one BST week:
    //  #1 Mon 09:45  Sourced → CV Sent          dave    (cv)
    //  #2 Tue 11:00  CV Sent → 1st Interview    dave    (iv)
    //  #3 Wed 09:00  1st Interview → CV Sent    carol  (revert — neither)
    //  #4 Wed 09:01  CV Sent → 1st Interview    carol  (iv)
    await upsertRows(
      env,
      [
        row({
          enteredRaw: '2026-06-08T08:45:00+0000',
          enteredMs: Date.parse('2026-06-08T08:45:00Z'),
        }),
        row({
          enteredRaw: '2026-06-09T10:00:00+0000',
          enteredMs: Date.parse('2026-06-09T10:00:00Z'),
          fromStage: 'CV Sent',
          toStage: '1st Interview',
          isCvCross: false,
          isIvLanding: true,
        }),
        row({
          enteredRaw: '2026-06-10T08:00:00+0000',
          enteredMs: Date.parse('2026-06-10T08:00:00Z'),
          fromStage: '1st Interview',
          toStage: 'CV Sent',
          moverRfId: CAROL,
          isCvCross: false,
          isIvLanding: false,
        }),
        row({
          enteredRaw: '2026-06-10T08:01:00+0000',
          enteredMs: Date.parse('2026-06-10T08:01:00Z'),
          fromStage: 'CV Sent',
          toStage: '1st Interview',
          moverRfId: CAROL,
          isCvCross: false,
          isIvLanding: true,
        }),
      ],
      'backfill',
      1000,
    );

    const agg = await computeAggregate(env, WEEK_START, WEEK_END);
    expect(agg.cvSent).toEqual([{ rfUserId: DAVE, count: 1 }]);
    // dave's Tue landing no longer counts — carol's Wed wiggle is the latest IV truth.
    expect(agg.firstInterviews).toEqual([{ rfUserId: CAROL, count: 1 }]);
  });

  it('counts a pair only when its LATEST qualifying event falls inside the window', async () => {
    // Crossing inside the week, then a RE-crossing the following week: the
    // latest truth moved out of the window, so the week loses the pair.
    await upsertRows(
      env,
      [
        row(),
        row({
          enteredRaw: '2026-06-16T09:00:00+0000',
          enteredMs: Date.parse('2026-06-16T09:00:00Z'),
          moverRfId: CAROL,
        }),
      ],
      'backfill',
      1000,
    );
    const week1 = await computeAggregate(env, WEEK_START, WEEK_END);
    expect(week1.cvSent).toEqual([]);
    const week2 = await computeAggregate(env, WEEK_END, WEEK_END + 7 * 86_400_000);
    expect(week2.cvSent).toEqual([{ rfUserId: CAROL, count: 1 }]);
  });

  it('counts the same candidate on two jobs as two pairs', async () => {
    await upsertRows(env, [row(), row({ jobId: 985 })], 'backfill', 1000);
    const agg = await computeAggregate(env, WEEK_START, WEEK_END);
    expect(agg.cvSent).toEqual([{ rfUserId: DAVE, count: 2 }]);
  });

  it('returns NULL movers as rfUserId null (they still occupy the latest slot)', async () => {
    // Attributed crossing, then a LATER unattributed crossing for the same
    // pair: latest truth wins, the attributed count is suppressed.
    await upsertRows(
      env,
      [
        row(),
        row({
          enteredRaw: '2026-06-11T09:00:00+0000',
          enteredMs: Date.parse('2026-06-11T09:00:00Z'),
          moverRfId: null,
        }),
      ],
      'backfill',
      1000,
    );
    const agg = await computeAggregate(env, WEEK_START, WEEK_END);
    expect(agg.cvSent).toEqual([{ rfUserId: null, count: 1 }]);
  });

  it('prefers an attributed row over an unattributed duplicate at the same instant', async () => {
    // Two rows, same entered_ms, different verbatim strings (RF's +0000 vs
    // +00:00 shapes) — the (mover_rf_id IS NULL) ASC tiebreak picks dave.
    await upsertRows(
      env,
      [
        row({ enteredRaw: '2026-06-08T08:45:00+0000', moverRfId: DAVE }),
        row({ enteredRaw: '2026-06-08T08:45:00+00:00', moverRfId: null }),
      ],
      'backfill',
      1000,
    );
    const agg = await computeAggregate(env, WEEK_START, WEEK_END);
    expect(agg.cvSent).toEqual([{ rfUserId: DAVE, count: 1 }]);
  });

  it('window edges are half-open [after, before)', async () => {
    await upsertRows(
      env,
      [
        row({ enteredRaw: 'at-start', enteredMs: WEEK_START }),
        row({
          candidateId: 60000,
          enteredRaw: 'at-end',
          enteredMs: WEEK_END,
          moverRfId: CAROL,
        }),
      ],
      'backfill',
      1000,
    );
    const agg = await computeAggregate(env, WEEK_START, WEEK_END);
    expect(agg.cvSent).toEqual([{ rfUserId: DAVE, count: 1 }]);
  });
});
