/**
 * Shared concurrency utilities for MCP middleware handlers.
 */

/**
 * Parallel map with concurrency cap. Returns a result array in input order
 * with shape `[{ok: true, value} | {ok: false, error}, ...]`.
 *
 * Used by the expanded-hydration fan-out in job-pipeline and
 * job-candidates-filter — concurrency cap (default 8 per spec rev 5 RF-6)
 * protects RF from a thundering herd on large stages while keeping latency
 * bounded. Per-id failures are captured (never thrown) so one bad candidate
 * doesn't poison the rest of the response.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit       Max parallel invocations.
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<Array<{ok: true, value: R} | {ok: false, error: unknown}>>}
 */
export async function pMapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
