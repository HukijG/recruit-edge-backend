import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  WS_SUBPROTOCOL,
  TICKET_SUBPROTOCOL_PREFIX,
  UPSTREAM_ALARM_INTERVAL_MS,
  COOLDOWN_MS,
  CATEGORY_MODE,
  PREV_BURST_LIMIT,
  PREV_BURST_WINDOW_MS,
  PREV_MIN_SPACING_MS,
  PLAY_DEBOUNCE_SETTLE_MS,
  PLAY_MAX_DEFER_MS,
  MAX_QUEUE,
  MAX_DELIVERY_ATTEMPTS,
  DELIVER_TIMEOUT_MS,
  UPSTREAM_OPEN_TIMEOUT_MS,
} from '../src/music-do.js';

function stub() {
  const id = env.MUSIC_REMOTE.idFromName('test-' + crypto.randomUUID());
  return env.MUSIC_REMOTE.get(id);
}

// Send a command through the real DO fetch path (index.js -> DO stub -> command()),
// exactly as the entry router does. Returns status + parsed body.
async function sendCommand(s, { category, dashboardPath, body = null }) {
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
    // sanity: the cadence + upstream-open timeout are named constants, not inline
    // magic values.
    expect(UPSTREAM_ALARM_INTERVAL_MS).toBe(30_000);
    expect(UPSTREAM_OPEN_TIMEOUT_MS).toBe(5000);
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

  it('(7) a HUNG upstream WS open aborts at UPSTREAM_OPEN_TIMEOUT_MS and leaves upstream null (parity with deliverCommand)', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runInDurableObject(s, async (instance) => {
      // A dashboard that ACCEPTS the connection then HANGS — fetch never resolves
      // except via the AbortController. Without the timeout this would wedge
      // openUpstream (and, via the constructor's blockConcurrencyWhile, the whole
      // DO). With it, the abort rejects the fetch and folds into the unreachable
      // catch: log + upstream null + retry-next-interval.
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

      // openUpstream must RETURN (not hang) at the timeout, with upstream left null.
      await instance.openUpstream();
      expect(instance.upstream).toBeNull();

      // The hang was LOUD (structured warn naming the timeout) — not silent.
      expect(warnSpy).toHaveBeenCalled();
      const logged = warnSpy.mock.calls[warnSpy.mock.calls.length - 1][0];
      expect(logged.source).toBe('music-do');
      expect(logged.message).toMatch(/timed out|hung/i);

      hung.mockRestore();
    });
    warnSpy.mockRestore();
  }, 20_000);

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


describe('MusicRemoteState — command rate-limiting (four modes)', () => {
  beforeEach(() => {
    // sanity: the named constants are the documented values, not inline magic.
    expect(COOLDOWN_MS).toEqual({ toggle: 5000, next: 5000, play: 10000, enqueue: 20000 });
    expect(CATEGORY_MODE).toEqual({
      toggle: 'throttle',
      next: 'throttle',
      prev: 'burst',
      play: 'latest-wins',
      enqueue: 'queue',
    });
    expect(PREV_BURST_LIMIT).toBe(2);
    expect(PREV_BURST_WINDOW_MS).toBe(3000);
    expect(PREV_MIN_SPACING_MS).toBe(1000);
    expect(PLAY_DEBOUNCE_SETTLE_MS).toBe(2000);
    expect(PLAY_MAX_DEFER_MS).toBe(8000);
    expect(MAX_QUEUE).toBe(100);
    expect(MAX_DELIVERY_ATTEMPTS).toBe(2);
    expect(DELIVER_TIMEOUT_MS).toBe(5000);
  });

  // ---- THROTTLE (toggle = pause+resume, next): leading-edge, drop extras --------

  // (T1) first toggle in a window delivers INLINE (proxy called once, dashboard
  // response forwarded verbatim) and stamps lastExec:toggle.
  it('(T1) throttle: first toggle delivers inline + forwards the dashboard response; lastExec stamped', async () => {
    const s = stub();
    const { calls } = mockFetch(200, { ok: true, source: 'dashboard' });
    const { status, json } = await sendCommand(s, {
      category: 'toggle',
      dashboardPath: '/api/remote/pause',
      body: '{}',
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://dashboard.test.invalid/api/remote/pause');
    expect(calls[0].init.headers['X-Remote-Key']).toBe('test-remote-key');
    expect(status).toBe(200);
    expect(json).toEqual({ ok: true, source: 'dashboard' });
    await runInDurableObject(s, async (instance) => {
      expect(await instance.ctx.storage.get('lastExec:toggle')).toBeGreaterThan(0);
    });
  });

  // (T2) a second toggle within the cooldown is DROPPED (no proxy call) and returns
  // the synthetic coalesced 200, logged once.
  it('(T2) throttle: a second toggle within cooldown is dropped (no delivery), returns coalesced 200', async () => {
    const s = stub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'toggle', dashboardPath: '/api/remote/pause', body: '{}' });
    expect(calls.length).toBe(1);
    const second = await sendCommand(s, { category: 'toggle', dashboardPath: '/api/remote/resume', body: '{}' });
    expect(calls.length).toBe(1);
    expect(second.status).toBe(200);
    expect(second.json).toEqual({ ok: true, executed: false, coalesced: true });
    const drops = logSpy.mock.calls.map((c) => c[0]).filter((o) => o && o.event === 'throttle-drop');
    expect(drops.length).toBe(1);
    expect(drops[0].category).toBe('toggle');
    logSpy.mockRestore();
  });

  // (T3) pause + resume MERGE into 'toggle': a pause then a resume share one
  // lastExec:toggle window, so the resume is dropped (one transport toggle/window).
  it('(T3) throttle: pause + resume share the toggle window (the second of the pair is dropped)', async () => {
    const s = stub();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'toggle', dashboardPath: '/api/remote/pause', body: '{}' });
    await sendCommand(s, { category: 'toggle', dashboardPath: '/api/remote/resume', body: '{}' });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://dashboard.test.invalid/api/remote/pause');
  });

  // (T4) once the cooldown elapses, the next toggle delivers again.
  it('(T4) throttle: after the cooldown elapses the next toggle delivers again', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'toggle', dashboardPath: '/api/remote/pause', body: '{}' });
    expect(calls.length).toBe(1);
    await runInDurableObject(s, async (instance) => {
      await instance.ctx.storage.put('lastExec:toggle', Date.now() - COOLDOWN_MS.toggle - 1);
    });
    await sendCommand(s, { category: 'toggle', dashboardPath: '/api/remote/resume', body: '{}' });
    expect(calls.length).toBe(2);
    expect(calls[1].url).toBe('https://dashboard.test.invalid/api/remote/resume');
  });

  // (T5) next is throttle too; first delivers, second within window dropped, and a
  // throttle command NEVER enters the cmdQueue (inline-only).
  it('(T5) throttle: next first-delivers + drops the second; nothing enters the cmdQueue', async () => {
    const s = stub();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'next', dashboardPath: '/api/remote/next', body: '{}' });
    const second = await sendCommand(s, { category: 'next', dashboardPath: '/api/remote/next', body: '{}' });
    expect(calls.length).toBe(1);
    expect(second.json).toEqual({ ok: true, executed: false, coalesced: true });
    await runInDurableObject(s, async (instance) => {
      expect((await instance.ctx.storage.get('cmdQueue')) ?? []).toEqual([]);
    });
  });

  // (T6) the inline path has NO retry: a dashboard reject folds into the structured
  // 502 (parity with the entry router's direct-proxy 502).
  it('(T6) throttle: a dashboard reject becomes a structured 502 (no retry on the inline path)', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejectSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const { status, json } = await sendCommand(s, {
      category: 'next',
      dashboardPath: '/api/remote/next',
      body: '{}',
    });
    expect(status).toBe(502);
    expect(json.code).toBe('dashboard_unreachable');
    rejectSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // ---- BURST (prev): token-bucket, 2 per 3s then 1s spacing --------------------

  // (B1) the first PREV_BURST_LIMIT presses in the window BOTH deliver — the fast
  // double-tap "go back" survives even when the taps are <1s apart.
  it('(B1) burst: the first two prevs in the window both deliver (fast double-tap go-back)', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    expect(calls.length).toBe(2);
  });

  // (B2) a third press within the window AND under the spacing is dropped.
  it('(B2) burst: a third prev within the window and under the spacing is dropped', async () => {
    const s = stub();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    const third = await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    expect(calls.length).toBe(2);
    expect(third.json).toEqual({ ok: true, executed: false, coalesced: true });
  });

  // (B3) once PREV_MIN_SPACING_MS has elapsed since the last accepted press, a prev
  // delivers again even with the bucket otherwise "full".
  it('(B3) burst: after the min-spacing elapses, a further prev delivers again', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    expect(calls.length).toBe(2);
    await runInDurableObject(s, async (instance) => {
      const now = Date.now();
      await instance.ctx.storage.put('prevTimestamps', [
        now - PREV_MIN_SPACING_MS - 50,
        now - PREV_MIN_SPACING_MS - 10,
      ]);
    });
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    expect(calls.length).toBe(3);
  });

  // (B4) out-of-window timestamps are pruned — a stale burst does not block a fresh one.
  it('(B4) burst: out-of-window timestamps are pruned (a stale burst does not block a fresh one)', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance) => {
      const now = Date.now();
      await instance.ctx.storage.put('prevTimestamps', [
        now - PREV_BURST_WINDOW_MS - 1000,
        now - PREV_BURST_WINDOW_MS - 500,
      ]);
    });
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    await sendCommand(s, { category: 'prev', dashboardPath: '/api/remote/prev', body: '{}' });
    expect(calls.length).toBe(2);
    await runInDurableObject(s, async (instance) => {
      const ts = await instance.ctx.storage.get('prevTimestamps');
      expect(ts.length).toBe(2);
    });
  });

  // ---- LATEST-WINS (play + playlist-play): trailing-edge debounce + floor -------

  // (LW1) a single play occupies ONE queue slot (firstAt/lastAt set), is NOT
  // delivered before the settle, and arms the alarm at ~now + SETTLE.
  it('(LW1) latest-wins: a single play waits the settle (not delivered immediately); alarm armed at ~settle', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    const before = Date.now();
    const { status, json } = await sendCommand(s, {
      category: 'play',
      dashboardPath: '/api/remote/songs/play',
      body: JSON.stringify({ id: '1' }),
    });
    expect(status).toBe(202);
    expect(json).toEqual({ ok: true, queued: true });
    await runInDurableObject(s, async (instance) => {
      const queue = await instance.ctx.storage.get('cmdQueue');
      expect(queue.length).toBe(1);
      expect(queue[0].category).toBe('play');
      expect(queue[0].firstAt).toBeGreaterThanOrEqual(before);
      expect(queue[0].lastAt).toBe(queue[0].firstAt);
      await instance.drainOneEligible();
      const alarmAt = await instance.ctx.storage.getAlarm();
      expect(alarmAt).toBeGreaterThan(Date.now() + PLAY_DEBOUNCE_SETTLE_MS - 500);
      expect(alarmAt).toBeLessThan(Date.now() + PLAY_DEBOUNCE_SETTLE_MS + 500);
      // Clear the armed alarm + slot so this stub leaks no future deliverable into a
      // later test's fetch spy (singleWorker:true shares one runtime).
      await instance.ctx.storage.put('cmdQueue', []);
      await instance.ctx.storage.deleteAlarm();
    });
    expect(calls.length).toBe(0);
  });

  // (LW2) rapid plays COALESCE to one slot: latest target wins, firstAt preserved
  // (the cap anchor), lastAt advances, attempts reset.
  it('(LW2) latest-wins: rapid plays coalesce to one slot — latest target wins, firstAt preserved', async () => {
    const s = stub();
    mockFetch(200);
    await sendCommand(s, { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }) });
    let firstAt;
    await runInDurableObject(s, async (instance) => {
      firstAt = (await instance.ctx.storage.get('cmdQueue'))[0].firstAt;
    });
    await sendCommand(s, { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '2' }) });
    await runInDurableObject(s, async (instance) => {
      const queue = await instance.ctx.storage.get('cmdQueue');
      expect(queue.length).toBe(1);
      expect(JSON.parse(queue[0].body)).toEqual({ id: '2' });
      expect(queue[0].firstAt).toBe(firstAt);
      expect(queue[0].lastAt).toBeGreaterThanOrEqual(firstAt);
      await instance.ctx.storage.put('cmdQueue', []);
      await instance.ctx.storage.deleteAlarm();
    });
  });

  // (LW3) play + playlist-play share 'play', so a playlist-play replaces a pending
  // song-play (latest wins across both — the TV plays one thing).
  it('(LW3) latest-wins: playlist-play replaces a pending play (shared category, latest wins across both)', async () => {
    const s = stub();
    mockFetch(200);
    await sendCommand(s, { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }) });
    await sendCommand(s, { category: 'play', dashboardPath: '/api/remote/playlists/play', body: JSON.stringify({ id: '9' }) });
    await runInDurableObject(s, async (instance) => {
      const queue = await instance.ctx.storage.get('cmdQueue');
      expect(queue.length).toBe(1);
      expect(queue[0].dashboardPath).toBe('/api/remote/playlists/play');
      expect(JSON.parse(queue[0].body)).toEqual({ id: '9' });
      await instance.ctx.storage.put('cmdQueue', []);
      await instance.ctx.storage.deleteAlarm();
    });
  });

  // (LW4) once the settle has elapsed, the drain delivers the latest target, stamps
  // lastExec:play, and clears the slot.
  it('(LW4) latest-wins: after the settle the drain delivers the latest target + clears the slot', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }) });
    await sendCommand(s, { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '2' }) });
    await runInDurableObject(s, async (instance) => {
      const queue = await instance.ctx.storage.get('cmdQueue');
      const past = Date.now() - PLAY_DEBOUNCE_SETTLE_MS - 1;
      queue[0] = { ...queue[0], firstAt: past, lastAt: past };
      await instance.ctx.storage.put('cmdQueue', queue);
      await instance.drainOneEligible();
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].init.body)).toEqual({ id: '2' });
      expect((await instance.ctx.storage.get('cmdQueue')) ?? []).toEqual([]);
      expect(await instance.ctx.storage.get('lastExec:play')).toBeGreaterThan(0);
      await instance.ctx.storage.deleteAlarm();
    });
  });

  // (LW5) the cooldown FLOOR dominates the settle: a play right after a prior delivery
  // is held to lastExec:play + COOLDOWN.play, not merely settle-after-last.
  it('(LW5) latest-wins: the cooldown floor holds a play to lastExec + COOLDOWN.play (floor > settle)', async () => {
    const s = stub();
    mockFetch(200);
    const tExec = Date.now();
    await runInDurableObject(s, async (instance) => {
      await instance.ctx.storage.put('lastExec:play', tExec);
    });
    await sendCommand(s, { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }) });
    await runInDurableObject(s, async (instance) => {
      await instance.reconcileAlarm();
      expect(await instance.ctx.storage.getAlarm()).toBe(tExec + COOLDOWN_MS.play);
      await instance.ctx.storage.put('cmdQueue', []);
      await instance.ctx.storage.deleteAlarm();
    });
  });

  // (LW6) the MAX_DEFER cap bounds a continually-pushed debounce: with an old firstAt
  // and a fresh lastAt, deliverAt is firstAt + MAX_DEFER (below settle).
  it('(LW6) latest-wins: MAX_DEFER caps a continually-pushed debounce at firstAt + MAX_DEFER', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance, state) => {
      const now = Date.now();
      await state.storage.put('demand', 0);
      const firstAt = now - PLAY_MAX_DEFER_MS + 1500;
      await state.storage.put('cmdQueue', [
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }), enqueuedAt: firstAt, firstAt, lastAt: now, attempts: 0 },
      ]);
      await instance.reconcileAlarm();
      expect(await state.storage.getAlarm()).toBe(firstAt + PLAY_MAX_DEFER_MS);
      await state.storage.put('cmdQueue', []);
      await state.storage.deleteAlarm();
    });
  });

  // ---- QUEUE (enqueue): save-all FIFO, one per cooldown ------------------------

  // (Q1) two enqueues are BOTH saved (FIFO) and delivered one per cooldown.
  it('(Q1) queue: two enqueues are both saved (FIFO) and delivered one per cooldown', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await sendCommand(s, { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }) });
    await sendCommand(s, { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '2' }) });
    await runInDurableObject(s, async (instance, state) => {
      await instance.drainOneEligible();
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].init.body)).toEqual({ id: '1' });
      await state.storage.put('lastExec:enqueue', Date.now() - COOLDOWN_MS.enqueue - 1);
      await instance.drainOneEligible();
      expect(calls.length).toBe(2);
      expect(JSON.parse(calls[1].init.body)).toEqual({ id: '2' });
      expect((await state.storage.get('cmdQueue')) ?? []).toEqual([]);
      await state.storage.deleteAlarm();
    });
  });

  // (Q2) MAX_QUEUE runaway backstop -> LOUD warn + the DISTINCT envelope.
  it('(Q2) queue: MAX_QUEUE overflow -> LOUD warn + { ok:true, queued:false, dropped:"queue_full" }', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runInDurableObject(s, async (instance, state) => {
      const full = Array.from({ length: MAX_QUEUE }, () => ({
        category: 'enqueue',
        dashboardPath: '/api/remote/songs/enqueue',
        body: JSON.stringify({ id: '1' }),
        enqueuedAt: Date.now(),
        attempts: 0,
      }));
      await state.storage.put('cmdQueue', full);
      await state.storage.put('lastExec:enqueue', Date.now() + 60_000);
      void instance;
    });
    const { status, json } = await sendCommand(s, {
      category: 'enqueue',
      dashboardPath: '/api/remote/songs/enqueue',
      body: JSON.stringify({ id: '2' }),
    });
    expect(status).toBe(202);
    expect(json).toEqual({ ok: true, queued: false, dropped: 'queue_full' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0].message).toMatch(/overflow/i);
    warnSpy.mockRestore();
  });

  // ---- Cross-mode deferred drain + delivery -----------------------------------

  // (A) the deferred drain delivers a play id as a STRING with X-Remote-Key + JSON
  // content-type (the IdBody{id:String} contract + proxy reuse).
  it('(A) drain delivers { id:"3135556" } as a STRING with X-Remote-Key + JSON content-type', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance, state) => {
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '3135556' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0 },
      ]);
      await instance.drainOneEligible();
    });
    expect(calls.length).toBe(1);
    const sent = JSON.parse(calls[0].init.body);
    expect(sent).toEqual({ id: '3135556' });
    expect(typeof sent.id).toBe('string');
    expect(calls[0].init.headers['X-Remote-Key']).toBe('test-remote-key');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
  });

  // (A2) precision: a >2^53 id is delivered byte-identically (no Number round-trip).
  it('(A2) drain delivers a >2^53 id byte-identically (no Number round-trip)', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance, state) => {
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '9007199254740993' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0 },
      ]);
      await instance.drainOneEligible();
    });
    expect(calls[0].init.body).toBe('{"id":"9007199254740993"}');
  });

  // (D) single-shot-per-wake: an eligible play + an eligible enqueue; alarm() delivers
  // EXACTLY ONE per invocation; armed while non-empty, null once drained + demand 0.
  it('(D) alarm() drains EXACTLY ONE command per wake; armed while non-empty, null once drained+demand0', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 0);
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0 },
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '2' }), enqueuedAt: Date.now(), attempts: 0 },
      ]);
      for (let i = 1; i <= 2; i++) {
        await instance.alarm();
        expect(calls.length).toBe(i);
        const queue = (await state.storage.get('cmdQueue')) ?? [];
        if (queue.length > 0) expect(await state.storage.getAlarm()).not.toBeNull();
      }
      expect((await state.storage.get('cmdQueue')) ?? []).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  // (D2) CROSS-CATEGORY OVERTAKING: the FIFO head is an enqueue still under its 20s
  // cooldown; behind it an eligible play overtakes it.
  it('(D2) an eligible play OVERTAKES a cooldown-blocked enqueue head', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.put('lastExec:enqueue', Date.now());
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '2' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0 },
      ]);
      await instance.drainOneEligible();
      expect(calls.length).toBe(1);
      expect(calls[0].url).toBe('https://dashboard.test.invalid/api/remote/songs/play');
      const queue = await state.storage.get('cmdQueue');
      expect(queue.length).toBe(1);
      expect(queue[0].category).toBe('enqueue');
      await state.storage.put('cmdQueue', []);
      await state.storage.deleteAlarm();
    });
  });

  // (D3) reconcileAlarm arms for the EARLIEST per-element eligibility (the eligible
  // play ~now), not the blocked enqueue head's far-future cooldown.
  it('(D3) reconcileAlarm arms for the earliest eligibility, not the blocked FIFO head', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.put('lastExec:enqueue', Date.now());
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '2' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0 },
      ]);
      await instance.reconcileAlarm();
      expect(await state.storage.getAlarm()).toBeLessThan(Date.now() + 1000);
      await state.storage.put('cmdQueue', []);
      await state.storage.deleteAlarm();
    });
  });

  // (F) COEXISTENCE: reconcileAlarm sets min(drain, liveness); liveness serviced
  // BEFORE a hung delivery.
  it('(F) reconcileAlarm sets min(drain, liveness); liveness serviced before a hung delivery', async () => {
    const s1 = stub();
    await runInDurableObject(s1, async (instance, state) => {
      await state.storage.put('demand', 1);
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0 },
      ]);
      await instance.reconcileAlarm();
      expect(await state.storage.getAlarm()).toBeLessThan(Date.now() + UPSTREAM_ALARM_INTERVAL_MS);
    });

    const s2 = stub();
    await runInDurableObject(s2, async (instance, state) => {
      await state.storage.put('demand', 1);
      await state.storage.put('lastExec:enqueue', Date.now() + 60_000);
      await state.storage.put('cmdQueue', [
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
      ]);
      await instance.reconcileAlarm();
      const at = await state.storage.getAlarm();
      expect(at).toBeLessThanOrEqual(Date.now() + UPSTREAM_ALARM_INTERVAL_MS + 50);
      expect(at).toBeGreaterThan(Date.now() + UPSTREAM_ALARM_INTERVAL_MS - 1000);
    });

    const s3 = stub();
    let releaseDelivery;
    const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
    await runInDurableObject(s3, async (instance, state) => {
      await state.storage.put('demand', 1);
      await state.storage.put('snapshot', SNAPSHOT);
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0 },
      ]);
      const order = [];
      instance.ensureUpstream = () => Promise.resolve(true);
      const realFan = instance.fanPersistedSnapshot.bind(instance);
      instance.fanPersistedSnapshot = async () => { order.push('liveness-fan'); return realFan(); };
      instance.deliverCommand = async () => { order.push('deliver'); await deliveryGate; return { terminal: true, traceOutcome: 'delivered' }; };
      const alarmPromise = instance.alarm();
      releaseDelivery();
      await alarmPromise;
      expect(order).toEqual(['liveness-fan', 'deliver']);
      expect((await state.storage.get('cmdQueue')) ?? []).toEqual([]);
    });
  });

  // (G) demand>0 + no eligible command -> alarm armed (liveness); drains once eligible.
  it('(G) demand>0 + no eligible command -> alarm armed (liveness); drains once eligible', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 1);
      await state.storage.put('lastExec:enqueue', Date.now());
      await state.storage.put('cmdQueue', [
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
      ]);
      await instance.alarm();
      expect(calls.length).toBe(0);
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.put('lastExec:enqueue', Date.now() - COOLDOWN_MS.enqueue - 1);
      await instance.alarm();
      expect(calls.length).toBe(1);
    });
  });

  // (H) a throwing drain still re-arms the alarm via the finally (error propagates).
  it('(H) a throwing drain still re-arms the alarm via the finally (error still propagates)', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 1);
      instance.drainOneEligible = () => Promise.reject(new Error('boom'));
      await expect(instance.alarm()).rejects.toThrow(/boom/);
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });

  // (I) demand 0 + queue empty -> alarm deleted + upstream closed.
  it('(I) demand 0 + queue empty -> alarm deleted + upstream closed', async () => {
    const s = stub();
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.setAlarm(Date.now() + 1000);
      let closed = false;
      instance.upstream = { readyState: WebSocket.OPEN, close() { closed = true; } };
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
      expect(closed).toBe(true);
      expect(instance.upstream).toBeNull();
    });
  });

  // (K) HUNG deferred delivery aborts at DELIVER_TIMEOUT_MS (transient); dropped after
  // MAX with the timeout trace.
  it('(K) a HUNG deferred delivery aborts at the timeout (transient); dropped after MAX', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInDurableObject(s, async (instance, state) => {
      const hung = vi.spyOn(globalThis, 'fetch').mockImplementation(
        (url, init) => new Promise((_resolve, reject) => {
          const sig = init?.signal;
          if (sig) sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      );
      await state.storage.put('demand', 0);
      await state.storage.put('cmdQueue', [
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
      ]);
      await instance.drainOneEligible();
      let queue = await state.storage.get('cmdQueue');
      expect(queue.length).toBe(1);
      expect(queue[0].attempts).toBe(1);
      await instance.drainOneEligible();
      queue = (await state.storage.get('cmdQueue')) ?? [];
      expect(queue).toEqual([]);
      hung.mockRestore();
    });
    const traces = logSpy.mock.calls.map((c) => c[0]).filter((o) => o && o.event === 'drain');
    expect(traces.length).toBe(1);
    expect(traces[0].outcome).toBe('dropped-after-max-transient-timeout');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  }, 20_000);

  // (L) 5xx transient: kept on first attempt (no lastExec bump), dropped on second.
  it('(L) a 5xx is transient: kept on first attempt, dropped on second', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runInDurableObject(s, async (instance, state) => {
      const f = mockFetch(503);
      await state.storage.put('demand', 0);
      await state.storage.put('cmdQueue', [
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
      ]);
      await instance.drainOneEligible();
      let queue = await state.storage.get('cmdQueue');
      expect(queue.length).toBe(1);
      expect(queue[0].attempts).toBe(1);
      expect(await state.storage.get('lastExec:enqueue')).toBeUndefined();
      await instance.drainOneEligible();
      queue = (await state.storage.get('cmdQueue')) ?? [];
      expect(queue).toEqual([]);
      f.spy.mockRestore();
    });
    const traces = logSpy.mock.calls.map((c) => c[0]).filter((o) => o && o.event === 'drain');
    expect(traces.length).toBe(1);
    expect(traces[0].outcome).toBe('dropped-after-max-dashboard-error-503');
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  // (M) 4xx terminal: dropped on the FIRST attempt, lastExec bumped, trace rejected.
  it('(M) a 4xx is terminal: dropped on the FIRST attempt, lastExec bumped', async () => {
    const s = stub();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFetch(422);
    await runInDurableObject(s, async (instance, state) => {
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0 },
      ]);
      await instance.drainOneEligible();
      expect((await state.storage.get('cmdQueue')) ?? []).toEqual([]);
      expect(await state.storage.get('lastExec:play')).toBeGreaterThan(0);
    });
    const traces = logSpy.mock.calls.map((c) => c[0]).filter((o) => o && o.event === 'drain');
    expect(traces.length).toBe(1);
    expect(traces[0].outcome).toBe('dashboard-rejected-422');
    expect(traces[0].attempt).toBe(1);
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  // (N) constructor arm-only: arms a persisted-undrained queue; never deletes when idle.
  it('(N) constructor reconcileAlarm is ARM-ONLY: arms a persisted-undrained queue; never deletes when idle', async () => {
    const s1 = stub();
    await runInDurableObject(s1, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.put('cmdQueue', [
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
      ]);
      await instance.reconcileAlarm({ armOnly: true });
      expect(await state.storage.getAlarm()).not.toBeNull();
      // The enqueue is eligible at t0, so the armed alarm fires ~now — clear it + the
      // queue so it can't bleed a real (unmocked) delivery into a later test's spy.
      await state.storage.put('cmdQueue', []);
      await state.storage.deleteAlarm();
    });

    const s2 = stub();
    await runInDurableObject(s2, async (instance, state) => {
      await state.storage.put('demand', 0);
      await state.storage.delete('cmdQueue');
      const preset = Date.now() + 5000;
      await state.storage.setAlarm(preset);
      await instance.reconcileAlarm({ armOnly: true });
      expect(await state.storage.getAlarm()).toBe(preset);
    });
  });

  // ---- re-read-after-await concurrency (the input-gate invariant) --------------

  // (R1) latest-wins: a play that REPLACES the slot DURING the in-flight delivery of
  // the prior pick MUST survive (latest wins) — not be index-spliced away. Regression
  // guard for the index-vs-identity drain bug: the delivery await opens the input
  // gate, so a re-pick lands a new pickId at the same index; the drain must remove the
  // element only if it is still the SAME pick. lastExec:play is still bumped (the prior
  // delivery happened), so the survivor is spaced by the cooldown floor.
  it('(R1) latest-wins: a re-pick during the in-flight delivery survives (identity, not index, drain)', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance, state) => {
      const past = Date.now() - PLAY_MAX_DEFER_MS - 1;
      await state.storage.put('cmdQueue', [
        { category: 'play', dashboardPath: '/api/remote/songs/play', body: JSON.stringify({ id: '1' }), enqueuedAt: past, firstAt: past, lastAt: past, attempts: 0, pickId: 'pick-1' },
      ]);
      // Inject a concurrent slot REPLACE (a user re-pick) during delivery of id:1.
      const realDeliver = instance.deliverCommand.bind(instance);
      instance.deliverCommand = async (cmd) => {
        const q = (await state.storage.get('cmdQueue')) ?? [];
        q[0] = { ...q[0], body: JSON.stringify({ id: '2' }), lastAt: Date.now(), attempts: 0, pickId: 'pick-2' };
        await state.storage.put('cmdQueue', q);
        return realDeliver(cmd);
      };
      await instance.drainOneEligible();
      // id:1 was delivered...
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].init.body)).toEqual({ id: '1' });
      // ...but the re-pick id:2 MUST remain (not spliced), with its own pickId intact.
      const q = await state.storage.get('cmdQueue');
      expect(q.length).toBe(1);
      expect(JSON.parse(q[0].body)).toEqual({ id: '2' });
      expect(q[0].pickId).toBe('pick-2');
      expect(q[0].attempts).toBe(0); // fresh pick — NOT clobbered with old attempt count
      // lastExec:play bumped (id:1's expensive delivery happened — space the survivor).
      expect(await state.storage.get('lastExec:play')).toBeGreaterThan(0);
    });
  });

  // (R2) queue: an enqueue APPENDED during the in-flight delivery of the head survives
  // at the tail; the delivered head is removed by its (stable) index. The append-only
  // arm of the same input-gate invariant.
  it('(R2) queue: an enqueue appended during the in-flight delivery survives at the tail', async () => {
    const s = stub();
    const { calls } = mockFetch(200);
    await runInDurableObject(s, async (instance, state) => {
      await state.storage.put('cmdQueue', [
        { category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '1' }), enqueuedAt: Date.now(), attempts: 0 },
      ]);
      const realDeliver = instance.deliverCommand.bind(instance);
      instance.deliverCommand = async (cmd) => {
        const q = (await state.storage.get('cmdQueue')) ?? [];
        q.push({ category: 'enqueue', dashboardPath: '/api/remote/songs/enqueue', body: JSON.stringify({ id: '2' }), enqueuedAt: Date.now(), attempts: 0 });
        await state.storage.put('cmdQueue', q);
        return realDeliver(cmd);
      };
      await instance.drainOneEligible();
      expect(calls.length).toBe(1);
      expect(JSON.parse(calls[0].init.body)).toEqual({ id: '1' }); // head delivered
      const q = await state.storage.get('cmdQueue');
      expect(q.length).toBe(1);
      expect(JSON.parse(q[0].body)).toEqual({ id: '2' }); // appended survivor at tail
    });
  });
});
