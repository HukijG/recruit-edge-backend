/**
 * ExtensionCallStateChannel — per-Dialpad-user SSE fan-in + state store.
 *
 * One Durable Object instance per consultant (named via `getByName(dialpadId)`).
 * Holds:
 *  - the live SSE writers for every browser tab/context the extension has
 *    open for that user (in-memory `Set`)
 *  - the call-state machine state (`watch` and `active`) in DO storage so
 *    reads/writes are strongly consistent across edge datacenters
 *
 * Why DO storage instead of KV: the calling/hangup webhook usually lands at
 * a different Cloudflare datacenter than the user's `/dialpad-call` or
 * `/dialpad-hangup` request, and KV is eventually consistent (up to ~60s
 * cross-DC). For state that's read within a few seconds of being written,
 * KV returns stale nulls. DO storage is single-instance + transactional so
 * any caller that resolves the same DO sees the same value.
 *
 * Surface:
 *   - fetch(request)                — extension subscribes here; returns a
 *                                     streaming SSE Response. The worker
 *                                     route /extension-call-stream forwards
 *                                     to this via stub.fetch().
 *   - pushState(event)  (RPC)       — broadcast state change to subscribers.
 *   - getWatch / setWatch / clearWatch       (RPC)
 *   - getActive / setActive / clearActive    (RPC)
 *   - clearAll                       (RPC, used by /dialpad-call's one-in-one-out)
 *   - alarm()                       — heartbeat keepalive (every 25s while
 *                                     subscribers exist).
 *
 * Watch + active are persisted to DO storage. Subscribers (writers) are
 * in-memory only — DO eviction kills active streams, but the extension's
 * EventSource auto-reconnects and the DO replays current state from
 * persisted storage on reconnect (see _readCurrentState).
 */

import { DurableObject } from 'cloudflare:workers';

const HEARTBEAT_MS = 25_000;

export class ExtensionCallStateChannel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {Set<WritableStreamDefaultWriter<Uint8Array>>} */
    this.writers = new Set();
    // Lazy-loaded from DO storage on first read; null = no value, undefined = not yet loaded
    this._watchCache = undefined;
    this._activeCache = undefined;
  }

  // -------------------- watch / active state --------------------

  async _loadWatch() {
    if (this._watchCache === undefined) {
      this._watchCache = (await this.ctx.storage.get('watch')) ?? null;
    }
    return this._watchCache;
  }

  async _loadActive() {
    if (this._activeCache === undefined) {
      this._activeCache = (await this.ctx.storage.get('active')) ?? null;
    }
    return this._activeCache;
  }

  async getWatch() {
    return await this._loadWatch();
  }

  async setWatch(watch) {
    this._watchCache = watch || null;
    if (watch) {
      await this.ctx.storage.put('watch', watch);
    } else {
      await this.ctx.storage.delete('watch');
    }
    return { ok: true };
  }

  async clearWatch() {
    return await this.setWatch(null);
  }

  async getActive() {
    return await this._loadActive();
  }

  async setActive(active) {
    this._activeCache = active || null;
    if (active) {
      await this.ctx.storage.put('active', active);
    } else {
      await this.ctx.storage.delete('active');
    }
    return { ok: true };
  }

  async clearActive() {
    return await this.setActive(null);
  }

  /**
   * Clear both watch and active in one trip. Used by /dialpad-call (one-in-
   * one-out invariant) and /dialpad-hangup (final-state reset).
   */
  async clearAll() {
    this._watchCache = null;
    this._activeCache = null;
    await this.ctx.storage.delete('watch');
    await this.ctx.storage.delete('active');
    return { ok: true };
  }

  async fetch(request) {
    // dialpadUserId param is no longer needed for state lookup (we read from
    // local DO storage), but we accept it for backwards compat / clarity in
    // logs if present.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // Register the writer up-front so any pushState that lands during the
    // initial-events background task still hits this subscriber.
    this.writers.add(writer);

    // Client disconnect cleanup. The DO request inherits the original
    // request's AbortSignal; aborting fires when the SSE stream closes.
    // writer.close() returns a Promise — must .catch() it (the listener is
    // sync; an unawaited rejected Promise would surface as an unhandled
    // rejection and could take the DO RPC down on the next request.)
    request.signal.addEventListener('abort', () => {
      this.writers.delete(writer);
      writer.close().catch(() => {});
    });

    // Schedule a heartbeat alarm if one isn't already running. Wrapped in
    // try/catch so a transient storage hiccup doesn't fail the whole
    // subscribe.
    try {
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null) {
        await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
      }
    } catch (err) {
      console.error({
        message: `[ExtCallChannel] alarm setup failed: ${err?.message || 'unknown'}`,
        source: 'extension-call-do',
        stack: err?.stack,
      });
    }

    // Initial writes (hello + KV-replayed state) happen AFTER the response
    // returns. TransformStream's readable defaults to highWaterMark 0, so
    // multiple awaited writes before returning the response would deadlock:
    // the second write blocks until the first is consumed, but no consumer
    // exists until the Response we're about to return reaches the client.
    // Kick the writes off async — the DO stays alive while the streaming
    // response is being consumed, so this background task runs to completion.
    (async () => {
      const encoder = new TextEncoder();
      try {
        await writer.write(encoder.encode(
          `event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`
        ));
        const initial = await this._readCurrentState();
        await writer.write(encoder.encode(
          `event: state\ndata: ${JSON.stringify(initial)}\n\n`
        ));
      } catch (err) {
        // Writer may have closed already (client disconnected mid-init);
        // log non-fatally for diagnosis.
        console.warn({
          message: `[ExtCallChannel] initial-write error: ${err?.message || 'unknown'}`,
          source: 'extension-call-do',
        });
      }
    })();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        // Hint to any intermediate buffering layer (nginx etc) to flush
        // immediately; CF itself doesn't buffer SSE but it's harmless.
        'X-Accel-Buffering': 'no',
      },
    });
  }

  /**
   * RPC: broadcast a state change to all current subscribers for this user.
   * Returns { delivered } so callers can log the fan-out size.
   *
   * The event shape pushed to the extension intentionally OMITS call_id —
   * per the design, the extension never sees that value; the worker holds it
   * in KV and uses it on /dialpad-hangup.
   *
   * Top-level try/catch keeps any internal error from surfacing as the
   * opaque "internal error; reference = ..." that CF wraps unhandled DO
   * RPC exceptions in. Real cause gets logged inside the DO instead.
   */
  async pushState(event) {
    try {
      const sse = `event: state\ndata: ${JSON.stringify(event)}\n\n`;
      return await this._broadcast(sse);
    } catch (err) {
      console.error({
        message: `[ExtCallChannel] pushState fatal: ${err?.message || 'unknown'}`,
        source: 'extension-call-do',
        stack: err?.stack,
        writersSize: this.writers?.size ?? 'undef',
        event,
      });
      return { delivered: 0, error: err?.message || 'unknown' };
    }
  }

  async alarm() {
    try {
      if (!this.writers || this.writers.size === 0) return;
      await this._broadcast(': keepalive\n\n');
      if (this.writers && this.writers.size > 0) {
        await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
      }
    } catch (err) {
      console.error({
        message: `[ExtCallChannel] alarm fatal: ${err?.message || 'unknown'}`,
        source: 'extension-call-do',
        stack: err?.stack,
      });
    }
  }

  async _broadcast(sseChunk) {
    if (!this.writers || this.writers.size === 0) {
      return { delivered: 0 };
    }
    const bytes = new TextEncoder().encode(sseChunk);
    const dead = [];
    for (const writer of this.writers) {
      try {
        await writer.write(bytes);
      } catch (err) {
        dead.push(writer);
        // Surface the actual write error so we can distinguish "writer was
        // already closed" from anything more interesting.
        console.warn({
          message: `[ExtCallChannel] writer.write failed: ${err?.message || 'unknown'}`,
          source: 'extension-call-do',
        });
      }
    }
    for (const w of dead) {
      this.writers.delete(w);
      try { await w.close(); } catch {}
    }
    return { delivered: this.writers.size };
  }

  async _readCurrentState() {
    // DO is keyed per-user, so we read directly from local storage — no
    // dialpadUserId param needed.
    const active = await this._loadActive();
    if (active && active.callId) {
      return { state: 'active', phoneNumber: active.phone };
    }
    const watch = await this._loadWatch();
    if (watch && watch.phone) {
      return { state: 'calling', phoneNumber: watch.phone };
    }
    return { state: 'idle' };
  }
}
