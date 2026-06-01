/**
 * Outbound proxy: music worker -> dashboard /api/remote/*.
 *
 * PLAIN fetch — NO @microlabs wrapper, NO OTel (observability waived for the
 * music remote). The outbound header X-Remote-Key (= env.DASHBOARD_REMOTE_KEY)
 * and the base env.DASHBOARD_REMOTE_BASE are FROZEN by the cross-repo contract.
 */

/**
 * @param {{ DASHBOARD_REMOTE_BASE: string, DASHBOARD_REMOTE_KEY: string }} env
 * @param {string} mappedPath - dashboard sub-path beginning with '/'
 *   (already validated non-placeholder by route-map.throwIfUnset).
 * @param {{ method?: string, body?: BodyInit | null, headers?: Record<string,string> }} [init]
 * @returns {Promise<Response>}
 */
export async function proxyToDashboard(env, mappedPath, init = {}) {
  const base = env.DASHBOARD_REMOTE_BASE;
  if (typeof base !== 'string' || base.length === 0) {
    throw new Error('DASHBOARD_REMOTE_BASE unset');
  }
  const headers = {
    'X-Remote-Key': env.DASHBOARD_REMOTE_KEY,
    ...(init.headers ?? {}),
  };
  if (init.body != null && !('Content-Type' in headers) && !('content-type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${base}${mappedPath}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body ?? undefined,
  });
}
