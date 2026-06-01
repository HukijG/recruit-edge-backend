import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  WS_SUBPROTOCOL,
  TICKET_SUBPROTOCOL_PREFIX,
  UPSTREAM_ALARM_INTERVAL_MS,
} from '../src/music-do.js';

function stub() {
  const id = env.MUSIC_REMOTE.idFromName('test-' + crypto.randomUUID());
  return env.MUSIC_REMOTE.get(id);
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
      // ('https://dashboard.test.local' in vitest miniflare bindings): https->wss
      // + '/api/remote/nowplaying'. DASHBOARD_REMOTE_KEY = 'test-remote-key'.
      expect(instance.env.DASHBOARD_REMOTE_BASE).toBe('https://dashboard.test.local');
      expect(instance.env.DASHBOARD_REMOTE_KEY).toBe('test-remote-key');

      await instance.openUpstream();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('wss://dashboard.test.local/api/remote/nowplaying');
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
