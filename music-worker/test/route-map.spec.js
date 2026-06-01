import { describe, it, expect } from 'vitest';
import {
  MUSIC_ROUTES,
  API_REMOTE_PATH,
  throwIfUnset,
  parseDeezerId,
  volumeDeltaFor,
  VOLUME_STEP_POINTS,
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

  it('throwIfUnset throws on an unset placeholder (escalation 1)', () => {
    expect(() => throwIfUnset('pause', API_REMOTE_PATH.pause)).toThrowError(/escalation 1/);
  });

  it('throwIfUnset returns a real, operator-set path unchanged', () => {
    expect(throwIfUnset('pause', '/api/remote/pause')).toBe('/api/remote/pause');
  });

  it('every API_REMOTE_PATH key matches a MUSIC_ROUTES key (no orphans)', () => {
    expect(Object.keys(API_REMOTE_PATH).sort()).toEqual(Object.keys(MUSIC_ROUTES).sort());
  });

  it('volume direction maps to a fixed +/-10 percentage-point delta', () => {
    expect(VOLUME_STEP_POINTS).toBe(10);
    expect(volumeDeltaFor('up')).toEqual({ ok: true, delta: 10 });
    expect(volumeDeltaFor('down')).toEqual({ ok: true, delta: -10 });
  });

  it('volume rejects any non up/down direction', () => {
    expect(volumeDeltaFor('UP').ok).toBe(false);
    expect(volumeDeltaFor(5).ok).toBe(false);
    expect(volumeDeltaFor(undefined).ok).toBe(false);
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
