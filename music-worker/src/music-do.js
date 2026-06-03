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
import { proxyToDashboard } from './proxy.js';

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

// ---- GLOBAL command rate-limiting — FOUR modes, one per category -------------
//
// The dashboard's real failure mode is at the transport/PCM layer: every command
// that starts NEW audio (next / prev / play song / play playlist) forces the TV to
// flush its playback buffer and re-stream fresh PCM over a fragile WS. Fast
// SEQUENTIAL new-audio commands collide with an in-flight delivery and choke the
// server mid-flush. The rate-limiting here is a deliberate bandaid in front of that
// dashboard-side durability problem — NOT UX politeness — so the modes are tuned to
// the danger each command poses, GLOBALLY across ALL extension consumers (the
// singleton DO is the only shared point, so the state lives here).
//
// Four modes (see CATEGORY_MODE):
//   'throttle'    — leading-edge: the FIRST command in a cooldown window delivers
//                   INLINE immediately, every other same-category command within the
//                   window is DROPPED (never saved). For toggle (pause+resume merged)
//                   and next — any single one is fine, so first-wins + drop-the-rest.
//   'burst'       — token-bucket: allow up to PREV_BURST_LIMIT presses within
//                   PREV_BURST_WINDOW_MS (so a fast double-tap "go back" always lands)
//                   then PREV_MIN_SPACING_MS between. Delivered INLINE. For prev only.
//   'latest-wins' — trailing-edge debounce: a burst of play/playlist-play requests
//                   COALESCES to the most-recent target, delivered after a quiet
//                   settle, never faster than the cooldown floor, never deferred past
//                   a hard cap. The SPECIFIC target must be right (latest), and these
//                   are the most expensive new-audio ops → longest protection.
//   'queue'       — save-all FIFO: EVERY enqueue is delivered, one per cooldown.
//                   Nothing dropped (save the runaway backstop).
//
// Minimum spacing between EXECUTIONS of a category, GLOBALLY. Named constants, NOT
// inline magic values. (prev is NOT here — its token-bucket uses PREV_* below.)
export const COOLDOWN_MS = { toggle: 5000, next: 5000, play: 10000, enqueue: 20000 };

// Per-category mode. The DO is route-agnostic (it sees only { category,
// dashboardPath, body }); the route->category map lives in index.js, and this
// category->mode map is the DO's single source of which mechanism handles a command.
export const CATEGORY_MODE = {
  toggle: 'throttle',
  next: 'throttle',
  prev: 'burst',
  play: 'latest-wins',
  enqueue: 'queue',
};

// prev token-bucket: allow up to PREV_BURST_LIMIT presses inside any
// PREV_BURST_WINDOW_MS window (so a fast double-tap always reaches the dashboard's
// "2 within 3s = go back" gesture), then enforce PREV_MIN_SPACING_MS between further
// presses. Protects the dashboard from sustained prev-spam WITHOUT killing the
// gesture — the one case a flat cooldown could not satisfy.
export const PREV_BURST_LIMIT = 2;
export const PREV_BURST_WINDOW_MS = 3000;
export const PREV_MIN_SPACING_MS = 1000;

// Latest-wins (play / playlist-play) debounce. A new pick collapses onto the single
// pending play slot (latest wins) and is delivered at:
//   max( COOLDOWN floor, min( max(lastAt + SETTLE, floor), firstAt + MAX_DEFER ) )
//   - SETTLE   — deliver only after this much quiet, so a rapid burst of picks
//                collapses to the last one (true trailing-edge debounce).
//   - floor    — COOLDOWN_MS.play after the previous delivery; a HARD floor (dashboard
//                protection) the settle/cap can never undercut.
//   - MAX_DEFER — bounds worst-case latency: under a sustained stream of picks the
//                settle keeps pushing out, so cap the wait from the FIRST un-delivered
//                request so a play always lands eventually.
export const PLAY_DEBOUNCE_SETTLE_MS = 2000;
export const PLAY_MAX_DEFER_MS = 8000;

// Runaway backstop ONLY (queue mode). Normal operation never reaches this; an
// overflow is a LOUD drop (console.warn), never silent.
export const MAX_QUEUE = 100;

// A delivery that fails transiently (5xx / fetch-reject / abort-timeout) is
// retried ONCE more (no backoff); after this many attempts it is a LOUD give-up
// drop. A 2xx is delivered (terminal) and a 4xx is permanently-rejected
// (terminal) — neither consumes a retry.
export const MAX_DELIVERY_ATTEMPTS = 2;

// A dashboard that accepts the connection then HANGS would wedge the drain. Bound
// every delivery with an AbortController firing at this timeout, folding a hang
// into the transient bucket (abort -> attempts++ -> bounded retry -> LOUD drop).
export const DELIVER_TIMEOUT_MS = 5000;

// The upstream now-playing WS upgrade hits the SAME dashboard ingress as delivery,
// so it has the SAME accept-then-hang hazard. openUpstream() is awaited inside the
// constructor's blockConcurrencyWhile (a hung handshake there would stall the DO
// from servicing ANY request — every consumer's enqueue/ws-ticket/upgrade blocks),
// and inside handleWsUpgrade / webSocketMessage / alarm(). Bound the upgrade fetch
// with an AbortController firing at this timeout; on abort fold into the existing
// "unreachable" catch (log + leave upstream null) so the demand-gate retries on the
// next interval — identical to the reject handling. Mirrors DELIVER_TIMEOUT_MS for
// the delivery path; named separately so the two can diverge without coupling.
export const UPSTREAM_OPEN_TIMEOUT_MS = 5000;

const STORAGE = {
  demand: 'demand',
  snapshot: 'snapshot',
  ticketPrefix: 'ticket:',
  // Alarm-deferred command queue (array) — holds 'queue' (enqueue, FIFO) and
  // 'latest-wins' (play, single coalesced slot) elements — plus per-category
  // last-execution timestamps. Both SQLite-backed via ctx.storage so they survive
  // hibernation / eviction.
  cmdQueue: 'cmdQueue',
  lastExecPrefix: 'lastExec:',
  // 'burst' mode (prev) — the accepted-press timestamps within the current window,
  // pruned to PREV_BURST_WINDOW_MS. SQLite-backed so the token-bucket survives
  // hibernation / eviction like every other piece of command state.
  prevTimestamps: 'prevTimestamps',
};

/**
 * The time a queued command becomes deliverable, given its category's last
 * delivery time. SINGLE SOURCE OF TRUTH for eligibility — used by both
 * firstEligibleIndex (the drain selector) and reconcileAlarm (the wake time), so
 * the two can never disagree on when a command is due.
 *
 *  - 'latest-wins' (play): the trailing-edge debounce — max(floor, min(max(lastAt +
 *    SETTLE, floor), firstAt + MAX_DEFER)). floor = lastExec + COOLDOWN.play is a
 *    HARD lower bound (dashboard protection); the settle waits for quiet; the cap
 *    bounds worst-case latency under a sustained stream.
 *  - everything else in the queue ('queue'/enqueue): the flat per-category cooldown,
 *    lastExec + COOLDOWN[category]. The `?? 0` on lastExec (applied by callers) makes
 *    a first-ever / post-eviction-empty timer eligible at t0.
 *
 * @param {{ category: string, firstAt?: number, lastAt?: number }} cmd
 * @param {number} lastExec - the category's last delivery time (caller applies ?? 0)
 * @returns {number} epoch ms at which the command may be delivered
 */
function commandEligibleAt(cmd, lastExec) {
  if (CATEGORY_MODE[cmd.category] === 'latest-wins') {
    const floor = lastExec + COOLDOWN_MS[cmd.category];
    const settle = cmd.lastAt + PLAY_DEBOUNCE_SETTLE_MS;
    const cap = cmd.firstAt + PLAY_MAX_DEFER_MS;
    return Math.max(floor, Math.min(Math.max(settle, floor), cap));
  }
  return lastExec + COOLDOWN_MS[cmd.category];
}

// Small JSON Response helper (the command surface returns several structured
// envelopes; the WS/demand-gate paths above build Responses inline).
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
    //
    // ARM-ONLY reconcile: a freshly-constructed isolate must NEVER tear
    // down an alarm a prior instance legitimately set. reconcileAlarm({armOnly})
    // ARMS for a persisted-undrained command queue (drain resumes even at demand 0
    // post-eviction) AND for liveness when demand>0, but NEVER deletes — so a
    // genuinely-idle reconstruction (demand 0 + empty queue) leaves any prior alarm
    // intact rather than wiping it.
    this.ctx.blockConcurrencyWhile(async () => {
      const demand = (await this.ctx.storage.get(STORAGE.demand)) ?? 0;
      if (demand > 0) {
        await this.ensureUpstream();
      }
      await this.reconcileAlarm({ armOnly: true });
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
    // Command surface — index.js routes pause/resume/next/prev/play/playlist-play/
    // enqueue here as { category, dashboardPath, body }. command() dispatches on the
    // category's mode (throttle / burst / latest-wins / queue). Mirrors the
    // /ws-ticket fetch wiring: index.js -> DO stub -> this handler.
    if (url.pathname.endsWith('/enqueue-command') && request.method === 'POST') {
      return this.command(await request.json());
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

    // Demand changed (0->1 arms the alarm + opens upstream). On the ACCEPT path
    // the just-accepted socket SHOULD be counted, so no `excluding` arg — the
    // unfiltered getWebSockets() length is authoritative here.
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
    // Demand dropped. CRITICAL: inside webSocketClose/webSocketError the closing
    // socket is STILL present in ctx.getWebSockets() — the set is NOT yet smaller.
    // Pass the closing socket as `excluding` so the demand count reflects the
    // post-close reality; at 0 this closes upstream + deleteAlarm(). Without the
    // exclusion the last subscriber leaving would leave demand stuck at 1, the
    // alarm armed forever, and the upstream WS leaked.
    await this.recomputeDemandAndReconcile(ws);
  }

  async webSocketError(ws) {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
    // Same closing-socket-still-counted hazard as webSocketClose — exclude it.
    await this.recomputeDemandAndReconcile(ws);
  }

  // ---- Demand-gate core ---------------------------------------------------

  /**
   * Recompute demand from the authoritative live socket set, persist it, then
   * reconcile upstream + alarm. CRITICAL: persist the (excluded) demand FIRST,
   * then open/close upstream per demand, THEN reconcileAlarm() — so reconcileAlarm
   * reads the JUST-PERSISTED demand and never independently re-reads
   * getWebSockets() (which still contains a closing socket inside webSocketClose).
   *
   * @param {WebSocket} [excluding] - a socket to exclude from the count. The
   *   close/error handlers pass the closing socket here because it is STILL in
   *   ctx.getWebSockets() during those handlers; the accept path passes nothing
   *   (the just-accepted socket SHOULD be counted).
   */
  async recomputeDemandAndReconcile(excluding) {
    const sockets = this.ctx.getWebSockets();
    const demand =
      excluding == null ? sockets.length : sockets.filter((s) => s !== excluding).length;
    await this.ctx.storage.put(STORAGE.demand, demand);
    if (demand > 0) {
      await this.ensureUpstream();
    } else {
      await this.closeUpstream();
    }
    // A real demand-change event MAY legitimately delete the alarm when BOTH
    // responsibilities go idle (demand 0 AND queue empty) — so NOT armOnly.
    await this.reconcileAlarm();
    return demand;
  }

  /**
   * THE SOLE setAlarm/deleteAlarm authority. The DO has exactly ONE alarm shared
   * by two responsibilities — upstream-liveness (the now-playing demand-gate) and
   * the command-queue drain — so the alarm time is the EARLIEST of the two next
   * eligible times.
   *
   *  - LIVENESS: reads the PERSISTED demand key (NEVER getWebSockets(), which still
   *    holds a closing socket inside webSocketClose). demand>0 => now +
   *    UPSTREAM_ALARM_INTERVAL_MS, else null.
   *  - DRAIN: reads the FRESH cmdQueue (only the alarm-deferred modes live here —
   *    'queue'/enqueue and 'latest-wins'/play; throttle + burst deliver inline and
   *    never enter the queue). Empty => null; else the EARLIEST per-ELEMENT
   *    eligibility (commandEligibleAt) clamped to >= now, MIN'd across the queue.
   *    Per-element (not just per-category) because a latest-wins play's deliverAt
   *    depends on its own firstAt/lastAt (the debounce), not only its category timer.
   *    This matches drainOneEligible's cross-category overtaking: an idle category's
   *    eligibility must drive the alarm, not just the strict-FIFO head's — otherwise
   *    the alarm would wait on a cooldown-blocked head while a behind-it idle category
   *    sits drainable. The `?? 0` on lastExec is LOAD-BEARING — a first-ever /
   *    post-eviction-empty timer is undefined, and undefined+cooldown is NaN
   *    (Math.max(NaN, now) === NaN => an invalid setAlarm); `?? 0` makes the first
   *    command of every category eligible at t0.
   *
   * Sets the alarm to the earliest non-null candidate. Deletes ONLY when BOTH are
   * null (demand===0 AND queue empty) and NOT armOnly — the constructor passes
   * armOnly:true so a fresh isolate never wipes an alarm a prior instance set.
   *
   * @param {{ armOnly?: boolean }} [opts]
   */
  async reconcileAlarm({ armOnly = false } = {}) {
    const demand = (await this.ctx.storage.get(STORAGE.demand)) ?? 0;
    const liveness = demand > 0 ? Date.now() + UPSTREAM_ALARM_INTERVAL_MS : null;

    const queue = (await this.ctx.storage.get(STORAGE.cmdQueue)) ?? [];
    let drain = null;
    if (queue.length) {
      const now = Date.now();
      const lastByCat = new Map();
      for (const cmd of queue) {
        if (!lastByCat.has(cmd.category)) {
          lastByCat.set(
            cmd.category,
            (await this.ctx.storage.get(STORAGE.lastExecPrefix + cmd.category)) ?? 0,
          );
        }
        const eligibleAt = Math.max(commandEligibleAt(cmd, lastByCat.get(cmd.category)), now);
        if (drain == null || eligibleAt < drain) drain = eligibleAt;
      }
    }

    const next = [liveness, drain].filter((v) => v != null).sort((a, b) => a - b)[0] ?? null;
    if (next != null) {
      await this.ctx.storage.setAlarm(next);
    } else if (!armOnly) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // ---- Command surface (four modes) ---------------------------------------

  /**
   * Dispatch a command by its category's mode. index.js hands us { category,
   * dashboardPath, body }; the category->mode map (CATEGORY_MODE) decides the
   * mechanism. An unknown category is a LOUD 400 (never silently swallowed).
   *
   * @param {{ category: string, dashboardPath: string, body: string|null }} cmd
   */
  async command(cmd) {
    switch (CATEGORY_MODE[cmd.category]) {
      case 'throttle':
        return this.throttleCommand(cmd);
      case 'burst':
        return this.burstCommand(cmd);
      case 'latest-wins':
        return this.enqueueLatestWins(cmd);
      case 'queue':
        return this.enqueueCommand(cmd);
      default:
        console.warn({
          source: 'music-do',
          message: '[music-do] unknown command category — REJECTING',
          category: cmd.category,
          dashboardPath: cmd.dashboardPath,
        });
        return jsonResponse(400, { ok: false, error: 'unknown command category' });
    }
  }

  /**
   * THROTTLE mode (leading-edge): toggle (pause+resume) and next. The FIRST command
   * in a COOLDOWN_MS[category] window claims the window and delivers INLINE; every
   * other same-category command inside the window is DROPPED (never saved — replaying
   * a backlog of toggles flickers the transport, a backlog of nexts skips a pile of
   * tracks).
   *
   * The check-and-claim runs inside blockConcurrencyWhile so a near-simultaneous
   * second command can't read the same stale lastExec and double-fire — the gate is
   * truly serialized. Delivery happens AFTER the block (a network await inside
   * blockConcurrencyWhile would stall the whole DO for the request's duration). The
   * window is claimed (lastExec stamped) BEFORE delivery, so even a delivery that
   * fails holds the window — the next press one cooldown later retries, and the truth
   * is on the now-playing WS regardless.
   *
   * @param {{ category: string, dashboardPath: string, body: string|null }} cmd
   */
  async throttleCommand(cmd) {
    let allowed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const last = (await this.ctx.storage.get(STORAGE.lastExecPrefix + cmd.category)) ?? 0;
      if (now >= last + COOLDOWN_MS[cmd.category]) {
        await this.ctx.storage.put(STORAGE.lastExecPrefix + cmd.category, now);
        allowed = true;
      }
    });
    if (!allowed) {
      console.log({
        source: 'music-do',
        event: 'throttle-drop',
        category: cmd.category,
        dashboardPath: cmd.dashboardPath,
      });
      return jsonResponse(200, { ok: true, executed: false, coalesced: true });
    }
    return this.deliverInline(cmd);
  }

  /**
   * BURST mode (token-bucket): prev only. Allow up to PREV_BURST_LIMIT presses inside
   * any PREV_BURST_WINDOW_MS window (so a fast double-tap reaches the dashboard's "2
   * within 3s = go back" gesture even when the taps are <1s apart), then require
   * PREV_MIN_SPACING_MS between further presses. Accepted presses deliver INLINE.
   *
   * Like throttle, the accept-decision-and-record runs inside blockConcurrencyWhile
   * so concurrent presses can't both consume the same token; delivery is after the
   * block. The timestamp array is pruned to the window on every press (bounded to a
   * handful of entries) and persisted whether or not the press is accepted, so the
   * window stays accurate.
   *
   * @param {{ category: string, dashboardPath: string, body: string|null }} cmd
   */
  async burstCommand(cmd) {
    let allowed = false;
    await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      const recent = ((await this.ctx.storage.get(STORAGE.prevTimestamps)) ?? []).filter(
        (t) => t > now - PREV_BURST_WINDOW_MS,
      );
      const last = recent.length ? recent[recent.length - 1] : 0;
      if (recent.length < PREV_BURST_LIMIT || now - last >= PREV_MIN_SPACING_MS) {
        recent.push(now);
        allowed = true;
      }
      await this.ctx.storage.put(STORAGE.prevTimestamps, recent);
    });
    if (!allowed) {
      console.log({
        source: 'music-do',
        event: 'burst-drop',
        category: cmd.category,
        dashboardPath: cmd.dashboardPath,
      });
      return jsonResponse(200, { ok: true, executed: false, coalesced: true });
    }
    return this.deliverInline(cmd);
  }

  /**
   * Deliver one command to the dashboard INLINE and forward its response VERBATIM
   * (status + body) so a real-response route (toggle = pause/resume) can stream the
   * dashboard's own reply back to the extension — parity with the pre-throttle DIRECT
   * proxy path. Bounded by a DELIVER_TIMEOUT_MS AbortController so a HUNG dashboard
   * can't wedge the request; an unset base / reject / timeout returns the structured
   * 502 the entry router used for the direct path (extension-side uniformity).
   *
   * No retry: these are leading-edge / token-bucket transport commands — a failed one
   * is simply re-pressable, and the now-playing WS carries the truth. (The retry +
   * give-up machinery lives on the alarm-deferred drain path, deliverCommand.)
   *
   * @param {{ dashboardPath: string, body: string|null }} cmd
   */
  async deliverInline(cmd) {
    const base = this.env.DASHBOARD_REMOTE_BASE;
    if (typeof base !== 'string' || base.length === 0) {
      console.warn({
        source: 'music-do',
        message: '[music-do] DASHBOARD_REMOTE_BASE unset — DROPPING inline command (no dashboard)',
        dashboardPath: cmd.dashboardPath,
      });
      return jsonResponse(502, {
        ok: false,
        code: 'dashboard_unreachable',
        error: 'music dashboard upstream unavailable',
      });
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), DELIVER_TIMEOUT_MS);
    try {
      const resp = await proxyToDashboard(this.env, cmd.dashboardPath, {
        method: 'POST',
        body: cmd.body,
        signal: ctl.signal,
      });
      return new Response(resp.body, {
        status: resp.status,
        headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/json' },
      });
    } catch (err) {
      console.warn({
        source: 'music-do',
        message: '[music-do] inline command delivery failed (reject/abort)',
        dashboardPath: cmd.dashboardPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(502, {
        ok: false,
        code: 'dashboard_unreachable',
        error: 'music dashboard upstream unavailable',
      });
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * LATEST-WINS mode (trailing-edge debounce): play + playlist-play share ONE slot
   * in the queue. A new pick COALESCES onto that single element — overwriting its
   * target (dashboardPath + body) and bumping lastAt, keeping firstAt — so the most
   * recent pick wins and a rapid burst collapses to one delivery. The element's
   * deliverAt (commandEligibleAt) is the debounce: settle after the last pick, never
   * before the cooldown floor, never past the max-defer cap. Replacing resets attempts
   * (a fresh target shouldn't inherit a prior target's retry count). Responds 202
   * IMMEDIATELY (fire-and-forget — truth via the now-playing WS).
   *
   * Single slot per category => no MAX_QUEUE concern here (it cannot grow). Read FRESH
   * + persist before the next await (the input-gate discipline).
   *
   * @param {{ category: string, dashboardPath: string, body: string|null }} cmd
   */
  async enqueueLatestWins(cmd) {
    const now = Date.now();
    const queue = (await this.ctx.storage.get(STORAGE.cmdQueue)) ?? [];
    const idx = queue.findIndex((c) => c.category === cmd.category);
    // pickId STAMPS each distinct pick. It is LOAD-BEARING for the drain's
    // re-read-after-await: a replace lands a NEW pickId, so drainOneEligible can tell
    // whether the slot it just delivered is still the same pick (remove it) or was
    // superseded mid-delivery by a fresh pick (leave the fresh one — latest wins).
    // Without it the index-based splice would discard a pick that arrived during the
    // in-flight delivery — exactly the re-pick this mode exists to honour.
    if (idx >= 0) {
      queue[idx] = {
        ...queue[idx],
        dashboardPath: cmd.dashboardPath,
        body: cmd.body ?? null,
        lastAt: now,
        attempts: 0,
        pickId: crypto.randomUUID(),
      };
    } else {
      queue.push({
        category: cmd.category,
        dashboardPath: cmd.dashboardPath,
        body: cmd.body ?? null,
        enqueuedAt: now,
        firstAt: now,
        lastAt: now,
        attempts: 0,
        pickId: crypto.randomUUID(),
      });
    }
    await this.ctx.storage.put(STORAGE.cmdQueue, queue);
    await this.reconcileAlarm();
    return jsonResponse(202, { ok: true, queued: true });
  }

  /**
   * QUEUE mode (save-all FIFO): enqueue. Append a command and respond 202 IMMEDIATELY
   * (fire-and-forget — the truth returns via the now-playing WS). The command is
   * NEVER dropped here save the runaway backstop (MAX_QUEUE overflow), which is a
   * LOUD console.warn returning the DISTINCT { ok:true, queued:false,
   * dropped:'queue_full' } envelope (the success field never lies about a drop).
   *
   * Read the queue FRESH and persist BEFORE the next await — never cache the array
   * across an await. (An awaited fetch in a DO handler OPENS the input gate, so a
   * concurrent enqueue/drain can interleave; a cached array would lose the
   * concurrent mutation.)
   *
   * @param {{ category: string, dashboardPath: string, body: string|null }} cmd
   */
  async enqueueCommand(cmd) {
    const queue = (await this.ctx.storage.get(STORAGE.cmdQueue)) ?? [];
    if (queue.length >= MAX_QUEUE) {
      console.warn({
        source: 'music-do',
        message: '[music-do] command queue overflow — DROPPING (runaway backstop)',
        category: cmd.category,
        queueLen: queue.length,
      });
      return new Response(
        JSON.stringify({ ok: true, queued: false, dropped: 'queue_full' }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      );
    }
    queue.push({
      category: cmd.category,
      dashboardPath: cmd.dashboardPath,
      body: cmd.body ?? null,
      enqueuedAt: Date.now(),
      attempts: 0,
    });
    await this.ctx.storage.put(STORAGE.cmdQueue, queue);
    await this.reconcileAlarm();
    return new Response(JSON.stringify({ ok: true, queued: true }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Find the index of the FIRST cooldown-ELIGIBLE command in the queue (the
   * drain-eligible head, NOT strictly index 0). Returns -1 if every queued command
   * is still under its category cooldown.
   *
   * CROSS-CATEGORY OVERTAKING (no head-of-line blocking): the per-category timers
   * exist to DECOUPLE categories — a 20s `enqueue` cooldown must not stall a
   * stone-cold `play`. So when the strict-FIFO head is ineligible we do NOT wait on
   * it; we scan forward for the first command whose OWN category is eligible
   * (commandEligibleAt — the cooldown for enqueue, the debounce deliverAt for a
   * latest-wins play) and drain THAT. Without this, one consumer's `enqueue` couples
   * everyone's `play` latency to the enqueue cooldown — exactly the coupling the
   * per-category design is meant to avoid.
   *
   * Only the alarm-deferred modes ('queue'/enqueue, 'latest-wins'/play) ever reach
   * this queue — throttle + burst deliver inline. A latest-wins category holds a
   * SINGLE coalesced slot, so there is no FIFO-within-play to preserve; enqueue
   * elements share one `lastExec:<cat>` timer, so an earlier same-category element
   * blocked under cooldown equally blocks a later one (no same-category overtaking).
   *
   * @param {Array<{category:string}>} queue
   * @returns {Promise<number>} index of the first eligible command, or -1
   */
  async firstEligibleIndex(queue) {
    const now = Date.now();
    // Cache per-category lastExec lookups: a long queue of one category does a
    // single storage.get, not one per element.
    const lastByCat = new Map();
    for (let i = 0; i < queue.length; i++) {
      const cat = queue[i].category;
      if (!lastByCat.has(cat)) {
        lastByCat.set(cat, (await this.ctx.storage.get(STORAGE.lastExecPrefix + cat)) ?? 0);
      }
      if (now >= commandEligibleAt(queue[i], lastByCat.get(cat))) return i;
    }
    return -1;
  }

  /**
   * Drain EXACTLY ONE eligible command — SINGLE-SHOT, NOT a gate-holding loop.
   * reconcileAlarm() (called by alarm()'s finally) re-arms for the next eligible
   * time, so the platform re-drives the drain one command per wake.
   *
   * Selects the FIRST cooldown-eligible command (firstEligibleIndex) — an idle
   * category is NEVER blocked behind a busy one. FIFO within a category is intact
   * (see firstEligibleIndex). If nothing is eligible the drain no-ops and
   * reconcileAlarm re-arms for the earliest per-category eligibility across the
   * queue.
   *
   * Order is preserved (modulo cross-category overtaking) and nothing is dropped
   * except the four LOUD cases (queue overflow handled in enqueueCommand; here:
   * transient give-up after MAX_DELIVERY_ATTEMPTS, a 4xx permanent rejection, and
   * DASHBOARD_REMOTE_BASE unset — all surfaced via deliverCommand's outcome + a
   * drain-trace).
   */
  async drainOneEligible() {
    const queue = (await this.ctx.storage.get(STORAGE.cmdQueue)) ?? [];
    if (queue.length === 0) return;

    const idx = await this.firstEligibleIndex(queue);
    if (idx === -1) {
      // No category eligible: every queued command STAYS (never skipped/reordered).
      // reconcileAlarm re-arms for the earliest per-category eligibility.
      return;
    }
    const cmd = queue[idx];

    const outcome = await this.deliverCommand(cmd);

    // RE-READ the queue FRESH after the delivery await: the await opened the input
    // gate, so a concurrent enqueue may have mutated cmdQueue. Two shapes of mutation
    // are possible and must be handled DIFFERENTLY:
    //   - 'queue' (enqueue) APPENDS to the tail — never reorders/removes, and drain is
    //     the SOLE remover (one alarm() per DO), so the delivered element is still at
    //     the SAME index `idx`.
    //   - 'latest-wins' (play) REPLACES its slot IN PLACE (same index, new pickId) —
    //     so the element at `idx` may now be a DIFFERENT, newer pick that was NEVER
    //     delivered. A blind splice(idx) would discard it.
    // So confirm IDENTITY before acting: the element at `idx` must still be the one we
    // delivered (same category, same pickId — both undefined for non-latest-wins, which
    // are never replaced in place, so the check is a no-op there). If it was superseded
    // mid-delivery, leave the fresh pick untouched (latest wins) and only record that
    // the delivered work completed.
    const fresh = (await this.ctx.storage.get(STORAGE.cmdQueue)) ?? [];
    const stillThere =
      fresh[idx] != null &&
      fresh[idx].category === cmd.category &&
      fresh[idx].pickId === cmd.pickId;

    const giveUp = outcome.transient && cmd.attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
    if (outcome.terminal || giveUp) {
      // Drained (delivered, permanently-rejected, or transient give-up): bump the
      // per-category lastExec (the expensive delivery happened, so the next of this
      // category — incl. a superseding pick — is spaced from now), remove the selected
      // command ONLY if it is still the same pick, persist, trace the REAL outcome.
      await this.ctx.storage.put(STORAGE.lastExecPrefix + cmd.category, Date.now());
      if (stillThere) {
        fresh.splice(idx, 1);
        await this.ctx.storage.put(STORAGE.cmdQueue, fresh);
      }
      console.log({
        source: 'music-do',
        event: 'drain',
        category: cmd.category,
        dashboardPath: cmd.dashboardPath,
        outcome: outcome.terminal
          ? outcome.traceOutcome
          : 'dropped-after-max-' + outcome.traceOutcome,
        attempt: cmd.attempts + 1,
        superseded: !stillThere,
      });
    } else if (stillThere) {
      // Transient under MAX: keep the command in place, bump its attempts, do NOT
      // bump lastExec. reconcileAlarm re-arms at now so the retry fires immediately
      // (one retry total at MAX_DELIVERY_ATTEMPTS=2).
      fresh[idx].attempts = cmd.attempts + 1;
      await this.ctx.storage.put(STORAGE.cmdQueue, fresh);
    } else {
      // Transient, but the pick was SUPERSEDED mid-delivery by a fresh latest-wins
      // pick. Abandon the failed target's retry (the user moved on); the fresh pick
      // delivers on its own eligibility. LOUD so it is never a silent disappearance.
      console.log({
        source: 'music-do',
        event: 'drain',
        category: cmd.category,
        dashboardPath: cmd.dashboardPath,
        outcome: 'superseded-' + outcome.traceOutcome,
        attempt: cmd.attempts + 1,
        superseded: true,
      });
    }
  }

  /**
   * Deliver one command to the dashboard, REUSING proxyToDashboard (identical
   * Content-Type:application/json + X-Remote-Key + base-join as the direct proxy
   * path — the two paths cannot drift). Bounded by a DELIVER_TIMEOUT_MS
   * AbortController so a HUNG dashboard folds into the transient bucket.
   *
   * Returns one of:
   *   { terminal:true,  traceOutcome:'delivered' }                      — 2xx
   *   { terminal:true,  traceOutcome:'dashboard-rejected-<status>' }    — 4xx (permanent)
   *   { terminal:true,  traceOutcome:'dropped-no-dashboard' }           — base unset
   *   { transient:true, traceOutcome:'dashboard-error-<status>' }       — 5xx
   *   { transient:true, traceOutcome:'transient-timeout'|'transient-reject' } — abort/reject
   *
   * @param {{ category:string, dashboardPath:string, body:string|null }} head
   */
  async deliverCommand(head) {
    const base = this.env.DASHBOARD_REMOTE_BASE;
    if (typeof base !== 'string' || base.length === 0) {
      console.warn({
        source: 'music-do',
        message: '[music-do] DASHBOARD_REMOTE_BASE unset — DROPPING command (no dashboard)',
        category: head.category,
        dashboardPath: head.dashboardPath,
      });
      return { terminal: true, traceOutcome: 'dropped-no-dashboard' };
    }

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), DELIVER_TIMEOUT_MS);
    try {
      const resp = await proxyToDashboard(this.env, head.dashboardPath, {
        method: 'POST',
        body: head.body,
        signal: ctl.signal,
      });
      if (resp.status >= 200 && resp.status < 300) {
        return { terminal: true, traceOutcome: 'delivered' };
      }
      if (resp.status >= 400 && resp.status < 500) {
        console.warn({
          source: 'music-do',
          message: '[music-do] dashboard rejected command (4xx) — DROPPING (permanent)',
          status: resp.status,
          category: head.category,
          dashboardPath: head.dashboardPath,
        });
        return { terminal: true, traceOutcome: 'dashboard-rejected-' + resp.status };
      }
      console.warn({
        source: 'music-do',
        message: '[music-do] dashboard 5xx — transient, will retry',
        status: resp.status,
        category: head.category,
        dashboardPath: head.dashboardPath,
      });
      return { transient: true, traceOutcome: 'dashboard-error-' + resp.status };
    } catch (err) {
      console.warn({
        source: 'music-do',
        message: '[music-do] command delivery failed (reject/abort) — transient',
        category: head.category,
        dashboardPath: head.dashboardPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        transient: true,
        traceOutcome: ctl.signal.aborted ? 'transient-timeout' : 'transient-reject',
      };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Alarm — services BOTH the single alarm's responsibilities, LIVENESS FIRST then
   * the command drain. The DO has ONE alarm (reconcileAlarm computes its time as
   * min(liveness, drain)), so a single wake may be due to either responsibility.
   *
   * Ordering rationale: liveness (a local readyState check + a getWebSockets fan of
   * the persisted snapshot) is CHEAP and must run BEFORE the up-to-DELIVER_TIMEOUT_MS
   * delivery, so the now-playing demand-gate fan is NEVER starved behind a slow/hung
   * delivery — even when sustained command load makes the min() fire on a near-term
   * drain time, the fan happens first every wake.
   *
   * The try/finally guarantees a re-arm even if liveness OR drain throws (a drain
   * exception must not orphan the liveness alarm); beyond that the platform gives
   * alarm() at-least-once execution + retry on uncaught throw.
   */
  async alarm() {
    try {
      const demand = (await this.ctx.storage.get(STORAGE.demand)) ?? 0;
      if (demand > 0) {
        const reopened = await this.ensureUpstream();
        if (reopened) {
          // Reconcile reconnect-during-gap clients with the last-known state.
          await this.fanPersistedSnapshot();
        }
      } else {
        // A drain-only wake at demand 0 must tear the upstream down rather than
        // leak it (the demand-gate's close path).
        await this.closeUpstream();
      }
      await this.drainOneEligible();
    } finally {
      await this.reconcileAlarm();
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
    const base = this.env.DASHBOARD_REMOTE_BASE;
    if (typeof base !== 'string' || base.length === 0) {
      // No dashboard base configured (e.g. test env). Demand-gate + fan-out still
      // function; live events simply won't arrive until DASHBOARD_REMOTE_BASE is
      // set. The fan-out then delivers only the persisted snapshot, never live
      // events.
      this.upstream = null;
      return;
    }
    // ESCALATION 5 RESOLVED: the upstream now-playing WS IS the dashboard's
    // /api/remote/nowplaying route over DASHBOARD_REMOTE_BASE — the same ingress
    // the HTTP proxy (proxy.js) already targets. In the Workers runtime an
    // outbound WebSocket is opened by fetch()ing the http(s) URL with an
    // `Upgrade: websocket` header and reading `resp.webSocket` — the runtime
    // REJECTS a ws/wss scheme ("Fetch API cannot load: wss://…"). So keep the
    // base's http(s) scheme as-is and just append the nowplaying path.
    const url = base.replace(/\/+$/, '') + '/api/remote/nowplaying';

    // PLAIN fetch WS upgrade. NO @microlabs wrapper, NO OTel.
    //
    // OUTBOUND AUTH (escalation 5): the upstream WS upgrade carries the SAME frozen
    // X-Remote-Key credential the HTTP proxy uses (proxy.js), since the upstream is
    // the dashboard. The key is omitted only when DASHBOARD_REMOTE_KEY itself is
    // unset (e.g. a test env).
    const headers = { Upgrade: 'websocket' };
    if (typeof this.env.DASHBOARD_REMOTE_KEY === 'string' && this.env.DASHBOARD_REMOTE_KEY.length > 0) {
      headers['X-Remote-Key'] = this.env.DASHBOARD_REMOTE_KEY;
    }
    // The dashboard may be briefly unreachable (DNS failure, cold or absent
    // ingress) — the same expected steady state the HTTP proxy degrades to a 502
    // for. A bare fetch rejection here would propagate out of ensureUpstream()
    // through alarm(), the WS-upgrade lazy re-open, and the constructor's
    // blockConcurrencyWhile, crashing those paths. Treat it like the no-socket
    // branch: leave upstream null; the demand-gate keeps the alarm armed and the
    // next interval (or a reconnecting/message-sending subscriber) retries.
    //
    // HANG HAZARD (parity with deliverCommand): a dashboard that ACCEPTS the
    // connection then never completes the WS handshake would otherwise wedge this
    // await — and because openUpstream is awaited inside the constructor's
    // blockConcurrencyWhile, a hung handshake stalls the DO from servicing ANY
    // request until the platform's internal timeout. Bound the fetch with an
    // UPSTREAM_OPEN_TIMEOUT_MS AbortController; an abort REJECTS the fetch and folds
    // into the SAME catch as a connection reject — log + leave upstream null + retry
    // next interval. Identical degrade-gracefully outcome, now also covering a hang.
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), UPSTREAM_OPEN_TIMEOUT_MS);
    let ws;
    try {
      const resp = await fetch(url, { headers, signal: ctl.signal });
      ws = resp.webSocket;
    } catch (err) {
      console.warn({
        source: 'music-do',
        message: ctl.signal.aborted
          ? '[music-do] upstream WS open timed out (dashboard accepted then hung) — will retry'
          : '[music-do] upstream WS open failed (dashboard unreachable) — will retry',
        error: err instanceof Error ? err.message : String(err),
      });
      this.upstream = null;
      return;
    } finally {
      clearTimeout(t);
    }
    if (!ws) {
      this.upstream = null;
      return;
    }
    ws.accept();
    this.upstream = ws;
    // Handle each upstream frame directly. We do NOT wrap in ctx.waitUntil: on a
    // DurableObjectState, waitUntil exists only for Workers-API surface
    // compatibility and HAS NO EFFECT — it neither extends DO lifetime nor keeps
    // the promise alive. DO lifetime here is governed by the open upstream socket
    // + persisted demand-gate, not waitUntil. onUpstreamMessage is async (it does
    // ctx.storage.put + fanOut), so attach a .catch: a parse/storage failure is
    // logged via the file's structured-log idiom rather than becoming an unhandled
    // rejection silently swallowed differently from every other error path here.
    ws.addEventListener('message', (event) => {
      this.onUpstreamMessage(event.data).catch((err) => {
        console.warn({
          source: 'music-do',
          message: '[music-do] onUpstreamMessage failed (snapshot persist/fan-out)',
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
