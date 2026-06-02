import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  WS_SUBPROTOCOL,
  TICKET_SUBPROTOCOL_PREFIX,
  UPSTREAM_ALARM_INTERVAL_MS,
  COOLDOWN_MS,
  MAX_QUEUE,
  MAX_DELIVERY_ATTEMPTS,
  DELIVER_TIMEOUT_MS,
} from '../src/music-do.js';

function stub() {
  const id = env.MUSIC_REMOTE.idFromName('test-' + crypto.randomUUID());
  return env.MUSIC_REMOTE.get(id);
}

// Enqueue a command through the real DO fetch path (index.js -> DO stub ->
// enqueueCommand), exactly as the entry router does. Returns the parsed body.
async function enqueue(s, { category, dashboardPath, body = null }) {
  const res = await s.fetch(
    new Request('https://do/enqueue-command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, dashboardPath, body }),
    }),
  );
  return { status: res.status, json: await res.json() };
}

// A fetch mock that records calls and replies with a fixed status. Spied onto
// globalThis.fetch so the DO's deliverCommand -> proxyToDashboard reaches it.
//
// `calls` records ONLY command-DELIVERY fetches (the /api/remote/* command
// sub-paths). The upstream now-playing WS open (/api/remote/nowplaying, triggered
// by a demand>0 alarm via openUpstream) is replied to with a fake `.webSocket` and
// is NOT counted as a delivery — otherwise a coexistence test counting deliveries
// would conflate the liveness WS open with a command delivery.
function mockFetch(replyStatus, replyBody = {}) {
  const calls = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    if (String(url).endsWith('/api/remote/nowplaying')) {
      // Upstream WS open — hand back a minimal fake socket; not a delivery.
      return Promise.resolve({ webSocket: { accept() {}, addEventListener() {} } });
    }
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(replyBody), {
        status: replyStatus,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  return { spy, calls };
}

// Open a now-playing client through the real WS-upgrade path: issue a ticket,
// then upgrade presenting it as a subprotocol. Returns the client WebSocket.
async function connectClient(s) {
  const issued = await s.fetch(
    new Request('https://do/ws-ticket', { method: 'POST' }),
  );
  const { ticket } = await issued.json();
  const upgrade = await s.fetch(
    new Request('https://do/music/now-playing', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': `${WS_SUBPROTOCOL}, ${TICKET_SUBPROTOCOL_PREFIX}${ticket}`,
      },
    }),
  );
  expect(upgrade.status).toBe(101);
  const ws = upgrade.webSocket;
  ws.accept();
  return ws;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const SNAPSHOT = {
  isPlaying: true,
  positionMs: 12000,
  track: {
    loadId: 'load-1',
    title: 'Around the World',
    artists: 'Daft Punk',
    album: 'Homework',
    artUrl: 'https://art.test/1.jpg',
    durationMs: 429000,
  },
};

describe('MusicRemoteState — WS-ticket store', () => {
  it('issues a ticket and redeems it exactly once (single-use, delete-on-read)', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance) => {
      const res = await instance.issueTicket();
      const { ticket } = await res.json();
      expect(typeof ticket).toBe('string');
      expect(await instance.redeemTicket(ticket)).toBe(true);
      // second redeem fails — single-use
      expect(await instance.redeemTicket(ticket)).toBe(false);
    });
  });

  it('rejects an unknown / empty ticket', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance) => {
      expect(await instance.redeemTicket('nope')).toBe(false);
      expect(await instance.redeemTicket(null)).toBe(false);
    });
  });

  it('rejects a WS upgrade with no valid ticket subprotocol', async () => {
    const s = stub();
    const resp = await s.fetch(
      new Request('https://do/music/now-playing', {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': WS_SUBPROTOCOL },
      }),
    );
    expect(resp.status).toBe(401);
  });
});

describe('MusicRemoteState — fan-out', () => {
  it('fans the persisted snapshot to a connecting client on upgrade', async () => {
    const s = stub();
    // Pre-persist a snapshot, then connect — the client must receive it immediately.
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('snapshot', SNAPSHOT);
      void instance;
    });
    const ws = await connectClient(s);
    const msg = await new Promise((resolve) => {
      ws.addEventListener('message', (e) => resolve(e.data), { once: true });
    });
    expect(JSON.parse(msg)).toEqual(SNAPSHOT);
  });

  it('fanOut delivers a verbatim snapshot string to every accepted socket', async () => {
    const s = stub();
    const ws = await connectClient(s);
    const received = new Promise((resolve) => {
      ws.addEventListener('message', (e) => resolve(e.data), { once: true });
    });
    await runInDurableObject(s, async (instance) => {
      instance.fanOut(JSON.stringify(SNAPSHOT));
    });
    expect(JSON.parse(await received)).toEqual(SNAPSHOT);
  });
});

describe('MusicRemoteState — demand-gate (post-eviction mechanism)', () => {
  beforeEach(() => {
    // sanity: the cadence is a named constant, not an inline magic value
    expect(UPSTREAM_ALARM_INTERVAL_MS).toBe(30_000);
  });

  it('(1) 0->1 connect arms an alarm and persists demand; the REAL webSocketClose handler drives demand back to 0 (excludes the closing socket), tears down upstream, and deletes the alarm', async () => {
    const s = stub();
    const ws = await connectClient(s);

    await runInDurableObject(s, async (instance, state) => {
      expect(await state.storage.get('demand')).toBe(1);
      const alarmAt = await state.storage.getAlarm();
      expect(alarmAt).toBeGreaterThan(Date.now());
      void instance;
    });

    // Invoke the REAL handler against the only socket. CRITICAL REGRESSION GUARD:
    // inside webSocketClose the closing socket is STILL present in
    // getWebSockets(), so the handler MUST exclude it (recomputeDemandAndReconcile(ws))
    // to reach demand=0. The prior test bypassed the handler — manually closing
    // each socket then calling recomputeDemandAndReconcile() with no arg, by which
    // point the set had already settled to 0 — and so MASKED the bug where the
    // last subscriber leaving left demand stuck at 1 and the alarm armed forever.
    await runInDurableObject(s, async (instance, state) => {
      const sockets = state.getWebSockets();
      expect(sockets.length).toBe(1); // the closing socket is still in the live set
      const theOnlySocket = sockets[0];

      // Force upstream "live" so we can prove the handler tears it down at 0.
      let upstreamClosed = false;
      instance.upstream = {
        readyState: WebSocket.OPEN,
        close() {
          upstreamClosed = true;
        },
      };

      await instance.webSocketClose(theOnlySocket);

      expect(await state.storage.get('demand')).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(upstreamClosed).toBe(true);
      expect(instance.upstream).toBeNull();
    });

    ws.close();
  });

  it('(2) alarm() with persisted demand>0 re-fans the persisted snapshot and re-arms', async () => {
    const s = stub();
    const ws = await connectClient(s);

    // Persist a snapshot + force demand>0, drop upstream to null (simulate eviction gap).
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('snapshot', SNAPSHOT);
      await state.storage.put('demand', 1);
      instance.upstream = null;
    });

    const received = new Promise((resolve) => {
      ws.addEventListener('message', (e) => resolve(e.data), { once: true });
    });

    await runInDurableObject(s, async (instance, state) => {
      // alarm() re-opens upstream. The derived dashboard WS is unreachable in the
      // test env, so openUpstream logs + leaves upstream null — but ensureUpstream
      // still returns "reopened", so the persisted snapshot is re-fanned; then it
      // re-arms because demand>0.
      await instance.alarm();
      const alarmAt = await state.storage.getAlarm();
      expect(alarmAt).toBeGreaterThan(Date.now());
    });

    expect(JSON.parse(await received)).toEqual(SNAPSHOT);
  });

  it('(4) openUpstream derives the WS URL from DASHBOARD_REMOTE_BASE and carries the frozen X-Remote-Key (escalation 5)', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance) => {
      // A fake upstream WebSocket so openUpstream completes without a real socket.
      // (A real Response can't be constructed with status 101 in workerd, so the
      // mock returns a minimal object exposing the `.webSocket` field openUpstream
      // reads — the fetch is what we're asserting on, not the Response shape.)
      const fakeWs = { accept() {}, addEventListener() {} };
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ webSocket: fakeWs });

      // The upstream URL is DERIVED from DASHBOARD_REMOTE_BASE
      // ('https://dashboard.test.invalid' in vitest miniflare bindings): the http(s)
      // scheme is KEPT (Workers opens an outbound WS by fetch()ing the http(s) URL
      // with an `Upgrade: websocket` header — a ws/wss scheme is rejected), plus
      // '/api/remote/nowplaying'. DASHBOARD_REMOTE_KEY = 'test-remote-key'.
      expect(instance.env.DASHBOARD_REMOTE_BASE).toBe('https://dashboard.test.invalid');
      expect(instance.env.DASHBOARD_REMOTE_KEY).toBe('test-remote-key');

      await instance.openUpstream();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://dashboard.test.invalid/api/remote/nowplaying');
      expect(init.headers.Upgrade).toBe('websocket');
      // The outbound credential is present by default (the contract's
      // outbound-auth requirement) — NOT silently omitted.
      expect(init.headers['X-Remote-Key']).toBe('test-remote-key');

      fetchSpy.mockRestore();
      instance.upstream = null;
    });
  });

  it('(5) the upstream message listener runs onUpstreamMessage DIRECTLY (no no-op ctx.waitUntil): a frame is parsed, persisted, and fanned verbatim', async () => {
    const s = stub();
    const ws = await connectClient(s);

    const received = new Promise((resolve) => {
      ws.addEventListener('message', (e) => resolve(e.data), { once: true });
    });

    await runInDurableObject(s, async (instance, state) => {
      // Capture the 'message' listener that openUpstream registers, so we can drive
      // a real upstream frame through it. A no-op ctx.waitUntil wrapper would still
      // let this work in-isolate, so we ALSO assert the promise the listener path
      // produces settles — proving the handler is invoked directly, not detached.
      let messageHandler = null;
      const fakeWs = {
        accept() {},
        addEventListener(type, fn) {
          if (type === 'message') messageHandler = fn;
        },
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ webSocket: fakeWs });
      // DASHBOARD_REMOTE_BASE is set in the vitest bindings, so openUpstream derives
      // the URL and runs the (mocked) fetch.
      await instance.openUpstream();
      expect(typeof messageHandler).toBe('function');

      // Drive a real upstream frame. The listener calls onUpstreamMessage directly;
      // await the underlying handler so the persist+fan completes before asserting.
      messageHandler({ data: JSON.stringify(SNAPSHOT) });
      await instance.onUpstreamMessage(JSON.stringify(SNAPSHOT));

      expect(await state.storage.get('snapshot')).toEqual(SNAPSHOT);

      fetchSpy.mockRestore();
      instance.upstream = null;
    });

    // The frame was fanned verbatim to the connected client (camelCase, unreshaped).
    expect(JSON.parse(await received)).toEqual(SNAPSHOT);

    ws.close();
  });

  it('(6) a rejection inside onUpstreamMessage is caught + logged by the listener, never an unhandled rejection (regression: ctx.waitUntil swallowed it)', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance) => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // Force onUpstreamMessage to reject (as a storage-write failure would).
      const boom = new Error('storage write failed');
      instance.onUpstreamMessage = () => Promise.reject(boom);

      let messageHandler = null;
      const fakeWs = {
        accept() {},
        addEventListener(type, fn) {
          if (type === 'message') messageHandler = fn;
        },
      };
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ webSocket: fakeWs });
      // DASHBOARD_REMOTE_BASE is set in the vitest bindings, so openUpstream runs.
      await instance.openUpstream();
      expect(typeof messageHandler).toBe('function');

      // Invoke the listener; the .catch must absorb the rejection and log it. The
      // listener returns undefined (no throw), and the rejection is handled — we
      // flush microtasks so the .catch runs before asserting.
      expect(() => messageHandler({ data: '{}' })).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = warnSpy.mock.calls[0][0];
      expect(logged.source).toBe('music-do');
      expect(logged.error).toBe('storage write failed');

      fetchSpy.mockRestore();
      warnSpy.mockRestore();
      instance.upstream = null;
    });
  });

  it('(3) lazy re-open: webSocketMessage forces ensureUpstream independent of the alarm', async () => {
    const s = stub();
    const ws = await connectClient(s);

    await runInDurableObject(s, async (instance) => {
      let opened = 0;
      const realOpen = instance.openUpstream.bind(instance);
      instance.openUpstream = async () => {
        opened += 1;
        return realOpen();
      };
      instance.upstream = null; // simulate a lapsed upstream
      await instance.webSocketMessage(instance.ctx.getWebSockets()[0], 'ping');
      // ensureUpstream saw a dead upstream and called openUpstream — proving the
      // lazy re-open path runs without any alarm.
      expect(opened).toBe(1);
    });

    ws.close();
  });
});

describe('MusicRemoteState — command queue + cooldowns', () => {
  beforeEach(() => {
    // sanity: the named constants are the documented values, not inline magic.
    expect(COOLDOWN_MS).toEqual({ skip: 5000, play: 5000, enqueue: 10000 });
    expect(MAX_QUEUE).toBe(100);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(2);
    expect(DELIVER_TIMEOUT_MS).toBe(5000);
  });

  // (A) CHANGE-A-at-DO-boundary: a play body { id:'3135556' } is delivered with the
  // id as a STRING (the IdBody{id:String} contract), reusing proxyToDashboard so
  // the outbound carries X-Remote-Key + Content-Type:application/json.
  it('(A) drain delivers { id:"3135556" } as a STRING with X-Remote-Key + JSON content-type (CHANGE A + proxy reuse)', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await enqueue(s, {
      category: 'play',
      dashboardPath: '/api/remote/songs/play',
      body: JSON.stringify({ id: '3135556' }),
    });
    await runInDurableObject(s, async (instance) => {
      await instance.drainOneEligible();
    });
    expect(calls.length).toBe(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://dashboard.test.local/api/remote/songs/play');
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({ id: '3135556' });
    expect(typeof sent.id).toBe('string');
    expect(init.headers['X-Remote-Key']).toBe('test-remote-key');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  // (A2) precision: a >2^53 id is delivered byte-identically (no Number round-trip).
  it('(A2) drain delivers a >2^53 id byte-identically (no Number round-trip)', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await enqueue(s, {
      category: 'play',
      dashboardPath: '/api/remote/songs/play',
      body: JSON.stringify({ id: '9007199254740993' }),
    });
    await runInDurableObject(s, async (instance) => {
      await instance.drainOneEligible();
    });
    expect(calls[0].init.body).toBe('{"id":"9007199254740993"}');
  });

  // (FIRST-EVER): a brand-new stub with lastExec UNSET — the first command of each
  // category must be eligible at t0 (the `?? 0` default). Without it, now>=NaN is
  // false and the command wedges.
  it('(FIRST-EVER) the first command of each category drains IMMEDIATELY (lastExec unset => ?? 0 eligible at t0)', async () => {
    for (const [category, dashboardPath, body] of [
      ['play', '/api/remote/songs/play', JSON.stringify({ id: '1' })],
      ['skip', '/api/remote/next', '{}'],
      ['enqueue', '/api/remote/songs/enqueue', JSON.stringify({ id: '2' })],
    ]) {
      const s = stub();
      const { calls } = mockFetch(200);
      await enqueue(s, { category, dashboardPath, body });
      await runInDurableObject(s, async (instance) => {
        await instance.drainOneEligible();
        // delivered + drained: queue empty, lastExec set.
        expect((await instance.ctx.storage.get('cmdQueue')) ?? []).toEqual([]);
      });
      expect(calls.length).toBe(1);
      vi.restoreAllMocks();
    }
  });

  // (B) FIFO order across two same-category commands (each separated by a cooldown).
  it('(B) FIFO order preserved across two same-category commands', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await enqueue(s, { category: 'skip', dashboardPath: '/api/remote/next', body: '{}' });
    await enqueue(s, { category: 'skip', dashboardPath: '/api/remote/prev', body: '{}' });
    await runInDurableObject(s, async (instance, state) => {
      // First drain: head (next) eligible at t0, delivered + shifted.
      await instance.drainOneEligible();
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe('https://dashboard.test.local/api/remote/next');
      // Second head (prev) is now under cooldown — drive lastExec back so it is
      // eligible, then drain. Order: prev follows next.
      await state.storage.put('lastExec:skip', Date.now() - COOLDOWN_MS.skip - 1);
      await instance.drainOneEligible();
      expect(calls.length).toBe(2);
      expect(calls[1].url).toBe('https://dashboard.test.local/api/remote/prev');
      expect((await state.storage.get('cmdQueue')) ?? []).toEqual([]);
    });
  });

  // (C) cooldown gating: two skips back-to-back — first drains, the second STAYS
  // (head unchanged) until lastExec+5000; the alarm is armed for exactly that time.
  it('(C) cooldown gates the second same-category command; head stays; alarm armed at lastExec+cooldown', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await enqueue(s, { category: 'skip', dashboardPath: '/api/remote/next', body: '{}' });
    await enqueue(s, { category: 'skip', dashboardPath: '/api/remote/prev', body: '{}' });
    await runInDurableObject(s, async (instance, state) => {
      await instance.drainOneEligible(); // delivers next, bumps lastExec:skip
      const last = await state.storage.get('lastExec:skip');
      expect(calls.length).toBe(1);

      // Second drain: prev is under cooldown — head stays, no new delivery.
      await instance.drainOneEligible();
      expect(calls.length).toBe(1);
      const queue = await state.storage.get('cmdQueue');
      expect(queue.length).toBe(1);
      expect(queue[0].dashboardPath).toBe('/api/remote/prev');

      // reconcileAlarm re-arms for lastExec+cooldown (demand 0, so drain is the min).
      await instance.reconcileAlarm();
      expect(await state.storage.getAlarm()).toBe(last + COOLDOWN_MS.skip);
    });
  });

  // (D) single-shot-per-wake: 3 DIFFERENT-category commands; alarm() delivers
  // EXACTLY ONE per invocation; the alarm stays armed while the queue is non-empty
  // and is deleted once drained AND demand===0.
  it('(D) alarm() drains EXACTLY ONE command per wake; armed while queue non-empty, null once drained+demand0', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    // Seed the queue DIRECTLY (not via the auto-alarming enqueue fetch path, whose
    // t0-eligible drain would auto-fire in the harness and race the manual steps).
    // demand 0 throughout — so the alarm's ONLY responsibility is the drain.
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.put('cmdQueue', [
        { category: 'skip', dashboardPath: '/api/remote/next', body: '{}', enqueuedAt: Date.now(), attempts: 0 },
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '2' }), enqueuedAt: Date.now(), attempts: 0 },
      ]);
      for (let i = 1; i <= 3; i++) {
        await instance.alarm();
        expect(calls.length).toBe(i); // exactly one delivery per wake
        const queue = (await state.storage.get('cmdQueue')) ?? [];
        if (queue.length > 0) {
          expect(await state.storage.getAlarm()).not.toBeNull();
        }
      }
      expect((await state.storage.get('cmdQueue')) ?? []).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  // (E) overflow (runaway backstop): push MAX_QUEUE, then one more -> LOUD warn +
  // the DISTINCT { ok:true, queued:false, dropped:'queue_full' } envelope.
  it('(E) MAX_QUEUE overflow -> LOUD warn + { ok:true, queued:false, dropped:"queue_full" }', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Pre-seed the queue at MAX_QUEUE directly (avoid 100 reconcile round-trips) AND
    // push lastExec:skip far into the future so the seeded head is NOT cooldown-
    // eligible — that keeps the auto-fired drain alarm (armed on the next DO
    // construction for the t0-eligible head) from delivering and emitting an
    // unrelated transient warn that would mask the single overflow warn we assert.
    await runInDurableObject(s, async (instance, state) => {
      const full = Array.from({ length: MAX_QUEUE }, () => ({
        category: 'skip',
        dashboardPath: '/api/remote/next',
        body: '{}',
        enqueuedAt: Date.now(),
        attempts: 0,
      }));
      await state.storage.put('cmdQueue', full);
      await state.storage.put('lastExec:skip', Date.now() + 60_000);
      void instance;
    });
    const { status, json } = await enqueue(s, {
      category: 'skip',
      dashboardPath: '/api/remote/next',
      body: '{}',
    });
    expect(status).toBe(202);
    expect(json).toEqual({ ok: true, queued: false, dropped: 'queue_full' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0].source).toBe('music-do');
    expect(warnSpy.mock.calls[0][0].message).toMatch(/overflow/i);
    warnSpy.mockRestore();
  });

  // (F) COEXISTENCE: reconcileAlarm sets min(drain, liveness); and alarm() services
  // liveness FIRST even when a delivery hangs to the timeout.
  it('(F) reconcileAlarm sets min(drain, liveness); liveness serviced BEFORE a hung delivery resolves', async () => {
    // F1 — a near-term drain is the min over a far liveness. Seed the queue DIRECTLY
    // (the auto-alarming enqueue path would drain the t0-eligible head before this
    // body runs, leaving an empty queue and no drain candidate).
    const s1 = stub();
    await runInDurableObject(s1, async (instance, state) => {
      await state.storage.put('demand', 1); // liveness at now+30s
      await state.storage.put('lastExec:skip', Date.now() - COOLDOWN_MS.skip - 1);
      await state.storage.put('cmdQueue', [
        { category: 'skip', dashboardPath: '/api/remote/next', body: '{}', enqueuedAt: Date.now(), attempts: 0 },
      ]);
      await instance.reconcileAlarm();
      const at = await state.storage.getAlarm();
      // The drain (≈now) is far nearer than liveness (now+30s).
      expect(at).toBeLessThan(Date.now() + UPSTREAM_ALARM_INTERVAL_MS);
    });

    // F2 — a far-future drain yields the liveness time as the min.
    const s2 = stub();
    await runInDurableObject(s2, async (instance, state) => {
      await state.storage.put('demand', 1);
      // lastExec far future => drain ~now+65s, so liveness (now+30s) is the min.
      await state.storage.put('lastExec:skip', Date.now() + 60_000);
      await state.storage.put('cmdQueue', [
        { category: 'skip', dashboardPath: '/api/remote/next', body: '{}', enqueuedAt: Date.now(), attempts: 0 },
      ]);
      await instance.reconcileAlarm();
      const at = await state.storage.getAlarm();
      expect(at).toBeLessThanOrEqual(Date.now() + UPSTREAM_ALARM_INTERVAL_MS + 50);
      expect(at).toBeGreaterThan(Date.now() + UPSTREAM_ALARM_INTERVAL_MS - 1000);
    });

    // F3 — liveness-first ORDERING: even when the delivery hangs to the
    // AbortController timeout, the cheap liveness fan must run BEFORE the drain's
    // delivery. Prove the order structurally by recording when fanPersistedSnapshot
    // (liveness) vs deliverCommand (drain) is invoked: the fan must be recorded
    // first. A delivery that hangs is represented by a deferred so the assertion
    // does not wait the full real DELIVER_TIMEOUT_MS; releasing it lets alarm()
    // settle cleanly (no abort, no retry refire).
    const s3 = stub();
    let releaseDelivery;
    const deliveryGate = new Promise((resolve) => {
      releaseDelivery = resolve;
    });
    await runInDurableObject(s3, async (instance, state) => {
      await state.storage.put('demand', 1);
      await state.storage.put('snapshot', SNAPSHOT);
      await state.storage.put('lastExec:skip', Date.now() - COOLDOWN_MS.skip - 1);
      await state.storage.put('cmdQueue', [
        { category: 'skip', dashboardPath: '/api/remote/next', body: '{}', enqueuedAt: Date.now(), attempts: 0 },
      ]);

      const order = [];
      // ensureUpstream must report a reopen so the liveness phase fans the snapshot.
      instance.ensureUpstream = () => Promise.resolve(true);
      const realFan = instance.fanPersistedSnapshot.bind(instance);
      instance.fanPersistedSnapshot = async () => {
        order.push('liveness-fan');
        return realFan();
      };
      instance.deliverCommand = async () => {
        order.push('deliver');
        await deliveryGate; // "hung" delivery, released below
        return { terminal: true, traceOutcome: 'delivered' };
      };

      const alarmPromise = instance.alarm();
      // Release the held delivery so alarm() can settle, then assert the recorded
      // call order: the liveness fan was invoked BEFORE the drain's delivery —
      // proving liveness-first ordering even with a (briefly) hung delivery.
      releaseDelivery();
      await alarmPromise;
      expect(order).toEqual(['liveness-fan', 'deliver']);
      expect((await state.storage.get('cmdQueue')) ?? []).toEqual([]);
    });
  });

  // (G) demand>0 + no eligible command: alarm stays armed (liveness); the command
  // drains once eligible.
  it('(G) demand>0 + no eligible command -> alarm armed (liveness); drains once eligible', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 1);
      // A command under cooldown.
      await state.storage.put('lastExec:skip', Date.now());
      await state.storage.put('cmdQueue', [
        { category: 'skip', dashboardPath: '/api/remote/next', body: '{}', enqueuedAt: Date.now(), attempts: 0 },
      ]);
      await instance.alarm();
      expect(calls.length).toBe(0); // under cooldown, not delivered
      expect(await state.storage.getAlarm()).not.toBeNull(); // armed (liveness + drain)

      // Make it eligible and drain.
      await state.storage.put('lastExec:skip', Date.now() - COOLDOWN_MS.skip - 1);
      await instance.alarm();
      expect(calls.length).toBe(1);
    });
  });

  // (H) drain throws -> alarm() still re-arms via the finally (a drain exception
  // must not orphan the liveness alarm).
  it('(H) a throwing drain still re-arms the alarm via the finally (error propagates to the platform for retry)', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 1); // liveness keeps an alarm warranted
      instance.drainOneEligible = () => Promise.reject(new Error('boom'));
      // The finally re-arms; the original error still PROPAGATES (the platform
      // retries alarm() on an uncaught throw — the try/finally complements that, it
      // does not swallow). So alarm() rejects, AND the alarm is re-armed.
      await expect(instance.alarm()).rejects.toThrow(/boom/);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  // (I) demand 0 + queue empty: reconcileAlarm deletes the alarm AND closeUpstream
  // ran (a drain-only wake at demand 0 tears the upstream down).
  it('(I) demand 0 + queue empty -> alarm deleted + upstream closed', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.setAlarm(Date.now() + 1000); // a stale alarm to be cleared
      let closed = false;
      instance.upstream = { readyState: WebSocket.OPEN, close() { closed = true; } };
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(closed).toBe(true);
      expect(instance.upstream).toBeNull();
    });
  });

  // (J) closing-socket race: after the REAL webSocketClose of the LAST socket, the
  // alarm is null AND demand===0 AND upstream torn down — under reconcileAlarm
  // reading PERSISTED demand, not getWebSockets() (which still holds the closing
  // socket inside the handler).
  it('(J) closing-socket race: last webSocketClose -> alarm null, demand 0, upstream down (persisted-demand read)', async () => {
    const s = stub();
    const ws = await connectClient(s);
    await runInDurableObject(s, async (instance, state) => {
      const sockets = state.getWebSockets();
      expect(sockets.length).toBe(1); // the closing socket is still in the live set
      let closed = false;
      instance.upstream = { readyState: WebSocket.OPEN, close() { closed = true; } };
      await instance.webSocketClose(sockets[0]);
      expect(await state.storage.get('demand')).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(closed).toBe(true);
      expect(instance.upstream).toBeNull();
    });
    ws.close();
  });

  // (K) HANG: a never-resolving fetch aborts at DELIVER_TIMEOUT_MS -> transient;
  // attempts increments; after MAX the head is dropped (LOUD warn + drain-trace
  // 'dropped-after-max-transient-timeout').
  it('(K) a HUNG delivery aborts at the timeout (transient); dropped after MAX with the timeout trace', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Seed DIRECTLY (no auto-alarming enqueue) and drive the drain manually, so the
    // attempt accounting + the single give-up trace are deterministic.
    await runInDurableObject(s, async (instance, state) => {
      const hung = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (url, init) =>
          new Promise((_resolve, reject) => {
            const sig = init?.signal;
            if (sig) {
              sig.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              );
            }
          }),
      );
      await state.storage.put('demand', 0);
      await state.storage.put('cmdQueue', [
        { category: 'skip', dashboardPath: '/api/remote/next', body: '{}', enqueuedAt: Date.now(), attempts: 0 },
      ]);

      // First drain: aborts at DELIVER_TIMEOUT_MS -> transient (attempts 0->1), kept.
      await instance.drainOneEligible();
      let queue = await state.storage.get('cmdQueue');
      expect(queue.length).toBe(1);
      expect(queue[0].attempts).toBe(1);

      // Second drain: transient again -> give-up (attempts+1 >= MAX), head dropped.
      await instance.drainOneEligible();
      queue = (await state.storage.get('cmdQueue')) ?? [];
      expect(queue).toEqual([]);
      hung.mockRestore();
    });
    // Both delivery failures were LOUD; the give-up drain-trace records the timeout.
    expect(warnSpy).toHaveBeenCalled();
    const traces = logSpy.mock.calls
      .map((c) => c[0])
      .filter((o) => o && o.event === 'drain');
    expect(traces.length).toBe(1);
    expect(traces[0].outcome).toBe('dropped-after-max-transient-timeout');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  }, 20_000);

  // (L) 5xx transient: first attempt keeps the head (attempts=1, NO lastExec bump),
  // second attempt drops with the 5xx trace.
  it('(L) a 5xx is transient: kept on first attempt, dropped on second (drain-trace dropped-after-max-dashboard-error-503)', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInDurableObject(s, async (instance, state) => {
      const f = mockFetch(503);
      await state.storage.put('demand', 0);
      await state.storage.put('cmdQueue', [
        { category: 'skip', dashboardPath: '/api/remote/next', body: '{}', enqueuedAt: Date.now(), attempts: 0 },
      ]);

      await instance.drainOneEligible();
      let queue = await state.storage.get('cmdQueue');
      expect(queue.length).toBe(1); // NOT dropped on first transient
      expect(queue[0].attempts).toBe(1);
      // No lastExec bump on a non-drained transient.
      expect(await state.storage.get('lastExec:skip')).toBeUndefined();

      await instance.drainOneEligible();
      queue = (await state.storage.get('cmdQueue')) ?? [];
      expect(queue).toEqual([]); // dropped on second (give-up)
      f.spy.mockRestore();
    });
    const traces = logSpy.mock.calls.map((c) => c[0]).filter((o) => o && o.event === 'drain');
    expect(traces.length).toBe(1);
    expect(traces[0].outcome).toBe('dropped-after-max-dashboard-error-503');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  // (M) 4xx terminal: dropped on the FIRST attempt (permanently-rejected), lastExec
  // bumped, LOUD warn, drain-trace 'dashboard-rejected-422' (NOT 'delivered').
  it('(M) a 4xx is terminal: dropped on the FIRST attempt, lastExec bumped, trace dashboard-rejected-422', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFetch(422);
    await enqueue(s, { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }) });
    await runInDurableObject(s, async (instance, state) => {
      await instance.drainOneEligible();
      expect((await state.storage.get('cmdQueue')) ?? []).toEqual([]); // dropped first try
      expect(await state.storage.get('lastExec:play')).toBeGreaterThan(0); // lastExec bumped
    });
    const traces = logSpy.mock.calls.map((c) => c[0]).filter((o) => o && o.event === 'drain');
    expect(traces.length).toBe(1);
    expect(traces[0].outcome).toBe('dashboard-rejected-422');
    expect(traces[0].attempt).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  // (N) constructor arm-only: a reconstructed isolate ARMS the drain for a
  // persisted-undrained queue (demand 0) and NEVER deletes an existing alarm when
  // both responsibilities are idle.
  it('(N) constructor reconcileAlarm is ARM-ONLY: arms a persisted-undrained queue; never deletes when idle', async () => {
    // N1 — persisted-undrained queue + demand 0: the constructor arms the drain.
    const s1 = stub();
    await runInDurableObject(s1, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.put('cmdQueue', [
        { category: 'skip', dashboardPath: '/api/remote/next', body: '{}', enqueuedAt: Date.now(), attempts: 0 },
      ]);
      // Re-run the arm-only reconcile the constructor would run post-eviction.
      await instance.reconcileAlarm({ armOnly: true });
      expect(await state.storage.getAlarm()).not.toBeNull(); // armed for the drain
    });

    // N2 — empty queue + demand 0 + a pre-existing alarm: armOnly must NOT delete it.
    const s2 = stub();
    await runInDurableObject(s2, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.delete('cmdQueue');
      const preset = Date.now() + 5000;
      await state.storage.setAlarm(preset);
      await instance.reconcileAlarm({ armOnly: true });
      expect(await state.storage.getAlarm()).toBe(preset); // left intact
    });
  });
});
