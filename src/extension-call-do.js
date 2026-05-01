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
    const encoder = new TextEncoder();

    // Greet immediately so the client knows the stream is live.
    try {
      await writer.write(encoder.encode(
        `event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`
      ));
    } catch {}

    // Replay current state from KV — ensures a tab opening mid-call gets the
    // right initial button. Without this, the extension only learns of an
    // active call when the next state transition happens.
    if (dialpadUserId) {
      try {
        const initial = await this._readCurrentState(dialpadUserId);
        await writer.write(encoder.encode(
          `event: state\ndata: ${JSON.stringify(initial)}\n\n`
        ));
      } catch {}
    }

    this.writers.add(writer);

    // Client disconnect cleanup. The DO request inherits the original
    // request's AbortSignal; aborting fires when the SSE stream closes.
    request.signal.addEventListener('abort', () => {
      this.writers.delete(writer);
      try { writer.close(); } catch {}
    });

    // Schedule a heartbeat alarm if one isn't already running. The alarm
    // reschedules itself while writers remain.
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null) {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    }

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
