import { describe, it, expect } from 'vitest';
import {
  MUSIC_ROUTES,
  API_REMOTE_PATH,
  throwIfUnset,
  parseDeezerId,
} from '../src/route-map.js';

describe('route-map', () => {
  it('declares all 11 inbound /music/* routes', () => {
    expect(Object.keys(MUSIC_ROUTES).sort()).toEqual(
      [
        'pause',
        'resume',
        'next',
        'prev',
        'volume',
        'search',
        'play',
        'enqueue',
        'playlist-play',
        'playlist-search',
        'playlist-contents',
      ].sort(),
    );
  });

  it('throwIfUnset throws on an unset placeholder (safety net retained)', () => {
    // The shipped API_REMOTE_PATH values are now CONFIRMED (escalation 1 resolved),
    // so feed a synthetic placeholder to prove the guard still fires if one ever
    // reaches a live proxy call.
    expect(() => throwIfUnset('pause', '__UNSET_pause__')).toThrowError(/path unset/);
  });

  it('throwIfUnset returns every confirmed API_REMOTE_PATH value unchanged', () => {
    for (const [route, path] of Object.entries(API_REMOTE_PATH)) {
      expect(throwIfUnset(route, path)).toBe(path);
    }
    // spot-check the exact confirmed strings
    expect(API_REMOTE_PATH.pause).toBe('/api/remote/pause');
    expect(API_REMOTE_PATH.search).toBe('/api/remote/songs/results');
    expect(API_REMOTE_PATH['playlist-contents']).toBe('/api/remote/playlists/contents');
  });

  it('every API_REMOTE_PATH key matches a MUSIC_ROUTES key (no orphans)', () => {
    expect(Object.keys(API_REMOTE_PATH).sort()).toEqual(Object.keys(MUSIC_ROUTES).sort());
  });

  it('the volume route is a POST of kind volume (direction forwarded verbatim; dashboard owns the step)', () => {
    expect(MUSIC_ROUTES.volume).toEqual({ method: 'POST', kind: 'volume' });
  });

  it('parseDeezerId accepts numbers and numeric strings', () => {
    expect(parseDeezerId(3135556)).toEqual({ ok: true, id: 3135556 });
    expect(parseDeezerId('3135556')).toEqual({ ok: true, id: 3135556 });
    expect(parseDeezerId(' 42 ')).toEqual({ ok: true, id: 42 });
    expect(parseDeezerId(0)).toEqual({ ok: true, id: 0 });
  });

  it('parseDeezerId rejects non-numeric, negative, float, and junk ids', () => {
    expect(parseDeezerId('abc').ok).toBe(false);
    expect(parseDeezerId('12.5').ok).toBe(false);
    expect(parseDeezerId(12.5).ok).toBe(false);
    expect(parseDeezerId(-1).ok).toBe(false);
    expect(parseDeezerId(null).ok).toBe(false);
    expect(parseDeezerId(undefined).ok).toBe(false);
    expect(parseDeezerId('').ok).toBe(false);
  });
});
