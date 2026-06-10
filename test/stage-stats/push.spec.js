import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { applyStageEventsMigration } from '../helpers/stage-events-migrate.js';
import { upsertRows } from '../../src/stage-stats/store.js';
import { recomputeAndPush } from '../../src/stage-stats/push.js';
import { currentWeekWindowLondon } from '../../src/stage-stats/week.js';
import { handleAggregatePull } from '../../src/stage-stats/pull.js';

const PROD = 'https://music.example.com';
const DEV = 'https://music-dev.example.com';

const pushEnv = (over = {}) => ({
  ...env,
  DASHBOARD_REMOTE_BASE: PROD,
  DASHBOARD_REMOTE_BASE_DEV: DEV,
  DASHBOARD_REMOTE_KEY: 'remote-key',
  ...over,
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(async () => {
  await applyStageEventsMigration(env);
  // one current-week CV crossing so the pushed aggregate is non-empty
  const week = currentWeekWindowLondon(Date.now());
  await upsertRows(
    env,
    [
      {
        candidateId: 50256,
        jobId: 984,
        enteredRaw: '2026-06-08T08:45:00+0000',
        enteredMs: week.startMs + 3_600_000,
        fromStage: 'Sourced',
        toStage: 'CV Sent',
        moverRfId: 900005,
        isCvCross: true,
        isIvLanding: false,
      },
    ],
    'webhook',
    Date.now(),
  );
});

/** fetch mock returning per-origin responses; records every push request. */
function mockPushTargets(respond) {
  const calls = [];
  globalThis.fetch = vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init, body: init?.body });
    return respond(url, calls);
  });
  return calls;
}

const ok200 = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

describe('recomputeAndPush', () => {
  it('fans out the identical §4.1 body to both targets with X-Remote-Key', async () => {
    const calls = mockPushTargets(() => ok200());
    await recomputeAndPush(pushEnv());

    expect(calls).toHaveLength(2);
    const urls = calls.map((c) => c.url).sort();
    expect(urls).toEqual([
      `${DEV}/api/remote/stats/stage-weekly`,
      `${PROD}/api/remote/stats/stage-weekly`,
    ]);
    expect(calls[0].body).toBe(calls[1].body); // byte-identical payload
    for (const c of calls) {
      expect(c.init.method).toBe('POST');
      expect(c.init.headers['X-Remote-Key']).toBe('remote-key');
    }

    const payload = JSON.parse(calls[0].body);
    const week = currentWeekWindowLondon(Date.now());
    expect(payload.schema).toBe(1);
    expect(payload.windowStartMs).toBe(week.startMs);
    expect(payload.windowEndMs).toBe(week.endMs);
    expect(typeof payload.asOfMs).toBe('number');
    expect(payload.cvSent).toEqual([{ rfUserId: 900005, count: 1 }]);
    expect(payload.firstInterviews).toEqual([]);
  });

  it('skips entirely (no fetch) when DASHBOARD_REMOTE_BASE is unset', async () => {
    const calls = mockPushTargets(() => ok200());
    await recomputeAndPush(pushEnv({ DASHBOARD_REMOTE_BASE: undefined }));
    expect(calls).toHaveLength(0);
  });

  it('skips entirely when DASHBOARD_REMOTE_KEY is unset', async () => {
    const calls = mockPushTargets(() => ok200());
    await recomputeAndPush(pushEnv({ DASHBOARD_REMOTE_KEY: undefined }));
    expect(calls).toHaveLength(0);
  });

  it('single-target when DASHBOARD_REMOTE_BASE_DEV is unset', async () => {
    const calls = mockPushTargets(() => ok200());
    await recomputeAndPush(pushEnv({ DASHBOARD_REMOTE_BASE_DEV: undefined }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PROD}/api/remote/stats/stage-weekly`);
  });

  it('retries once on 5xx then gives up (the puller heals)', async () => {
    const calls = mockPushTargets(() => new Response('boom', { status: 503 }));
    await recomputeAndPush(pushEnv({ DASHBOARD_REMOTE_BASE_DEV: undefined }));
    expect(calls).toHaveLength(2); // initial + one retry, no more
  });

  it('retries once on a network error then gives up', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('connect refused'));
    await recomputeAndPush(pushEnv({ DASHBOARD_REMOTE_BASE_DEV: undefined }));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 409 (window_mismatch / stale are expected)', async () => {
    const calls = mockPushTargets(
      () => new Response(JSON.stringify({ ok: false, reason: 'window_mismatch' }), { status: 409 }),
    );
    await recomputeAndPush(pushEnv({ DASHBOARD_REMOTE_BASE_DEV: undefined }));
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry a 404 (target still runs a pre-stats dashboard build)', async () => {
    const calls = mockPushTargets(() => new Response('not found', { status: 404 }));
    await recomputeAndPush(pushEnv({ DASHBOARD_REMOTE_BASE_DEV: undefined }));
    expect(calls).toHaveLength(1);
  });

  it('absorbs a D1 read failure (never throws — webhook runs it in waitUntil)', async () => {
    const calls = mockPushTargets(() => ok200());
    const brokenEnv = pushEnv({
      STAGE_EVENTS: {
        prepare: () => ({ bind: () => ({}) }),
        batch: () => Promise.reject(new Error('D1 unavailable')),
      },
    });
    await expect(recomputeAndPush(brokenEnv)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0); // no push attempted with no aggregate
  });

  it('a failing dev target never affects the prod outcome', async () => {
    const calls = mockPushTargets((url) =>
      url.startsWith(DEV) ? new Response('down', { status: 502 }) : ok200(),
    );
    await recomputeAndPush(pushEnv());
    const prodCalls = calls.filter((c) => c.url.startsWith(PROD));
    const devCalls = calls.filter((c) => c.url.startsWith(DEV));
    expect(prodCalls).toHaveLength(1); // succeeded first try
    expect(devCalls).toHaveLength(2); // retried once, then gave up
  });
});

describe('GET /stats/stage-aggregate (pull)', () => {
  const pullRequest = (qs, token = env.STATS_PULL_TOKEN) => {
    const url = new URL(`http://example.com/stats/stage-aggregate?${qs}`);
    const request = new Request(url, {
      headers: token === null ? {} : { 'X-Stats-Token': token },
    });
    return [request, url];
  };

  it('401s a missing or wrong token (fail closed)', async () => {
    for (const token of [null, 'wrong']) {
      const [request, url] = pullRequest('afterMs=0&beforeMs=1', token);
      const res = await handleAggregatePull(request, env, url);
      expect(res.status).toBe(401);
    }
  });

  it('400s missing / non-numeric / inverted windows', async () => {
    // 'beforeMs=5' is the load-bearing case: a missing afterMs must NOT be
    // coerced to 0 ("since the epoch") by Number(null).
    for (const qs of ['', 'afterMs=1', 'beforeMs=5', 'afterMs=a&beforeMs=2', 'afterMs=5&beforeMs=5', 'afterMs=9&beforeMs=2']) {
      const [request, url] = pullRequest(qs);
      const res = await handleAggregatePull(request, env, url);
      expect(res.status).toBe(400);
    }
  });

  it('echoes the caller-chosen window and returns the aggregate', async () => {
    const week = currentWeekWindowLondon(Date.now());
    const [request, url] = pullRequest(`afterMs=${week.startMs}&beforeMs=${week.endMs}`);
    const res = await handleAggregatePull(request, env, url);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema).toBe(1);
    expect(body.windowStartMs).toBe(week.startMs);
    expect(body.windowEndMs).toBe(week.endMs);
    expect(body.cvSent).toEqual([{ rfUserId: 900005, count: 1 }]);
    expect(body.firstInterviews).toEqual([]);
  });
});
