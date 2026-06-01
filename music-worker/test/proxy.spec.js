import { describe, it, expect, vi, afterEach } from 'vitest';
import { proxyToDashboard } from '../src/proxy.js';

const baseEnv = {
  DASHBOARD_REMOTE_BASE: 'https://dashboard.test.invalid',
  DASHBOARD_REMOTE_KEY: 'secret-remote-key',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxyToDashboard', () => {
  it('fetches DASHBOARD_REMOTE_BASE + path with X-Remote-Key', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const res = await proxyToDashboard(baseEnv, '/api/remote/pause', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('https://dashboard.test.invalid/api/remote/pause');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Remote-Key']).toBe('secret-remote-key');
    // JSON content-type is defaulted when a body is present.
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('preserves a query-string path verbatim', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { status: 200 }));
    await proxyToDashboard(baseEnv, '/api/remote/search?q=daft%20punk', { method: 'GET' });
    expect(spy.mock.calls[0][0]).toBe('https://dashboard.test.invalid/api/remote/search?q=daft%20punk');
    // GET has no body => no defaulted content-type.
    expect(spy.mock.calls[0][1].headers['Content-Type']).toBeUndefined();
  });

  it('throws when DASHBOARD_REMOTE_BASE is unset', async () => {
    await expect(
      proxyToDashboard({ DASHBOARD_REMOTE_KEY: 'k' }, '/api/remote/pause', {}),
    ).rejects.toThrow(/DASHBOARD_REMOTE_BASE unset/);
  });
});
