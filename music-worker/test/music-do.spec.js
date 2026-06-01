import { describe, it, expect, beforeEach } from 'vitest';
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

  it('(1) 0->1 connect arms an alarm and persists demand; close back to 0 deletes it', async () => {
    const s = stub();
    const ws = await connectClient(s);

    await runInDurableObject(s, async (instance, state) => {
      expect(await state.storage.get('demand')).toBe(1);
      const alarmAt = await state.storage.getAlarm();
      expect(alarmAt).toBeGreaterThan(Date.now());
      void instance;
    });

    // Close the only subscriber; webSocketClose recomputes demand=0 and deletes the alarm.
    ws.close();
    await runInDurableObject(s, async (instance, state) => {
      // Drive the close handler deterministically against the live socket set.
      for (const sock of state.getWebSockets()) {
        try {
          sock.close();
        } catch {
          /* noop */
        }
      }
      await instance.recomputeDemandAndReconcile();
      expect(await state.storage.get('demand')).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
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
      // alarm() re-opens upstream (no UPSTREAM_WS_URL in test => stays null, but
      // ensureUpstream returns "reopened" so the persisted snapshot is re-fanned),
      // then re-arms because demand>0.
      await instance.alarm();
      const alarmAt = await state.storage.getAlarm();
      expect(alarmAt).toBeGreaterThan(Date.now());
    });

    expect(JSON.parse(await received)).toEqual(SNAPSHOT);
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
