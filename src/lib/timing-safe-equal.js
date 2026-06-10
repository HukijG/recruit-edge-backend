/**
 * Constant-time string comparison for shared-secret header checks.
 *
 * A plain `===` short-circuits on the first differing byte, which leaks the
 * secret's matching-prefix length through response timing. This compares every
 * byte unconditionally (and still burns a full loop on length mismatch so the
 * length itself doesn't become the timing signal).
 *
 * Same implementation as cache-worker/src/index.js's local helper; lifted to
 * src/lib/ so main-worker routes can share it.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) {
    // still iterate to avoid timing leak on length
    let dummy = 0;
    for (let i = 0; i < ea.length; i++) dummy |= ea[i];
    return false;
  }
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}
