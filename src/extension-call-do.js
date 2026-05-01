/**
 * ExtensionCallStateChannel — per-Dialpad-user SSE fan-in.
 *
 * One Durable Object instance per consultant (named via `getByName(dialpadId)`).
 * Holds the live SSE writers for every browser tab/context the extension has
 * open for that user, so a state change pushed once reaches every tab.
 *
 * Surface:
 *   - fetch(request)                — the extension subscribes here; returns
 *                                     a streaming SSE Response. The worker
 *                                     route /extension-call-stream forwards
 *                                     to this via stub.fetch().
 *   - pushState(event)  (RPC)       — invoked by notifyExtensionCallState
 *                                     from the webhook handler to broadcast
 *                                     a state change to all subscribers.
 *   - alarm()                       — heartbeat keepalive (every 25s while
 *                                     subscribers exist) so proxies don't
 *                                     drop the connection and dead writers
 *                                     surface fast.
 *
 * No persistent storage: subscribers are in-memory only. If the DO is evicted
 * the extension's stream just dies and reconnects — the fresh fetch() reads
 * the current state from KV and replays it on connect (see _readCurrentState).
 */

import { DurableObject } from 'cloudflare:workers';
import { getActiveExtensionCall, getExtensionCallWatch } from './cache.js';

const HEARTBEAT_MS = 25_000;

export class ExtensionCallStateChannel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {Set<WritableStreamDefaultWriter<Uint8Array>>} */
    this.writers = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const dialpadUserId = url.searchParams.get('userId');

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
        if (dialpadUserId) {
          const initial = await this._readCurrentState(dialpadUserId);
          await writer.write(encoder.encode(
            `event: state\ndata: ${JSON.stringify(initial)}\n\n`
          ));
        }
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

  async _readCurrentState(dialpadUserId) {
    const active = await getActiveExtensionCall(dialpadUserId, this.env);
    if (active && active.callId) {
      return { state: 'active', phoneNumber: active.phone };
    }
    const watch = await getExtensionCallWatch(dialpadUserId, this.env);
    if (watch && watch.phone) {
      return { state: 'calling', phoneNumber: watch.phone };
    }
    return { state: 'idle' };
  }
}
