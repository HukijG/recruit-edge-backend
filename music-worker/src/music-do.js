/**
 * MusicRemoteState — WebSocket-Hibernation Durable Object.
 *
 * NET-NEW PRECEDENT: this is the FIRST WebSocket-Hibernation DO in the repo. The
 * only prior DO (ExtCallState) is RPC-only; the hibernation lifecycle here
 * (acceptWebSocket / webSocketMessage|Close|Error / getWebSockets / the
 * alarm-heartbeat upstream-liveness pattern / persisted-demand re-open / lazy
 * re-open belt-and-braces) is entirely new. Only the migration-TAG style
 * (new_sqlite_classes) is mirrored from the root wrangler.
 *
 * RESPONSIBILITIES
 *  1. Downstream fan-out: every extension now-playing client connects through the
 *     WS-upgrade route; the socket is acceptWebSocket()'d so it survives isolate
 *     hibernation and is recoverable via ctx.getWebSockets(). Each upstream
 *     NowPlayingSnapshot is fanned VERBATIM (camelCase, never re-shaped) to every
 *     such socket.
 *  2. Upstream liveness: the music-source WS is opened via PLAIN fetch (no OTel,
 *     no @microlabs wrapper). It is NOT acceptWebSocket()'d (it is not a client of
 *     this DO) — it lives on the plain in-memory field `this.upstream`. A plain
 *     field does NOT survive isolate eviction, and a fully-hibernated DO with zero
 *     in-flight events does NOT wake on its own. The demand-gate below resolves
 *     this concretely.
 *  3. WS-ticket store (WS-auth Option B): single-use, short-TTL tickets issued by
 *     an auth-gated HTTP endpoint and redeemed on WS upgrade, so no secret/token
 *     ever lands in a URL or CF log.
 *
 * DEMAND-GATE (the load-bearing mechanism)
 *  Demand is PERSISTED to ctx.storage (which survives eviction), NOT inferred from
 *  the plain upstream field (which does not). `demand` = getWebSockets().length,
 *  recomputed + persisted on every accept and webSocketClose. Upstream is open IFF
 *  demand >= 1.
 *
 *  An armed ctx.storage alarm is THE ONLY mechanism that reliably re-runs a
 *  fully-hibernated DO that has only idle (no-traffic) subscribers attached. So
 *  whenever demand > 0 we keep an alarm armed UPSTREAM_ALARM_INTERVAL_MS ahead;
 *  alarm() re-opens upstream if it died during an eviction gap and re-arms. When
 *  demand hits 0 we close upstream and deleteAlarm().
 *
 *  LOAD-BEARING PLATFORM INVARIANT (stated in docs/music-worker.md): an armed
 *  ctx.storage alarm fires for a DO whose isolate has been evicted, AND
 *  accepted-but-idle hibernatable WebSockets do NOT block that alarm from firing.
 *  If CF hibernation semantics ever change this, the demand-gate breaks — that is
 *  the single platform assumption this design rests on.
 *
 *  BELT-AND-BRACES: because runInDurableObject in vitest-pool-workers hands a LIVE
 *  instance (it cannot evict a real isolate), the alarm test proves the HANDLER
 *  re-opens but cannot prove the PLATFORM fires an alarm post-eviction with idle
 *  sockets attached. To remove that single point of failure, upstream is ALSO
 *  re-checked/re-opened lazily at the top of the WS-upgrade handler AND at the top
 *  of webSocketMessage — a reconnecting or message-sending subscriber forces
 *  re-open even if an alarm lapsed. Liveness survives an alarm GAP, not only an
 *  alarm.
 */

import { DurableObject } from 'cloudflare:workers';

// Heartbeat cadence for the upstream-liveness alarm, in ms.
//
// WHY 30s: a balance between (a) upstream-reconnect latency after an eviction
// gap — a longer interval means a now-playing change can sit unfanned for up to
// one interval — and (b) wasted wakeups when idle — a shorter interval bills more
// alarm invocations on an idle-but-subscribed DO. 30s keeps post-eviction
// staleness bounded while not hammering an idle remote. NOT an inline magic value.
export const UPSTREAM_ALARM_INTERVAL_MS = 30_000;

// Single-use WS ticket TTL. Short — the extension issues a ticket then immediately
// upgrades; anything older is a replay/stale attempt.
export const WS_TICKET_TTL_MS = 30_000;

const STORAGE = {
  demand: 'demand',
  snapshot: 'snapshot',
  ticketPrefix: 'ticket:',
};

// Subprotocol marker. The extension presents `Sec-WebSocket-Protocol:
// rf-music.v1, ticket.<id>`; we redeem the ticket and echo back `rf-music.v1`.
export const WS_SUBPROTOCOL = 'rf-music.v1';
export const TICKET_SUBPROTOCOL_PREFIX = 'ticket.';

export class MusicRemoteState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    // Plain in-memory field — DELIBERATELY not persisted, does NOT survive
    // eviction. The persisted demand counter + alarm is what re-establishes it.
    this.upstream = null;
    // Defensive re-open on construction: if the DO is being re-instantiated after
    // eviction with persisted demand, get upstream back up without waiting for the
    // next alarm. blockConcurrencyWhile so no request observes a half-built state.
    this.ctx.blockConcurrencyWhile(async () => {
      const demand = (await this.ctx.storage.get(STORAGE.demand)) ?? 0;
      if (demand > 0) {
        await this.ensureUpstream();
        await this.armAlarm();
      }
    });
  }

  // ---- HTTP surface (router in index.js delegates here) -------------------

  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');
    if (upgrade && upgrade.toLowerCase() === 'websocket') {
      return this.handleWsUpgrade(request);
    }
    if (url.pathname.endsWith('/ws-ticket') && request.method === 'POST') {
      return this.issueTicket();
    }
    return new Response('Not Found', { status: 404 });
  }

  /**
   * Issue a single-use, short-TTL ticket. Called ONLY after the HTTP layer has
   * already run authMusicRequest — the DO trusts its own worker's router.
   */
  async issueTicket() {
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + WS_TICKET_TTL_MS;
    await this.ctx.storage.put(STORAGE.ticketPrefix + id, expiresAt);
    return new Response(JSON.stringify({ ticket: id, expiresAt }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Redeem a ticket (delete-on-read, TTL-checked). Returns true exactly once per
   * issued ticket, and only within its TTL.
   */
  async redeemTicket(id) {
    if (!id) return false;
    const key = STORAGE.ticketPrefix + id;
    const expiresAt = await this.ctx.storage.get(key);
    if (expiresAt == null) return false;
    await this.ctx.storage.delete(key); // single-use: gone after first read
    if (Date.now() > expiresAt) return false; // expired
    return true;
  }

  async handleWsUpgrade(request) {
    // Redeem the subprotocol ticket BEFORE accepting. The secret never travels on
    // a URL/log — it rides the Sec-WebSocket-Protocol header.
    const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const ticketTok = offered.find((p) => p.startsWith(TICKET_SUBPROTOCOL_PREFIX));
    const ticketId = ticketTok ? ticketTok.slice(TICKET_SUBPROTOCOL_PREFIX.length) : null;
    const okTicket = await this.redeemTicket(ticketId);
    if (!okTicket) {
      return new Response('ws ticket invalid or expired', { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable accept — survives isolate eviction; recoverable via
    // getWebSockets(). This is the demand source of truth on the live side.
    this.ctx.acceptWebSocket(server);

    // Demand changed (0->1 arms the alarm + opens upstream). Recompute from the
    // live socket set so the count is always authoritative.
    await this.recomputeDemandAndReconcile();

    // BELT-AND-BRACES lazy re-open: a freshly-connecting subscriber forces
    // upstream up even if an alarm lapsed during an eviction gap.
    await this.ensureUpstream();

    // Always hand the new client the last-known snapshot so it never shows blank
    // state while waiting for the next live upstream event.
    const snap = await this.ctx.storage.get(STORAGE.snapshot);
    if (snap !== undefined) {
      try {
        server.send(JSON.stringify(snap));
      } catch {
        /* socket may have closed instantly; fan-out below is the steady path */
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': WS_SUBPROTOCOL },
    });
  }

  // ---- Hibernation handlers (downstream ext sockets) ----------------------

  async webSocketMessage(ws, message) {
    // BELT-AND-BRACES lazy re-open: a subscriber sending traffic forces upstream
    // up independent of the alarm. (Ext clients are receive-mostly; this is the
    // liveness hook, not a command channel — any inbound message just pings.)
    await this.ensureUpstream();
    void ws;
    void message;
  }

  async webSocketClose(ws) {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    // Demand dropped. Recompute from the (now-smaller) live set; at 0 this closes
    // upstream + deleteAlarm().
    await this.recomputeDemandAndReconcile();
  }

  async webSocketError(ws) {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    await this.recomputeDemandAndReconcile();
  }

  // ---- Demand-gate core ---------------------------------------------------

  /**
   * Recompute demand from the authoritative live socket set, persist it, and
   * reconcile upstream + alarm: open+arm when demand>0, close+deleteAlarm when 0.
   */
  async recomputeDemandAndReconcile() {
    const demand = this.ctx.getWebSockets().length;
    await this.ctx.storage.put(STORAGE.demand, demand);
    if (demand > 0) {
      await this.ensureUpstream();
      await this.armAlarm();
    } else {
      await this.closeUpstream();
      await this.ctx.storage.deleteAlarm();
    }
    return demand;
  }

  async armAlarm() {
    await this.ctx.storage.setAlarm(Date.now() + UPSTREAM_ALARM_INTERVAL_MS);
  }

  /**
   * Alarm — the ONLY mechanism that reliably re-runs a fully-hibernated DO whose
   * subscribers are idle (no message traffic). Re-open upstream if it died during
   * an eviction gap, re-fan the persisted snapshot to anyone who reconnected, and
   * re-arm while demand persists.
   */
  async alarm() {
    const demand = (await this.ctx.storage.get(STORAGE.demand)) ?? 0;
    if (demand > 0) {
      const reopened = await this.ensureUpstream();
      if (reopened) {
        // Reconcile reconnect-during-gap clients with the last-known state.
        await this.fanPersistedSnapshot();
      }
      await this.armAlarm();
    } else {
      await this.closeUpstream();
      await this.ctx.storage.deleteAlarm();
    }
  }

  // ---- Upstream socket (plain fetch, no OTel) -----------------------------

  /**
   * Ensure the upstream music-source WS is open. Returns true if it (re)opened
   * this call, false if it was already live. Opened via PLAIN fetch — no wrapper.
   */
  async ensureUpstream() {
    if (this.isUpstreamLive()) return false;
    await this.openUpstream();
    return true;
  }

  isUpstreamLive() {
    return (
      this.upstream != null &&
      this.upstream.readyState !== undefined &&
      this.upstream.readyState !== WebSocket.CLOSING &&
      this.upstream.readyState !== WebSocket.CLOSED
    );
  }

  async openUpstream() {
    const url = this.env.UPSTREAM_WS_URL;
    if (typeof url !== 'string' || url.length === 0) {
      // No upstream configured (e.g. test env). Demand-gate + fan-out still
      // function; live events simply won't arrive until UPSTREAM_WS_URL is set.
      this.upstream = null;
      return;
    }
    // PLAIN fetch WS upgrade. NO @microlabs wrapper, NO OTel.
    const resp = await fetch(url, { headers: { Upgrade: 'websocket' } });
    const ws = resp.webSocket;
    if (!ws) {
      this.upstream = null;
      return;
    }
    ws.accept();
    this.upstream = ws;
    ws.addEventListener('message', (event) => {
      this.ctx.waitUntil(this.onUpstreamMessage(event.data));
    });
    const drop = () => {
      if (this.upstream === ws) this.upstream = null;
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  async closeUpstream() {
    if (this.upstream) {
      try {
        this.upstream.close();
      } catch {
        /* already closed */
      }
      this.upstream = null;
    }
  }

  /**
   * Persist the latest NowPlayingSnapshot and fan it VERBATIM to every ext socket.
   * The snapshot is forwarded byte-for-byte (camelCase, never re-shaped) per the
   * frozen contract:
   *   { isPlaying, positionMs, track: { loadId, title, artists, album, artUrl,
   *     durationMs } | null }
   */
  async onUpstreamMessage(data) {
    let snapshot;
    try {
      snapshot = typeof data === 'string' ? JSON.parse(data) : JSON.parse(await blobText(data));
    } catch {
      return; // not a JSON snapshot; ignore
    }
    await this.ctx.storage.put(STORAGE.snapshot, snapshot);
    this.fanOut(JSON.stringify(snapshot));
  }

  async fanPersistedSnapshot() {
    const snap = await this.ctx.storage.get(STORAGE.snapshot);
    if (snap === undefined) return;
    this.fanOut(JSON.stringify(snap));
  }

  /**
   * Fan a pre-serialized JSON string to every accepted ext socket. Verbatim — no
   * re-shaping. getWebSockets() is authoritative across hibernation.
   */
  fanOut(jsonString) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(jsonString);
      } catch {
        /* a dead socket will surface via webSocketClose/Error; skip it here */
      }
    }
  }
}

/**
 * Read a Blob/ArrayBuffer-ish WS frame as text. Upstream frames are normally
 * strings; this handles the binary-frame edge without pulling a dep.
 */
async function blobText(data) {
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (typeof data?.text === 'function') return data.text();
  return String(data);
}
