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
    request.signal.addEventListener('abort', () => {
      this.writers.delete(writer);
      try { writer.close(); } catch {}
    });

    // Schedule a heartbeat alarm if one isn't already running. The alarm
    // reschedules itself while writers remain. Fast op — fine to await.
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
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
      } catch {
        // Writer may have closed already (client disconnected mid-init); ignore.
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
   */
  async pushState(event) {
    const sse = `event: state\ndata: ${JSON.stringify(event)}\n\n`;
    return await this._broadcast(sse);
  }

  async alarm() {
    if (this.writers.size === 0) return;
    await this._broadcast(': keepalive\n\n');
    if (this.writers.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    }
  }

  async _broadcast(sseChunk) {
    const bytes = new TextEncoder().encode(sseChunk);
    const dead = [];
    for (const writer of this.writers) {
      try {
        await writer.write(bytes);
      } catch {
        dead.push(writer);
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
